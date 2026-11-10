const test = require('brittle')
const http = require('http')
const b4a = require('b4a')
const tmp = require('test-tmp')
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const RelayedDHT = require('@hyperswarm/dht-relay')
const { relay } = RelayedDHT
const Hyperswarm = require('hyperswarm')
const Hypercore = require('hypercore')
const Stream = require('.')
const Server = require('./server')

const fetch = global.fetch || require('bare-fetch')

test('frames go both ways, whole and in order', async (t) => {
  t.plan(2)

  const sent = ['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((s) => b4a.from(s))
  const received = []

  const url = await listen(
    t,
    new Server((session) => {
      session.on('data', (data) => session.write(data))
      session.on('close', () => t.pass('session closed'))
    })
  )

  const stream = new Stream(url, { fetch })

  for (const frame of sent) stream.write(frame)

  stream.on('data', (data) => {
    received.push(data)

    if (received.length === sent.length) {
      t.alike(received, sent)
      stream.destroy()
    }
  })
})

test('destroying the stream ends its poll and closes its session', async (t) => {
  t.plan(2)

  const url = await listen(
    t,
    new Server(
      (session) => {
        session.on('close', () => t.pass('session closed'))
        session.write(b4a.from('hello'))
      },
      { pollTimeout: 60000 }
    )
  )

  const stream = new Stream(url, { fetch })

  stream
    .once('data', () => setImmediate(() => stream.destroy()))
    .on('close', () => t.pass('stream closed'))
})

test('a stream destroyed while it opens closes its session', async (t) => {
  t.plan(2)

  const url = await listen(
    t,
    new Server((session) => {
      session.on('close', () => t.pass('session closed'))
    })
  )

  const stream = new Stream(url, { fetch })

  stream.resume()
  stream.on('close', () => t.pass('stream closed'))

  setImmediate(() => stream.destroy())
})

test('the relay closing a session ends the stream', async (t) => {
  t.plan(2)

  const url = await listen(t, new Server((session) => setTimeout(() => session.destroy(), 100)))

  const stream = new Stream(url, { fetch })

  stream
    .on('error', (err) => t.is(err.message, 'Relay responded with status 410'))
    .on('close', () => t.pass('stream closed'))
    .resume()
})

test('a stream fails when the relay cannot be reached', async (t) => {
  t.plan(2)

  const http1 = http.createServer()
  await new Promise((resolve) => http1.listen(0, '127.0.0.1', resolve))
  const { port } = http1.address()
  await new Promise((resolve) => http1.close(resolve))

  const stream = new Stream('http://127.0.0.1:' + port, { fetch })

  stream
    .on('error', (err) => t.ok(err, 'failed'))
    .on('close', () => t.pass('stream closed'))
    .resume()
})

test('a stream splits large writes into requests the relay takes', async (t) => {
  t.plan(1)

  const sent = [b4a.alloc(3 * 1024 * 1024, 1), b4a.alloc(1, 2), b4a.alloc(1024 * 1024, 3)]
  const received = []

  const url = await listen(
    t,
    new Server((session) => {
      session.on('data', (data) => {
        received.push(data)

        if (received.length === sent.length) {
          t.alike(received, sent)
          stream.destroy()
        }
      })
    })
  )

  const stream = new Stream(url, { fetch })

  for (const frame of sent) stream.write(frame)
})

test('a stream destroyed while it writes opens no other session', async (t) => {
  t.plan(2)

  let opened = 0

  const server = new Server((session) => {
    opened++

    session.once('data', () => stream.destroy())
  })

  const url = await listen(t, server)

  const stream = new Stream(url, { fetch })

  stream.on('close', () => {
    setTimeout(() => {
      t.is(opened, 1)
      t.is(server.sessions, 0)
    }, 100)
  })

  stream.write(b4a.alloc(1024 * 1024))
  stream.write(b4a.alloc(1024 * 1024))
})

test('a stream fails when the relay refuses a write', async (t) => {
  t.plan(2)

  const url = await listen(t, new Server(() => {}))

  const stream = new Stream(url, { fetch })

  stream.on('error', (err) => t.ok(err, 'failed')).on('close', () => t.pass('stream closed'))
  stream.write(b4a.alloc(4 * 1024 * 1024 + 1))
})

test('requests that do not belong to a session', async (t) => {
  const url = await listen(t, new Server(() => {}))
  const session = await open(url)

  t.is((await fetch(url)).status, 401, 'no session')
  t.is((await fetch(url, { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } })).status, 404)
  t.is((await fetch(url, { method: 'PUT', headers: { authorization: session } })).status, 405)

  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: session },
    body: b4a.from([2, 9])
  })

  t.is(res.status, 400, 'malformed frames')
  t.is(res.headers.get('cache-control'), 'no-store')

  t.is((await fetch(url, { method: 'DELETE', headers: { authorization: session } })).status, 200)
  t.is((await fetch(url, { headers: { authorization: session } })).status, 404, 'closed')
})

test('a poll is answered with no frames after a while', async (t) => {
  const url = await listen(t, new Server(() => {}, { pollTimeout: 100 }))
  const session = await open(url)

  const res = await fetch(url, { headers: { authorization: session } })

  t.is(res.status, 200)
  t.alike(b4a.from(await res.arrayBuffer()), b4a.from([0]))
})

test('a newer poll answers the older one', async (t) => {
  const url = await listen(t, new Server(() => {}))
  const session = await open(url)

  const older = fetch(url, { headers: { authorization: session } })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const newer = fetch(url, { headers: { authorization: session } })

  const res = await older

  t.is(res.status, 200)
  t.alike(b4a.from(await res.arrayBuffer()), b4a.from([0]))

  await fetch(url, { method: 'DELETE', headers: { authorization: session } })

  t.is((await newer).status, 410)
})

test('a session without requests is closed', async (t) => {
  t.plan(1)

  const url = await listen(
    t,
    new Server((session) => session.on('close', () => t.pass('closed')), { idleTimeout: 100 })
  )

  await open(url)
})

test('a session that is not polled is closed once too much waits for it', async (t) => {
  t.plan(1)

  const url = await listen(
    t,
    new Server((session) => {
      session.on('error', (err) => t.is(err.message, 'Too many bytes queued'))
      session.write(b4a.alloc(4 * 1024 * 1024))
      session.write(b4a.alloc(4 * 1024 * 1024))
      session.write(b4a.alloc(1))
    })
  )

  await open(url)
})

test('a request body is bounded', async (t) => {
  const url = await listen(
    t,
    new Server((session) => session.on('data', () => t.fail('frames were taken')))
  )
  const session = await open(url)

  const refused = await fetch(url, {
    method: 'POST',
    headers: { authorization: session },
    body: b4a.alloc(4 * 1024 * 1024 + 1)
  }).then(
    (res) => res.status === 413,
    () => true
  )

  t.ok(refused, 'refused with 413, or the connection closed')
})

test('an address opens a bounded number of sessions', async (t) => {
  const url = await listen(t, new Server(() => {}))

  for (let i = 0; i < 8; i++) await open(url)

  t.is((await fetch(url, { method: 'POST' })).status, 429)
})

test('behind a proxy, the address is the one the proxy added', async (t) => {
  const url = await listen(t, new Server(() => {}, { behindProxy: true }))

  for (let i = 0; i < 8; i++) await open(url, { 'x-forwarded-for': 'spoofed-' + i + ', 10.0.0.1' })

  t.is(
    (await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.1' } })).status,
    429,
    'the last address counts'
  )
  t.is(
    (await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.2' } })).status,
    200
  )
  t.is((await fetch(url, { method: 'POST' })).status, 200, 'no address')
})

test('destroying the server closes every session', async (t) => {
  const server = new Server(() => {})
  const url = await listen(t, server)

  const session = await open(url)
  const poll = fetch(url, { headers: { authorization: session } })

  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(server.sessions, 1)

  server.destroy()

  t.is((await poll).status, 410)
  t.is(server.sessions, 0)
})

test('a hypercore replicates through a relay over HTTP, which sees no keys and no data', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })

  const core = new Hypercore(await tmp(t))
  await core.append(b4a.from('a block that only the two peers can read'))
  t.teardown(() => core.close())

  const a = new Hyperswarm({ bootstrap: testnet.bootstrap })
  t.teardown(() => a.destroy())

  a.on('connection', (socket) => core.replicate(socket))
  await a.join(core.discoveryKey, { server: true, client: false }).flushed()

  const relayed = new DHT({ bootstrap: testnet.bootstrap })
  t.teardown(() => relayed.destroy())

  const url = await listen(t, new Server((session) => relay(relayed, session)))

  const seen = []

  const dht = new RelayedDHT(
    new Stream(url, {
      async fetch(url, opts) {
        if (opts.body) seen.push(b4a.from(opts.body))

        const res = await fetch(url, opts)
        const data = await res.arrayBuffer()

        seen.push(b4a.from(data.slice(0)))

        return { status: res.status, arrayBuffer: () => Promise.resolve(data) }
      }
    }),
    { custodial: false }
  )

  const b = new Hyperswarm({ dht })
  t.teardown(() => b.destroy())

  const clone = new Hypercore(await tmp(t), core.key)
  t.teardown(() => clone.close())

  b.on('connection', (socket) => clone.replicate(socket))
  b.join(core.discoveryKey, { server: false, client: true })

  t.alike(await clone.get(0), b4a.from('a block that only the two peers can read'))

  const crossed = b4a.concat(seen)

  t.ok(b4a.indexOf(crossed, b.keyPair.publicKey) !== -1, 'public keys crossed HTTP')
  t.is(b4a.indexOf(crossed, b.keyPair.secretKey), -1, 'the swarm secret key did not')
  t.is(b4a.indexOf(crossed, dht.defaultKeyPair.secretKey), -1, 'the DHT secret key did not')
  t.is(b4a.indexOf(crossed, b4a.from('only the two peers')), -1, 'the block did not')
})

async function listen(t, server) {
  const http1 = http.createServer((req, res) => server.handle(req, res))

  await new Promise((resolve) => http1.listen(0, '127.0.0.1', resolve))

  t.teardown(() => {
    server.destroy()
    return new Promise((resolve) => http1.close(resolve))
  })

  return 'http://127.0.0.1:' + http1.address().port
}

async function open(url, headers) {
  const res = await fetch(url, { method: 'POST', headers })

  return 'Bearer ' + b4a.toString(b4a.from(await res.arrayBuffer()), 'hex')
}

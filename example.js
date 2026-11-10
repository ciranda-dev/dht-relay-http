// Replicates a hypercore to a peer that only has URLSession, through a relay
// over HTTP, on a local testnet. Run with Bare on an Apple platform:
//
//   npm install --no-save bare-foundation
//   bare example.js

const http = require('http')
const b4a = require('b4a')
const tmp = require('test-tmp')
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const RelayedDHT = require('@hyperswarm/dht-relay')
const { relay } = RelayedDHT
const Hyperswarm = require('hyperswarm')
const Hypercore = require('hypercore')
const { URLSession, URLRequest } = require('bare-foundation')
const Stream = require('.')
const Server = require('./server')

const BLOCK = b4a.from('a block that only the two peers can read')

main()

async function main() {
  const started = Date.now()
  const testnet = await createTestnet(3)

  const core = new Hypercore(await tmp())
  await core.append(BLOCK)

  const a = new Hyperswarm({ bootstrap: testnet.bootstrap })
  a.on('connection', (socket) => core.replicate(socket))
  await a.join(core.discoveryKey, { server: true, client: false }).flushed()

  const relayed = new DHT({ bootstrap: testnet.bootstrap })
  const server = new Server((session) => relay(relayed, session))
  const http1 = http.createServer((req, res) => server.handle(req, res))
  await new Promise((resolve) => http1.listen(0, '127.0.0.1', resolve))

  const crossed = []
  let requests = 0

  const dht = new RelayedDHT(
    new Stream('http://127.0.0.1:' + http1.address().port, {
      async fetch(url, opts) {
        requests++

        if (opts.body) crossed.push(b4a.from(opts.body))

        const res = await fetch(url, opts)
        const data = await res.arrayBuffer()

        crossed.push(b4a.from(data.slice(0)))

        return { status: res.status, arrayBuffer: () => Promise.resolve(data) }
      }
    }),
    { custodial: false }
  )

  const b = new Hyperswarm({ dht })
  const clone = new Hypercore(await tmp(), core.key)

  b.on('connection', (socket) => clone.replicate(socket))
  b.join(core.discoveryKey, { server: false, client: true })

  const block = await clone.get(0)
  const all = b4a.concat(crossed)

  console.log('Read through the relay:', b4a.toString(block))
  console.log('Requests made with URLSession:', requests)
  console.log('Bytes that crossed HTTP:', all.byteLength)
  console.log('Public key crossed HTTP:', b4a.indexOf(all, b.keyPair.publicKey) !== -1)
  console.log(
    'Secret keys crossed HTTP:',
    b4a.indexOf(all, b.keyPair.secretKey) !== -1 ||
      b4a.indexOf(all, dht.defaultKeyPair.secretKey) !== -1
  )
  console.log('Block crossed HTTP in the clear:', b4a.indexOf(all, BLOCK) !== -1)
  console.log('Time:', Date.now() - started, 'ms')

  await b.destroy()
  await a.destroy()
  await clone.close()
  await core.close()
  server.destroy()
  http1.close()
  await relayed.destroy()
  await testnet.destroy()
}

function fetch(url, opts) {
  return new Promise((resolve, reject) => {
    const request = new URLRequest(url)

    request.httpMethod = opts.method

    for (const field in opts.headers) request.setValue(opts.headers[field], field)

    if (opts.body) request.httpBody = opts.body

    URLSession.shared
      .dataTask(request, (err, response, data) => {
        if (err) return reject(err)

        resolve({
          status: response.statusCode,
          arrayBuffer: () =>
            Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        })
      })
      .resume()
  })
}

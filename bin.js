#!/usr/bin/env node

const http = require('http')
const DHT = require('hyperdht')
const { relay } = require('@hyperswarm/dht-relay')
const goodbye = require('graceful-goodbye')
const Server = require('./server')

const port = Number(arg('port')) || 49443
const host = arg('host') || undefined
const behindProxy = process.argv.includes('--behind-proxy')

const dht = new DHT()

const server = new Server(
  (stream) => {
    console.log('Session opened (' + server.sessions + ')')

    stream.on('close', () => console.log('Session closed (' + server.sessions + ')'))

    relay(dht, stream)
  },
  { behindProxy }
)

const http1 = http.createServer((req, res) => server.handle(req, res))

http1.listen(port, host, () => {
  const { address, port } = http1.address()

  console.log('Relay is listening on ' + address + ':' + port)
})

goodbye(async () => {
  const closing = new Promise((resolve) => http1.close(resolve))

  server.destroy()

  await closing
  await dht.destroy()
})

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1 || i === process.argv.length - 1) return null
  return process.argv[i + 1]
}

# dht-relay-http

Relaying the Hyperswarm DHT over plain HTTP, for hosts that have nothing else.

A transport for [`@hyperswarm/dht-relay`](https://github.com/holepunchto/hyperswarm-dht-relay), next to its TCP and WebSocket ones. The relayed side sends frames with `POST` and receives them with a long-polling `GET`, through the HTTP client it is given, so it runs where an app gets no sockets at all, such as an Apple Watch, where only `URLSession` is allowed.

> [!NOTE]
> `@hyperswarm/dht-relay` was archived by Holepunch on 2026-10-15 and is marked experimental. This module works with its last release, 0.4.3, and will follow whatever replaces it.

```
npm i @ciranda/dht-relay-http
```

## Usage

On the relaying side:

```js
const http = require('http')
const DHT = require('hyperdht')
const { relay } = require('@hyperswarm/dht-relay')
const Server = require('@ciranda/dht-relay-http/server')

const dht = new DHT()
const server = new Server((stream) => relay(dht, stream))

http.createServer((req, res) => server.handle(req, res)).listen(8080)
```

On the relayed side:

```js
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@ciranda/dht-relay-http')

const dht = new DHT(new Stream('https://relay.example.com', { fetch }), { custodial: false })
```

Always pass `custodial: false`. The default of `@hyperswarm/dht-relay` sends the secret key of the client to the relay, which can then decrypt and sign everything as the client. With `custodial: false` the key stays on the client, Noise runs end to end, and the relay forwards ciphertext. It still sees the public keys, the topics and the address of the client.

The relayed side can connect to peers, not accept connections: `@hyperswarm/dht-relay` does not yet complete incoming connections without custody. Its 0.4.3 also passes the keep-alives of the remote peer to a client without custody as empty messages.

### With URLSession

On Apple platforms, `URLSession` is all the stream needs. Bare gets it from [`bare-foundation`](https://github.com/holepunchto/bare-foundation), where it is proposed and not released yet:

```js
const { URLSession, URLRequest } = require('bare-foundation')

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
```

`example.js` replicates a hypercore this way on a local testnet.

## API

#### `const stream = new Stream(url, options)`

The relayed side. `options.fetch(url, { method, headers, body })` makes the requests and resolves to `{ status, arrayBuffer() }`. The `fetch` of Node and `bare-fetch` both do.

#### `const server = new Server(onstream[, options])`

The relaying side. `onstream(stream)` is called with a stream for every session a client opens.

Options include:

```js
{
  behindProxy: false, // Count sessions by the address the proxy put last in X-Forwarded-For
  pollTimeout: 25000, // How long a poll is held, under the read timeout of any proxy in front
  idleTimeout: 60000 // How long a session lives without a request
}
```

#### `server.handle(req, res)`

Handle a request from `http` in Node or `bare-http1` in Bare.

#### `server.sessions`

The number of open sessions.

#### `server.destroy()`

Close every session.

### CLI

```sh
npm i -g @ciranda/dht-relay-http
dht-relay-http [--port 49443] [--host 0.0.0.0] [--behind-proxy]
```

The relay speaks plain HTTP. Terminate TLS at a reverse proxy in front of it, such as Caddy or nginx, and pass `--behind-proxy`. Without TLS, anyone on the path sees which keys and topics a client asks for, and an Apple Watch only allows HTTPS anyway. The CLI logs how many sessions are open, never an address or a session.

With Caddy, which gets the certificate and sets `X-Forwarded-For`, that is one line next to the relay:

```sh
dht-relay-http --host 127.0.0.1 --behind-proxy
caddy reverse-proxy --from relay.example.com --to 127.0.0.1:49443
```

## Protocol

Every request goes to the same URL. A session is named by 32 random bytes, sent as `Authorization: Bearer <hex>` and never in the URL, so it stays out of access logs.

- `POST` without a session opens one. The response body is its 32 bytes.
- `POST` with a session sends the frames in the body.
- `GET` returns the frames waiting for the client, or holds the request until some arrive, for up to `pollTimeout`.
- `DELETE` closes the session.

Bodies are `c.array(c.buffer)` from [`compact-encoding`](https://github.com/holepunchto/compact-encoding). Any status other than `200` ends the stream. Responses carry `Cache-Control: no-store`.

A session that falls 8 MiB behind is closed, a request body is at most 4 MiB, and an address has at most 8 sessions open.

## License

Apache-2.0

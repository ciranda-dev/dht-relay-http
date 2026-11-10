# Results

Measured on 2026-11-07. Everything below ran on one Mac (Apple silicon, arm64, macOS 26.7.1) with Node
v24.21.0, Bare v1.35.0, bare-make 2.1.0, cmake 4.4.4 and Xcode's WatchOS 26.2 SDK. Nothing here ran on a
watch or a simulator. Only a real Apple Watch proves how URLSession behaves there: the simulator allows
sockets, UDP and WebSocket, and a watch (TN3135) allows none of them.

## The relayed side over URLSession, under Bare

The relayed side of `@hyperswarm/dht-relay` (`custodial: false`) used `bare-foundation`'s `URLSession`
(branch `feat/url-session` of `../forks/bare-foundation`, built for darwin-arm64) as its only network, and
replicated a hypercore from a peer on a local `hyperdht/testnet` through `server.js` served by `bare-http1`.

```sh
cd ../forks/bare-foundation && bare-make generate --debug && bare-make build && bare-make install
cd ../../dht-relay-http && npm install && npm install --no-save ../forks/bare-foundation
bare example.js
```

Three runs, at commit `b497b5c`:

| run | block read through the relay | requests | bytes over HTTP | secret keys over HTTP | block in the clear over HTTP | time   |
| --- | ---------------------------- | -------- | --------------- | --------------------- | ---------------------------- | ------ |
| 1   | yes                          | 25       | 2073            | no                    | no                           | 133 ms |
| 2   | yes                          | 25       | 2073            | no                    | no                           | 131 ms |
| 3   | yes                          | 23       | 1925            | no                    | no                           | 634 ms |

"Over HTTP" is every request body and response body the URLSession fetch handled, copied as it crossed.
The public key of the relayed peer was found in those bytes in every run, so the search finds a key that
is there. The time is from the start of the script, testnet included.

Negative control, the same script with `{ custodial: true }` (a scratch copy, not committed): the secret
key and the block both crossed HTTP in the clear (20 requests, 1432 bytes, 126 ms). That is why the stream
must always be used with `custodial: false`.

The relay URL was `http://127.0.0.1`. A command line Bare is not subject to App Transport Security, a
watch app is, so a watch needs the relay behind HTTPS.

## Tests

`npm test` in this repo (brittle in Bare, then Node, with coverage):

| runtime | tests | asserts | statements | branches | functions | lines | time   |
| ------- | ----- | ------- | ---------- | -------- | --------- | ----- | ------ |
| Bare    | 18/18 | 42/42   | 100%       | 100%     | 100%      | 100%  | 2.0 s  |
| Node    | 18/18 | 42/42   | 100%       | 100%     | 100%      | 100%  | 10.7 s |

Coverage is of `index.js` and `server.js`. The end to end test replicates a hypercore through the relay
over HTTP on `hyperdht/testnet`, non-custodial, with Node's `fetch` in Node and `bare-fetch` in Bare, and
checks that the public key crossed HTTP and that neither secret key nor the block did. `bin.js` and
`example.js` are not covered by it.

One request is bounded in a way that depends on the runtime: a body over 4 MiB got `413` from Node's
`http` and a closed connection from `bare-http1`. Both refuse it, and the test accepts either.

`npm test` in `../forks/bare-foundation` on `feat/url-session` (Bare, darwin-arm64 debug build): 7/7 tests,
46/46 asserts. `url-request.js`, `url-session.js`, `url-session-data-task.js` and `http-url-response.js`
are at 100% statements, branches, functions and lines. The tests run data tasks against a local
`bare-http1` server: method, URL, header fields and body in, status, header fields and body out, a
cancelled task (code -999) and a refused connection (`NSURLErrorDomain`).

The binding also compiled and linked for ios-arm64, ios-arm64-simulator and darwin-x64 with bare-make
(not run), and `binding.m` compiled with `-fsyntax-only` against the WatchOS 26.2 SDK for
`arm64_32-apple-watchos9.0` and `arm64-apple-watchos9.0`, and against the tvOS SDK for
`arm64-apple-tvos16.0` (not linked, not run: there is no watchOS toolchain for bare-make yet).

`npm test` in `../forks/hyperswarm-dht-relay` on `feat/http-transport` (standard, then brittle in Node):
15/15 tests, 56/56 asserts, with the 3 upstream skips. Its new `test/http.mjs` runs the client mode test
over HTTP with `custodial` true and false, and replicates a hypercore over HTTP with `custodial: false`.

## The CLI

```sh
node bin.js --port 49555 --host 127.0.0.1
```

`POST /` answered with 32 bytes (64 hex characters). A `GET` with that session answered `200` with
`cache-control: no-store`, `DELETE` answered `200`, and the next `GET` `404`. After `SIGINT` the process
exited. The log was `Relay is listening on 127.0.0.1:49555`, `Session opened (1)`, `Session closed (0)`,
and did not contain the session.

## What does not work yet

The relayed side cannot accept connections. A relayed Hyperswarm that joined a topic as a server
announced through the relay in 127 ms, and a peer on the testnet that joined as a client had not
connected 20 s later. The same happened over `@hyperswarm/dht-relay`'s own TCP transport, so it is not
this transport. With `custodial: true` over TCP the relaying side threw
`TypeError: Cannot read properties of null (reading 'byteLength')` from compact-encoding. The upstream
tests skip both cases (`custodial: [true/*, false */]` in its server mode tests). Versions:
`@hyperswarm/dht-relay` 0.4.3, `hyperdht` 6.36.0, `hyperswarm` 4.17.2, in Node.

A relayed peer is a client only: it can reach peers that listen on the DHT directly.

A client without custody gets the keep-alives of the remote peer (empty encrypted messages, every 5 s from a
`hyperdht` peer) as empty `data` events, as its `SecretStream` is made without `keepAlive` or
`filterZeroByteMessages`. Measured with a test added to `../forks/hyperswarm-dht-relay` (branch `fix/keepalive`,
`client mode, keep-alive of the server`): it fails for `custodial: false` on 0.4.3 and passes with
`filterZeroByteMessages: true` on that stream, where the whole suite passes (14/14 tests, 49/49 asserts, Node).

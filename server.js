const { Duplex } = require('streamx')
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-universal')

const frames = c.array(c.buffer)

const MAX_BODY = 4 * 1024 * 1024 // Bytes in one request
const MAX_QUEUED = 8 * 1024 * 1024 // Bytes waiting for a session to poll
const MAX_SESSIONS = 8 // Sessions per address

const EMPTY = c.encode(frames, [])

module.exports = class HTTPServer {
  constructor(onstream, opts = {}) {
    const { behindProxy = false, pollTimeout = 25000, idleTimeout = 60000 } = opts

    this._onstream = onstream
    this._behindProxy = behindProxy
    this._pollTimeout = pollTimeout
    this._idleTimeout = idleTimeout
    this._sessions = new Map()
    this._addresses = new Map()
  }

  get sessions() {
    return this._sessions.size
  }

  handle(req, res) {
    res.setHeader('cache-control', 'no-store')

    const { authorization } = req.headers

    if (authorization === undefined) {
      if (req.method === 'POST') return this._open(req, res)
      return reply(res, 401)
    }

    const session = this._sessions.get(authorization.slice(7))

    if (session === undefined) return reply(res, 404)

    session._refresh()

    switch (req.method) {
      case 'GET':
        return session._poll(res)
      case 'POST':
        return session._receive(req, res)
      case 'DELETE':
        session.destroy()
        return reply(res, 200)
      default:
        return reply(res, 405)
    }
  }

  destroy() {
    for (const session of this._sessions.values()) session.destroy()
  }

  _open(req, res) {
    const address = this._address(req)
    const sessions = this._addresses.get(address) || 0

    if (sessions >= MAX_SESSIONS) return reply(res, 429)

    const id = b4a.allocUnsafe(32)
    sodium.randombytes_buf(id)

    const session = new HTTPSession(this, b4a.toString(id, 'hex'), address)

    this._sessions.set(session._id, session)
    this._addresses.set(address, sessions + 1)

    this._onstream(session)

    reply(res, 200, id)
  }

  _close(session) {
    this._sessions.delete(session._id)

    const sessions = this._addresses.get(session._address) - 1

    if (sessions === 0) this._addresses.delete(session._address)
    else this._addresses.set(session._address, sessions)
  }

  _address(req) {
    if (this._behindProxy) {
      const forwarded = req.headers['x-forwarded-for'] || ''

      return forwarded.split(',').pop().trim()
    }

    return req.socket.remoteAddress
  }
}

class HTTPSession extends Duplex {
  constructor(server, id, address) {
    super()

    this._server = server
    this._id = id
    this._address = address
    this._queue = []
    this._queued = 0
    this._polling = null
    this._pollTimer = null
    this._idleTimer = setTimeout(() => this.destroy(), server._idleTimeout)
  }

  _writev(batch, cb) {
    for (const frame of batch) {
      this._queue.push(frame)
      this._queued += frame.byteLength
    }

    if (this._queued > MAX_QUEUED) return cb(new Error('Too many bytes queued'))

    this._flush()

    cb(null)
  }

  _destroy(cb) {
    clearTimeout(this._idleTimer)
    clearTimeout(this._pollTimer)

    if (this._polling !== null) reply(this._polling, 410)

    this._server._close(this)

    cb(null)
  }

  _refresh() {
    clearTimeout(this._idleTimer)
    this._idleTimer = setTimeout(() => this.destroy(), this._server._idleTimeout)
  }

  _poll(res) {
    if (this._polling !== null) this._end(EMPTY)

    this._polling = res
    this._pollTimer = setTimeout(() => this._end(EMPTY), this._server._pollTimeout)

    this._flush()
  }

  _flush() {
    if (this._polling === null || this._queue.length === 0) return

    const data = c.encode(frames, this._queue)

    this._queue = []
    this._queued = 0

    this._end(data)
  }

  _end(data) {
    clearTimeout(this._pollTimer)

    const res = this._polling
    this._polling = null

    reply(res, 200, data)
  }

  _receive(req, res) {
    const chunks = []
    let size = 0

    req
      .on('data', (data) => {
        size += data.byteLength

        if (size <= MAX_BODY) return chunks.push(data)

        reply(res, 413)
        req.destroy()
      })
      .on('end', () => {
        let list

        try {
          list = c.decode(frames, b4a.concat(chunks))
        } catch {
          return reply(res, 400)
        }

        for (const frame of list) this.push(frame)

        reply(res, 200)
      })
  }
}

function reply(res, status, data) {
  res.statusCode = status
  res.end(data)
}

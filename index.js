const { Duplex } = require('streamx')
const b4a = require('b4a')
const c = require('compact-encoding')

const frames = c.array(c.buffer)

const MAX_BATCH = 1024 * 1024 // Bytes of frames in one request

module.exports = class HTTPStream extends Duplex {
  constructor(url, opts = {}) {
    const { fetch } = opts

    super()

    this._url = url
    this._fetch = fetch
    this._session = null
    this._closing = false
  }

  async _open(cb) {
    try {
      this._session = b4a.toString(await this._request('POST'), 'hex')
    } catch (err) {
      return cb(err)
    }

    cb(null)
  }

  async _read(cb) {
    try {
      for (const frame of c.decode(frames, await this._request('GET'))) this.push(frame)
    } catch (err) {
      return cb(err)
    }

    cb(null)
  }

  async _writev(batch, cb) {
    try {
      for (let i = 0, j = 0; i < batch.length; i = j) {
        let size = 0

        while (j < batch.length && (j === i || size + batch[j].byteLength <= MAX_BATCH)) {
          size += batch[j++].byteLength
        }

        await this._request('POST', c.encode(frames, batch.slice(i, j)))
      }
    } catch (err) {
      return cb(err)
    }

    cb(null)
  }

  _predestroy() {
    this._close()
  }

  _destroy(cb) {
    this._close()
    cb(null)
  }

  _close() {
    if (this._session === null || this._closing) return

    this._closing = true
    this._request('DELETE').catch(noop)
  }

  async _request(method, body) {
    const headers = {}

    if (this._session !== null) headers.authorization = 'Bearer ' + this._session
    if (body) headers['content-type'] = 'application/octet-stream'

    const res = await this._fetch(this._url, { method, headers, body })
    const data = b4a.from(await res.arrayBuffer())

    if (res.status !== 200) throw new Error('Relay responded with status ' + res.status)

    return data
  }
}

function noop() {}

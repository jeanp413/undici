'use strict'

const {
  InvalidArgumentError,
  NotSupportedError
} = require('./errors')
const assert = require('node:assert')
const util = require('./util')
const { channels } = require('./diagnostics.js')
const { headerNameLowerCasedRecord } = require('./constants')

// headerCharRegex have been lifted from
// https://github.com/nodejs/node/blob/main/lib/_http_common.js

/**
 * Matches if val contains an invalid field-vchar
 *  field-value    = *( field-content / obs-fold )
 *  field-content  = field-vchar [ 1*( SP / HTAB ) field-vchar ]
 *  field-vchar    = VCHAR / obs-text
 */
const headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/

// Verifies that a given path is valid does not contain control chars \x00 to \x20
const invalidPathRegex = /[^\u0021-\u00ff]/

const kHandler = Symbol('handler')

class Request {
  constructor (origin, {
    path,
    method,
    body,
    headers,
    query,
    idempotent,
    blocking,
    upgrade,
    headersTimeout,
    bodyTimeout,
    reset,
    throwOnError,
    expectContinue
  }, handler) {
    if (typeof path !== 'string') {
      throw new InvalidArgumentError('path must be a string')
    } else if (
      path[0] !== '/' &&
      !(path.startsWith('http://') || path.startsWith('https://')) &&
      method !== 'CONNECT'
    ) {
      throw new InvalidArgumentError('path must be an absolute URL or start with a slash')
    } else if (invalidPathRegex.exec(path) !== null) {
      throw new InvalidArgumentError('invalid request path')
    }

    if (typeof method !== 'string') {
      throw new InvalidArgumentError('method must be a string')
    } else if (!util.isValidHTTPToken(method)) {
      throw new InvalidArgumentError('invalid request method')
    }

    if (upgrade && typeof upgrade !== 'string') {
      throw new InvalidArgumentError('upgrade must be a string')
    }

    if (headersTimeout != null && (!Number.isFinite(headersTimeout) || headersTimeout < 0)) {
      throw new InvalidArgumentError('invalid headersTimeout')
    }

    if (bodyTimeout != null && (!Number.isFinite(bodyTimeout) || bodyTimeout < 0)) {
      throw new InvalidArgumentError('invalid bodyTimeout')
    }

    if (reset != null && typeof reset !== 'boolean') {
      throw new InvalidArgumentError('invalid reset')
    }

    if (expectContinue != null && typeof expectContinue !== 'boolean') {
      throw new InvalidArgumentError('invalid expectContinue')
    }

    this.headersTimeout = headersTimeout

    this.bodyTimeout = bodyTimeout

    this.throwOnError = throwOnError === true

    this.method = method

    this.abort = null

    if (body == null) {
      this.body = null
    } else if (util.isStream(body)) {
      this.body = body

      const rState = this.body._readableState
      if (!rState || !rState.autoDestroy) {
        this.endHandler = function autoDestroy () {
          util.destroy(this)
        }
        this.body.on('end', this.endHandler)
      }

      this.errorHandler = err => {
        if (this.abort) {
          this.abort(err)
        } else {
          this.error = err
        }
      }
      this.body.on('error', this.errorHandler)
    } else if (util.isBuffer(body)) {
      this.body = body.byteLength ? body : null
    } else if (ArrayBuffer.isView(body)) {
      this.body = body.buffer.byteLength ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null
    } else if (body instanceof ArrayBuffer) {
      this.body = body.byteLength ? Buffer.from(body) : null
    } else if (typeof body === 'string') {
      this.body = body.length ? Buffer.from(body) : null
    } else if (util.isFormDataLike(body) || util.isIterable(body) || util.isBlobLike(body)) {
      this.body = body
    } else {
      throw new InvalidArgumentError('body must be a string, a Buffer, a Readable stream, an iterable, or an async iterable')
    }

    this.completed = false

    this.aborted = false

    this.upgrade = upgrade || null

    this.path = query ? util.buildURL(path, query) : path

    this.origin = origin

    this.idempotent = idempotent == null
      ? method === 'HEAD' || method === 'GET'
      : idempotent

    this.blocking = blocking == null ? false : blocking

    this.reset = reset == null ? null : reset

    this.host = null

    this.contentLength = null

    this.contentType = null

    this.headers = []

    // Only for H2
    this.expectContinue = expectContinue != null ? expectContinue : false

    if (Array.isArray(headers)) {
      if (headers.length % 2 !== 0) {
        throw new InvalidArgumentError('headers array must be even')
      }
      for (let i = 0; i < headers.length; i += 2) {
        processHeader(this, headers[i], headers[i + 1])
      }
    } else if (headers && typeof headers === 'object') {
      if (headers[Symbol.iterator]) {
        for (const header of headers) {
          if (!Array.isArray(header) || header.length !== 2) {
            throw new InvalidArgumentError('headers must be in key-value pair format')
          }
          const [key, value] = header
          processHeader(this, key, value)
        }
      } else {
        const keys = Object.keys(headers)
        for (const key of keys) {
          processHeader(this, key, headers[key])
        }
      }
    } else if (headers != null) {
      throw new InvalidArgumentError('headers must be an object or an array')
    }

    util.validateHandler(handler, method, upgrade)

    this.servername = util.getServerName(this.host)

    this[kHandler] = handler

    if (channels.create.hasSubscribers) {
      channels.create.publish({ request: this })
    }
  }

  onBodySent (chunk) {
    if (this[kHandler].onBodySent) {
      try {
        return this[kHandler].onBodySent(chunk)
      } catch (err) {
        this.abort(err)
      }
    }
  }

  onRequestSent () {
    if (channels.bodySent.hasSubscribers) {
      channels.bodySent.publish({ request: this })
    }

    if (this[kHandler].onRequestSent) {
      try {
        return this[kHandler].onRequestSent()
      } catch (err) {
        this.abort(err)
      }
    }
  }

  onConnect (abort) {
    assert(!this.aborted)
    assert(!this.completed)

    if (this.error) {
      abort(this.error)
    } else {
      this.abort = abort
      return this[kHandler].onConnect(abort)
    }
  }

  onResponseStarted () {
    return this[kHandler].onResponseStarted?.()
  }

  onHeaders (statusCode, headers, resume, statusText) {
    assert(!this.aborted)
    assert(!this.completed)

    if (channels.headers.hasSubscribers) {
      channels.headers.publish({ request: this, response: { statusCode, headers, statusText } })
    }

    try {
      return this[kHandler].onHeaders(statusCode, headers, resume, statusText)
    } catch (err) {
      this.abort(err)
    }
  }

  onData (chunk) {
    assert(!this.aborted)
    assert(!this.completed)

    try {
      return this[kHandler].onData(chunk)
    } catch (err) {
      this.abort(err)
      return false
    }
  }

  onUpgrade (statusCode, headers, socket) {
    assert(!this.aborted)
    assert(!this.completed)

    return this[kHandler].onUpgrade(statusCode, headers, socket)
  }

  onComplete (trailers) {
    this.onFinally()

    assert(!this.aborted)

    this.completed = true
    if (channels.trailers.hasSubscribers) {
      channels.trailers.publish({ request: this, trailers })
    }

    try {
      return this[kHandler].onComplete(trailers)
    } catch (err) {
      // TODO (fix): This might be a bad idea?
      this.onError(err)
    }
  }

  onError (error) {
    this.onFinally()

    if (channels.error.hasSubscribers) {
      channels.error.publish({ request: this, error })
    }

    if (this.aborted) {
      return
    }
    this.aborted = true

    return this[kHandler].onError(error)
  }

  onFinally () {
    if (this.errorHandler) {
      this.body.off('error', this.errorHandler)
      this.errorHandler = null
    }

    if (this.endHandler) {
      this.body.off('end', this.endHandler)
      this.endHandler = null
    }
  }

  addHeader (key, value) {
    processHeader(this, key, value)
    return this
  }
}

function processHeader (request, key, val, skipAppend = false) {
  if (val && (typeof val === 'object' && !Array.isArray(val))) {
    throw new InvalidArgumentError(`invalid ${key} header`)
  } else if (val === undefined) {
    return
  }

  let headerName = headerNameLowerCasedRecord[key]

  if (headerName === undefined) {
    headerName = key.toLowerCase()
    if (headerNameLowerCasedRecord[headerName] === undefined && !util.isValidHTTPToken(headerName)) {
      throw new InvalidArgumentError('invalid header key')
    }
  }

  if (Array.isArray(val)) {
    const arr = []
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] === 'string') {
        if (headerCharRegex.exec(val[i]) !== null) {
          throw new InvalidArgumentError(`invalid ${key} header`)
        }
        arr.push(val[i])
      } else if (val[i] === null) {
        arr.push('')
      } else if (typeof val[i] === 'object') {
        throw new InvalidArgumentError(`invalid ${key} header`)
      } else {
        arr.push(`${val[i]}`)
      }
    }
    val = arr
  } else if (typeof val === 'string') {
    if (headerCharRegex.exec(val) !== null) {
      throw new InvalidArgumentError(`invalid ${key} header`)
    }
  } else if (val === null) {
    val = ''
  } else if (typeof val === 'object') {
    throw new InvalidArgumentError(`invalid ${key} header`)
  } else {
    val = `${val}`
  }

  if (request.host === null && headerName === 'host') {
    if (typeof val !== 'string') {
      throw new InvalidArgumentError('invalid host header')
    }
    // Consumed by Client
    request.host = val
  } else if (request.contentLength === null && headerName === 'content-length') {
    request.contentLength = parseInt(val, 10)
    if (!Number.isFinite(request.contentLength)) {
      throw new InvalidArgumentError('invalid content-length header')
    }
  } else if (request.contentType === null && headerName === 'content-type') {
    request.contentType = val
    request.headers.push(key, val)
  } else if (headerName === 'transfer-encoding' || headerName === 'keep-alive' || headerName === 'upgrade') {
    throw new InvalidArgumentError(`invalid ${headerName} header`)
  } else if (headerName === 'connection') {
    const value = typeof val === 'string' ? val.toLowerCase() : null
    if (value !== 'close' && value !== 'keep-alive') {
      throw new InvalidArgumentError('invalid connection header')
    }

    if (value === 'close') {
      request.reset = true
    }
  } else if (headerName === 'expect') {
    throw new NotSupportedError('expect header not supported')
  } else {
    request.headers.push(key, val)
  }
}

module.exports = Request

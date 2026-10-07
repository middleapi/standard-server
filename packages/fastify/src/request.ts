import { Readable } from 'node:stream'

import type { StandardLazyRequest } from '@standard-server/core'
import type { NodeHttpRequest } from '@standard-server/node'
import {
  readableChunkToBytes,
  toAbortSignal,
  toStandardBody,
  toStandardMethod,
  toStandardUrl,
} from '@standard-server/node'
import { errorCodes } from 'fastify'

import type { AnyFastifyReply, AnyFastifyRequest } from './types'

const PAYLOADS = new WeakMap<AnyFastifyRequest, Readable>()

/**
 * A fastify content type parser that leaves the body unparsed, so `toStandardLazyRequest`
 * resolves it from the payload fastify hands to parsers: the request stream after any
 * `preParsing` hook (e.g. decompression) transformed it.
 */
export function standardContentTypeParser(
  req: AnyFastifyRequest,
  payload: Readable,
  done: (error: Error | null, body?: undefined) => void,
): void {
  PAYLOADS.set(req, payload)
  done(null, undefined)
}

export function toStandardLazyRequest(
  req: AnyFastifyRequest,
  reply: AnyFastifyReply,
): StandardLazyRequest {
  // DON'T lazy load signal, because we need register event listener as soon as possible
  // to make the signal abort in time
  const signal = toAbortSignal(reply.raw)

  return {
    url: toStandardUrl({ url: req.url }),
    method: toStandardMethod(req.raw.method),
    headers: req.headers,
    resolveBody: async (hint) => {
      // prefer the body fastify already parsed with its own content type parsers
      if (req.body !== undefined) {
        return req.body
      }

      return toStandardBody(toLimitedBody(req, reply), { hint })
    },
    signal,
  }
}

/**
 * The unparsed body, failing once it exceeds the route's `bodyLimit`: fastify only enforces
 * it on the bodies its own parsers read. Streaming bodies stay streaming, each chunk is
 * counted as it is read.
 */
function toLimitedBody(req: AnyFastifyRequest, reply: AnyFastifyReply): NodeHttpRequest {
  const payload = PAYLOADS.get(req) ?? req.raw
  const bodyLimit = req.routeOptions.bodyLimit
  const declaredTooLarge = Number(req.headers['content-length']) > bodyLimit
  const iterator = payload[Symbol.asyncIterator]()
  let size = 0
  let ended = false

  const tooLarge = () => {
    // like fastify, close the connection, the client may still be sending the rest of the body
    // (http2 has no connection header, it drops the value with a warning)
    if (!('stream' in reply.raw) && !reply.raw.headersSent) {
      reply.header('connection', 'close')
    }

    return new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE()
  }

  const chunks: AsyncIterableIterator<Uint8Array<ArrayBuffer>> = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      // like fastify, a body declared too large fails before any of it is read
      if (declaredTooLarge) {
        throw tooLarge()
      }

      const result = await iterator.next()

      if (result.done) {
        ended = true
        return result
      }

      const chunk = readableChunkToBytes(payload, result.value)
      size += chunk.byteLength

      if (size > bodyLimit) {
        throw tooLarge()
      }

      return { done: false, value: chunk }
    },
    async return() {
      if (!ended) {
        // Read the rest and discard it rather than destroying the payload, the way
        // `toWebReadableStream` treats server requests: destroying an http1 request kills
        // the socket its response shares, and an unread http2 body stalls the response.
        // Errors mean the request is already torn down (e.g. the client aborted).
        void _drainIterator(iterator).catch(() => {})
      }

      return { done: true, value: undefined }
    },
  }

  const body = Readable.from(chunks, { objectMode: false })

  // a consumed payload stays consumed, so `toStandardBody` refuses to read it again
  if (!payload.readable) {
    ended = true
    body.destroy()
  }

  // `toStandardBody` takes the content headers from the stream it reads
  return Object.assign(body, { headers: req.headers }) as NodeHttpRequest
}

async function _drainIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  while (!(await iterator.next()).done) {
    // discard
  }
}

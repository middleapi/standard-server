import { Buffer } from 'node:buffer'
import { IncomingMessage } from 'node:http'
import { Http2ServerRequest } from 'node:http2'
import type { Readable } from 'node:stream'
import type Stream from 'node:stream'

import type { NodeHttpResponse } from './types'

/**
 * A cancel-safe alternative to `Readable.toWeb`.
 *
 * Node's adapter enqueues from `'data'` events, so a chunk arriving after the
 * consumer cancels hits a closed controller and crashes the process with an
 * uncaught `ERR_INVALID_STATE` (nodejs/node#54205) — on some Node releases even
 * through an intermediate `TransformStream`. Pulling through the stream's async
 * iterator makes that impossible: chunks are only enqueued inside `pull`, never
 * after cancel. The per-chunk copy detaches chunks from Node's pooled `Buffer`
 * memory.
 *
 * Fixed upstream in Node 26.10 (nodejs/node#62773); switch back to
 * `Readable.toWeb` once every supported Node release has the fix.
 *
 * Cancel destroys the source, except server requests, which are read to the
 * end and discarded, the way Node drains a body the handler never reads:
 * destroying an http1 request kills the socket its response shares, and an
 * unread body stalls on backpressure, blocking the next keep-alive request
 * (http1) or the response's `close` (http2).
 */
export function toWebReadableStream(stream: Readable): ReadableStream<Uint8Array<ArrayBuffer>> {
  const iterator = stream[Symbol.asyncIterator]()
  stream.on('error', () => {})
  let canceled = false

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()

      if (canceled) {
        return // a read in flight while cancel happened; drop it
      }

      if (done) {
        controller.close()
      } else {
        controller.enqueue(new Uint8Array(readableChunkToBytes(stream, value)))
      }
    },
    cancel(reason) {
      canceled = true

      const isServerRequest =
        (stream instanceof IncomingMessage && stream.method !== null) ||
        stream instanceof Http2ServerRequest

      if (isServerRequest) {
        // Errors mean the request is already torn down (e.g. the client aborted)
        void _drainIterator(iterator).catch(() => {})
      } else {
        stream.destroy(reason instanceof Error ? reason : undefined)
      }
    },
  })
}

export function readableChunkToBytes(
  stream: Readable,
  chunk: Uint8Array<ArrayBuffer> | string,
): Uint8Array<ArrayBuffer> {
  return typeof chunk === 'string' ? Buffer.from(chunk, stream.readableEncoding ?? 'utf8') : chunk
}

async function _drainIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  while (!(await iterator.next()).done) {
    // discard
  }
}

/**
 * Check the response can still be sent.
 */
export function canWriteToNodeResponse(res: Stream.Writable | NodeHttpResponse): boolean {
  return (
    !('headersSent' in res && res.headersSent) && !res.writableEnded && !isNodeResponseClosed(res)
  )
}

/**
 * Call `listener` once the response closes, right away if it already has.
 *
 * Node's http1 server only gives the socket to the first of pipelined requests.
 * When the connection drops, the responses queued behind it never emit `close`
 * ("Abort socket._httpMessage ?" in `abortIncoming` of Node's
 * `lib/_http_server.js`); only their requests are destroyed, with an
 * `ECONNRESET` error, so that error counts as the response closing too. A plain
 * request `close` doesn't: it fires before the response ends in every normal
 * request.
 */
export function onNodeResponseClose(
  res: Stream.Writable | NodeHttpResponse,
  listener: () => void,
): void {
  if (isNodeResponseClosed(res)) {
    listener()
    return
  }

  let closed = false
  const onClose = () => {
    if (!closed) {
      closed = true
      listener()
    }
  }

  ;('stream' in res ? res.stream : res).once('close', onClose)

  const req = getHttp1Request(res)
  // a request that already closed without an error never emits `close` again
  if (req && !req.closed) {
    req.once('close', () => {
      if (req.errored) {
        onClose()
      }
    })
  }
}

function isNodeResponseClosed(res: Stream.Writable | NodeHttpResponse): boolean {
  return ('stream' in res ? res.stream : res).destroyed || !!getHttp1Request(res)?.errored
}

function getHttp1Request(res: Stream.Writable | NodeHttpResponse): IncomingMessage | undefined {
  return 'stream' in res || !('req' in res) ? undefined : res.req
}

/**
 * Get the error of the response, preferring its underlying stream's (http2).
 */
export function getNodeResponseError(res: Stream.Writable | NodeHttpResponse): Error | null {
  if ('stream' in res) {
    return res.stream.errored ?? res.errored ?? null
  }

  return res.errored
}

/**
 * Destroy a body that won't be sent. `onError` is attached first, so an `error`
 * event from `destroy` is never unhandled.
 */
export function destroyNodeHttpBody(
  body: Readable | string | undefined,
  error: unknown,
  onError: (error: Error) => void,
): void {
  if (typeof body === 'object' && !body.closed) {
    body.on('error', onError)
    body.destroy((error ?? undefined) as Error | undefined)
  }
}

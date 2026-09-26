import type { Readable } from 'node:stream'
import type Stream from 'node:stream'
import type { NodeHttpResponse } from './types'
import { IncomingMessage } from 'node:http'
import { Http2ServerRequest } from 'node:http2'

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
  let canceled = false

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()

      if (canceled) {
        return // a read in flight while cancel happened; drop it
      }

      if (done) {
        controller.close()
      }
      else {
        controller.enqueue(new Uint8Array(value))
      }
    },
    cancel(reason) {
      canceled = true

      const isServerRequest = (stream instanceof IncomingMessage && stream.method !== null)
        || stream instanceof Http2ServerRequest

      if (isServerRequest) {
        // Errors mean the request is already torn down (e.g. the client aborted)
        void _drainIterator(iterator).catch(() => {})
      }
      else {
        stream.destroy(reason instanceof Error ? reason : undefined)
      }
    },
  })
}

async function _drainIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  while (!(await iterator.next()).done) {
    // discard
  }
}

/**
 * Check both the response itself and its underlying stream (http2) are still writable.
 */
export function canWriteToNodeResponse(res: Stream.Writable | NodeHttpResponse): boolean {
  if ('headersSent' in res && res.headersSent) {
    return false
  }

  if ('stream' in res && !_canWriteToStream(res.stream)) {
    return false
  }

  return _canWriteToStream(res)
}

function _canWriteToStream(stream: Stream.Writable): boolean {
  return !stream.closed && !stream.destroyed && !stream.writableFinished && !stream.writableEnded
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

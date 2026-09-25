import type { Readable } from 'node:stream'
import type Stream from 'node:stream'
import type { NodeHttpResponse } from './types'
import { IncomingMessage } from 'node:http'

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
 * Cancel destroys the source, except http1 server requests: they share their
 * socket with the response, so destroying them would kill an in-flight
 * response. They are abandoned instead — stalled by backpressure and reclaimed
 * on connection teardown.
 */
export function toWebReadableStream(stream: Readable): ReadableStream<Uint8Array<ArrayBuffer>> {
  const iterator = stream[Symbol.asyncIterator]()
  let canceled = false

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()

      if (canceled) {
        return // a chunk in flight while cancel happened; drop it
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

      const isHttp1ServerRequest = stream instanceof IncomingMessage && stream.method !== null

      if (!isHttp1ServerRequest) {
        stream.destroy(reason instanceof Error ? reason : undefined)
      }
    },
  })
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

import type Stream from 'node:stream'
import type { NodeHttpResponse } from './types'
import { AbortError } from '@standard-server/shared'
import { getNodeResponseError } from './utils'

/**
 * Abort when the response closes before it ends.
 */
export function toAbortSignal(res: Stream.Writable | NodeHttpResponse): AbortSignal {
  const controller = new AbortController()

  // On http2 the connection closes on the underlying stream: Node skips the response's own
  // `close` when a HEAD stream closes before `res.end()`
  const stream = 'stream' in res ? res.stream : res

  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort(getNodeResponseError(res) ?? new AbortError('Writable stream closed before it finished writing'))
    }
  }

  if (stream.destroyed) {
    onClose()
  }
  else {
    // also keeps an 'error' nobody else listens to from crashing the process
    res.once('error', error => controller.abort(error))
    stream.once('close', onClose)
  }

  return controller.signal
}

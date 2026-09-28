import type Stream from 'node:stream'
import type { NodeHttpResponse } from './types'
import { AbortError } from '@standard-server/shared'
import { canWriteToNodeResponse, getNodeResponseError } from './utils'

export function toAbortSignal(stream: Stream.Writable | NodeHttpResponse): AbortSignal {
  const controller = new AbortController()

  const error = getNodeResponseError(stream)

  if (error) {
    controller.abort(error)
  }
  else if (!canWriteToNodeResponse(stream)) {
    if (!stream.writableFinished || !stream.writableEnded) {
      controller.abort(new AbortError('Writable stream closed before it finished writing'))
    }
  }
  else {
    stream.once('error', error => controller.abort(error))

    // Node skips the http2 response's `close` when a HEAD stream closes before `res.end()`,
    // so listen to the underlying stream instead
    const closable = 'stream' in stream ? stream.stream : stream

    closable.once('close', () => {
      if (!stream.writableFinished || !stream.writableEnded) {
        controller.abort(new AbortError('Writable stream closed before it finished writing'))
      }
    })
  }

  return controller.signal
}

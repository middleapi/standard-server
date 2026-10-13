import type Stream from 'node:stream'

import { AbortError } from '@standard-server/shared'

import type { NodeHttpResponse } from './types'
import { getNodeResponseError, onNodeResponseClose } from './utils'

export function toAbortSignal(res: Stream.Writable | NodeHttpResponse): AbortSignal {
  const controller = new AbortController()

  const stream = 'stream' in res ? res.stream : res

  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort(
        getNodeResponseError(res) ??
          new AbortError('Writable stream closed before it finished writing'),
      )
    }
  }

  stream.once('error', (error) => controller.abort(error))
  onNodeResponseClose(res, onClose)

  return controller.signal
}

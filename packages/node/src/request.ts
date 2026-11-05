import type { StandardLazyRequest } from '@standard-server/core'

import { toStandardBody } from './body.ts'
import { toStandardMethod } from './method.ts'
import { toAbortSignal } from './signal.ts'
import type { NodeHttpRequest, NodeHttpResponse } from './types.ts'
import { toStandardUrl } from './url.ts'

export function toStandardLazyRequest(
  req: NodeHttpRequest,
  res: NodeHttpResponse,
): StandardLazyRequest {
  // DON'T lazy load signal, because we need register event listener as soon as possible
  // to make the signal abort in time
  const signal = toAbortSignal(res)

  return {
    url: toStandardUrl(req),
    method: toStandardMethod(req.method),
    headers: req.headers,
    resolveBody: (hint) => toStandardBody(req, { hint }),
    signal,
  }
}

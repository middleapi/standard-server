import type { StandardLazyRequest } from '@standard-server/core'
import type { ToStandardBodyOptions } from './body'
import type { NodeHttpRequest, NodeHttpResponse } from './types'
import { toStandardBody } from './body'
import { toStandardMethod } from './method'
import { toAbortSignal } from './signal'
import { toStandardUrl } from './url'

export interface ToStandardLazyRequestOptions extends Omit<ToStandardBodyOptions, 'hint'> {
}

export function toStandardLazyRequest(
  req: NodeHttpRequest,
  res: NodeHttpResponse,
  options: ToStandardLazyRequestOptions = {},
): StandardLazyRequest {
  // DON'T lazy load signal, because we need register event listener as soon as possible
  // to make the signal abort in time
  const signal = toAbortSignal(res)

  return {
    url: toStandardUrl(req),
    method: toStandardMethod(req.method),
    headers: req.headers,
    resolveBody: hint => toStandardBody(req, { ...options, hint }),
    signal,
  }
}

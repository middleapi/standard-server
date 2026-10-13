import type { StandardLazyRequest } from '@standard-server/core'
import {
  toAbortSignal,
  toStandardBody,
  toStandardMethod,
  toStandardUrl,
} from '@standard-server/node'

import type { AnyFastifyReply, AnyFastifyRequest } from './types'

export interface ToStandardLazyRequestOptions {
  /**
   * The maximum number of bytes read into memory for a body Fastify left unparsed, applied
   * like the `maxBodySize` option of `toStandardBody` from `@standard-server/node`.
   * Pass `Infinity` to lift the limit.
   *
   * @default the route's `bodyLimit`
   */
  maxBodySize?: number | undefined
}

export function toStandardLazyRequest(
  req: AnyFastifyRequest,
  reply: AnyFastifyReply,
  options: ToStandardLazyRequestOptions = {},
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

      // fastify only enforces `bodyLimit` in the parsers it reads the body with,
      // which skip this body (a catch-all stream parser, or a bodyless method like GET)
      return toStandardBody(req.raw, {
        hint,
        maxBodySize: options.maxBodySize ?? req.routeOptions.bodyLimit,
      })
    },
    signal,
  }
}

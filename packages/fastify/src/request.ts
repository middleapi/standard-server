import type { StandardLazyRequest } from '@standard-server/core'
import type { AnyFastifyReply, AnyFastifyRequest } from './types'
import { toAbortSignal, toStandardBody, toStandardMethod, toStandardUrl } from '@standard-server/node'

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

      return toStandardBody(req.raw, { hint })
    },
    signal,
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'

export type NodeHttpRequest = (IncomingMessage | Http2ServerRequest) & {
  /**
   * Prefer `originalUrl` over `url` if it is available.
   */
  originalUrl?: string

  /**
   * Body might already parsed by upstream framework like express.js, ...
   * Only used once the request stream has been consumed.
   */
  body?: unknown

  /**
   * Unparsed body kept by platforms that consume the request stream before the handler runs,
   * like Firebase and Google Cloud Functions. Preferred over `body` once the stream has been consumed.
   */
  rawBody?: unknown
}

export type NodeHttpResponse = ServerResponse | Http2ServerResponse

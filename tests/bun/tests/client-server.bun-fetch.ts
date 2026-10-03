import {
  toFetchBody,
  toFetchHeaders,
  toFetchResponse,
  toStandardLazyRequest,
  toStandardLazyResponse,
} from '@standard-server/fetch'

import type { ClientServerHandler, ClientServerTest } from './client-server'
import { NOT_FOUND_HANDLER } from './client-server'

export function createBunFetchClientServerTest(): ClientServerTest {
  let handler: ClientServerHandler = NOT_FOUND_HANDLER

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const standardRequest = toStandardLazyRequest(request)
      const standardResponse = await handler(standardRequest)

      return toFetchResponse(standardResponse)
    },
  })

  const request: ClientServerTest['request'] = async (standardRequest) => {
    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    /**
     * Disable keep-alive: Bun's fetch can reuse a connection whose previous
     * request ended with a broken stream, delivering stale bytes as the next
     * response.
     */
    standardHeaders.connection = 'close'

    const init: RequestInit & { duplex?: 'half' } = {
      method: standardRequest.method,
      signal: standardRequest.signal ?? null,
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null, // null = empty body
      duplex: 'half',
    }

    const response = await fetch(`${server.url.origin}${standardRequest.url}`, init)

    return toStandardLazyResponse(response)
  }

  return {
    setHandler: (next) => {
      handler = next
    },
    request,
    close: () => {
      server.stop(true)
    },
  }
}

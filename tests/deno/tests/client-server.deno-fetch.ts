import {
  toFetchBody,
  toFetchHeaders,
  toFetchResponse,
  toStandardLazyRequest,
  toStandardLazyResponse,
} from '@standard-server/fetch'

import type { ClientServerHandler, ClientServerTest } from './client-server'
import { NOT_FOUND_HANDLER } from './client-server'

export function createDenoFetchClientServerTest(): ClientServerTest {
  let handler: ClientServerHandler = NOT_FOUND_HANDLER

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (request) => {
    const standardRequest = toStandardLazyRequest(request)
    const standardResponse = await handler(standardRequest)

    return toFetchResponse(standardResponse)
  })

  const request: ClientServerTest['request'] = async (standardRequest) => {
    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    const init: RequestInit & { duplex?: 'half' } = {
      method: standardRequest.method,
      signal: standardRequest.signal ?? null,
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null, // null = empty body
      duplex: 'half',
    }

    const response = await fetch(`http://localhost:${server.addr.port}${standardRequest.url}`, init)

    return toStandardLazyResponse(response)
  }

  return {
    setHandler: (next) => {
      handler = next
    },
    request,
    close: () => {
      // don't await: a graceful shutdown can hang on connections stuck by aborted tests
      server.unref()
      void server.shutdown()
    },
  }
}

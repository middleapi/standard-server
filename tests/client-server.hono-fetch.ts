import type { AddressInfo } from 'node:net'

import { serve } from '@hono/node-server'
import {
  toFetchBody,
  toFetchHeaders,
  toFetchResponse,
  toStandardLazyRequest,
  toStandardLazyResponse,
} from '@standard-server/fetch'

import type { ClientServerTest } from './client-server'

export function createHonoFetchClientServerTest(): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const server = serve({
    fetch: async (request: Request) => {
      const standardRequest = toStandardLazyRequest(request)
      const standardResponse = await handler(standardRequest)
      const response = toFetchResponse(standardResponse)

      return response
    },
    port: 0,
  })

  afterAll(() => {
    server.close()
  })

  const addressInfo = server.address() as AddressInfo

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    const id = crypto.randomUUID()

    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    standardHeaders.id = id

    const response = await fetch(`http://localhost:${addressInfo.port}${standardRequest.url}`, {
      method: standardRequest.method,
      signal: standardRequest.signal ?? null,
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null,
      duplex: 'half',
    })

    const standardResponse = toStandardLazyResponse(response)

    return standardResponse
  })

  return {
    handler,
    request,
  }
}

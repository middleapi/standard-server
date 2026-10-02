import {
  toFetchBody,
  toFetchHeaders,
  toFetchResponse,
  toStandardLazyRequest,
  toStandardLazyResponse,
} from '@standard-server/fetch'
import { fromWebHandler, H3, serve } from 'h3'

import type { ClientServerTest } from './client-server'

export function createH3WebHandlerClientServerTest(): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const app = new H3()

  app.all(
    '/*',
    fromWebHandler(async (request) => {
      const standardRequest = toStandardLazyRequest(request)
      const standardResponse = await handler(standardRequest)
      const response = toFetchResponse(standardResponse)

      return response
    }),
  )

  const server = serve(app, { port: 0 })

  afterAll(() => {
    server.close()
  })

  const port = server.url!.split(':').pop()!.split('/').shift()!

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    const id = crypto.randomUUID()

    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    standardHeaders.id = id

    const response = await fetch(`http://localhost:${port}${standardRequest.url}`, {
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

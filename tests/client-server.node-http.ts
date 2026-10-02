import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

import { toFetchBody, toFetchHeaders, toStandardLazyResponse } from '@standard-server/fetch'
import { sendStandardResponse, toStandardLazyRequest } from '@standard-server/node'

import type { ClientServerTest } from './client-server'

export function createNodeHttpClientServerTest(): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const server = http.createServer(async (req, res) => {
    const standardRequest = toStandardLazyRequest(req, res)
    const standardResponse = await handler(standardRequest)

    await sendStandardResponse(res, standardResponse)
  })

  server.listen(0)

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
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null,
      duplex: 'half',
      signal: standardRequest.signal ?? null,
    })

    const standardResponse = toStandardLazyResponse(response)

    return standardResponse
  })

  return {
    handler,
    request,
  }
}

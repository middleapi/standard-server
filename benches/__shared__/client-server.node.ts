import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

import { toFetchBody, toFetchHeaders, toStandardLazyResponse } from '@standard-server/fetch'
import { sendStandardResponse, toStandardLazyRequest } from '@standard-server/node'

import type { ClientServer } from './client-server'

export function createNodeClientServer(): ClientServer {
  const clientServer: ClientServer = {
    handler: async () => ({ status: 404, body: 'Not Found', headers: {} }),
    request: async () => {
      throw new Error('client-server not ready')
    },
  }

  const server = http.createServer(async (req, res) => {
    const standardRequest = toStandardLazyRequest(req, res)
    const standardResponse = await clientServer.handler(standardRequest)
    await sendStandardResponse(res, standardResponse)
  })

  server.listen(0)

  afterAll(() => {
    server.close()
  })

  const addressInfo = server.address() as AddressInfo

  clientServer.request = async (standardRequest) => {
    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    const init: RequestInit = {
      method: standardRequest.method,
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null,
      signal: standardRequest.signal ?? null,
    }

    if (body instanceof ReadableStream) {
      init.duplex = 'half'
    }

    const response = await fetch(`http://localhost:${addressInfo.port}${standardRequest.url}`, init)

    return toStandardLazyResponse(response)
  }

  return clientServer
}

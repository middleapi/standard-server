import {
  toFetchBody,
  toFetchHeaders,
  toFetchResponse,
  toStandardLazyRequest,
  toStandardLazyResponse,
} from '@standard-server/fetch'

import type { ClientServer } from './client-server'

export function createFetchClientServer(): ClientServer {
  const clientServer: ClientServer = {
    handler: async () => ({ status: 404, body: 'Not Found', headers: {} }),
    request: async () => {
      throw new Error('client-server not ready')
    },
  }

  clientServer.request = async (standardRequest) => {
    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    const init: RequestInit = {
      method: standardRequest.method,
      signal: standardRequest.signal ?? null,
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null,
    }

    if (body instanceof ReadableStream) {
      init.duplex = 'half'
    }

    return toStandardLazyResponse(
      toFetchResponse(
        await clientServer.handler(
          toStandardLazyRequest(new Request(`http://localhost:${standardRequest.url}`, init)),
        ),
      ),
    )
  }

  return clientServer
}

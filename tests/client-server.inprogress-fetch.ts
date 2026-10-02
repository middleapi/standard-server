import {
  toFetchBody,
  toFetchHeaders,
  toFetchResponse,
  toStandardLazyRequest,
  toStandardLazyResponse,
} from '@standard-server/fetch'

import type { ClientServerTest } from './client-server'

export function createInprogressFetchClientServerTest(): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    return toStandardLazyResponse(
      toFetchResponse(
        await handler(
          toStandardLazyRequest(
            new Request(`http://localhost${standardRequest.url}`, {
              method: standardRequest.method,
              signal: standardRequest.signal ?? null,
              headers: toFetchHeaders(standardHeaders),
              body: body ?? null, // null = empty body
              duplex: 'half',
            }),
          ),
        ),
      ),
    )
  })

  return {
    handler,
    request,
  }
}

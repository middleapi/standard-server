import type { ClientServerTest } from './client-server'

export function createInprogressClientServerTest(): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    const standardResponse = await handler({
      ...standardRequest,
      resolveBody: async () => standardRequest.body,
    })
    return { ...standardResponse, resolveBody: async () => standardResponse.body }
  })

  return {
    handler,
    request,
  }
}

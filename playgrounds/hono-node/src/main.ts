import { serve } from '@hono/node-server'
import type { StandardLazyRequest, StandardResponse } from '@standard-server/core'
import { toFetchResponse, toStandardLazyRequest } from '@standard-server/fetch'

async function main(request: StandardLazyRequest): Promise<StandardResponse> {
  return {
    status: 200,
    headers: {},
    body: (async function* () {
      yield `${request.method} ${request.url}`

      while (true) {
        yield `now:${new Date()}`
        await new Promise((r) => setTimeout(r, 1000))
      }
    })(),
  }
}

serve(
  {
    async fetch(request, env) {
      const response = await main(toStandardLazyRequest(request))
      return toFetchResponse(response)
    },
  },
  (info) => {
    console.log(`Listening on http://localhost:${info.port}`)
  },
)

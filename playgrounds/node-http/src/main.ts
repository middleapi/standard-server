import { createServer } from 'node:http'

import type { StandardLazyRequest, StandardResponse } from '@standard-server/core'
import { sendStandardResponse, toStandardLazyRequest } from '@standard-server/node'

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

const server = createServer(async (req, res) => {
  const response = await main(toStandardLazyRequest(req, res))
  await sendStandardResponse(res, response)
})

server.listen(3000, '127.0.0.1', () => {
  console.log('Listening on http://localhost:3000')
})

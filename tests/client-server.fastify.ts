import {
  sendStandardResponse,
  standardContentTypeParser,
  toStandardLazyRequest,
} from '@standard-server/fastify'
import { toFetchBody, toFetchHeaders, toStandardLazyResponse } from '@standard-server/fetch'
import Fastify from 'fastify'

import type { ClientServerTest } from './client-server'

export function createFastifyClientServerTest(): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const fastify = Fastify()

  // hand every body over to the standard adapter, which knows the standard-server hints
  fastify.removeAllContentTypeParsers()
  fastify.addContentTypeParser('*', standardContentTypeParser)

  // a blob/file without a type is sent with an empty `content-type`, which fastify rejects with 415
  fastify.addHook('onRequest', async (req) => {
    if (req.headers['content-type'] === '') {
      req.headers['content-type'] = 'custom/empty'
    }
  })

  fastify.all('/*', async (req, reply) => {
    if (req.headers['content-type'] === 'custom/empty') {
      req.headers['content-type'] = ''
    }

    const standardRequest = toStandardLazyRequest(req, reply)
    const standardResponse = await handler(standardRequest)

    await sendStandardResponse(reply, standardResponse)
  })

  const origin = fastify.listen({ port: 0, host: '127.0.0.1' })

  afterAll(async () => {
    fastify.close()
  })

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    const id = crypto.randomUUID()

    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    standardHeaders.id = id

    const response = await fetch(`${await origin}${standardRequest.url}`, {
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

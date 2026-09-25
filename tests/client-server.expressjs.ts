import type { AddressInfo } from 'node:net'
import type { ClientServerTest } from './client-server'
import { toFetchBody, toFetchHeaders, toStandardLazyResponse } from '@standard-server/fetch'
import { sendStandardResponse, toStandardLazyRequest } from '@standard-server/node'
import express from 'express'
import express4 from 'express4'

export interface ExpressjsClientServerTestOptions {
  /**
   * Major version of express to run, each ships a different body-parser major.
   *
   * @default 5
   */
  version?: 4 | 5

  /**
   * Registers the body parsers a regular express app ships with, exercising the
   * `req.body` short-circuit in `toStandardBody` instead of reading the raw stream.
   */
  bodyParser?: boolean
}

export function createExpressjsClientServerTest(
  options: ExpressjsClientServerTestOptions = {},
): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  // the api used below is the same across both majors, only their types are incompatible
  const expressjs = (options.version === 4 ? express4 : express) as typeof express
  const app = expressjs()

  if (options.bodyParser) {
    // the parsers a regular express project registers; for every other content type body-parser
    // leaves the stream unread, so those bodies still reach the adapter as a stream. body-parser 1.x
    // (express 4) still assigns `{}` to `req.body` then, while 2.x (express 5) leaves it undefined
    //
    // `strict` must be off: it defaults to on, which rejects every top-level JSON value that
    // isn't an object or array (`"a string"`, `null`, `1`) with a 400 before the adapter runs
    app.use(expressjs.json({ strict: false }))
  }

  app.use(async (req, res) => {
    const standardRequest = toStandardLazyRequest(req, res)
    const standardResponse = await handler(standardRequest)

    await sendStandardResponse(res, standardResponse)
  })

  const server = app.listen(0)

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

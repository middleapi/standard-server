import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'
import * as http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

import { toFetchBody, toFetchHeaders, toStandardLazyResponse } from '@standard-server/fetch'
import { sendStandardResponse, toStandardLazyRequest } from '@standard-server/node'
import { throwIfAborted } from '@standard-server/shared'

import type { ClientServerTest } from './client-server'
import { generateTlsCert } from './tls'

export interface NodeHttp2ClientServerTestOptions {
  /** Serve over TLS (https) with a self-signed localhost certificate. */
  secure?: boolean
}

export function createNodeHttp2ClientServerTest(
  options: NodeHttp2ClientServerTestOptions = {},
): ClientServerTest {
  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })

  const requestListener = async (req: Http2ServerRequest, res: Http2ServerResponse) => {
    // a client RST_STREAM surfaces as an 'error' on the raw stream (not on `res`),
    // and crashes the process unless something listens to it
    res.stream.on('error', () => {})

    const standardRequest = toStandardLazyRequest(req, res)
    const standardResponse = await handler(standardRequest)

    // rejects when the client aborts the stream mid-response
    await sendStandardResponse(res, standardResponse).catch(() => {})
  }

  const serverReady = (async () => {
    const tls = options.secure ? await generateTlsCert() : undefined

    const server = tls
      ? http2.createSecureServer({ cert: tls.cert, key: tls.key }, requestListener)
      : http2.createServer(requestListener)

    await new Promise<void>((resolve) => server.listen(0, resolve))

    const port = (server.address() as AddressInfo).port

    // fetch cannot speak h2c, so requests go through a raw http2 client session
    const session = tls
      ? http2.connect(`https://localhost:${port}`, { ca: tls.cert })
      : http2.connect(`http://localhost:${port}`)
    session.on('error', () => {})

    return { server, session, port }
  })()

  afterAll(async () => {
    const { server, session } = await serverReady

    session.destroy()
    server.close()
  })

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    throwIfAborted(standardRequest.signal)

    const { session, port } = await serverReady

    const [body, standardHeaders] = toFetchBody(standardRequest.body, standardRequest.headers)

    // Normalize the fetch body (Blob, FormData, ...) into a byte stream and let
    // fetch fill in derived headers such as the multipart boundary.
    const fetchRequest = new Request(`http://localhost:${port}${standardRequest.url}`, {
      method: standardRequest.method,
      headers: toFetchHeaders(standardHeaders),
      body: body ?? null,
      duplex: 'half',
    })

    const requestHeaders: http2.OutgoingHttpHeaders = {
      ':method': standardRequest.method,
      ':path': `${standardRequest.url}`,
    }
    fetchRequest.headers.forEach((value, key) => {
      requestHeaders[key] = value
    })

    const stream = session.request(requestHeaders, { endStream: fetchRequest.body === null })

    standardRequest.signal?.addEventListener('abort', () => {
      stream.destroy(standardRequest.signal!.reason)
    })

    if (fetchRequest.body) {
      void (async () => {
        const reader = fetchRequest.body!.getReader()

        try {
          while (true) {
            const { done, value } = await reader.read()

            if (stream.destroyed || stream.writableEnded) {
              return // abandon the body without cancelling it, like fetch does
            }

            if (done) {
              stream.end()
              return
            }

            if (!stream.write(value)) {
              await new Promise<void>((resolve) => {
                stream.once('drain', resolve)
                stream.once('close', resolve)
              })
            }
          }
        } catch (error) {
          stream.destroy(error as Error)
        }
      })()
    }

    const responseHeaders = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      stream.once('response', resolve)
      stream.once('error', reject)
    })

    const headers = new Headers()
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (key.startsWith(':') || value === undefined) {
        continue
      }

      for (const item of Array.isArray(value) ? value : [value]) {
        headers.append(key, item)
      }
    }

    const response = new Response(Readable.toWeb(stream) as ReadableStream, {
      status: Number(responseHeaders[':status']),
      headers,
    })

    return toStandardLazyResponse(response)
  })

  return {
    handler,
    request,
  }
}

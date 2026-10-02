import type {
  StandardLazyRequest,
  StandardLazyResponse,
  StandardRequest,
  StandardResponse,
} from '@standard-server/core'
import { isAsyncIteratorObject } from '@standard-server/shared'

export interface ClientServer {
  handler: (request: StandardLazyRequest) => Promise<StandardResponse>
  request: (request: StandardRequest) => Promise<StandardLazyResponse>
}

export const echoHandler: ClientServer['handler'] = async (request) => {
  const body = await request.resolveBody()

  return {
    status: 200,
    headers: {
      'x-from': 'server',
    },
    body,
  }
}

/**
 * Fully consume a response body so streaming / lazy adapters are measured end-to-end.
 */
async function drainBody(body: unknown): Promise<void> {
  if (body === undefined || body === null) {
    return
  }

  if (isAsyncIteratorObject(body)) {
    const iterator = body as AsyncGenerator
    while (true) {
      const result = await iterator.next()
      if (result.done) {
        break
      }
    }
    return
  }

  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    try {
      while (true) {
        const { done } = await reader.read()
        if (done) {
          break
        }
      }
    } finally {
      reader.releaseLock()
    }
    return
  }

  if (body instanceof Blob) {
    await body.arrayBuffer()
    return
  }

  if (body instanceof FormData) {
    for (const value of body.values()) {
      if (value instanceof Blob) {
        await value.arrayBuffer()
      }
    }
    return
  }

  if (body instanceof URLSearchParams) {
    body.toString()
  }
}

export async function roundTrip(
  clientServer: ClientServer,
  request: StandardRequest,
): Promise<void> {
  const response = await clientServer.request(request)
  await drainBody(await response.resolveBody())
}

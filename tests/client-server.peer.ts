import type { StandardLazyRequest, StandardRequest, StandardResponse } from '@standard-server/core'
import type { ClientPeer, PeerMessage, ServerPeer } from '@standard-server/peer'
import type { BlobPart } from 'node:buffer'
import type { Mock } from 'vitest'
import type { ClientServerTest } from './client-server'
import { toFetchBody, toFetchHeaders, toStandardBody } from '@standard-server/fetch'
import { encodePeerMessage } from '@standard-server/peer'

export const peerPrefix = '__PREFIX__'

export interface PeerClientServerTestOptions {
  /**
   * Pass request/response bodies through the fetch adapters so the peer transport
   * exercises octet-stream bodies interoperating with fetch-compatible bodies.
   */
  fetchStreamed?: boolean
}

export async function randomEncodePeerMessage(message: PeerMessage) {
  let encoded = await encodePeerMessage(message, { prefix: peerPrefix })

  /**
   * In some env when you send string but on server you might receive buffer,
   * so this is to increase coverage
   */
  if (typeof encoded === 'string' && Math.random() < 0.5) {
    encoded = new TextEncoder().encode(encoded)
  }

  return encoded
}

/**
 * Normalizes the possible `ws` message data shapes into what `decodePeerMessage` accepts.
 */
export async function wsMessageDataToEncoded(data: unknown): Promise<string | Uint8Array<ArrayBuffer>> {
  if (typeof data === 'string') {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  if (Array.isArray(data)) {
    // eslint-disable-next-line ban/ban
    return (new Blob(data as BlobPart[])).bytes()
  }

  const view = data as Uint8Array
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
}

/**
 * Wraps the test handler so request bodies are resolved through the fetch adapters.
 */
export function wrapFetchStreamedServerHandler(
  handler: ClientServerTest['handler'],
): (request: StandardLazyRequest) => Promise<StandardResponse> {
  return async request => handler({
    ...request,
    resolveBody: async (hint) => {
      // peer adapter does not support body-hint, but I still put it there :V
      const stream = await request.resolveBody('octet-stream')

      if (stream instanceof ReadableStream) {
        const body = await toStandardBody(new Response(stream, { headers: toFetchHeaders(request.headers) }), { hint })
        return body
      }

      return stream
    },
  })
}

/**
 * Converts the request body into a fetch `Response` stream before sending it over the peer transport.
 */
export function toFetchStreamedStandardRequest(standardRequest: StandardRequest): StandardRequest {
  const [body, headers] = toFetchBody(standardRequest.body, standardRequest.headers)
  const res = new Response(body)

  return {
    ...standardRequest,
    body: res.body ?? undefined,
    headers: {
      ...headers,
      'content-type': headers['content-type'] ?? res.headers.get('content-type') ?? undefined,
    },
  }
}

export function expectPeerRequestsCleanedUpAfterEach(clientPeer: ClientPeer, serverPeer: ServerPeer): void {
  afterEach(() => {
    // ensure all resource is cleaned up correctly
    expect((clientPeer as any).requests.size).toBe(0)
    expect((serverPeer as any).requests.size).toBe(0)
  })
}

/**
 * The wiring catches `message()` rejections (as documented) and reports them to `onPeerMessageError`,
 * so fail the test instead of silently ignoring them. Tests that expect one should assert it, then clear the mock.
 */
export function expectNoPeerMessageErrorAfterEach(onPeerMessageError: Mock<(error: unknown) => void>): void {
  afterEach(() => {
    expect(onPeerMessageError).not.toHaveBeenCalled()
  })
}

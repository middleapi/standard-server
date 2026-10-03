import type {
  StandardLazyRequest,
  StandardLazyResponse,
  StandardRequest,
  StandardResponse,
} from '@standard-server/core'
import { sleep } from '@standard-server/shared'

export type ClientServerHandler = (request: StandardLazyRequest) => Promise<StandardResponse>

export interface ClientServerTest {
  /** Replaces the server-side handler used for subsequent requests. */
  setHandler: (handler: ClientServerHandler) => void
  request: (request: StandardRequest) => Promise<StandardLazyResponse>
  close: () => void | Promise<void>
}

export const NOT_FOUND_HANDLER: ClientServerHandler = async () => {
  return { status: 404, body: 'Not Found', headers: {} }
}

/**
 * Waits until `assertion` stops throwing.
 * Prefer this over a fixed `sleep` so tests continue as soon as the condition holds.
 */
export async function waitFor<T>(
  assertion: () => T | Promise<T>,
  { timeout = 2000, interval = 10 } = {},
): Promise<T> {
  const start = Date.now()

  for (;;) {
    try {
      return await assertion()
    } catch (error) {
      if (Date.now() - start >= timeout) {
        throw error
      }

      await sleep(interval)
    }
  }
}

/**
 * Normalizes the possible WebSocket message data shapes into what `decodePeerMessage` accepts.
 */
export function toEncodedPeerMessage(data: unknown): string | Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  const view = data as Uint8Array
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
}

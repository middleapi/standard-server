import type { StandardLazyRequest, StandardLazyResponse, StandardRequest, StandardResponse } from '@standard-server/core'
import type { ClientPeerSendMessage, ServerPeerSendMessage } from '@standard-server/peer'
import type { Mock } from 'vitest'

export interface ClientServerTest {
  handler: Mock<(request: StandardLazyRequest) => Promise<StandardResponse>>
  request: Mock<(request: StandardRequest) => Promise<StandardLazyResponse>>

  /** Only available in peer adapter */
  sendClientPeerMessage?: Mock<(message: ClientPeerSendMessage) => Promise<void>>
  sendServerPeerMessage?: Mock<(message: ServerPeerSendMessage) => Promise<void>>
  /** Only available in peer adapter, receives rejections of `clientPeer.message()` and `serverPeer.message()` */
  onPeerMessageError?: Mock<(error: unknown) => void>
}

/**
 * Asserts the exact sequence of peer messages each side sent so far.
 * Each expected entry is matched with `expect.objectContaining`.
 * Skipped for adapters that don't expose the peer send mocks.
 */
export function expectPeerMessages(
  clientServer: ClientServerTest,
  expected: { client: Record<string, unknown>[], server: Record<string, unknown>[] },
): void {
  const { sendClientPeerMessage, sendServerPeerMessage } = clientServer

  if (!sendClientPeerMessage || !sendServerPeerMessage) {
    return
  }

  expect(sendClientPeerMessage.mock.calls.map(([message]) => message))
    .toEqual(expected.client.map(message => expect.objectContaining(message)))
  expect(sendServerPeerMessage.mock.calls.map(([message]) => message))
    .toEqual(expected.server.map(message => expect.objectContaining(message)))
}

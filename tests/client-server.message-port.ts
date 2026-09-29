import type { ClientServerTest } from './client-server'
import type { PeerClientServerTestOptions } from './client-server.peer'
import { ClientPeer, decodePeerMessage, isClientPeerSendMessage, isServerPeerSendMessage, ServerPeer } from '@standard-server/peer'
import { expectNoPeerMessageErrorAfterEach, expectPeerRequestsCleanedUpAfterEach, peerPrefix, randomEncodePeerMessage, toFetchStreamedStandardRequest, wrapFetchStreamedServerHandler } from './client-server.peer'

export function createMessagePortClientServerTest(options: PeerClientServerTestOptions = {}): ClientServerTest {
  const { port1, port2 } = new MessageChannel()

  /**
   * `message()` can reject (e.g. the handler throws), and a rejection
   * inside an event listener is unhandled, so always attach a catch.
   */
  const onPeerMessageError: NonNullable<ClientServerTest['onPeerMessageError']> = vi.fn()

  const sendClientPeerMessage: NonNullable<ClientServerTest['sendClientPeerMessage']> = vi.fn(async (message) => {
    port1.postMessage(await randomEncodePeerMessage(message))
  })
  const clientPeer = new ClientPeer(sendClientPeerMessage)
  port1.addEventListener('message', async (event) => {
    const { matched, message } = decodePeerMessage(event.data, { prefix: peerPrefix })

    if (!matched || !isServerPeerSendMessage(message)) {
      return
    }

    await clientPeer.message(message).catch(onPeerMessageError)
  })
  port1.start()

  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })
  const serverHandler = options.fetchStreamed ? wrapFetchStreamedServerHandler(handler) : handler

  const sendServerPeerMessage: NonNullable<ClientServerTest['sendServerPeerMessage']> = vi.fn(async (message) => {
    port2.postMessage(await randomEncodePeerMessage(message))
  })
  const serverPeer = new ServerPeer(sendServerPeerMessage)
  port2.addEventListener('message', async (event) => {
    const { matched, message } = decodePeerMessage(event.data, { prefix: peerPrefix })

    if (!matched || !isClientPeerSendMessage(message)) {
      return
    }

    await serverPeer.message(message, async (request) => {
      return serverHandler(request)
    }).catch(onPeerMessageError)
  })
  port2.start()

  const request: ClientServerTest['request'] = vi.fn(async (standardRequest) => {
    if (options.fetchStreamed) {
      standardRequest = toFetchStreamedStandardRequest(standardRequest)
    }

    const response = await clientPeer.request(standardRequest)
    return response
  })

  expectPeerRequestsCleanedUpAfterEach(clientPeer, serverPeer)
  expectNoPeerMessageErrorAfterEach(onPeerMessageError)

  if (options.fetchStreamed) {
    return { handler, request, onPeerMessageError }
  }

  return {
    handler,
    request,
    sendClientPeerMessage,
    sendServerPeerMessage,
    onPeerMessageError,
  }
}

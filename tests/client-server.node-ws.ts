import type { ClientServerTest } from './client-server'
import type { PeerClientServerTestOptions } from './client-server.peer'
import { ClientPeer, decodePeerMessage, isClientPeerSendMessage, isServerPeerSendMessage, ServerPeer } from '@standard-server/peer'
import { WebSocket, WebSocketServer } from 'ws'
import { expectNoPeerMessageErrorAfterEach, expectPeerRequestsCleanedUpAfterEach, peerPrefix, randomEncodePeerMessage, toFetchStreamedStandardRequest, wrapFetchStreamedServerHandler, wsMessageDataToEncoded } from './client-server.peer'

export function createNodeWsClientServerTest(options: PeerClientServerTestOptions = {}): ClientServerTest {
  const wss = new WebSocketServer({ port: 0 })
  const port = wss.address() as WebSocket.AddressInfo
  const wsc = new WebSocket(`ws://localhost:${port.port}`)

  afterAll(() => {
    wss.close()
    wsc.close()
  })

  const untilReady = new Promise<void>((resolve) => {
    if (wsc.readyState === WebSocket.OPEN) {
      resolve()
      return
    }

    wsc.addEventListener('open', () => {
      resolve()
    })
  })

  /**
   * `message()` can reject (e.g. the handler throws), and a rejection
   * inside an event listener is unhandled, so always attach a catch.
   */
  const onPeerMessageError: NonNullable<ClientServerTest['onPeerMessageError']> = vi.fn()

  const sendClientPeerMessage: NonNullable<ClientServerTest['sendClientPeerMessage']> = vi.fn(async (message) => {
    await untilReady
    wsc.send(await randomEncodePeerMessage(message))
  })
  const clientPeer = new ClientPeer(sendClientPeerMessage)
  wsc.addEventListener('message', async (event) => {
    const { matched, message } = decodePeerMessage(await wsMessageDataToEncoded(event.data), { prefix: peerPrefix })

    if (!matched || !isServerPeerSendMessage(message)) {
      return
    }

    await clientPeer.message(message).catch(onPeerMessageError)
  })

  const handler: ClientServerTest['handler'] = vi.fn(async () => {
    return { status: 404, body: 'Not Found', headers: {} }
  })
  const serverHandler = options.fetchStreamed ? wrapFetchStreamedServerHandler(handler) : handler

  let sendServerPeerInternal: (message: any) => void
  const sendServerPeerMessage: NonNullable<ClientServerTest['sendServerPeerMessage']> = vi.fn(async (message) => {
    sendServerPeerInternal(await randomEncodePeerMessage(message))
  })
  const serverPeer = new ServerPeer(sendServerPeerMessage)

  wss.on('connection', (ws) => {
    sendServerPeerInternal = ws.send.bind(ws)

    ws.addEventListener('message', async (event) => {
      const { matched, message } = decodePeerMessage(await wsMessageDataToEncoded(event.data), { prefix: peerPrefix })

      if (!matched || !isClientPeerSendMessage(message)) {
        return
      }

      await serverPeer.message(message, async (request) => {
        return serverHandler(request)
      }).catch(onPeerMessageError)
    })
  })

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

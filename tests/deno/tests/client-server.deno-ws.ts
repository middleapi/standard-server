import {
  ClientPeer,
  decodePeerMessage,
  encodePeerMessage,
  isClientPeerSendMessage,
  isServerPeerSendMessage,
  ServerPeer,
} from '@standard-server/peer'

import type { ClientServerHandler, ClientServerTest } from './client-server'
import { NOT_FOUND_HANDLER, toEncodedPeerMessage } from './client-server'

export function createDenoWsClientServerTest(): ClientServerTest {
  let handler: ClientServerHandler = NOT_FOUND_HANDLER

  const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('WebSocket only', { status: 426 })
    }

    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.binaryType = 'arraybuffer'

    const serverPeer = new ServerPeer(async (message) => {
      socket.send(await encodePeerMessage(message))
    })

    socket.addEventListener('message', async (event) => {
      const { matched, message } = decodePeerMessage(toEncodedPeerMessage(event.data))

      if (!matched || !isClientPeerSendMessage(message)) {
        return
      }

      await serverPeer.message(message, async (request) => handler(request))
    })

    return response
  })

  const wsc = new WebSocket(`ws://localhost:${server.addr.port}`)
  wsc.binaryType = 'arraybuffer'

  const untilReady = new Promise<void>((resolve, reject) => {
    wsc.addEventListener('open', () => resolve())
    wsc.addEventListener('error', () => reject(new Error('WebSocket connection failed')))
  })

  const clientPeer = new ClientPeer(async (message) => {
    await untilReady
    wsc.send(await encodePeerMessage(message))
  })

  wsc.addEventListener('message', async (event) => {
    const { matched, message } = decodePeerMessage(toEncodedPeerMessage(event.data))

    if (!matched || !isServerPeerSendMessage(message)) {
      return
    }

    await clientPeer.message(message)
  })

  return {
    setHandler: (next) => {
      handler = next
    },
    request: (standardRequest) => clientPeer.request(standardRequest),
    close: async () => {
      wsc.close()
      await server.shutdown()
    },
  }
}

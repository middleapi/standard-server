import {
  ClientPeer,
  decodePeerMessage,
  encodePeerMessage,
  isClientPeerSendMessage,
  isServerPeerSendMessage,
  ServerPeer,
} from '@standard-server/peer'

import type { ClientServer } from './client-server'

export function createPeerClientServer(): ClientServer {
  const clientServer: ClientServer = {
    handler: async () => ({ status: 404, body: 'Not Found', headers: {} }),
    request: async (standardRequest) => {
      return clientPeer.request(standardRequest)
    },
  }

  const serverPeer = new ServerPeer(async (message) => {
    const encoded = await encodePeerMessage(message)
    const decoded = decodePeerMessage(encoded)

    if (!decoded.matched || !isServerPeerSendMessage(decoded.message)) {
      return
    }

    clientPeer.message(decoded.message)
  })

  const clientPeer = new ClientPeer(async (message) => {
    const encoded = await encodePeerMessage(message)
    const decoded = decodePeerMessage(encoded)

    if (!decoded.matched || !isClientPeerSendMessage(decoded.message)) {
      throw new Error('not found')
    }

    serverPeer.message(decoded.message, clientServer.handler)
  })

  return clientServer
}

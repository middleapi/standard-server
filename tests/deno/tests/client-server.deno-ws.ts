import type { ClientServerHandler, ClientServerTest } from './client-server'
import { ClientPeer, decodePeerMessage, encodePeerMessage, isClientPeerSendMessage, isServerPeerSendMessage, ServerPeer } from '@standard-server/peer'
import { expect } from '@std/expect'
import { afterEach } from '@std/testing/bdd'
import { NOT_FOUND_HANDLER, toEncodedPeerMessage } from './client-server'

export function createDenoWsClientServerTest(): ClientServerTest {
  let handler: ClientServerHandler = NOT_FOUND_HANDLER

  /**
   * `message()` can reject (e.g. the handler throws), and a rejection
   * inside an event listener is unhandled, so always attach a catch.
   * Fail the test instead of silently ignoring the error.
   */
  const peerMessageErrors: unknown[] = []
  const onPeerMessageError = (error: unknown) => {
    peerMessageErrors.push(error)
  }

  afterEach(() => {
    expect(peerMessageErrors.splice(0)).toEqual([])
  })

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

      await serverPeer.message(message, async request => handler(request)).catch(onPeerMessageError)
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

    await clientPeer.message(message).catch(onPeerMessageError)
  })

  return {
    setHandler: (next) => {
      handler = next
    },
    request: standardRequest => clientPeer.request(standardRequest),
    close: async () => {
      wsc.close()
      await server.shutdown()
    },
  }
}

import type { ClientServerHandler, ClientServerTest } from './client-server'
import { ClientPeer, decodePeerMessage, encodePeerMessage, isClientPeerSendMessage, isServerPeerSendMessage, ServerPeer } from '@standard-server/peer'
import { afterEach, expect } from 'bun:test'
import { NOT_FOUND_HANDLER, toEncodedPeerMessage } from './client-server'

export function createBunWsClientServerTest(): ClientServerTest {
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

  /**
   * Tests open a single client connection, so a single server peer is enough.
   */
  let serverPeer: ServerPeer | undefined

  const server = Bun.serve({
    port: 0,
    fetch: (request, server) => {
      if (server.upgrade(request)) {
        return
      }

      return new Response('WebSocket only', { status: 426 })
    },
    websocket: {
      open: (ws) => {
        serverPeer = new ServerPeer(async (message) => {
          ws.send(await encodePeerMessage(message))
        })
      },
      message: async (_, data) => {
        const { matched, message } = decodePeerMessage(toEncodedPeerMessage(data))

        if (!matched || !isClientPeerSendMessage(message)) {
          return
        }

        await serverPeer!.message(message, async request => handler(request)).catch(onPeerMessageError)
      },
    },
  })

  const wsc = new WebSocket(`ws://${server.url.host}`)
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
    close: () => {
      wsc.close()
      server.stop(true)
    },
  }
}

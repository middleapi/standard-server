import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

import { ErrorEvent } from '@standard-server/core'
import { sendStandardResponse } from '@standard-server/node'

let createBody: () => AsyncGenerator

const server = http.createServer((_req, res) =>
  sendStandardResponse(res, {
    status: 200,
    headers: {},
    body: createBody(),
  }),
)

server.listen(0)

afterAll(() => {
  server.close()
})

/**
 * Listens with EventSource until a close or error event arrives.
 */
function receive(): Promise<{ event: string; data: string }[]> {
  const source = new EventSource(`http://localhost:${(server.address() as AddressInfo).port}`)
  const received: { event: string; data: string }[] = []

  return new Promise((resolve) => {
    for (const event of ['message', 'close', 'error']) {
      source.addEventListener(event, ({ data }: any) => {
        received.push({ event, data })

        if (event !== 'message') {
          source.close()
          resolve(received)
        }
      })
    }
  })
}

describe.skipIf(typeof EventSource === 'undefined')('eventSource', () => {
  it('receives message and close events', async () => {
    createBody = async function* () {
      yield 'hello'
      yield { order: 2 }
      // must return a value: a close event without data is dropped by EventSource, which reconnects
      return 'bye'
    }

    expect(await receive()).toEqual([
      { event: 'message', data: '"hello"' },
      { event: 'message', data: '{"order":2}' },
      { event: 'close', data: '"bye"' },
    ])
  })

  it('receives message and error events', async () => {
    createBody = async function* () {
      yield 'hello'
      throw new ErrorEvent({ code: 'BOOM' })
    }

    expect(await receive()).toEqual([
      { event: 'message', data: '"hello"' },
      { event: 'error', data: '{"code":"BOOM"}' },
    ])
  })
})

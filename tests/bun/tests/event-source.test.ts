import { ErrorEvent } from '@standard-server/core'
import { toFetchResponse } from '@standard-server/fetch'
import { afterAll, describe, expect, it } from 'bun:test'

let createBody: () => AsyncGenerator

const server = Bun.serve({
  port: 0,
  fetch: () => toFetchResponse({
    status: 200,
    headers: {},
    body: createBody(),
  }),
})

afterAll(() => server.stop(true))

/**
 * Listens with EventSource until a close or error event arrives.
 */
function receive(): Promise<{ event: string, data: string }[]> {
  const source = new EventSource(server.url)
  const received: { event: string, data: string }[] = []

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

// bun-types declares EventSource, but Bun doesn't implement it yet
describe.skipIf(typeof EventSource === 'undefined')('eventSource', () => {
  it('receives message and close events', async () => {
    createBody = async function* () {
      yield 'hello'
      yield { order: 2 }
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

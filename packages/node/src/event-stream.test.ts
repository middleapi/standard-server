import { Readable } from 'node:stream'

import { EventStreamIncompleteError, getEventMeta } from '@standard-server/core'
import * as FetchAdapter from '@standard-server/fetch'
import { isAsyncIteratorObject } from '@standard-server/shared'

import { toAsyncIteratorObject, toEventStream } from './event-stream'
import * as UtilsModule from './utils'

const toAsyncIteratorObjectFetch = vi.spyOn(FetchAdapter, 'toAsyncIteratorObject')
const toEventStreamFetch = vi.spyOn(FetchAdapter, 'toEventStream')
const toWebReadableStreamSpy = vi.spyOn(UtilsModule, 'toWebReadableStream')

beforeEach(() => {
  vi.clearAllMocks()
})

it('toAsyncIteratorObject', async () => {
  const stream = new ReadableStream<string>({
    async pull(controller) {
      controller.enqueue('event: message\ndata: 1\n\n')
      controller.enqueue('event: message\ndata: 2\n\n')
      controller.enqueue('event: message\ndata: 3\n\n')
      controller.enqueue('event: close\n\n')
      controller.close()
    },
  }).pipeThrough(new TextEncoderStream())

  const generator = toAsyncIteratorObject(Readable.fromWeb(stream))
  expect(generator).toSatisfy(isAsyncIteratorObject)

  expect(await generator.next()).toEqual({ done: false, value: 1 })
  expect(await generator.next()).toEqual({ done: false, value: 2 })
  expect(await generator.next()).toEqual({ done: false, value: 3 })
  expect(await generator.next()).toEqual({ done: true, value: undefined })

  expect(toWebReadableStreamSpy).toBeCalledTimes(1)
  expect(toAsyncIteratorObjectFetch).toBeCalledTimes(1)
  expect(toAsyncIteratorObjectFetch).toHaveBeenCalledWith(
    toWebReadableStreamSpy.mock.results[0]!.value,
  )
})

it('toAsyncIteratorObject without close event', async () => {
  const readable = Readable.from(['event: message\ndata: 1\nid: id-1\n\n'])

  const generator = toAsyncIteratorObject(readable)

  expect(await generator.next()).toEqual({ done: false, value: 1 })
  await expect(generator.next()).rejects.toSatisfy((error: any) => {
    expect(error).toBeInstanceOf(EventStreamIncompleteError)
    expect(getEventMeta(error)).toEqual({ id: 'id-1' })

    return true
  })
})

it('toEventStream', async () => {
  async function* gen() {
    yield 1
    yield 2
    yield 3
  }

  const reader = Readable.toWeb(toEventStream(gen(), {}))
    .pipeThrough(new TextDecoderStream())
    .getReader()

  expect(await reader.read()).toEqual({ done: false, value: ': \n\n' })
  expect(await reader.read()).toEqual({ done: false, value: 'data: 1\n\n' })
  expect(await reader.read()).toEqual({ done: false, value: 'data: 2\n\n' })
  expect(await reader.read()).toEqual({ done: false, value: 'data: 3\n\n' })
  expect(await reader.read()).toEqual({ done: false, value: 'event: close\n\n' })
  expect(await reader.read()).toEqual({ done: true, value: undefined })

  expect(toEventStreamFetch).toHaveBeenCalledTimes(1)
})

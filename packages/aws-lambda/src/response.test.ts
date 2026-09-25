import type { StandardResponse } from '@standard-server/core'
import type { HttpResponseStream } from './types'
import { Buffer } from 'node:buffer'
import Stream from 'node:stream'
import * as StandardServerNode from '@standard-server/node'
import { sendStandardResponse } from './response'

const toNodeHttpBodySpy = vi.spyOn(StandardServerNode, 'toNodeHttpBody')

const DELIMITER = new Uint8Array(8)

const fromSpy = vi.fn((responseStream: HttpResponseStream, metadata: Record<string, unknown>) => {
  // mimics what the lambda runtime does: send the metadata prelude
  // ahead of the first `write` call only, `end(chunk)` bypasses it
  responseStream.setContentType('application/vnd.awslambda.http-integration-response')
  const write = responseStream.write.bind(responseStream)
  responseStream.write = (chunk: unknown) => {
    responseStream.write = write
    write(JSON.stringify(metadata))
    write(DELIMITER)
    return write(chunk)
  }
  return responseStream
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('awslambda', { HttpResponseStream: { from: fromSpy } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function createResponseStream(): HttpResponseStream & { chunks: Buffer[] } {
  const stream = new Stream.Writable({
    write(chunk, encoding, callback) {
      stream.chunks.push(chunk)
      callback()
    },
  }) as HttpResponseStream & { chunks: Buffer[] }

  stream.chunks = []
  stream.setContentType = vi.fn()

  return stream
}

function metadataOf(stream: HttpResponseStream & { chunks: Buffer[] }): Record<string, unknown> {
  return JSON.parse(stream.chunks[0]!.toString())
}

function bodyOf(stream: HttpResponseStream & { chunks: Buffer[] }): string {
  return Buffer.concat(stream.chunks.slice(2)).toString()
}

describe('sendStandardResponse', () => {
  it('buffered (empty)', async () => {
    const responseStream = createResponseStream()

    const options = { eventStream: { keepAlive: { enabled: true } } }
    await sendStandardResponse(responseStream, {
      status: 207,
      headers: {
        'x-custom-header': 'custom-value',
      },
      body: undefined,
    }, options)

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(undefined, {
      'x-custom-header': 'custom-value',
    }, options)

    expect(fromSpy).toBeCalledTimes(1)
    expect(metadataOf(responseStream)).toEqual({
      statusCode: 207,
      headers: {
        'x-custom-header': 'custom-value',
      },
      cookies: [],
    })

    expect(bodyOf(responseStream)).toBe('')
    expect(responseStream.writableEnded).toBe(true)
  })

  it('buffered (json)', async () => {
    const responseStream = createResponseStream()

    await sendStandardResponse(responseStream, {
      status: 200,
      headers: {
        'x-custom-header': 'custom-value',
        'set-cookie': ['foo=bar', 'bar=baz'],
      },
      body: { foo: 'bar' },
    })

    expect(metadataOf(responseStream)).toEqual({
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'x-custom-header': 'custom-value',
      },
      cookies: ['foo=bar', 'bar=baz'],
    })

    expect(bodyOf(responseStream)).toBe('{"foo":"bar"}')
    expect(responseStream.writableEnded).toBe(true)
  })

  it('chunked (async generator)', async () => {
    const responseStream = createResponseStream()

    async function* gen() {
      yield 'foo'
      yield 'bar'
      return 'baz'
    }

    await sendStandardResponse(responseStream, {
      status: 200,
      headers: {},
      body: gen(),
    })

    expect(metadataOf(responseStream)).toMatchObject({
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    })

    expect(bodyOf(responseStream)).toBe(': \n\nevent: message\ndata: "foo"\n\nevent: message\ndata: "bar"\n\nevent: close\ndata: "baz"\n\n')
    expect(responseStream.writableEnded).toBe(true)
  })

  it('chunked (octet-stream)', async () => {
    const responseStream = createResponseStream()

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'))
        controller.enqueue(new TextEncoder().encode('chunk2'))
        controller.close()
      },
    })

    await sendStandardResponse(responseStream, {
      status: 200,
      headers: {},
      body: stream,
    })

    expect(metadataOf(responseStream)).toMatchObject({
      statusCode: 200,
      headers: {
        'content-type': 'application/octet-stream',
      },
    })

    expect(bodyOf(responseStream)).toBe('chunk1chunk2')
    expect(responseStream.writableEnded).toBe(true)
  })

  it('chunked (empty)', async () => {
    const responseStream = createResponseStream()

    await sendStandardResponse(responseStream, {
      status: 200,
      headers: {},
      body: new Blob([]),
    })

    expect(metadataOf(responseStream)).toMatchObject({
      statusCode: 200,
    })

    expect(bodyOf(responseStream)).toBe('')
    expect(responseStream.writableEnded).toBe(true)
  })

  it('destroys the response stream when the body stream errors during streaming', async () => {
    const responseStream = createResponseStream()

    const error = new Error('TEST')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'))
        controller.error(error)
      },
    })

    await expect(sendStandardResponse(responseStream, {
      status: 200,
      headers: {},
      body: stream,
    })).rejects.toThrow('TEST')

    expect(responseStream.destroyed).toBe(true)
    expect(responseStream.errored).toBe(error)
  })

  it('destroys the body when the response stream closes while streaming', async () => {
    const responseStream = createResponseStream()

    let clean = false
    const standardResponse: StandardResponse = {
      body: (async function* () {
        try {
          yield 1
          await new Promise(r => setTimeout(r, 100))
          yield 2
          await new Promise(r => setTimeout(r, 9999999))
          yield 3
        }
        finally {
          clean = true
        }
      })(),
      headers: {},
      status: 200,
    }

    const sendPromise = expect(sendStandardResponse(responseStream, standardResponse)).rejects.toThrow('test')

    await vi.waitFor(() => {
      expect(bodyOf(responseStream)).toContain('data: 1')
    })

    responseStream.destroy(new Error('test'))

    await vi.waitFor(() => {
      expect(clean).toBe(true)
    })

    await sendPromise
  })

  it('destroys the body without error when the response stream closes cleanly while streaming', async () => {
    const responseStream = createResponseStream()

    let clean = false
    const standardResponse: StandardResponse = {
      body: (async function* () {
        try {
          yield 1
          await new Promise(r => setTimeout(r, 100))
          yield 2
          await new Promise(r => setTimeout(r, 9999999))
          yield 3
        }
        finally {
          clean = true
        }
      })(),
      headers: {},
      status: 200,
    }

    const sendPromise = sendStandardResponse(responseStream, standardResponse)

    await vi.waitFor(() => {
      expect(bodyOf(responseStream)).toContain('data: 1')
    })

    responseStream.destroy()

    await vi.waitFor(() => {
      expect(clean).toBe(true)
    })

    await sendPromise
  })

  describe('response stream closed before sending', () => {
    it('resolves and destroys the body', async () => {
      const responseStream = createResponseStream()
      responseStream.destroy()

      await vi.waitFor(() => {
        expect(responseStream.closed).toBe(true)
      })

      let clean = false
      const standardResponse: StandardResponse = {
        body: (async function* () {
          try {
            yield 1
          }
          finally {
            clean = true
          }
        })(),
        headers: {},
        status: 200,
      }

      await expect(sendStandardResponse(responseStream, standardResponse)).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })

      expect(fromSpy).not.toHaveBeenCalled()
    })

    it('rejects when the response stream was destroyed with an error', async () => {
      const responseStream = createResponseStream()
      responseStream.once('error', () => {})
      responseStream.destroy(new Error('test'))

      await vi.waitFor(() => {
        expect(responseStream.closed).toBe(true)
      })

      await expect(sendStandardResponse(responseStream, {
        status: 200,
        headers: {},
        body: { foo: 'bar' },
      })).rejects.toThrow('test')

      expect(fromSpy).not.toHaveBeenCalled()
    })
  })
})

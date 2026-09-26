import type { EventStreamMessage } from './types'
import { decodeEventStreamMessage, EventStreamDecoder, EventStreamDecoderStream } from './decoder'

function feedAll(chunks: string[]): EventStreamMessage[] {
  const events: EventStreamMessage[] = []
  const decoder = new EventStreamDecoder(event => events.push(event))

  for (const chunk of chunks) {
    decoder.feed(chunk)
  }

  decoder.end()

  return events
}

describe('decodeEventStreamMessage', () => {
  it('decodes an empty message', () => {
    expect(decodeEventStreamMessage('\n')).toEqual({})
  })

  it('decodes event, data, id, and retry fields', () => {
    expect(decodeEventStreamMessage('event: message\n\n')).toEqual({
      event: 'message',
    })

    expect(decodeEventStreamMessage('event: message\ndata: hello\ndata: world\nid: 123\nretry: 10000\n\n')).toEqual({
      event: 'message',
      data: 'hello\nworld',
      id: '123',
      retry: 10000,
    })
  })

  it('joins multi-line data with newlines', () => {
    expect(decodeEventStreamMessage('event: message\ndata: hello\ndata: world\n\n')).toEqual({
      event: 'message',
      data: 'hello\nworld',
    })
  })

  it('collects comments', () => {
    expect(decodeEventStreamMessage(': hi\n: hello\nevent: message\ndata: hello\ndata: world\n\n')).toEqual({
      event: 'message',
      data: 'hello\nworld',
      comments: ['hi', 'hello'],
    })
  })

  it('strips a single leading space from values', () => {
    expect(decodeEventStreamMessage(':hi\nevent:message\ndata:hello\ndata:world\n\n')).toEqual({
      event: 'message',
      data: 'hello\nworld',
      comments: ['hi'],
    })

    expect(decodeEventStreamMessage(':  hi\nevent:  message\ndata:  hello\ndata:  world\n\n')).toEqual({
      event: ' message',
      data: ' hello\n world',
      comments: [' hi'],
    })

    // Per spec, only a single U+0020 SPACE is stripped — not tabs.
    expect(decodeEventStreamMessage('data:\thello\n\n')).toEqual({
      data: '\thello',
    })
  })

  it('supports LF, CR, and CRLF line endings', () => {
    expect(decodeEventStreamMessage('event: message\rdata: hello\r\ndata: world\rid: 123\r\nretry: 10000\r\r\n')).toEqual({
      event: 'message',
      data: 'hello\nworld',
      id: '123',
      retry: 10000,
    })
  })

  it('treats lines without a colon as fields with empty values', () => {
    expect(decodeEventStreamMessage('data\n\n')).toEqual({ data: '' })
    expect(decodeEventStreamMessage('data:\n\n')).toEqual({ data: '' })
    expect(decodeEventStreamMessage('data: a\ndata:\ndata: b\n\n')).toEqual({ data: 'a\n\nb' })
    expect(decodeEventStreamMessage('event\ndata: x\n\n')).toEqual({ event: '', data: 'x' })
  })

  it('ignores unknown and case-mismatched keys', () => {
    expect(decodeEventStreamMessage('foo: bar\n\n')).toEqual({})
    expect(decodeEventStreamMessage('Data: x\nEVENT: y\n\n')).toEqual({})
  })

  it('last duplicate key wins', () => {
    expect(decodeEventStreamMessage('id: 123\nid: 456\n\n')).toEqual({
      id: '456',
    })
  })

  it('accepts only canonical non-negative integer retry values', () => {
    expect(decodeEventStreamMessage('retry: 0\n\n')).toEqual({ retry: 0 })

    expect(decodeEventStreamMessage('retry: hello\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry: 1.5\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry: -1\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry: 1abc\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry: Infinity\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry: 010\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry: +10\n\n')).toEqual({})
    expect(decodeEventStreamMessage('retry:  10\n\n')).toEqual({}) // extra space survives the single-space strip
  })
})

describe('eventStreamDecoder', () => {
  describe('feeding', () => {
    it('decodes a single message in a single feed', () => {
      expect(feedAll(['event: message\ndata: hello\n\n'])).toEqual([
        { event: 'message', data: 'hello' },
      ])
    })

    it('decodes messages split across feeds and multiple messages per feed', () => {
      const events = feedAll([
        'event: message\n',
        'data: hello1\n',
        'data: world\n\n',
        'event: message\ndata: hello2\ndata: world\n\n',
        // NOTE: a chunk can contain 1.5 events (a partial message); this is an important test—be careful when modifying.
        'event: message\ndata: hello3\ndata: world\n\nevent: message\ndata: hello4\n',
        'data: world\nid: 123\nretry: 10000\n\nevent: done\ndata: hello5\ndata: world\nid: 123\nretry: 10000\n',
        '\n',
      ])

      expect(events).toEqual([
        { event: 'message', data: 'hello1\nworld' },
        { event: 'message', data: 'hello2\nworld' },
        { event: 'message', data: 'hello3\nworld' },
        { event: 'message', data: 'hello4\nworld', id: '123', retry: 10000 },
        { event: 'done', data: 'hello5\nworld', id: '123', retry: 10000 },
      ])
    })

    it('ignores empty chunks', () => {
      expect(feedAll(['', 'data: hello', '', '\n\n', ''])).toEqual([
        { data: 'hello' },
      ])
    })

    it('emits the same events regardless of chunk size', () => {
      const stream = '\n\nevent: a\r\ndata: 1\r\n\r\n\r\n: comment\ndata: 2\ndata: 3\n\n\n\nid: 9\rretry: 50\rdata: 4\r\r\revent: done\ndata: bye\n\n\r\n'

      const expected = feedAll([stream])
      expect(expected).toHaveLength(4)

      for (const size of [1, 2, 3, 4, 5, 7, 11]) {
        const chunks: string[] = []
        for (let i = 0; i < stream.length; i += size) {
          chunks.push(stream.slice(i, i + size))
        }

        expect(feedAll(chunks), `chunk size ${size}`).toEqual(expected)
      }
    })

    it('decodes a large message fed in many small chunks', () => {
      const value = 'x'.repeat(64 * 1024)
      const stream = `event: big\ndata: ${value}\ndata: ${value}\n\n`

      const chunks: string[] = []
      for (let i = 0; i < stream.length; i += 251) {
        chunks.push(stream.slice(i, i + 251))
      }

      expect(feedAll(chunks)).toEqual([
        { event: 'big', data: `${value}\n${value}` },
      ])
    })
  })

  describe('delimiters across chunk boundaries', () => {
    // Per spec, a blank line with nothing buffered dispatches nothing, so
    // leading and extra blank lines are ignored.
    it('handles every delimiter split at every position', () => {
      for (const delimiter of ['\n\n', '\r\r', '\n\r', '\n\r\n', '\r\n\n', '\r\n\r\n', '\n\n\n', '\r\r\r', '\r\n\r\n\r\n', '\n\r\n\r\n']) {
        const stream = `${delimiter}data: first${delimiter}data: second${delimiter}`

        for (let split = 1; split < stream.length; split++) {
          const events = feedAll([stream.slice(0, split), stream.slice(split)])

          expect(events, `delimiter ${JSON.stringify(delimiter)} split at ${split}`).toEqual([
            { data: 'first' },
            { data: 'second' },
          ])
        }
      }
    })

    it('handles CR & CRLF delimiters', () => {
      const events = feedAll([
        'event: message\rdata: hello\r\ndata: world\r',
        '\r\nevent: done\r',
        'data: bye\r\n\r',
      ])

      expect(events).toEqual([
        { event: 'message', data: 'hello\nworld' },
        { event: 'done', data: 'bye' },
      ])
    })

    it('handles CRLF line endings split across chunks', () => {
      const events = feedAll([
        'event: message\r',
        '\ndata: hello\r',
        '\ndata: world\r',
        '\n\r',
        '\n',
        'event: done\rdata: bye\r\r',
      ])

      expect(events).toEqual([
        { event: 'message', data: 'hello\nworld' },
        { event: 'done', data: 'bye' },
      ])
    })

    it('drops the LF of a CRLF delimiter split across an empty chunk', () => {
      const events = feedAll([
        'data: first\n\r',
        '',
        '\n\ndata: second\n\n',
      ])

      expect(events).toEqual([
        { data: 'first' },
        { data: 'second' },
      ])
    })

    // Per spec, the '\n' completes the buffered '\r' into a single CRLF line
    // ending, so the following '\n' is a blank line terminating the message.
    it('handles a CRLF+LF delimiter split between the CR and LF', () => {
      const events = feedAll([
        'data: first\r',
        '\n\ndata: second\n\n',
      ])

      expect(events).toEqual([
        { data: 'first' },
        { data: 'second' },
      ])
    })
  })

  describe('end', () => {
    it('does not throw when nothing was fed or the stream completed cleanly', () => {
      const decoder = new EventStreamDecoder(() => {})
      expect(() => decoder.end()).not.toThrow()

      decoder.feed('data: hello\n\n')
      expect(() => decoder.end()).not.toThrow()
    })

    it('throws when the stream ends with an incomplete message', () => {
      const events: EventStreamMessage[] = []
      const decoder = new EventStreamDecoder(event => events.push(event))

      decoder.feed('event: message\ndata: hello1\ndata: world\n\n')
      decoder.feed('event: message\ndata: hello2\ndata: world\nid: 123\nretry: 10000\n')

      expect(() => decoder.end()).toThrowError('Event Stream ended before complete')

      expect(events).toEqual([
        { event: 'message', data: 'hello1\nworld' },
      ])
    })
  })
})

describe('eventStreamDecoderStream', () => {
  it('on success', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('event: message\ndata: hello1\ndata: world\n\n')
        controller.enqueue('event: message\ndata: hello2\ndata: world\nid: 123\nretry: 10000\n\n')
        controller.enqueue('event: message\ndata: hello3\ndata: world\nid: 123\nretry: 10000\n\n')
        controller.enqueue('event: done\n')
        controller.enqueue('data: hello4\n')
        controller.enqueue('data: world\n\n')
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const response = new Response(stream)

    const eventStream = response.body!
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventStreamDecoderStream())

    const messages: EventStreamMessage[] = []

    for await (const message of eventStream) {
      messages.push(message)
    }

    expect(messages).toEqual([
      {
        data: 'hello1\nworld',
        event: 'message',
        id: undefined,
        retry: undefined,
      },
      {
        data: 'hello2\nworld',
        event: 'message',
        id: '123',
        retry: 10000,
      },
      {
        data: 'hello3\nworld',
        event: 'message',
        id: '123',
        retry: 10000,
      },
      {
        data: 'hello4\nworld',
        event: 'done',
        id: undefined,
        retry: undefined,
      },
    ])
  })

  it('imports without TransformStream in the global scope', async ({ onTestFinished }) => {
    vi.stubGlobal('TransformStream', undefined)
    vi.resetModules()

    onTestFinished(() => {
      vi.unstubAllGlobals()
      vi.resetModules()
    })

    const module = await import('./decoder')

    expect(module.EventStreamDecoderStream).toBeDefined()
    expect(module.decodeEventStreamMessage('data: hello\n\n')).toEqual({ data: 'hello' })
  })

  it('on incomplete message', async () => {
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('event: message\ndata: hello1\ndata: world\n\n')
        controller.enqueue('event: message\ndata: hello2\ndata: world\nid: 123\nretry: 10000\n')
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const response = new Response(stream)

    const eventStream = response.body!
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventStreamDecoderStream())

    const messages: EventStreamMessage[] = []

    await expect(async () => {
      for await (const message of eventStream) {
        messages.push(message)
      }
    }).rejects.toThrowError('Event Stream ended before complete')

    expect(messages).toEqual([
      {
        data: 'hello1\nworld',
        event: 'message',
        id: undefined,
        retry: undefined,
      },
    ])
  })
})

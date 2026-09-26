import type { EventStreamMessage } from './types'
import { decodeEventStreamMessage } from './decoder'
import {
  assertEventStreamMessageComment,
  assertEventStreamMessageId,
  assertEventStreamMessageName,
  assertEventStreamMessageRetry,
  encodeEventStreamMessage,
  encodeEventStreamMessageComments,
  encodeEventStreamMessageData,
  isEventStreamMessageComment,
  isEventStreamMessageId,
  isEventStreamMessageRetry,
} from './encoder'

describe('predicates', () => {
  it('accept valid values', () => {
    expect(isEventStreamMessageId('')).toBe(true)
    expect(isEventStreamMessageId('123')).toBe(true)
    expect(isEventStreamMessageComment('hi')).toBe(true)
    expect(isEventStreamMessageRetry(0)).toBe(true)
    expect(isEventStreamMessageRetry(10000)).toBe(true)
  })

  it('reject strings containing line breaks', () => {
    for (const lineBreak of ['\n', '\r', '\r\n']) {
      expect(isEventStreamMessageId(`hi${lineBreak}`)).toBe(false)
      expect(isEventStreamMessageComment(`hi${lineBreak}`)).toBe(false)
    }
  })

  it('reject ids containing NULL', () => {
    expect(isEventStreamMessageId('\0')).toBe(false)
    expect(isEventStreamMessageId('a\0b')).toBe(false)
    expect(isEventStreamMessageComment('a\0b')).toBe(true) // only ids are ignored by clients
  })

  it('reject non-integer or negative retry values', () => {
    for (const retry of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(isEventStreamMessageRetry(retry)).toBe(false)
    }
  })

  it('reject wrong types', () => {
    expect(isEventStreamMessageId(123)).toBe(false)
    expect(isEventStreamMessageComment(undefined)).toBe(false)
    expect(isEventStreamMessageRetry('3000')).toBe(false)
  })
})

describe('assertions', () => {
  it('accept values without line breaks', () => {
    expect(() => assertEventStreamMessageId('123')).not.toThrow()
    expect(() => assertEventStreamMessageName('message')).not.toThrow()
    expect(() => assertEventStreamMessageComment('hi')).not.toThrow()
    expect(() => assertEventStreamMessageRetry(0)).not.toThrow()
    expect(() => assertEventStreamMessageRetry(10000)).not.toThrow()
  })

  it('reject ids containing line breaks or NULL', () => {
    for (const char of ['\n', '\r', '\r\n', '\0']) {
      expect(() => assertEventStreamMessageId(`hi${char}`))
        .toThrow('Event\'s id must not contain a carriage return, newline or NULL character')
    }
  })

  it('reject event names containing line breaks', () => {
    for (const lineBreak of ['\n', '\r', '\r\n']) {
      expect(() => assertEventStreamMessageName(`hi${lineBreak}`))
        .toThrow('Event\'s event must not contain a carriage return or newline character')
    }
  })

  it('reject comments containing line breaks', () => {
    for (const lineBreak of ['\n', '\r', '\r\n']) {
      expect(() => assertEventStreamMessageComment(`hi${lineBreak}`))
        .toThrow('Event\'s comment must not contain a carriage return or newline character')
    }
  })

  it('reject non-integer or negative retry values', () => {
    for (const retry of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => assertEventStreamMessageRetry(retry))
        .toThrow('Event\'s retry must be a integer and >= 0')
    }
  })
})

describe('encodeEventStreamMessageData', () => {
  it('encodes undefined as no output', () => {
    expect(encodeEventStreamMessageData(undefined)).toBe('')
  })

  it('encodes single-line data', () => {
    expect(encodeEventStreamMessageData('hello')).toBe('data: hello\n')
    expect(encodeEventStreamMessageData('')).toBe('data: \n')
  })

  it('splits multi-line data into one data field per line', () => {
    expect(encodeEventStreamMessageData('hello\nworld')).toBe('data: hello\ndata: world\n')
    expect(encodeEventStreamMessageData('hello\rworld')).toBe('data: hello\ndata: world\n')
    expect(encodeEventStreamMessageData('hello\r\nworld')).toBe('data: hello\ndata: world\n')
  })

  it('preserves trailing line endings as an empty data field', () => {
    expect(encodeEventStreamMessageData('hello\nworld\n')).toBe('data: hello\ndata: world\ndata: \n')
    expect(encodeEventStreamMessageData('hello\rworld\r')).toBe('data: hello\ndata: world\ndata: \n')
    expect(encodeEventStreamMessageData('hello\r\nworld\r\n')).toBe('data: hello\ndata: world\ndata: \n')
  })
})

describe('encodeEventStreamMessageComments', () => {
  it('encodes undefined or empty comments as no output', () => {
    expect(encodeEventStreamMessageComments(undefined)).toBe('')
    expect(encodeEventStreamMessageComments([])).toBe('')
  })

  it('encodes each comment on its own line', () => {
    expect(encodeEventStreamMessageComments(['hello'])).toBe(': hello\n')
    expect(encodeEventStreamMessageComments(['hello', 'world'])).toBe(': hello\n: world\n')
  })

  it('rejects comments containing line breaks', () => {
    expect(() => encodeEventStreamMessageComments(['hi\n']))
      .toThrow('Event\'s comment must not contain a carriage return or newline character')
  })
})

describe('encodeEventStreamMessage', () => {
  it('encodes an empty message as a bare delimiter', () => {
    expect(encodeEventStreamMessage({})).toBe('\n')
  })

  it('encodes fields in order: comments, event, retry, id, data', () => {
    expect(encodeEventStreamMessage({ event: 'message', data: 'hello\nworld' }))
      .toBe('event: message\ndata: hello\ndata: world\n\n')

    expect(encodeEventStreamMessage({ event: 'message', id: '123', retry: 10000 }))
      .toBe('event: message\nretry: 10000\nid: 123\n\n')

    expect(encodeEventStreamMessage({ event: 'message', id: '123', retry: 10000, comments: ['hello', 'world'] }))
      .toBe(': hello\n: world\nevent: message\nretry: 10000\nid: 123\n\n')
  })

  it('round-trips through decodeEventStreamMessage', () => {
    const messages: EventStreamMessage[] = [
      {},
      { data: 'hello' },
      { data: 'hello\nworld\n' },
      { event: 'message', data: 'hello', id: '123', retry: 10000, comments: ['hi'] },
    ]

    for (const message of messages) {
      expect(decodeEventStreamMessage(encodeEventStreamMessage(message))).toEqual(message)
    }
  })

  it('rejects an invalid event name', () => {
    for (const lineBreak of ['\n', '\r', '\r\n']) {
      expect(() => encodeEventStreamMessage({ event: `hi${lineBreak}` }))
        .toThrow('Event\'s event must not contain a carriage return or newline character')
    }
  })

  it('rejects an invalid id', () => {
    for (const char of ['\n', '\r', '\r\n', '\0']) {
      expect(() => encodeEventStreamMessage({ event: 'message', id: `hi${char}` }))
        .toThrow('Event\'s id must not contain a carriage return, newline or NULL character')
    }
  })

  it('rejects an invalid retry', () => {
    for (const retry of [Number.NaN, -1, 1.5]) {
      expect(() => encodeEventStreamMessage({ event: 'message', retry }))
        .toThrow('Event\'s retry must be a integer and >= 0')
    }
  })

  it('rejects an invalid comment', () => {
    for (const lineBreak of ['\n', '\r', '\r\n']) {
      expect(() => encodeEventStreamMessage({ event: 'message', comments: [`hi${lineBreak}`] }))
        .toThrow('Event\'s comment must not contain a carriage return or newline character')
    }
  })
})

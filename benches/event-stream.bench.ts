import {
  decodeEventStreamMessage,
  encodeEventStreamMessage,
  EventStreamDecoder,
} from '@standard-server/core'
import { bench, describe } from 'vitest'

const SIZE_1KB = 1024
const SIZE_100KB = 100 * SIZE_1KB

const SMALL_MESSAGE = {
  event: 'message',
  id: '123',
  retry: 10000,
  data: 'hello world',
  comments: ['keep-alive'],
}

const SINGLE_LINE_MESSAGE_100KB = {
  event: 'message',
  data: 'x'.repeat(SIZE_100KB),
}

/** 2048 lines x 50 chars = 100KB of data. */
const MULTI_LINE_MESSAGE_100KB = {
  event: 'message',
  data: Array.from({ length: 2048 }, (_, i) => `line-${i}`.padEnd(49, 'x')).join('\n'),
}

const ENCODED_SMALL_MESSAGE = encodeEventStreamMessage(SMALL_MESSAGE)

const ENCODED_100_SMALL_MESSAGES = ENCODED_SMALL_MESSAGE.repeat(100)

const ENCODED_LARGE_MESSAGE = encodeEventStreamMessage(SINGLE_LINE_MESSAGE_100KB)

/** The large message chopped into 1KB chunks, as a streaming transport would deliver it. */
const ENCODED_LARGE_MESSAGE_1KB_CHUNKS = Array.from(
  { length: Math.ceil(ENCODED_LARGE_MESSAGE.length / SIZE_1KB) },
  (_, i) => ENCODED_LARGE_MESSAGE.slice(i * SIZE_1KB, (i + 1) * SIZE_1KB),
)

describe('event stream encode', () => {
  bench('small message', () => {
    encodeEventStreamMessage(SMALL_MESSAGE)
  })

  bench('single-line data 100KB', () => {
    encodeEventStreamMessage(SINGLE_LINE_MESSAGE_100KB)
  })

  bench('multi-line data 100KB (2k lines)', () => {
    encodeEventStreamMessage(MULTI_LINE_MESSAGE_100KB)
  })
})

describe('event stream decode', () => {
  bench('small message', () => {
    decodeEventStreamMessage(ENCODED_SMALL_MESSAGE)
  })

  bench('100 small messages in one chunk', () => {
    const decoder = new EventStreamDecoder(() => {})
    decoder.feed(ENCODED_100_SMALL_MESSAGES)
    decoder.end()
  })

  bench('100 small messages in 1KB chunks', () => {
    const decoder = new EventStreamDecoder(() => {})
    for (let i = 0; i < ENCODED_100_SMALL_MESSAGES.length; i += SIZE_1KB) {
      decoder.feed(ENCODED_100_SMALL_MESSAGES.slice(i, i + SIZE_1KB))
    }
    decoder.end()
  })

  bench('large message 100KB in one chunk', () => {
    const decoder = new EventStreamDecoder(() => {})
    decoder.feed(ENCODED_LARGE_MESSAGE)
    decoder.end()
  })

  bench('large message 100KB in 1KB chunks', () => {
    const decoder = new EventStreamDecoder(() => {})
    for (const chunk of ENCODED_LARGE_MESSAGE_1KB_CHUNKS) {
      decoder.feed(chunk)
    }
    decoder.end()
  })
})

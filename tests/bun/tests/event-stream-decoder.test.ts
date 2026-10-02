import { describe, expect, it } from 'bun:test'

import type { EventStreamMessage } from '@standard-server/core'
import { EventStreamDecoder } from '@standard-server/core'

function feedAll(chunks: string[]): EventStreamMessage[] {
  const events: EventStreamMessage[] = []
  const decoder = new EventStreamDecoder((event) => events.push(event))

  for (const chunk of chunks) {
    decoder.feed(chunk)
  }

  decoder.end()

  return events
}

/**
 * The decoder's unit tests run on Node (V8). These repeat the line ending
 * cases on JavaScriptCore, whose regex engine is a separate implementation.
 */
describe('event stream decoder on JavaScriptCore', () => {
  it('does not treat a single CR or CRLF line ending as a blank line', () => {
    for (const eol of ['\n', '\r', '\r\n']) {
      expect(
        feedAll([`event: update${eol}data: 42${eol}${eol}`]),
        `line ending ${JSON.stringify(eol)}`,
      ).toEqual([{ event: 'update', data: '42' }])
    }
  })

  it('handles every delimiter split at every position', () => {
    for (const delimiter of [
      '\n\n',
      '\r\r',
      '\n\r',
      '\n\r\n',
      '\r\n\n',
      '\r\n\r\n',
      '\n\n\n',
      '\r\r\r',
      '\r\n\r\n\r\n',
      '\n\r\n\r\n',
    ]) {
      const stream = `${delimiter}data: first${delimiter}data: second${delimiter}`

      for (let split = 1; split < stream.length; split++) {
        const events = feedAll([stream.slice(0, split), stream.slice(split)])

        expect(events, `delimiter ${JSON.stringify(delimiter)} split at ${split}`).toEqual([
          { event: 'message', data: 'first' },
          { event: 'message', data: 'second' },
        ])
      }
    }
  })
})

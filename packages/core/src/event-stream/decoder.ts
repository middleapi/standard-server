import type { EventStreamMessage } from './types'
import { isEventStreamMessageId, isEventStreamMessageRetry } from './encoder'
import { EventStreamDecoderError } from './error'

// A line ending is CR, LF or CRLF.
const LINE_ENDING_REGEX = /\r\n|\r(?!\n)|\n/
// A message ends at a blank line; any extra blank lines after it are part of
// the same delimiter, since the spec treats them as no-ops.
const MESSAGE_DELIMITER_REGEX = /(?:\r\n|\r(?!\n)|\n){2,}/g
const LEADING_LINE_ENDINGS_REGEX = /^[\r\n]+/

// JS `\d` matches ASCII digits only, as the spec requires for retry.
const ASCII_DIGITS_REGEX = /^\d+$/

// Pending text never contains a blank line, so it ends in at most one line
// ending ('\r\n'). A delimiter crossing a chunk boundary therefore starts
// within its last 2 characters.
const MAX_DELIMITER_OVERLAP = 2

const SPACE = 0x20

export function decodeEventStreamMessage(encoded: string): EventStreamMessage {
  const message: EventStreamMessage & { comments?: string[] } = {}

  for (const line of encoded.split(LINE_ENDING_REGEX)) {
    if (line === '') {
      continue
    }

    const index = line.indexOf(':')

    // The value may be prefixed by a single space
    // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
    const value = index === -1
      ? ''
      : line.slice(line.charCodeAt(index + 1) === SPACE ? index + 2 : index + 1)

    if (index === 0) { // comment starting with ':'
      (message.comments ??= []).push(value)
      continue
    }

    switch (index === -1 ? line : line.slice(0, index)) {
      case 'data':
        // data can be sent in multiple lines if containing newlines
        // https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
        message.data = message.data === undefined
          ? value
          : `${message.data}\n${value}`
        break

      case 'event':
        message.event = value
        break

      case 'id':
        // Per spec, an id containing U+0000 NULL is ignored and the previous id is kept.
        if (isEventStreamMessageId(value)) {
          message.id = value
        }
        break

      case 'retry': {
        const retry = Number.parseInt(value, 10)

        // parseInt returns Infinity for 309+ digits, which withEventMeta would reject.
        if (ASCII_DIGITS_REGEX.test(value) && isEventStreamMessageRetry(retry)) {
          message.retry = retry
        }
        break
      }
    }
  }

  return message
}

export class EventStreamDecoder {
  // The incomplete message: empty, or text that neither starts with a line
  // ending nor contains a blank line.
  private pending: string[] = []
  // Last MAX_DELIMITER_OVERLAP characters of the pending text, prefixed to the
  // next chunk so a delimiter straddling the boundary is still found.
  private tail: string = ''

  constructor(
    private readonly onEvent: (event: EventStreamMessage) => void,
  ) {
  }

  feed(chunk: string): void {
    // Line endings between messages are extra blank lines (or the '\n' of a
    // CRLF split after a delimiter), so they carry no content.
    if (this.pending.length === 0) {
      chunk = chunk.replace(LEADING_LINE_ENDINGS_REGEX, '')
    }

    // empty chunk has no meaningful content to process
    if (chunk === '') {
      return
    }

    const scan = this.tail + chunk
    this.pending.push(chunk)

    MESSAGE_DELIMITER_REGEX.lastIndex = 0
    let match = MESSAGE_DELIMITER_REGEX.exec(scan)

    if (match === null) {
      this.tail = scan.slice(-MAX_DELIMITER_OVERLAP)
      return
    }

    const buffered = this.pending.join('')
    const offset = buffered.length - scan.length
    const parts: string[] = []
    let start = 0

    while (match !== null) {
      parts.push(buffered.slice(start, offset + match.index))
      start = offset + match.index + match[0].length
      match = MESSAGE_DELIMITER_REGEX.exec(scan)
    }

    const incomplete = buffered.slice(start)
    this.pending = incomplete === '' ? [] : [incomplete]
    this.tail = incomplete.slice(-MAX_DELIMITER_OVERLAP)

    for (const encoded of parts) {
      this.onEvent(decodeEventStreamMessage(encoded))
    }
  }

  end(): void {
    if (this.pending.length !== 0) {
      throw new EventStreamDecoderError('Event Stream ended before complete')
    }
  }
}

export class EventStreamDecoderStream {
  readonly readable: ReadableStream<EventStreamMessage>
  readonly writable: WritableStream<string>

  constructor() {
    let decoder!: EventStreamDecoder

    const transform = new TransformStream<string, EventStreamMessage>({
      start(controller) {
        decoder = new EventStreamDecoder((event) => {
          controller.enqueue(event)
        })
      },
      transform(chunk) {
        decoder.feed(chunk)
      },
      flush() {
        decoder.end()
      },
    })

    this.readable = transform.readable
    this.writable = transform.writable
  }
}

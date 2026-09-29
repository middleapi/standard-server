import type { EventStreamMessage } from './types'
import { isEventStreamMessageId, isEventStreamMessageRetry } from './encoder'
import { EventStreamDecoderError } from './error'

// A line ending is CR, LF or CRLF.
const LINE_ENDING_REGEX = /\r\n?|\n/
// A message ends at a blank line; any extra blank lines after it are part of
// the same delimiter, since the spec treats them as no-ops. No quantified group,
// which JavaScriptCore runs ~100x slower; {3,} goes first to consume the run.
const MESSAGE_DELIMITER_REGEX = /[\r\n]{3,}|\r\r|\n[\r\n]/g
const LEADING_LINE_ENDINGS_REGEX = /^[\r\n]+/
// A line ending followed by the first character of the next line.
const LINE_START_REGEX = /[\r\n][^\r\n]/g

// JS `\d` matches ASCII digits only, as the spec requires for retry.
const ASCII_DIGITS_REGEX = /^\d+$/

// Pending text never contains a blank line, so it ends in at most one line
// ending ('\r\n'). A delimiter crossing a chunk boundary therefore starts
// within its last 2 characters.
const MAX_DELIMITER_OVERLAP = 2

const SPACE = 0x20
const LF = 0x0A
const CR = 0x0D

export function decodeEventStreamMessage(encoded: string): EventStreamMessage {
  const message: EventStreamMessage = {}

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

  // Per spec, a message with no (or an empty) event name is a 'message' event if it has
  // data, even an empty `data:` line. Without data it is never dispatched.
  // https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
  if (!message.event) {
    if (message.data === undefined) {
      delete message.event
    }
    else {
      message.event = 'message'
    }
  }

  return message
}

// Counts the characters in text[from, to) that start a line: those that are
// not a line ending and follow one. The character at index 0 has nothing
// before it, so it starts a line too.
function countLineStarts(text: string, from: number, to: number): number {
  let count = 0

  if (from === 0 && to > 0) {
    const first = text.charCodeAt(0)

    if (first !== LF && first !== CR) {
      count++
    }
  }

  // test() leaves lastIndex just past the matched line start
  LINE_START_REGEX.lastIndex = from === 0 ? 0 : from - 1

  while (LINE_START_REGEX.test(text) && LINE_START_REGEX.lastIndex <= to) {
    count++
  }

  return count
}

export interface EventStreamDecoderOptions {
  /**
   * The maximum size of a single message, in characters (UTF-16 code units),
   * not counting the line breaks that end it. A message that grows past it fails
   * the decoder with an `EventStreamDecoderError`, so a sender that never ends a
   * message cannot make the decoder buffer without bound.
   *
   * @default Infinity
   */
  maxMessageSize?: number

  /**
   * The maximum number of lines (fields and comments) in a single message.
   * A message with more lines fails the decoder with an `EventStreamDecoderError`.
   * Each line decodes into its own string, so this bounds the memory of decoding
   * a message made of many short lines.
   *
   * @default Infinity
   */
  maxMessageLines?: number
}

export class EventStreamDecoder {
  // The incomplete message: empty, or text that neither starts with a line
  // ending nor contains a blank line.
  private pending: string[] = []
  // Last MAX_DELIMITER_OVERLAP characters of the pending text, prefixed to the
  // next chunk so a delimiter straddling the boundary is still found.
  private tail: string = ''
  // Length of the pending text.
  private size: number = 0
  // Lines started in the pending text, only counted when maxMessageLines is set.
  private lines: number = 0
  // Set once a message exceeds a limit; the decoder then rejects any further input.
  private error: EventStreamDecoderError | undefined

  private readonly maxMessageSize: number
  private readonly maxMessageLines: number

  constructor(
    private readonly onEvent: (event: EventStreamMessage) => void,
    options: EventStreamDecoderOptions = {},
  ) {
    this.maxMessageSize = options.maxMessageSize ?? Infinity
    this.maxMessageLines = options.maxMessageLines ?? Infinity
  }

  feed(chunk: string): void {
    if (this.error !== undefined) {
      throw this.error
    }

    // Line endings between messages are extra blank lines (or the '\n' of a
    // CRLF split after a delimiter), so they carry no content.
    if (this.pending.length === 0) {
      const first = chunk.charCodeAt(0)

      if (first === LF || first === CR) {
        chunk = chunk.replace(LEADING_LINE_ENDINGS_REGEX, '')
      }
    }

    // empty chunk has no meaningful content to process
    if (chunk === '') {
      return
    }

    const countLines = this.maxMessageLines !== Infinity
    const scan = this.tail + chunk
    this.pending.push(chunk)

    MESSAGE_DELIMITER_REGEX.lastIndex = 0
    let match = MESSAGE_DELIMITER_REGEX.exec(scan)

    if (match === null) {
      this.tail = scan.slice(-MAX_DELIMITER_OVERLAP)
      this.size += chunk.length

      if (countLines) {
        this.lines += countLineStarts(scan, scan.length - chunk.length, scan.length)
      }

      const error = this.checkPending()

      if (error !== undefined) {
        this.fail(error)
        throw error
      }

      return
    }

    const buffered = this.pending.length === 1 ? chunk : this.pending.join('')
    const offset = buffered.length - scan.length
    const parts: string[] = []
    let start = 0
    // Where the current message's unscanned lines start in `scan`; the lines
    // before it, in earlier chunks, are already counted.
    let linesFrom = scan.length - chunk.length
    let lines = this.lines
    let error: EventStreamDecoderError | undefined

    while (match !== null) {
      const part = buffered.slice(start, offset + match.index)

      if (countLines) {
        lines += countLineStarts(scan, linesFrom, match.index)
      }

      error = this.check(part.length, lines)

      if (error !== undefined) {
        break
      }

      parts.push(part)
      start = offset + match.index + match[0].length
      linesFrom = match.index + match[0].length
      lines = 0
      match = MESSAGE_DELIMITER_REGEX.exec(scan)
    }

    if (error === undefined) {
      const incomplete = buffered.slice(start)
      this.pending = incomplete === '' ? [] : [incomplete]
      this.tail = incomplete.slice(-MAX_DELIMITER_OVERLAP)
      this.size = incomplete.length
      this.lines = countLines ? lines + countLineStarts(scan, linesFrom, scan.length) : 0
      error = this.checkPending()
    }

    if (error !== undefined) {
      this.fail(error)
    }

    // Messages before the one over a limit are still delivered, as they would
    // be had they arrived in earlier chunks.
    for (const encoded of parts) {
      this.onEvent(decodeEventStreamMessage(encoded))
    }

    if (error !== undefined) {
      throw error
    }
  }

  end(): void {
    if (this.error !== undefined) {
      throw this.error
    }

    if (this.pending.length !== 0) {
      throw new EventStreamDecoderError('Event Stream ended before complete')
    }
  }

  private check(size: number, lines: number): EventStreamDecoderError | undefined {
    if (size > this.maxMessageSize) {
      return new EventStreamDecoderError(`Event Stream message exceeded the maximum size of ${this.maxMessageSize} characters`)
    }

    if (lines > this.maxMessageLines) {
      return new EventStreamDecoderError(`Event Stream message exceeded the maximum line count of ${this.maxMessageLines}`)
    }

    return undefined
  }

  private checkPending(): EventStreamDecoderError | undefined {
    let size = this.size

    // The pending text may end in a line ending ('\r', '\n' or '\r\n') that
    // turns out to start the delimiter, so it only counts once more text
    // follows it. That keeps the limit independent of where chunks split.
    if (size > this.maxMessageSize) {
      const last = this.tail.charCodeAt(this.tail.length - 1)

      if (last === LF) {
        size -= this.tail.charCodeAt(this.tail.length - 2) === CR ? 2 : 1
      }
      else if (last === CR) {
        size -= 1
      }
    }

    return this.check(size, this.lines)
  }

  // Drops the pending text so a sender cannot keep growing it, and keeps the
  // error to reject any further input.
  private fail(error: EventStreamDecoderError): void {
    this.error = error
    this.pending = []
    this.tail = ''
    this.size = 0
    this.lines = 0
  }
}

export class EventStreamDecoderStream {
  readonly readable: ReadableStream<EventStreamMessage>
  readonly writable: WritableStream<string>

  constructor(options: EventStreamDecoderOptions = {}) {
    let decoder!: EventStreamDecoder

    const transform = new TransformStream<string, EventStreamMessage>({
      start(controller) {
        decoder = new EventStreamDecoder((event) => {
          controller.enqueue(event)
        }, options)
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

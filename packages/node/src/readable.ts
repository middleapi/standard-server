import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { IncomingMessage } from 'node:http'

/**
 * Iterates the bytes of a node readable.
 *
 * A request whose client disconnected once its whole body was sent ends with the rest
 * of that body instead of failing, see `readBodyBufferedBeforeDisconnect`.
 *
 * Written by hand: an async generator wrapper about doubles the cost per chunk.
 */
export function readNodeReadable(stream: Readable): AsyncIterableIterator<Uint8Array<ArrayBuffer>> {
  const iterator: AsyncIterator<Uint8Array<ArrayBuffer> | string> = stream[Symbol.asyncIterator]()
  // only a read that owns the body from its start knows how much of it was read
  const ownsBody = !stream.readableDidRead
  let readLength = 0

  return {
    next: () => iterator.next().then(
      (result): IteratorResult<Uint8Array<ArrayBuffer>> => {
        if (result.done) {
          return result
        }

        const bytes = toBytes(result.value, stream.readableEncoding)
        readLength += bytes.length
        return { done: false, value: bytes }
      },
      (error): IteratorResult<Uint8Array<ArrayBuffer>> => {
        const rest = ownsBody ? readBodyBufferedBeforeDisconnect(stream, readLength) : undefined

        if (rest === undefined) {
          throw error
        }

        // the failed iterator is done, so the read after the rest ends there
        return rest.length > 0 ? { done: false, value: rest } : { done: true, value: undefined }
      },
    ),
    async return(value) {
      await iterator.return?.()
      return { done: true, value }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

const RECOVERED_REQUESTS = new WeakSet<IncomingMessage>()

/**
 * Encodings whose decode, then encode round trip gives back the original bytes. `utf8` and `utf16le`
 * replace invalid sequences, and `ascii` drops the high bit, so the length check below cannot vouch for them.
 */
const BYTE_EXACT_ENCODINGS = new Set<BufferEncoding | null>([null, 'latin1', 'binary', 'hex', 'base64', 'base64url'])

/**
 * A client can disconnect after node parsed its whole http1 request, but before the handler
 * read all of its body: node then destroys the request, with the unread body still buffered in it.
 * Returns what is left of that body once, or `undefined` when it cannot be recovered.
 *
 * `readLength` is how many bytes a read that owns the body from its start already took out of it.
 *
 * http2 is left out: a stream reset discards the buffered data, and `complete` is not reliable there.
 */
export function readBodyBufferedBeforeDisconnect(req: Readable, readLength = 0): Uint8Array<ArrayBuffer> | undefined {
  if (
    !(req instanceof IncomingMessage)
    || !req.complete
    || !req.readableAborted
    || (readLength === 0 && req.readableDidRead)
    // any other error (e.g. a body size guard destroying the request) must surface
    || (req.errored as NodeJS.ErrnoException | null)?.code !== 'ECONNRESET'
    || !BYTE_EXACT_ENCODINGS.has(req.readableEncoding)
    || RECOVERED_REQUESTS.has(req)
  ) {
    return undefined
  }

  RECOVERED_REQUESTS.add(req)

  const chunk: Buffer<ArrayBuffer> | string | null = req.read()
  const rest = chunk === null ? new Uint8Array() : toBytes(chunk, req.readableEncoding)

  // `read()` on a destroyed stream does not flag it as read, so something
  // may have taken part of the body without `readableDidRead` noticing
  const contentLength = req.headers['content-length']
  if (contentLength !== undefined && /^\d+$/.test(contentLength) && Number(contentLength) !== readLength + rest.length) {
    return undefined
  }

  return rest
}

/**
 * Node yields strings instead of bytes once `setEncoding()` is called on a stream,
 * encoding them back with the same encoding recovers the original bytes.
 */
function toBytes(chunk: Uint8Array<ArrayBuffer> | string, encoding: BufferEncoding | null): Uint8Array<ArrayBuffer> {
  return typeof chunk === 'string' ? Buffer.from(chunk, encoding ?? 'utf8') : chunk
}

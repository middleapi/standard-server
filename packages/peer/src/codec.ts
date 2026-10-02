import { stringifyJSON } from '@standard-server/shared'

import type { PeerMessage } from './types'
import { isPeerMessage } from './validators'

/**
 * Single-byte delimiter separating the JSON payload from trailing binary data.
 *
 * 0xFF is guaranteed not to appear in UTF-8 encoded JSON because `TextEncoder`
 * never emits this value, making the boundary unambiguous.
 */
const JSON_BINARY_DELIMITER = 0xff

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface EncodePeerMessageOptions {
  /**
   * Optional string prepended to the encoded message.
   * Used to distinguish messages when multiple protocols share the same peer.
   */
  prefix?: string
}

/**
 * Encodes a {@link PeerMessage} into a wire-safe representation.
 *
 * Encoding rules:
 * - If no binary payload is present, the message is encoded as a JSON string.
 * - If binary data exists, the output layout is:
 *
 *   [ UTF-8 (prefix + JSON) | delimiter byte | raw binary bytes ]
 *
 * The optional prefix is prepended to the JSON portion before encoding.
 */
export async function encodePeerMessage(
  message: PeerMessage,
  options: EncodePeerMessageOptions = {},
): Promise<string | Uint8Array<ArrayBuffer>> {
  if (message.binary === undefined) {
    const jsonPart = stringifyJSON(message)
    return options.prefix ? options.prefix + jsonPart : jsonPart
  }

  const jsonPart = stringifyJSON({ ...message, binary: undefined })

  const textBytes = textEncoder.encode(options.prefix ? options.prefix + jsonPart : jsonPart)

  const binaryBytes =
    message.binary instanceof Blob
      ? new Uint8Array(await message.binary.arrayBuffer())
      : message.binary

  const output = new Uint8Array(textBytes.length + 1 + binaryBytes.length)

  output.set(textBytes, 0)
  output[textBytes.length] = JSON_BINARY_DELIMITER
  output.set(binaryBytes, textBytes.length + 1)

  return output
}

export interface DecodePeerMessageOptions {
  /**
   * Optional prefix expected at the start of the encoded message.
   * If present and the message does not start with this prefix,
   * the decoder returns `matched: false`.
   */
  prefix?: string
}

/**
 * Result of a decode attempt.
 *
 * - `matched: false` indicates the input does not belong to this decoder
 *   (typically due to a prefix mismatch).
 * - `matched: true` indicates successful decoding of a {@link PeerMessage}.
 */
export type DecodePeerMessageResult =
  | { matched: false; message?: undefined }
  | { matched: true; message: PeerMessage }

/**
 * Decodes a wire-encoded {@link PeerMessage}.
 *
 * Decoding rules:
 * - String input is treated as a JSON-only message.
 * - Binary input may contain:
 *   - JSON only, or
 *   - JSON followed by binary data separated by the delimiter byte.
 *
 * If a prefix is provided, it must be present at the start of the payload
 * or the decode attempt will return `matched: false`.
 */
export function decodePeerMessage(
  encoded: string | Uint8Array<ArrayBuffer>,
  options: DecodePeerMessageOptions = {},
): DecodePeerMessageResult {
  try {
    if (typeof encoded === 'string') {
      if (options.prefix) {
        if (!encoded.startsWith(options.prefix)) {
          return { matched: false }
        }

        encoded = encoded.slice(options.prefix.length)
      }

      const message = JSON.parse(encoded) as unknown

      if (!isPeerMessage(message)) {
        return { matched: false }
      }

      return { matched: true, message }
    }

    if (options.prefix) {
      const prefixBytes = textEncoder.encode(options.prefix)

      for (let i = 0; i < prefixBytes.length; i++) {
        if (encoded[i] !== prefixBytes[i]) {
          return { matched: false }
        }
      }

      encoded = encoded.subarray(prefixBytes.length)
    }

    const separatorIndex = encoded.indexOf(JSON_BINARY_DELIMITER)

    // No separator means the payload is JSON-only.
    if (separatorIndex === -1) {
      const message = JSON.parse(textDecoder.decode(encoded)) as unknown

      if (!isPeerMessage(message)) {
        return { matched: false }
      }

      return { matched: true, message }
    }

    const jsonBytes = encoded.subarray(0, separatorIndex)
    const binaryBytes = encoded.subarray(separatorIndex + 1)

    const message = JSON.parse(textDecoder.decode(jsonBytes)) as unknown

    if (!isPeerMessage(message)) {
      return { matched: false }
    }

    message.binary = binaryBytes
    return { matched: true, message }
  } catch {
    return { matched: false }
  }
}

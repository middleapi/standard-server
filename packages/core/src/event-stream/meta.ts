import { getOrBind, isTypescriptObject } from '@standard-server/shared'

import {
  assertEventStreamMessageComment,
  assertEventStreamMessageId,
  assertEventStreamMessageRetry,
} from './encoder'
import type { EventMeta } from './types'

const EVENT_META_SYMBOL = Symbol.for('STANDARD_SERVER_EVENT_META')
const EVENT_SOURCE_SYMBOL = Symbol.for('STANDARD_SERVER_EVENT_SOURCE')
const EVENT_META_RECEIVED_SYMBOL = Symbol.for('STANDARD_SERVER_EVENT_META_RECEIVED')

/**
 * Returns a new iterator *event value* with attached, validated metadata.
 */
export function withEventMeta<T extends object>(container: T, meta: EventMeta): T {
  return attachEventMeta(container, meta, false)
}

/**
 * Like `withEventMeta`, but marks the metadata as received from the remote sender.
 * It stays readable through `getEventMeta`/`unwrapEvent`, but encoders do not emit it
 * again unless it is re-attached with `withEventMeta`.
 */
export function withReceivedEventMeta<T extends object>(container: T, meta: EventMeta): T {
  return attachEventMeta(container, meta, true)
}

function attachEventMeta<T extends object>(container: T, meta: EventMeta, received: boolean): T {
  let assertedMeta: EventMeta | undefined
  if (meta.id !== undefined) {
    assertEventStreamMessageId(meta.id)
    assertedMeta ??= {}
    assertedMeta.id = meta.id
  }

  if (meta.retry !== undefined) {
    assertEventStreamMessageRetry(meta.retry)
    assertedMeta ??= {}
    assertedMeta.retry = meta.retry
  }

  if (meta.comments !== undefined) {
    for (const comment of meta.comments) {
      assertEventStreamMessageComment(comment)
    }
    assertedMeta ??= {}
    assertedMeta.comments = meta.comments
  }

  // avoid proxy creation if no meta is asserted
  if (!assertedMeta) {
    return container
  }

  return new Proxy(container, {
    get(target, prop, _receiver) {
      if (prop === EVENT_SOURCE_SYMBOL) {
        return target
      }

      if (prop === EVENT_META_SYMBOL) {
        return assertedMeta
      }

      // answer explicitly, otherwise re-wrapping a received value would inherit the flag from its target
      if (prop === EVENT_META_RECEIVED_SYMBOL) {
        return received
      }

      return getOrBind(target, prop, { bind: prop !== 'constructor' })
    },
  })
}

/**
 * Unwraps an iterator event value and extracts its associated metadata.
 */
export function unwrapEvent<T>(container: T): [data: T, meta: EventMeta | undefined] {
  if (!isTypescriptObject(container)) {
    return [container, undefined]
  }

  const meta = (container as Record<symbol, unknown>)[EVENT_META_SYMBOL] as EventMeta | undefined
  const target =
    ((container as Record<symbol, unknown>)[EVENT_SOURCE_SYMBOL] as T | undefined) ?? container

  return [target, meta]
}

/**
 * Like `unwrapEvent`, but drops metadata received from the remote sender,
 * so relaying a decoded value never re-emits the sender's `id`, `retry` or `comments`.
 */
export function unwrapEventForEmit<T>(container: T): [data: T, meta: EventMeta | undefined] {
  const [data, meta] = unwrapEvent(container)

  if (
    meta !== undefined &&
    (container as Record<symbol, unknown>)[EVENT_META_RECEIVED_SYMBOL] === true
  ) {
    return [data, undefined]
  }

  return [data, meta]
}

/**
 * Retrieves metadata attached to a single iterator event value.
 */
export function getEventMeta(container: unknown): EventMeta | undefined {
  if (!isTypescriptObject(container)) {
    return undefined
  }

  return (container as Record<symbol, unknown>)[EVENT_META_SYMBOL] as EventMeta | undefined
}

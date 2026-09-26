import type { EventMeta } from './types'
import { getOrBind, isTypescriptObject } from '@standard-server/shared'
import { assertEventStreamMessageComment, assertEventStreamMessageId, assertEventStreamMessageRetry } from './encoder'

const EVENT_META_SYMBOL = Symbol.for('STANDARD_SERVER_EVENT_META')
const EVENT_SOURCE_SYMBOL = Symbol.for('STANDARD_SERVER_EVENT_SOURCE')

/**
 * Returns a new iterator *event value* with attached, validated metadata.
 */
export function withEventMeta<T extends object>(container: T, meta: EventMeta): T {
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
  const target = (container as Record<symbol, unknown>)[EVENT_SOURCE_SYMBOL] as T | undefined ?? container

  return [target, meta]
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

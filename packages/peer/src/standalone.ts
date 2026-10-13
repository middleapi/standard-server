/**
 * Copy a view that covers only part of its `ArrayBuffer` (e.g. Node's pooled `Buffer`),
 * so structured-clone transports don't send the whole backing buffer to the remote peer.
 *
 * A view that covers its whole buffer is returned as-is.
 */
export function toStandaloneView<T extends ArrayBufferView>(view: T): T {
  if (view.byteLength === view.buffer.byteLength) {
    return view
  }

  if (view instanceof DataView) {
    return new DataView(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    ) as unknown as T
  }

  // Not `view.slice()`: `Buffer#slice` returns a view, not a copy.
  // The generic `%TypedArray%.prototype.slice` copies and keeps the subclass, so a `Buffer` stays a `Buffer`.
  return Uint8Array.prototype.slice.call(view as unknown as Uint8Array) as unknown as T
}

type Container = Record<PropertyKey, unknown>

/**
 * Copy every partial view (see `toStandaloneView`) reachable through arrays and plain objects.
 *
 * Copy-on-write: a container is rebuilt only when something inside it changed,
 * so a value without partial views is returned as-is. The input is never mutated.
 * Other containers (`Map`, `Set`, class instances, ...) are not walked.
 */
export function toStandaloneValue<T>(value: T): T {
  return replacePartialViews(value, new WeakMap()) as T
}

/**
 * @param replacements Each visited container mapped to its replacement: itself when nothing inside changed,
 *   otherwise its copy. `null` marks a container that is still being visited.
 */
function replacePartialViews(
  value: unknown,
  replacements: WeakMap<Container, Container | null>,
): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return toStandaloneView(value)
  }

  const isArray = Array.isArray(value)

  if (!isArray && !isPlainObject(value)) {
    return value
  }

  const container = value as Container
  const replacement = replacements.get(container)

  if (replacement === null) {
    // A cycle back to a container still being visited: copy it now, so the back-reference
    // points at the copy rather than at the original, which may still hold partial views
    const copy = copyContainer(container, isArray)
    replacements.set(container, copy)
    return copy
  }

  if (replacement !== undefined) {
    return replacement
  }

  replacements.set(container, null)

  const keys = isArray ? (value as unknown[]).keys() : Object.keys(container)

  for (const key of keys) {
    const item = container[key]
    const replacedItem = replacePartialViews(item, replacements)

    if (replacedItem !== item) {
      let copy = replacements.get(container)

      if (!copy) {
        copy = copyContainer(container, isArray)
        replacements.set(container, copy)
      }

      copy[key] = replacedItem
    }
  }

  const result = replacements.get(container) ?? container
  replacements.set(container, result)
  return result
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Shallow copy that keeps an own `__proto__` key as data instead of invoking its setter.
 */
function copyContainer(container: Container, isArray: boolean): Container {
  if (isArray) {
    return Array.prototype.slice.call(container) as unknown as Container
  }

  return Object.getPrototypeOf(container) === null
    ? Object.assign(Object.create(null), container)
    : { ...container }
}

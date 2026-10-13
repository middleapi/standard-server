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
 * Each visited container mapped to its replacement: itself when nothing inside changed,
 * otherwise its copy. `null` marks a container that is still being visited.
 */
type Replacements = Map<Container, Container | null>

/**
 * Copy every partial view (see `toStandaloneView`) reachable through arrays and plain objects.
 *
 * Copy-on-write: a container is rebuilt only when something inside it changed,
 * so a value without partial views is returned as-is. The input is never mutated.
 * Other containers (`Map`, `Set`, class instances, ...) are not walked.
 */
export function toStandaloneValue<T>(value: T): T {
  // Most bodies and event data are primitives or `undefined`: skip allocating the map
  if (typeof value !== 'object' || value === null) {
    return value
  }

  return replacePartialViews(value, new Map()) as T
}

function replacePartialViews(value: unknown, replacements: Replacements): unknown {
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

  if (replacement !== undefined) {
    // `null` is a cycle back to a container still being visited: copy it now, so the back-reference
    // points at the copy rather than at the original, which may still hold partial views
    return replacement ?? getOrCreateCopy(container, replacements)
  }

  replacements.set(container, null)

  // Indexed loop instead of `for...of` over `keys()`, which allocates an iterator per container
  const keys = isArray ? undefined : Object.keys(container)
  const length = keys === undefined ? (value as unknown[]).length : keys.length
  let copy: Container | undefined

  for (let index = 0; index < length; index++) {
    const key = keys === undefined ? index : keys[index]!
    const item = container[key]
    const replacedItem = replacePartialViews(item, replacements)

    if (replacedItem !== item) {
      // A back-reference inside `item` may already have created the copy
      copy ??= getOrCreateCopy(container, replacements)
      copy[key] = replacedItem
    }
  }

  const result = copy ?? container
  replacements.set(container, result)
  return result
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function getOrCreateCopy(container: Container, replacements: Replacements): Container {
  let copy = replacements.get(container)

  if (!copy) {
    copy = copyContainer(container)
    replacements.set(container, copy)
  }

  return copy
}

/**
 * Shallow copy that keeps an own `__proto__` key as data instead of invoking its setter.
 */
function copyContainer(container: Container): Container {
  if (Array.isArray(container)) {
    return Array.prototype.slice.call(container) as unknown as Container
  }

  return Object.getPrototypeOf(container) === null
    ? Object.assign(Object.create(null), container)
    : { ...container }
}

/**
 * Checks whether the object has at least one property with a defined value.
 * Keys holding `undefined` are treated as absent, matching JSON semantics
 * where such entries disappear on serialization.
 */
export function hasAnyDefinedValue(object: Record<string, unknown>): boolean {
  for (const value of Object.values(object)) {
    if (value !== undefined) {
      return true
    }
  }

  return false
}

/**
 * Checks whether the provided container is a typescript object (object or function).
 */
export function isTypescriptObject(maybeObject: unknown): maybeObject is object & Record<PropertyKey, unknown> {
  if (!maybeObject) {
    return false
  }

  const type = typeof maybeObject
  return type === 'object' || type === 'function'
}

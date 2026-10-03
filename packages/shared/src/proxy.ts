const GET_OR_BIND_CACHE = new WeakMap<Function, WeakMap<object, Function>>()

export interface GetOrBindOptions {
  /**
   * Whether to bind the function to the target before returning it.
   *
   * @default true
   */
  bind?: boolean
}

export function getOrBind<T extends object, K extends PropertyKey>(
  target: T,
  property: K,
  { bind = true }: GetOrBindOptions = {},
): K extends keyof T ? T[K] : unknown {
  const value = Reflect.get(target, property)

  if (!bind || typeof value !== 'function') {
    return value
  }

  let targetCache = GET_OR_BIND_CACHE.get(value)
  if (!targetCache) {
    GET_OR_BIND_CACHE.set(value, (targetCache = new WeakMap()))
  }

  let bound = targetCache.get(target)
  if (!bound) {
    targetCache.set(target, (bound = value.bind(target)))
  }

  return bound as any
}

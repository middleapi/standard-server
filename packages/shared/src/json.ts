export function parseEmptyableJSON(text: string | null | undefined): unknown {
  if (!text) {
    return undefined
  }

  return JSON.parse(text)
}

export function stringifyJSON<T>(value: T | { toJSON(): T }): undefined extends T ? undefined | string : string {
  // oxlint-disable-next-line no-restricted-properties
  return JSON.stringify(value)
}

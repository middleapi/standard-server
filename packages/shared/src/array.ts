export function toArray<T>(
  value: T,
): T extends readonly any[] ? T : T extends undefined | null ? never : T[] {
  return (
    Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  ) as any
}

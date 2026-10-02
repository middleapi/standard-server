export type AsyncCleanupFnState =
  | { kind: 'success'; error?: undefined }
  | { kind: 'error'; error: unknown }
  | { kind: 'cancelled'; error?: unknown }

export interface AsyncCleanupFn {
  (state: AsyncCleanupFnState): Promise<void>
}

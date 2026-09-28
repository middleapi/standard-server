import { AbortError } from './error'

/**
 * Combines multiple AbortSignals using OR semantics.
 * Aborts when the first signal aborts and forwards its reason.
 */
export function anyAbortSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter(s => !!s)

  /**
   * https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
   * AbortSignal.any is not available in all environments
   */
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(filtered)
  }

  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()

  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener)
    }
    listeners.clear()
  }

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason)
      cleanup()
    }
  }

  for (const signal of filtered) {
    if (signal.aborted) {
      abort(signal.reason)
      break
    }

    const listener = () => abort(signal.reason)
    listeners.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
  }

  return controller.signal
}

/**
 * Throws the signal's abort reason if it is aborted, like `signal.throwIfAborted()`.
 * React Native's AbortSignal polyfill has no `throwIfAborted` and never sets a reason,
 * so use this instead. A missing reason falls back to an `AbortError`.
 */
export function throwIfAborted(signal: AbortSignal | undefined | null): void {
  if (signal?.aborted) {
    throw signal.reason ?? new AbortError('This operation was aborted')
  }
}

import { AbortError } from './error'
import { throwIfAborted } from './signal'

export interface SleepOptions {
  signal?: AbortSignal | undefined
}

/**
 * sleep for a specified amount of time
 */
export function sleep(ms: number, { signal }: SleepOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)

    let abortListener: (() => void) | null = null

    const timeout = setTimeout(() => {
      if (abortListener) {
        signal?.removeEventListener('abort', abortListener)
      }

      resolve()
    }, ms)

    if (signal) {
      signal.addEventListener('abort', abortListener = () => {
        clearTimeout(timeout)
        reject(signal.reason ?? new AbortError('This operation was aborted'))
      }, { once: true })
    }
  })
}

import { describe, expect, it, vi } from 'vitest'
import { anyAbortSignal, throwIfAborted } from './signal'

/**
 * Helper to temporarily disable AbortSignal.any to force fallback implementation.
 */
function withFallback<T>(fn: () => T): T {
  const originalAny = AbortSignal.any
  // @ts-expect-error - allow setting to undefined for testing fallback
  AbortSignal.any = undefined
  try {
    return fn()
  }
  finally {
    AbortSignal.any = originalAny
  }
}

describe('anyAbortSignal', () => {
  it('works with native AbortSignal.any', () => {
    const controller = new AbortController()
    controller.abort('native')

    const combined = anyAbortSignal(new AbortController().signal, controller.signal)

    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('native')
  })

  describe('fallback implementation', () => {
    it('returns non-aborted signal when no inputs are aborted', () => {
      withFallback(() => {
        const combined = anyAbortSignal(
          new AbortController().signal,
          new AbortController().signal,
        )
        expect(combined.aborted).toBe(false)
      })
    })

    it('aborts immediately when any input is already aborted', () => {
      withFallback(() => {
        const controller = new AbortController()
        controller.abort('pre-aborted')

        const combined = anyAbortSignal(new AbortController().signal, controller.signal)

        expect(combined.aborted).toBe(true)
        expect(combined.reason).toBe('pre-aborted')
      })
    })

    it('aborts when any signal aborts later', () => {
      withFallback(() => {
        const controller1 = new AbortController()
        const controller2 = new AbortController()
        const combined = anyAbortSignal(controller1.signal, controller2.signal)

        expect(combined.aborted).toBe(false)

        controller2.abort('later')

        expect(combined.aborted).toBe(true)
        expect(combined.reason).toBe('later')
      })
    })

    it('cleans up listeners after abort', () => {
      withFallback(() => {
        const controller1 = new AbortController()
        const controller2 = new AbortController()

        const spy1 = vi.spyOn(controller1.signal, 'removeEventListener')
        const spy2 = vi.spyOn(controller2.signal, 'removeEventListener')

        anyAbortSignal(controller1.signal, controller2.signal)
        controller1.abort('trigger')

        expect(spy1).toHaveBeenCalledWith('abort', expect.any(Function))
        expect(spy2).toHaveBeenCalledWith('abort', expect.any(Function))
      })
    })

    it('ignores subsequent abort calls', () => {
      withFallback(() => {
        const controller = new AbortController()
        const listeners: Array<() => void> = []

        const fakeSignal = {
          get aborted() { return controller.signal.aborted },
          get reason() { return controller.signal.reason },
          addEventListener(_type: string, listener: () => void, options: { once?: boolean }) {
            listeners.push(listener)
            controller.signal.addEventListener('abort', listener, options)
          },
          removeEventListener() {},
        } as unknown as AbortSignal

        const combined = anyAbortSignal(fakeSignal, fakeSignal)
        controller.abort('once')

        expect(combined.aborted).toBe(true)
        expect(combined.reason).toBe('once')
      })
    })
  })
})

describe('throwIfAborted', () => {
  it('works on a signal without throwIfAborted (React Native polyfill)', () => {
    const controller = new AbortController()
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined })

    expect(() => throwIfAborted(undefined)).not.toThrow()
    expect(() => throwIfAborted(controller.signal)).not.toThrow()

    const reason = new Error('aborted')
    controller.abort(reason)

    expect(() => throwIfAborted(controller.signal)).toThrow(reason)
  })
})

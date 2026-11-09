import { sequential } from './function'
import type { AsyncCleanupFn } from './types'

export function isAsyncIteratorObject(maybe: unknown): maybe is AsyncIteratorObject<any, any, any> {
  if (!maybe || typeof maybe !== 'object') {
    return false
  }

  return (
    'next' in maybe &&
    typeof maybe.next === 'function' &&
    Symbol.asyncIterator in maybe &&
    typeof maybe[Symbol.asyncIterator] === 'function'
  )
}

export interface AsyncIteratorClassNextFn<T, TReturn> {
  (): Promise<IteratorResult<T, TReturn>>
}

// same key as esbuild's `__using`, Babel's `usingCtx` and core-js use without a native symbol
const fallbackAsyncDisposeSymbol: unique symbol = Symbol.for('Symbol.asyncDispose')
const asyncDisposeSymbol: typeof Symbol extends { asyncDispose: infer T }
  ? T
  : typeof fallbackAsyncDisposeSymbol = (Symbol as any).asyncDispose ?? fallbackAsyncDisposeSymbol

// Declared here and defined after the class, because isolated declarations can't
// infer a class member named by `asyncDisposeSymbol`, whose type is conditional.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging, no-unused-vars
export interface AsyncIteratorClass<T, TReturn = unknown, TNext = unknown> {
  /**
   * Uses the native Symbol.asyncDispose, or Symbol.for('Symbol.asyncDispose') on runtimes without it
   */
  [asyncDisposeSymbol](): Promise<void>
}

export class AsyncIteratorClass<T, TReturn = unknown, TNext = unknown>
  implements AsyncIteratorObject<T, TReturn, TNext>, AsyncGenerator<T, TReturn, TNext>
{
  private isDone = false
  private isExecuteComplete = false
  private readonly cleanup: AsyncCleanupFn

  readonly next: AsyncIteratorClassNextFn<T, TReturn>

  constructor(next: AsyncIteratorClassNextFn<T, TReturn>, cleanup: AsyncCleanupFn) {
    this.cleanup = cleanup
    this.next = sequential(async () => {
      if (this.isDone) {
        return { done: true, value: undefined as any }
      }

      let errorRef: { value: unknown } | undefined

      try {
        const result = await next()

        // the consumer stopped reading (e.g. `return()`) while this call was waiting
        if (this.isDone) {
          return { done: true, value: undefined as any }
        }

        if (result.done) {
          this.isDone = true
        }

        return result
      } catch (error) {
        // the consumer stopped reading (e.g. `return()`) while this call was waiting
        if (this.isDone) {
          return { done: true, value: undefined as any }
        }

        errorRef = { value: error }
        this.isDone = true

        throw error
      } finally {
        if (this.isDone && !this.isExecuteComplete) {
          this.isExecuteComplete = true
          await this.cleanup(
            errorRef ? { kind: 'error', error: errorRef.value } : { kind: 'success' },
          )
        }
      }
    })
  }

  async return(value?: any): Promise<IteratorResult<T, TReturn>> {
    this.isDone = true
    if (!this.isExecuteComplete) {
      this.isExecuteComplete = true
      await this.cleanup({ kind: 'cancelled' })
    }

    return { done: true, value }
  }

  async throw(error: any): Promise<IteratorResult<T, TReturn>> {
    this.isDone = true

    if (!this.isExecuteComplete) {
      this.isExecuteComplete = true
      await this.cleanup({ kind: 'cancelled', error })
    }

    throw error
  }

  [Symbol.asyncIterator](): this {
    return this
  }
}

Object.defineProperty(AsyncIteratorClass.prototype, asyncDisposeSymbol, {
  async value(this: AsyncIteratorClass<unknown>): Promise<void> {
    await this.return()
  },
  writable: true,
  configurable: true,
})

import { AsyncIteratorClass } from '@standard-server/shared'

export interface HibernationAsyncIteratorClassCallback {
  (id: string): void | Promise<void>
}

export class HibernationAsyncIteratorClass<
  T,
  TReturn = unknown,
  TNext = unknown,
> extends AsyncIteratorClass<T, TReturn, TNext> {
  /**
   * Optional because `AsyncIteratorClass` does not define this property.
   * The client library represents server results as `AsyncIteratorClass` instances.
   */
  readonly '~callback'?: HibernationAsyncIteratorClassCallback

  'constructor'(callback: HibernationAsyncIteratorClassCallback) {
    super(
      async () => {
        throw new Error('Cannot use hibernating iterator directly')
      },
      async () => {
        // nothing to clean up
      },
    )

    this['~callback'] = callback
  }
}

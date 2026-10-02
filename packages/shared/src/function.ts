/**
 * Sequentially execute the function, if the previous execution is not completed, the next execution will be blocked
 */
export function sequential<A extends any[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let lastOperationPromise: Promise<any> = Promise.resolve()

  return (...args: A): Promise<R> => {
    return (lastOperationPromise = lastOperationPromise
      .catch(() => {})
      .then(() => {
        return fn(...args)
      }))
  }
}

import { isAsyncIteratorObject } from '@standard-server/shared'

import { HibernationAsyncIteratorClass } from './hibernation'

describe('hibernationAsyncIteratorClass', () => {
  it('is async iterator object', () => {
    const iterator = new HibernationAsyncIteratorClass(vi.fn())
    expect(iterator).toSatisfy(isAsyncIteratorObject)
  })

  it('next() throws', async () => {
    const iterator = new HibernationAsyncIteratorClass(vi.fn())
    await expect(iterator.next()).rejects.toThrow('Cannot use hibernating iterator directly')
  })

  it('return() does not throw', async () => {
    const iterator = new HibernationAsyncIteratorClass(vi.fn())
    await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined })
  })

  it('invokes callback with correct id', () => {
    const callback = vi.fn()
    const iterator = new HibernationAsyncIteratorClass(callback)

    iterator['~callback']?.('12344')

    expect(callback).toHaveBeenCalledWith('12344')
    expect(callback).toHaveBeenCalledTimes(1)
  })
})

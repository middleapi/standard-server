import { sequential } from './function'

describe('sequential', () => {
  it('should call the function sequentially', async () => {
    let time = 0
    const fn = vi.fn(async () => {
      const result = time++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return result
    })

    const sequentialFn = sequential(fn)

    expect(sequentialFn()).resolves.toBe(0)
    expect(sequentialFn()).resolves.toBe(1)
    expect(sequentialFn()).resolves.toBe(2)
    expect(sequentialFn()).resolves.toBe(3)
  })

  it('should call the function sequentially even with errors', async () => {
    let time = 0
    const fn = vi.fn(async () => {
      const result = time++

      if (result === 1) {
        throw new Error('Forced error')
      }

      await new Promise((resolve) => setTimeout(resolve, 10))
      return result
    })

    const sequentialFn = sequential(fn)

    expect(sequentialFn()).resolves.toBe(0)
    expect(sequentialFn()).rejects.toThrow('Forced error')
    expect(sequentialFn()).resolves.toBe(2)
    expect(sequentialFn()).resolves.toBe(3)
  })
})

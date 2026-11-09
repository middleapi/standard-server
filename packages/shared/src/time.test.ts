import { sleep } from './time'

describe('sleep', () => {
  it('sleep resolves after the given duration', async () => {
    const start = Date.now()
    await sleep(100)
    expect(Date.now() - start).toBeGreaterThanOrEqual(90)
    expect(Date.now() - start).toBeLessThanOrEqual(150)
  })

  it('sleep resolves after the given duration with signal', async () => {
    const start = Date.now()
    await sleep(100, { signal: new AbortController().signal })
    expect(Date.now() - start).toBeGreaterThanOrEqual(90)
    expect(Date.now() - start).toBeLessThanOrEqual(150)
  })

  it('sleep rejects when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(sleep(100, { signal: controller.signal })).rejects.toThrow('cancelled')
  })

  it('sleep rejects when signal is aborted during sleep', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 20)
    const start = Date.now()
    await expect(sleep(100, { signal: controller.signal })).rejects.toThrow('cancelled')
    expect(Date.now() - start).toBeLessThan(80)
  })
})

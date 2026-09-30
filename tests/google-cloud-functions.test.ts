import type { StandardBody } from '@standard-server/core'
import type { AddressInfo } from 'node:net'
import { http } from '@google-cloud/functions-framework'
import { getTestServer } from '@google-cloud/functions-framework/testing'
import { toFetchBody, toFetchHeaders } from '@standard-server/fetch'
import { toStandardBody } from '@standard-server/node'
import { isAsyncIteratorObject } from '@standard-server/shared'

// Not in the shared matrices: the Functions Framework buffers request bodies before the
// function runs, and rejects top-level JSON primitives with a 400
describe('google cloud functions', () => {
  let resolvedBody: StandardBody

  http('standard-server', async (req, res) => {
    resolvedBody = await toStandardBody(req)
    res.end()
  })

  const server = getTestServer('standard-server').listen(0)

  afterAll(() => {
    server.close()
  })

  async function send(body: StandardBody): Promise<any> {
    const [fetchBody, headers] = toFetchBody(body, {})

    const response = await fetch(`http://localhost:${(server.address() as AddressInfo).port}`, {
      method: 'POST',
      headers: toFetchHeaders(headers),
      body: fetchBody ?? null,
      duplex: 'half',
    })

    expect(response.status).toBe(200)
    return resolvedBody
  }

  it('json', async () => {
    expect(await send({ a: 1, b: [2, 3] })).toEqual({ a: 1, b: [2, 3] })
  })

  it('url-search-params', async () => {
    expect(await send(new URLSearchParams('a=b&c=d&c=e'))).toEqual(new URLSearchParams('a=b&c=d&c=e'))
  })

  it('file', async () => {
    const body = await send(new File(['hello'], 'hello.txt', { type: 'text/plain' }))

    expect(body).toBeInstanceOf(File)
    expect(body.name).toBe('hello.txt')
    expect(await body.text()).toBe('hello')
  })

  it('form-data', async () => {
    const form = new FormData()
    form.append('a', 'b')
    form.append('file', new File(['hello'], 'hello.txt'))

    const body = await send(form)

    expect(body).toBeInstanceOf(FormData)
    expect(body.get('a')).toBe('b')
    expect(await body.get('file').text()).toBe('hello')
  })

  it('event-stream', async () => {
    const body = await send((async function* () {
      yield 1
      return 2
    })())

    expect(body).toSatisfy(isAsyncIteratorObject)
    await expect(body.next()).resolves.toEqual({ done: false, value: 1 })
    await expect(body.next()).resolves.toEqual({ done: true, value: 2 })
  })

  it('octet-stream', async () => {
    const body = await send(new Blob(['hello']).stream())

    expect(body).toBeInstanceOf(ReadableStream)
    expect(await new Response(body).text()).toBe('hello')
  })
})

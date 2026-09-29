import type { AsyncIteratorClass } from '@standard-server/shared'
import type { AnyAPIGatewayProxyEvent, APIGatewayProxyEvent } from './types'
import { Buffer } from 'node:buffer'
import { StandardBodyTooLargeError } from '@standard-server/core'
import { toStandardBody } from './body'

function event(override: Partial<APIGatewayProxyEvent>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/',
    body: null,
    isBase64Encoded: false,
    ...override,
  }
}

describe('toStandardBody', () => {
  describe('empty', () => {
    it('returns undefined when body is missing', async () => {
      await expect(toStandardBody(event({ body: null }))).resolves.toBeUndefined()
      await expect(toStandardBody(event({ body: undefined }))).resolves.toBeUndefined()
    })

    it('returns undefined for a body no content header describes', async () => {
      // the hint comes from the headers alone, so unlabelled bytes are indistinguishable from no body
      await expect(toStandardBody(event({ body: 'raw-data' }))).resolves.toBeUndefined()
    })

    it('parses an empty body when content-type is present', async () => {
      await expect(toStandardBody(event({
        body: '',
        multiValueHeaders: { 'Content-Type': ['application/x-www-form-urlencoded'] },
      }))).resolves.toEqual(new URLSearchParams())
    })

    it('respects the none hint', async () => {
      await expect(toStandardBody(event({
        body: '{"foo":"bar"}',
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }), { hint: 'none' })).resolves.toBeUndefined()

      await expect(toStandardBody(event({
        body: '{"foo":"bar"}',
        multiValueHeaders: { 'standard-server': ['none'] },
      }))).resolves.toBeUndefined()
    })

    it('parses a missing body as empty when a hint is provided', async () => {
      await expect(toStandardBody(event({ body: null }), { hint: 'json' })).resolves.toBeUndefined()
      await expect(toStandardBody(event({ body: null }), { hint: 'url-search-params' })).resolves.toEqual(new URLSearchParams())
    })
  })

  describe('json', () => {
    it('parses json', async () => {
      await expect(toStandardBody(event({
        body: '{"foo":"bar"}',
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }))).resolves.toEqual({ foo: 'bar' })
    })

    it('parses base64-encoded json', async () => {
      await expect(toStandardBody(event({
        body: Buffer.from('{"foo":"bar"}').toString('base64'),
        isBase64Encoded: true,
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }))).resolves.toEqual({ foo: 'bar' })
    })

    it('parses empty json as undefined', async () => {
      await expect(toStandardBody(event({
        body: '',
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }))).resolves.toBeUndefined()
    })
  })

  describe('url-search-params', () => {
    it('parses url-encoded forms', async () => {
      await expect(toStandardBody(event({
        body: 'foo=bar&baz=qux',
        multiValueHeaders: { 'Content-Type': ['application/x-www-form-urlencoded'] },
      }))).resolves.toEqual(new URLSearchParams('foo=bar&baz=qux'))
    })
  })

  describe('form-data', () => {
    it('parses multipart forms', async () => {
      const form = new FormData()
      form.append('foo', 'bar')
      form.append('file', new File(['content'], 'file.txt', { type: 'text/plain' }))

      const encoded = new Response(form)

      const standardBody = await toStandardBody(event({
        body: Buffer.from(await encoded.arrayBuffer()).toString('base64'),
        isBase64Encoded: true,
        multiValueHeaders: { 'Content-Type': [encoded.headers.get('content-type')!] },
      })) as FormData

      expect(standardBody).toBeInstanceOf(FormData)
      expect(standardBody.get('foo')).toBe('bar')
      expect((standardBody.get('file') as File).name).toBe('file.txt')
      await expect((standardBody.get('file') as File).text()).resolves.toBe('content')
    })

    it('rejects on form-data hint without content-type', async () => {
      await expect(toStandardBody(event({
        body: 'not-multipart',
      }), { hint: 'form-data' })).rejects.toThrow()
    })
  })

  describe('event-stream', () => {
    it('parses server-sent events', async () => {
      const standardBody = await toStandardBody(event({
        body: ': \n\nevent: message\ndata: "foo"\n\nevent: close\ndata: "baz"\n\n',
        multiValueHeaders: { 'Content-Type': ['text/event-stream'] },
      })) as AsyncIteratorClass<unknown>

      await expect(standardBody.next()).resolves.toEqual({ done: false, value: 'foo' })
      await expect(standardBody.next()).resolves.toEqual({ done: true, value: 'baz' })
    })
  })

  describe('octet-stream', () => {
    it('streams the body on explicit hint', async () => {
      const standardBody = await toStandardBody(event({
        body: 'raw-data',
        multiValueHeaders: {
          'Content-Type': ['application/octet-stream'],
          'standard-server': ['octet-stream'],
        },
      })) as ReadableStream<Uint8Array>

      expect(standardBody).toBeInstanceOf(ReadableStream)
      await expect(new Response(standardBody).text()).resolves.toBe('raw-data')
    })

    it('streams base64 bodies as chunks that own their memory', async () => {
      const standardBody = await toStandardBody(event({
        body: Buffer.from('raw-data').toString('base64'),
        isBase64Encoded: true,
        multiValueHeaders: {
          'Content-Type': ['application/octet-stream'],
          'standard-server': ['octet-stream'],
        },
      })) as ReadableStream<Uint8Array>

      const { value } = await standardBody.getReader().read()

      // `Buffer.from(string)` slices Node's shared pool, so an un-copied chunk would
      // expose other invocations' bytes through `.buffer`
      expect(value!.byteOffset).toBe(0)
      expect(value!.buffer.byteLength).toBe(value!.byteLength)
      expect(new TextDecoder().decode(value)).toBe('raw-data')
    })
  })

  describe('file', () => {
    it('parses file with filename from content-disposition', async () => {
      const standardBody = await toStandardBody(event({
        body: 'hello',
        multiValueHeaders: {
          'Content-Type': ['text/plain'],
          'Content-Disposition': ['inline; filename="hello.txt"'],
          'Content-Length': ['5'],
        },
      })) as File

      expect(standardBody).toBeInstanceOf(File)
      expect(standardBody.name).toBe('hello.txt')
      expect(standardBody.type).toBe('text/plain')
      await expect(standardBody.text()).resolves.toBe('hello')
    })

    it.each<[string, AnyAPIGatewayProxyEvent]>([
      ['v1 headers fallback', event({
        body: 'hello',
        multiValueHeaders: { 'X-Other': ['ignored'] },
        headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'inline; filename="hello.txt"' },
      })],
      ['v2', {
        rawPath: '/',
        requestContext: { http: { method: 'POST' } },
        body: 'hello',
        isBase64Encoded: false,
        headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'inline; filename="hello.txt"' },
      }],
    ])('reads content headers from single-value headers (%s)', async (_, e) => {
      const standardBody = await toStandardBody(e) as File

      expect(standardBody.name).toBe('hello.txt')
      expect(standardBody.type).toBe('text/plain')
    })

    it('respects the file hint over the content-type', async () => {
      const standardBody = await toStandardBody(event({
        body: '{"foo":"bar"}',
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }), { hint: 'file' }) as File

      expect(standardBody).toBeInstanceOf(File)
      expect(standardBody.name).toBe('blob')
      await expect(standardBody.text()).resolves.toBe('{"foo":"bar"}')
    })
  })

  describe('hint', () => {
    it('the hint option wins over the standard-server header', async () => {
      await expect(toStandardBody(event({
        body: '{"foo":"bar"}',
        multiValueHeaders: {
          'Content-Type': ['text/plain'],
          'standard-server': ['file'],
        },
      }), { hint: 'json' })).resolves.toEqual({ foo: 'bar' })
    })
  })

  describe('maxBodySize', () => {
    it('parses a body up to the limit', async () => {
      const body = '{"emoji":"😀"}' // 16 bytes, 14 utf-16 code units

      await expect(toStandardBody(event({
        body,
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }), { maxBodySize: 16 })).resolves.toEqual({ emoji: '😀' })

      await expect(toStandardBody(event({
        body,
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }), { maxBodySize: 15 })).rejects.toThrow(StandardBodyTooLargeError)
    })

    it('measures the decoded size of a base64-encoded body', async () => {
      const body = Buffer.from('{"foo":"bar"}').toString('base64') // 13 bytes, 20 base64 characters

      await expect(toStandardBody(event({
        body,
        isBase64Encoded: true,
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }), { maxBodySize: 13 })).resolves.toEqual({ foo: 'bar' })

      await expect(toStandardBody(event({
        body,
        isBase64Encoded: true,
        multiValueHeaders: { 'Content-Type': ['application/json'] },
      }), { maxBodySize: 12 })).rejects.toThrow(StandardBodyTooLargeError)
    })

    it.each([
      ['json', '{"foo":"bar"}'],
      ['url-search-params', 'foo=bar&bar=baz'],
      ['form-data', '--boundary\r\nContent-Disposition: form-data; name="foo"\r\n\r\nbar\r\n--boundary--\r\n'],
      ['file', 'hello world'],
    ])('rejects %s over the limit', async (hint, body) => {
      const promise = toStandardBody(event({
        body,
        multiValueHeaders: {
          'Content-Type': ['multipart/form-data; boundary=boundary'],
          'standard-server': [hint],
        },
      }), { maxBodySize: 10 })

      await expect(promise).rejects.toThrow(StandardBodyTooLargeError)
      await expect(promise).rejects.toThrow('Body exceeds the maximum size of 10 bytes')
    })

    it('does not limit streamed bodies', async () => {
      const eventStream = await toStandardBody(event({
        body: 'event: message\ndata: 123\n\n',
        multiValueHeaders: { 'standard-server': ['event-stream'] },
      }), { maxBodySize: 1 }) as AsyncIteratorClass<unknown>
      await expect(eventStream.next()).resolves.toEqual({ done: false, value: 123 })

      const octetStream = await toStandardBody(event({
        body: 'hello',
        multiValueHeaders: { 'standard-server': ['octet-stream'] },
      }), { maxBodySize: 1 }) as ReadableStream
      await expect(new Response(octetStream).text()).resolves.toBe('hello')
    })

    it('has no limit by default', async () => {
      const body = 'a'.repeat(1024 * 1024)

      const standardBody = await toStandardBody(event({
        body,
        multiValueHeaders: { 'standard-server': ['file'] },
      })) as File

      expect(standardBody.size).toBe(body.length)
    })
  })
})

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'

import { toStandardUrl } from './url'

describe('toStandardUrl', () => {
  it('origin-form', () => {
    expect(toStandardUrl({} as any)).toBe('/')
    expect(toStandardUrl({ url: '/' } as any)).toBe('/')
    expect(toStandardUrl({ url: '/foo' } as any)).toBe('/foo')
    expect(toStandardUrl({ url: '/foo?bar=1#baz' } as any)).toBe('/foo?bar=1#baz')
    // asterisk-form (`OPTIONS *`)
    expect(toStandardUrl({ url: '*' } as any)).toBe('/*')
  })

  it('prefers originalUrl over url', () => {
    expect(toStandardUrl({ url: '/', originalUrl: '/foo?bar=2#baz' } as any)).toBe('/foo?bar=2#baz')
    expect(toStandardUrl({ url: '/', originalUrl: 'http://127.0.0.1:80/foo?x=1' } as any)).toBe(
      '/foo?x=1',
    )
  })

  it('absolute-form (RFC 9112 §3.2.2, sent by clients that treat the server as a proxy)', () => {
    expect(toStandardUrl({ url: 'http://127.0.0.1:3000/ping' } as any)).toBe('/ping')
    expect(toStandardUrl({ url: 'http://example.com/foo?bar=1' } as any)).toBe('/foo?bar=1')
    expect(toStandardUrl({ url: 'https://example.com/foo#h' } as any)).toBe('/foo#h')
    expect(toStandardUrl({ url: 'HTTP://EXAMPLE.COM/Foo' } as any)).toBe('/Foo')
    expect(toStandardUrl({ url: 'http://example.com' } as any)).toBe('/')
    expect(toStandardUrl({ url: 'http://example.com?x=1' } as any)).toBe('/?x=1')
    expect(toStandardUrl({ url: 'http://example.com#f' } as any)).toBe('/#f')
    expect(toStandardUrl({ url: 'http://user:pw@example.com:8080/p' } as any)).toBe('/p')
    expect(toStandardUrl({ url: 'http://[::1]:3000/p' } as any)).toBe('/p')
  })

  it('reduces non-http schemes to their path', () => {
    expect(toStandardUrl({ url: 'ws://example.com/socket' } as any)).toBe('/socket')
    expect(toStandardUrl({ url: 'ftp://example.com/file' } as any)).toBe('/file')
  })

  it('treats anything else as a relative path', () => {
    expect(toStandardUrl({ url: 'base' } as any)).toBe('/base')
    expect(toStandardUrl({ url: '' } as any)).toBe('/')
    expect(toStandardUrl({ url: '?x=1' } as any)).toBe('/?x=1')
    expect(toStandardUrl({ url: '#frag' } as any)).toBe('/#frag')
  })

  it('malicious or malformed input', () => {
    // origin-form is passed through: never resolved as a host, never normalized
    expect(toStandardUrl({ url: '/../../etc/passwd' } as any)).toBe('/../../etc/passwd')
    expect(toStandardUrl({ url: '/%2e%2e/x' } as any)).toBe('/%2e%2e/x')
    expect(toStandardUrl({ url: ':::' } as any)).toBe('/:::')

    // authority tricks in absolute-form never leak into the path
    expect(toStandardUrl({ url: 'http://good.com@evil.com/x' } as any)).toBe('/x')
    expect(toStandardUrl({ url: 'http://evil.com\\@good.com/x' } as any)).toBe('/@good.com/x')
    expect(toStandardUrl({ url: 'http://example.com/../../etc/passwd' } as any)).toBe('/etc/passwd')
    expect(toStandardUrl({ url: 'http://example.com/a\tb\n' } as any)).toBe('/ab')
    expect(toStandardUrl({ url: 'javascript:alert(1)' } as any)).toBe('/alert(1)')

    // unparseable absolute-form keeps the legacy `/${url}` behavior instead of throwing
    expect(toStandardUrl({ url: 'http://' } as any)).toBe('/http://')
    expect(toStandardUrl({ url: 'http://[::1' } as any)).toBe('/http://[::1')
    expect(toStandardUrl({ url: 'http://example.com:99999/x' } as any)).toBe(
      '/http://example.com:99999/x',
    )
  })

  it('escapes a path `new URL(url, base)` would read as a host', () => {
    const cases: [url: string, standardUrl: string][] = [
      ['//evil.com/admin/x?next=//evil.com#//h', '/%2Fevil.com/admin/x?next=//evil.com#//h'],
      ['/\\evil.com/admin/x', '/%5Cevil.com/admin/x'],
      ['/\t/evil.com/admin/x', '/%09%2Fevil.com/admin/x'],
      ['////', '/%2F//'],
      // absolute-form whose pathname starts with `//`
      ['http://example.com//evil.com/admin/x', '/%2Fevil.com/admin/x'],
      ['http://example.com/..//evil.com/admin/x', '/%2Fevil.com/admin/x'],
      // unparseable input that only gains its leading `/` here
      ['\\\\[::1', '/%5C\\[::1'],
    ]

    for (const [url, standardUrl] of cases) {
      expect(toStandardUrl({ url } as any)).toBe(standardUrl)
      expect(toStandardUrl({ url: '/', originalUrl: url } as any)).toBe(standardUrl)
      expect(new URL(standardUrl, 'http://localhost').host).toBe('localhost')
    }
  })

  it('absolute-form from a real node:http server (what `curl -x <server> <url>` sends)', async ({
    onTestFinished,
  }) => {
    let url: string | undefined

    const server = http.createServer((req, res) => {
      url = toStandardUrl(req)
      res.end()
    })
    onTestFinished(() => new Promise<any>((r) => server.close(r)))

    await new Promise<void>((r) => server.listen(0, r))
    const { port } = server.address() as AddressInfo

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end(
          `GET http://127.0.0.1:${port}/ping?x=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
        )
      })
      socket.resume()
      socket.on('close', resolve)
      socket.on('error', reject)
    })

    expect(url).toBe('/ping?x=1')
  })

  it('scheme-relative origin-form from a real node:http server', async ({ onTestFinished }) => {
    const urls: string[] = []

    const server = http.createServer((req, res) => {
      urls.push(toStandardUrl(req))
      res.end()
    })
    onTestFinished(() => new Promise<any>((r) => server.close(r)))

    await new Promise<void>((r) => server.listen(0, r))
    const { port } = server.address() as AddressInfo

    // node:http hands both request targets to the handler unchanged
    for (const target of ['//evil.com/admin/x?y=1', '/\\evil.com/admin/x?y=1']) {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
        })
        socket.resume()
        socket.on('close', resolve)
        socket.on('error', reject)
      })
    }

    expect(urls).toEqual(['/%2Fevil.com/admin/x?y=1', '/%5Cevil.com/admin/x?y=1'])

    for (const url of urls) {
      const resolved = new URL(url, 'http://localhost')
      expect(resolved.host).toBe('localhost')
      expect(resolved.pathname).toBe(url.slice(0, url.indexOf('?')))
    }
  })
})

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { text } from 'node:stream/consumers'

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
    // origin-form is passed through untouched: never resolved as a host, never normalized
    expect(toStandardUrl({ url: '//evil.com/ping' } as any)).toBe('//evil.com/ping')
    expect(toStandardUrl({ url: '////' } as any)).toBe('////')
    expect(toStandardUrl({ url: '/../../etc/passwd' } as any)).toBe('/../../etc/passwd')
    expect(toStandardUrl({ url: '/%2e%2e/x' } as any)).toBe('/%2e%2e/x')
    expect(toStandardUrl({ url: ':::' } as any)).toBe('/:::')

    // authority tricks in absolute-form never leak into the path
    expect(toStandardUrl({ url: 'http://good.com@evil.com/x' } as any)).toBe('/x')
    expect(toStandardUrl({ url: 'http://evil.com\\@good.com/x' } as any)).toBe('/x')
    expect(toStandardUrl({ url: 'http://example.com:99999/x' } as any)).toBe('/x')

    // absolute-form keeps the raw path like origin-form does: no dot-segment resolution, no decoding
    expect(toStandardUrl({ url: 'http://example.com/../../etc/passwd' } as any)).toBe(
      '/../../etc/passwd',
    )
    expect(toStandardUrl({ url: 'http://x/rpc/public/../admin/y' } as any)).toBe(
      '/rpc/public/../admin/y',
    )
    expect(toStandardUrl({ url: 'http://x/a/%2e%2e/b' } as any)).toBe('/a/%2e%2e/b')
    expect(toStandardUrl({ url: 'http://x/a/%2E%2E/b' } as any)).toBe('/a/%2E%2E/b')
    expect(toStandardUrl({ url: 'http://x/a/./b?c=../d#../e' } as any)).toBe('/a/./b?c=../d#../e')
    expect(toStandardUrl({ url: 'http://example.com/a\tb\n' } as any)).toBe('/a\tb\n')

    // not absolute-form, so it is treated as a relative path
    expect(toStandardUrl({ url: 'javascript:alert(1)' } as any)).toBe('/javascript:alert(1)')

    // an empty or malformed authority leaves an empty path
    expect(toStandardUrl({ url: 'http://' } as any)).toBe('/')
    expect(toStandardUrl({ url: 'http://[::1' } as any)).toBe('/')
  })

  it('never throws, never leaks the authority, and always returns a path', () => {
    const inputs = [
      'http://user:secret@host.example/p?q#f',
      'http://user:secret@host.example',
      'https://user@host.example?q',
      'http://host.example#f',
      'http://evil.com\\@host.example/x',
      'http://host.example:99999/x',
      'http://[::1',
      'http://',
      'javascript:alert(1)',
      'foo:/a',
      '*',
      '',
      ':::',
      '%',
      'http://host.example/%',
    ]

    for (const url of inputs) {
      const result = toStandardUrl({ url } as any)

      expect(result.startsWith('/')).toBe(true)
      expect(result).not.toContain('secret')
      expect(result).not.toContain('host.example')
    }
  })

  it('absolute-form from a real node:http server (what `curl -x <server> <url>` sends)', async ({
    onTestFinished,
  }) => {
    const urls: string[] = []

    const server = http.createServer((req, res) => {
      urls.push(toStandardUrl(req))
      res.end()
    })
    onTestFinished(() => new Promise<any>((r) => server.close(r)))

    await new Promise<void>((r) => server.listen(0, r))
    const { port } = server.address() as AddressInfo

    const send = async (target: string) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
      await text(socket)
    }

    await send(`http://127.0.0.1:${port}/ping?x=1`)
    // dot segments and percent-encoding stay raw, like origin-form
    await send(`http://127.0.0.1:${port}/rpc/public/../admin/x`)
    await send(`http://127.0.0.1:${port}/rpc/public/%2e%2e/admin/x`)

    expect(urls).toEqual(['/ping?x=1', '/rpc/public/../admin/x', '/rpc/public/%2e%2e/admin/x'])
  })
})

import type { AddressInfo } from 'node:net'
import http from 'node:http'
import net from 'node:net'
import { toStandardUrl } from './url'

describe('toStandardUrl', () => {
  it('origin-form', () => {
    expect(toStandardUrl({ } as any)).toBe('/')
    expect(toStandardUrl({ url: '/' } as any)).toBe('/')
    expect(toStandardUrl({ url: '/foo' } as any)).toBe('/foo')
    expect(toStandardUrl({ url: '/foo?bar=1#baz' } as any)).toBe('/foo?bar=1#baz')
    // asterisk-form (`OPTIONS *`)
    expect(toStandardUrl({ url: '*' } as any)).toBe('/*')
  })

  it('prefers originalUrl over url', () => {
    expect(toStandardUrl({ url: '/', originalUrl: '/foo?bar=2#baz' } as any)).toBe('/foo?bar=2#baz')
    expect(toStandardUrl({ url: '/', originalUrl: 'http://127.0.0.1:80/foo?x=1' } as any)).toBe('/foo?x=1')
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
    // origin-form is never resolved as a host and never normalized beyond the leading slashes
    expect(toStandardUrl({ url: '/../../etc/passwd' } as any)).toBe('/../../etc/passwd')
    expect(toStandardUrl({ url: '/%2e%2e/x' } as any)).toBe('/%2e%2e/x')
    expect(toStandardUrl({ url: ':::' } as any)).toBe('/:::')

    // authority tricks in absolute-form never leak into the path
    expect(toStandardUrl({ url: 'http://good.com@evil.com/x' } as any)).toBe('/x')
    expect(toStandardUrl({ url: 'http://evil.com\\@good.com/x' } as any)).toBe('/@good.com/x')
    expect(toStandardUrl({ url: 'http://example.com/../../etc/passwd' } as any)).toBe('/etc/passwd')
    expect(toStandardUrl({ url: 'http://example.com/a\tb\n' } as any)).toBe('/ab')
    expect(toStandardUrl({ url: 'javascript:alert(1)' } as any)).toBe('/alert(1)')

    // protocol-relative references are resolved like absolute-form, the pseudo-authority never leaks into the path
    expect(toStandardUrl({ url: '//evil.com/ping' } as any)).toBe('/ping')
    expect(toStandardUrl({ url: '//evil.com/admin?x=1' } as any)).toBe('/admin?x=1')
    expect(toStandardUrl({ url: '/\\evil.com/admin?x=1' } as any)).toBe('/admin?x=1')
    expect(toStandardUrl({ url: '///evil.com/x' } as any)).toBe('/x')
    expect(toStandardUrl({ url: '//evil.com//x' } as any)).toBe('/')
    expect(toStandardUrl({ url: '/', originalUrl: '//evil.com/x' } as any)).toBe('/x')
    expect(toStandardUrl({ url: 'http://example.com//evil.com/x' } as any)).toBe('/x')

    // an unresolvable pseudo-authority is dropped along with everything after it
    expect(toStandardUrl({ url: '////' } as any)).toBe('/')
    expect(toStandardUrl({ url: '//' } as any)).toBe('/')
    expect(toStandardUrl({ url: '//?x=1' } as any)).toBe('/')
    expect(toStandardUrl({ url: '//evil.com:99999/x' } as any)).toBe('/')

    // unparseable absolute-form keeps the legacy `/${url}` behavior instead of throwing
    expect(toStandardUrl({ url: 'http://' } as any)).toBe('/http://')
    expect(toStandardUrl({ url: 'http://[::1' } as any)).toBe('/http://[::1')
    expect(toStandardUrl({ url: 'http://example.com:99999/x' } as any)).toBe('/http://example.com:99999/x')
  })

  async function requestTarget(target: string, onTestFinished: (fn: () => Promise<any>) => void): Promise<string | undefined> {
    let url: string | undefined

    const server = http.createServer((req, res) => {
      url = toStandardUrl(req)
      res.end()
    })
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    await new Promise<void>(r => server.listen(0, r))
    const { port } = server.address() as AddressInfo

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end(`GET ${target.replaceAll('{port}', String(port))} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
      })
      socket.resume()
      socket.on('close', resolve)
      socket.on('error', reject)
    })

    return url
  }

  it('absolute-form from a real node:http server (what `curl -x <server> <url>` sends)', async ({ onTestFinished }) => {
    expect(await requestTarget('http://127.0.0.1:{port}/ping?x=1', onTestFinished)).toBe('/ping?x=1')
  })

  it('protocol-relative origin-form from a real node:http server (llhttp accepts it as a path)', async ({ onTestFinished }) => {
    expect(await requestTarget('//evil.com/admin?x=1', onTestFinished)).toBe('/admin?x=1')
  })
})

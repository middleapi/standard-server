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
    expect(toStandardUrl({ url: 'http://x:/p' } as any)).toBe('/p')
    expect(toStandardUrl({ url: 'http://a@b@example.com/p' } as any)).toBe('/p')
  })

  it('keeps the rest of an absolute-form target byte-for-byte, exactly like origin-form', () => {
    // routers and path-scoped middleware (express, find-my-way) match on the raw path, so resolving
    // dot segments or backslashes here would let `/rpc/public/../admin` skip a guard on `/rpc/admin`
    const paths = [
      '/rpc/public/../admin/x',
      '/rpc/public/%2e%2e/admin/x',
      '/rpc/public/.%2E/admin/x',
      '/rpc/public/./../admin/x',
      '/rpc/./admin/x',
      '/rpc/public\\..\\admin/x',
      '/rpc\\admin',
      '/a//b/',
      '/a%2Fb/%7e?q=%2e%2e/../x&y=\\#../h\\',
      '/p?/../x',
      '/p#/../x',
      '/?x=1',
      '/#f',
    ]

    for (const path of paths) {
      expect(toStandardUrl({ url: `http://example.com${path}` } as any)).toBe(path)
      expect(toStandardUrl({ url: `https://user:pw@127.0.0.1:3000${path}` } as any)).toBe(path)
      expect(toStandardUrl({ url: `http://example.com${path}` } as any)).toBe(toStandardUrl({ url: path } as any))
    }

    // a query or hash right after the authority still gets its leading `/`
    expect(toStandardUrl({ url: 'http://example.com?/../x' } as any)).toBe('/?/../x')
    expect(toStandardUrl({ url: 'http://example.com#/../x' } as any)).toBe('/#/../x')
  })

  it('does not strip the authority of other schemes, find-my-way routes them unstripped', () => {
    expect(toStandardUrl({ url: 'ws://example.com/socket' } as any)).toBe('/ws://example.com/socket')
    expect(toStandardUrl({ url: 'ftp://example.com/file' } as any)).toBe('/ftp://example.com/file')
    // `url.parse` (express) doesn't treat what follows `javascript://` as an authority
    expect(toStandardUrl({ url: 'javascript://x/rpc/admin' } as any)).toBe('/javascript://x/rpc/admin')
  })

  it('prefixes anything else with `/` as is', () => {
    expect(toStandardUrl({ url: 'base' } as any)).toBe('/base')
    expect(toStandardUrl({ url: '' } as any)).toBe('/')
    expect(toStandardUrl({ url: '?x=1' } as any)).toBe('/?x=1')
    expect(toStandardUrl({ url: '#frag' } as any)).toBe('/#frag')
    // node:http accepts anything after an asterisk-form `*`
    expect(toStandardUrl({ url: '*/../rpc/admin' } as any)).toBe('/*/../rpc/admin')
    expect(toStandardUrl({ url: 'base/../x' } as any)).toBe('/base/../x')
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
    expect(toStandardUrl({ url: 'http://example.com/../../etc/passwd' } as any)).toBe('/../../etc/passwd')
    expect(toStandardUrl({ url: 'http://example.com/a\tb\n' } as any)).toBe('/a\tb\n')
    expect(toStandardUrl({ url: 'javascript:alert(1)' } as any)).toBe('/javascript:alert(1)')

    // authorities express (`url.parse`) ends early, so it routes on a different path, keep `/${url}`
    expect(toStandardUrl({ url: 'http://evil.com\\@good.com/x' } as any)).toBe('/http://evil.com\\@good.com/x')
    expect(toStandardUrl({ url: 'http://evil.com\\x/y' } as any)).toBe('/http://evil.com\\x/y')
    expect(toStandardUrl({ url: 'http://a;b/rpc/admin' } as any)).toBe('/http://a;b/rpc/admin')
    expect(toStandardUrl({ url: 'http://a\'b/rpc/admin' } as any)).toBe('/http://a\'b/rpc/admin')
    expect(toStandardUrl({ url: 'http://%41/rpc/admin' } as any)).toBe('/http://%41/rpc/admin')
    expect(toStandardUrl({ url: 'http://x:abc/rpc/admin' } as any)).toBe('/http://x:abc/rpc/admin')
    // an http(s) URI with an empty host is invalid (RFC 9110 §4.2.1)
    expect(toStandardUrl({ url: 'http:///x' } as any)).toBe('/http:///x')
    expect(toStandardUrl({ url: 'http://u@/x' } as any)).toBe('/http://u@/x')

    // unparseable absolute-form keeps the legacy `/${url}` behavior instead of throwing
    expect(toStandardUrl({ url: 'http://' } as any)).toBe('/http://')
    expect(toStandardUrl({ url: 'http://[::1' } as any)).toBe('/http://[::1')
    expect(toStandardUrl({ url: 'http://[::1::2]/x' } as any)).toBe('/http://[::1::2]/x')
    expect(toStandardUrl({ url: 'http://example.com:99999/x' } as any)).toBe('/http://example.com:99999/x')
  })

  it('absolute-form from a real node:http server (what `curl -x <server> <url>` sends)', async ({ onTestFinished }) => {
    let url: string | undefined

    const server = http.createServer((req, res) => {
      url = toStandardUrl(req)
      res.end()
    })
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    await new Promise<void>(r => server.listen(0, r))
    const { port } = server.address() as AddressInfo

    const send = (target: string) => new Promise<string | undefined>((resolve, reject) => {
      url = undefined
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
      })
      socket.resume()
      socket.on('close', () => resolve(url))
      socket.on('error', reject)
    })

    expect(await send(`http://127.0.0.1:${port}/ping?x=1`)).toBe('/ping?x=1')

    // node:http accepts all of these, and must yield the same url as their origin-form
    for (const path of [
      '/rpc/public/../admin/x',
      '/rpc/public/%2e%2e/admin/x',
      '/rpc/public/.%2E/admin/x',
      '/rpc/public/./../admin/x',
      '/rpc/public\\..\\admin/x',
      '/p/../q?a=/../b#../h',
    ]) {
      expect(await send(`http://127.0.0.1:${port}${path}`)).toBe(path)
      expect(await send(path)).toBe(path)
    }
  })
})

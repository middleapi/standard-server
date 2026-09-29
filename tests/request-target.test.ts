import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { toStandardLazyRequest } from '@standard-server/node'
import express from 'express'
import express4 from 'express4'

function send(port: number, target: string): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    let response = ''
    const socket = net.connect(port, '127.0.0.1', () => {
      // a raw request line, so the target reaches node:http exactly as written
      socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    socket.setEncoding('utf8')
    socket.on('data', chunk => response += chunk)
    socket.on('close', () => resolve({
      status: Number(response.split(' ')[1]),
      body: response.slice(response.indexOf('\r\n\r\n') + 4),
    }))
    socket.on('error', reject)
  })
}

describe.each([
  ['expressjs', '/rpc', 5],
  ['expressjs', '/', 5],
  ['expressjs4', '/rpc', 4],
  ['expressjs4', '/', 4],
] as const)('%s: absolute-form request targets with the standard handler on `%s`', (_name, mount, version) => {
  let adminExecutions = 0
  let server: Server
  let port: number

  beforeAll(async () => {
    // the api used below is the same across both majors, only their types are incompatible
    const expressjs = (version === 4 ? express4 : express) as typeof express
    const app = expressjs()

    app.use('/rpc/admin', (req, res) => {
      res.status(401).end()
    })

    app.use(mount, (req, res) => {
      // stands for a standard handler routing on the url it is given
      const { url } = toStandardLazyRequest(req, res)

      if (url.startsWith('/rpc/admin/')) {
        adminExecutions++
        res.status(200).end(url)
        return
      }

      res.status(404).end(url)
    })

    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<any>(r => server.close(r)))

  it('reaches the handler like origin-form', async () => {
    expect(await send(port, `http://127.0.0.1:${port}/rpc/public/x?a=1`)).toEqual({ status: 404, body: '/rpc/public/x?a=1' })
    expect(await send(port, `http://127.0.0.1:${port}/rpc/admin/x`)).toEqual({ status: 401, body: '' })
  })

  it('can not skip a guard on `/rpc/admin`', async () => {
    for (const path of [
      '/rpc/public/../admin/x',
      '/rpc/public/%2e%2e/admin/x',
      '/rpc/public/.%2E/admin/x',
      '/rpc/public/./../admin/x',
    ]) {
      // the handler gets exactly what an origin-form request for the same path would give it
      expect(await send(port, `http://127.0.0.1:${port}${path}`)).toEqual({ status: 404, body: path })
      expect(await send(port, path)).toEqual({ status: 404, body: path })
    }

    for (const target of [
      // express (`url.parse`) turns `\` into `/` before routing, the handler keeps it
      `http://127.0.0.1:${port}/rpc/public\\..\\admin/x`,
      // authorities express ends early, or doesn't strip at all
      'http://a;b/rpc/admin/x',
      'http://%41/rpc/admin/x',
      'javascript://127.0.0.1/rpc/admin/x',
      // paths after an asterisk-form `*`
      '*/../rpc/admin/x',
    ]) {
      expect((await send(port, target)).status).not.toBe(200)
    }

    expect(adminExecutions).toBe(0)
  })
})

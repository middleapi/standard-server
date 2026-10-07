import type { StandardHeaders } from '@standard-server/core'
import type { NodeHttpRequest, NodeHttpResponse } from '@standard-server/node'
import Fastify from 'fastify'

import { standardContentTypeParser } from './request'
import type { AnyFastifyReply, AnyFastifyRequest } from './types'

/**
 * Passing a concrete fastify request/reply here only compiles if the widened
 * aliases accept it, whatever raw server and route generic it came from.
 */
function accepts(req: AnyFastifyRequest, reply: AnyFastifyReply): void {
  // the aliases must expose exactly what `@standard-server/node` consumes
  expectTypeOf(req.raw).toExtend<NodeHttpRequest>()
  expectTypeOf(req.headers).toExtend<StandardHeaders>()
  expectTypeOf(reply.raw).toExtend<NodeHttpResponse>()
}

it('accept the request and reply of an http1 instance', () => {
  const fastify = Fastify()

  fastify.all('/*', async (req, reply) => accepts(req, reply))
  fastify.addHook('preHandler', async (req, reply) => accepts(req, reply))
  fastify.setNotFoundHandler(async (req, reply) => accepts(req, reply))
  fastify.setErrorHandler(async (error, req, reply) => {
    expectTypeOf(error).not.toBeAny()
    accepts(req, reply)
  })
})

it('accept the request and reply of an http2 instance', () => {
  const fastify = Fastify({ http2: true })

  fastify.all('/*', async (req, reply) => accepts(req, reply))
  fastify.addHook('preHandler', async (req, reply) => accepts(req, reply))
  fastify.setNotFoundHandler(async (req, reply) => accepts(req, reply))
  fastify.setErrorHandler(async (error, req, reply) => {
    expectTypeOf(error).not.toBeAny()
    accepts(req, reply)
  })
})

it('accept the request and reply of a route with a route generic', () => {
  const fastify = Fastify()

  fastify.post<{ Querystring: { q: string }; Body: { b: number } }>('/', async (req, reply) => {
    accepts(req, reply)
  })
})

it('accept the request and reply of an encapsulated plugin', () => {
  const fastify = Fastify()

  fastify.register(
    async (instance) => {
      instance.all('/*', async (req, reply) => accepts(req, reply))
    },
    { prefix: '/api' },
  )
})

it('accept standardContentTypeParser as a content type parser of any instance', () => {
  Fastify().addContentTypeParser('*', standardContentTypeParser)
  Fastify({ http2: true }).addContentTypeParser('*', standardContentTypeParser)
  Fastify().register(async (instance) => {
    instance.addContentTypeParser(/^text\//, standardContentTypeParser)
  })
})

import { bench, describe } from 'vitest'

import { echoHandler, roundTrip } from './__shared__/client-server'
import { createFetchClientServer } from './__shared__/client-server.fetch'
import { createNodeClientServer } from './__shared__/client-server.node'
import { createPeerClientServer } from './__shared__/client-server.peer'
import {
  asAsyncIteratorObject,
  asReadableStream,
  BLOB_10KB,
  BYTES_10KB,
  EVENTS_10KB,
  FORM_10KB,
  JSON_10KB,
  USP_10KB,
} from './__shared__/payloads'

const adapters = [
  ['node-adapter', createNodeClientServer],
  ['fetch-adapter', createFetchClientServer],
  ['peer-adapter', createPeerClientServer],
] as const

describe.each(adapters)('e2e client-server: $0', async (_, create) => {
  const clientServer = create()
  clientServer.handler = echoHandler
  await roundTrip(clientServer, { method: 'GET', url: '/', headers: {} }) // ensure client-server is ready

  bench('json 10KB', async () => {
    await roundTrip(clientServer, {
      method: 'POST',
      url: '/10KB/json',
      headers: {},
      body: JSON_10KB,
    })
  })

  bench('blob 10KB', async () => {
    await roundTrip(clientServer, {
      method: 'POST',
      url: '/10KB/blob',
      headers: {},
      body: BLOB_10KB,
    })
  })

  bench('form data 10KB', async () => {
    await roundTrip(clientServer, {
      method: 'POST',
      url: '/10KB/form-data',
      headers: {},
      body: FORM_10KB,
    })
  })

  bench('url search params 10KB', async () => {
    await roundTrip(clientServer, {
      method: 'POST',
      url: '/10KB/url-search-params',
      headers: {},
      body: USP_10KB,
    })
  })

  bench('event stream 10KB', async () => {
    await roundTrip(clientServer, {
      method: 'POST',
      url: '/10KB/event-stream',
      headers: {},
      body: asAsyncIteratorObject(EVENTS_10KB),
    })
  })

  bench('octet stream 10KB', async () => {
    await roundTrip(clientServer, {
      method: 'POST',
      url: '/10KB/octet-stream',
      headers: {},
      body: asReadableStream(BYTES_10KB),
    })
  })
})

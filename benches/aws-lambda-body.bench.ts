import type { APIGatewayProxyEvent } from '@standard-server/aws-lambda'
import { Buffer } from 'node:buffer'
import { toStandardBody } from '@standard-server/aws-lambda'
import { stringifyJSON } from '@standard-server/shared'
import { bench, describe } from 'vitest'

/** About 1MB of stringified JSON, `name` switches it between a one-byte and a two-byte string. */
function createJson(name: string): string {
  return stringifyJSON(Array.from({ length: 9000 }, (_, i) => ({
    id: i,
    name: `${name}-${i}`,
    email: `user-${i}@example.com`,
    tags: ['a', 'b', 'c'],
    active: i % 2 === 0,
  })))!
}

const JSON_1MB = createJson('user')
const JSON_1MB_NON_ASCII = createJson('ユーザー')

function jsonEvent(body: string, isBase64Encoded = false): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/',
    body: isBase64Encoded ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded,
    headers: { 'content-type': 'application/json' },
  }
}

const EVENT_1MB = jsonEvent(JSON_1MB)
const EVENT_1MB_BASE64 = jsonEvent(JSON_1MB, true)
const EVENT_1MB_NON_ASCII = jsonEvent(JSON_1MB_NON_ASCII)

describe('aws-lambda toStandardBody json', () => {
  bench('1MB', async () => {
    await toStandardBody(EVENT_1MB)
  })

  bench('1MB base64', async () => {
    await toStandardBody(EVENT_1MB_BASE64)
  })

  bench('1MB non-ascii', async () => {
    await toStandardBody(EVENT_1MB_NON_ASCII)
  })
})

import type { PeerMessage } from './types'
import { isClientPeerSendMessage, isPeerCancelMessage, isPeerEventStreamMessage, isPeerMessage, isPeerOctetStreamMessage, isPeerRequestMessage, isPeerResponseMessage, isPeerStreamCancelMessage, isServerPeerSendMessage } from './validators'

function base(overrides?: Partial<PeerMessage>): PeerMessage {
  return { id: 'abc', kind: 'request', ...overrides }
}

describe('isPeerMessage', () => {
  it('accepts minimal valid message', () => expect(isPeerMessage(base())).toBe(true))
  it('accepts binary as Uint8Array', () => expect(isPeerMessage(base({ binary: new Uint8Array() }))).toBe(true))
  it('accepts binary as Blob', () => expect(isPeerMessage(base({ binary: new Blob() }))).toBe(true))

  it.each([
    ['non-string id', base({ id: 123 as any })],
    ['invalid kind', base({ kind: 123 as any })],
    ['binary as string', base({ binary: 'data' as any })],
    ['null', null],
    ['array', []],
  ])('rejects %s', (_, v) => expect(isPeerMessage(v)).toBe(false))
})

describe('isPeerRequestMessage', () => {
  it('accepts minimal valid request message', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: { url: '/path' } }))).toBe(true)
  })

  it('accepts full valid request message', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: { method: 'GET', url: '/path', headers: {}, body: 'json' } }))).toBe(true)
  })

  it('rejects wrong kind', () => {
    expect(isPeerRequestMessage(base({ kind: 'response', json: {} }))).toBe(false)
  })

  it('rejects invalid json', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: 'invalid' }))).toBe(false)
  })

  it('rejects missing url', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: { method: 'GET', headers: {}, body: 'json' } }))).toBe(false)
  })

  it('rejects invalid url', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: { url: 'invalid' } }))).toBe(false)
  })

  it('rejects invalid method', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: { url: '/path', method: 123 } }))).toBe(false)
  })

  it('rejects invalid headers', () => {
    expect(isPeerRequestMessage(base({ kind: 'request', json: { url: '/path', headers: 'invalid' as any } }))).toBe(false)
  })
})

describe('isPeerResponseMessage', () => {
  it('accepts minimal valid response message', () => {
    expect(isPeerResponseMessage(base({ kind: 'response', json: { } }))).toBe(true)
  })

  it('accepts full valid response message', () => {
    expect(isPeerResponseMessage(base({ kind: 'response', json: { status: 200, headers: {}, body: 'json' } }))).toBe(true)
  })

  it('rejects wrong kind', () => {
    expect(isPeerResponseMessage(base({ kind: 'request', json: {} }))).toBe(false)
  })

  it('rejects invalid json', () => {
    expect(isPeerResponseMessage(base({ kind: 'response', json: 'invalid' }))).toBe(false)
  })

  it('rejects invalid status', () => {
    expect(isPeerResponseMessage(base({ kind: 'response', json: { status: 'invalid', headers: {} } }))).toBe(false)
  })

  it('rejects invalid headers', () => {
    expect(isPeerResponseMessage(base({ kind: 'response', json: { status: 200, headers: 'invalid' } }))).toBe(false)
  })
})

describe('isPeerCancelMessage', () => {
  it('accepts valid cancel', () => {
    expect(isPeerCancelMessage(base({ kind: 'cancel', json: undefined, binary: undefined }))).toBe(true)
  })

  it('rejects when json is set', () => {
    expect(isPeerCancelMessage(base({ kind: 'cancel', json: {} }))).toBe(false)
  })

  it('rejects when binary is set', () => {
    expect(isPeerCancelMessage(base({ kind: 'cancel', binary: new Uint8Array() }))).toBe(false)
  })

  it('rejects when wrong kind', () => {
    expect(isPeerCancelMessage(base({ kind: 'invalid', binary: new Uint8Array() }))).toBe(false)
  })
})

describe('isPeerEventStreamMessage', () => {
  const msg = (json: unknown, binary?: any) =>
    base({ kind: 'event-stream', json, binary })

  it('accepts minimal event', () => {
    expect(isPeerEventStreamMessage(msg({ }))).toBe(true)
  })

  it('accepts full valid payload', () => {
    expect(isPeerEventStreamMessage(msg({ id: 'e1', event: 'message', data: { x: 1 }, retry: 3000, comments: ['ok'] }))).toBe(true)
  })

  it('accepts valid event', () => {
    expect(isPeerEventStreamMessage(msg({ event: 'message' }))).toBe(true)
    expect(isPeerEventStreamMessage(msg({ event: 'error' }))).toBe(true)
    expect(isPeerEventStreamMessage(msg({ event: 'close' }))).toBe(true)
  })

  it('rejects invalid event', () => {
    expect(isPeerEventStreamMessage(msg({ event: 'invalid' }))).toBe(false)
    expect(isPeerEventStreamMessage(msg({ event: 123 }))).toBe(false)
  })

  it('rejects binary present', () => {
    expect(isPeerEventStreamMessage(msg({}, new Uint8Array()))).toBe(false)
  })

  it('rejects non-object json', () => {
    expect(isPeerEventStreamMessage(msg('string'))).toBe(false)
  })

  it.each([
    ['non-string id', { id: 42 }],
    ['non-string event', { event: true }],
    ['non-finite retry', { retry: Infinity }],
    ['negative retry', { retry: -1 }],
    ['fractional retry', { retry: 1.5 }],
    ['id with line break', { id: 'a\nb' }],
    ['id with NULL', { id: 'a\0b' }],
    ['non-string-array comments', { comments: [1, 2] }],
    ['comment with line break', { comments: ['ok', 'a\rb'] }],
  ])('rejects %s', (_, json) => expect(isPeerEventStreamMessage(msg(json))).toBe(false))
})

describe('isPeerOctetStreamMessage', () => {
  it('accepts close: false', () => {
    expect(isPeerOctetStreamMessage(base({ kind: 'octet-stream', json: { close: false } }))).toBe(true)
  })

  it('accepts empty close', () => {
    expect(isPeerOctetStreamMessage(base({ kind: 'octet-stream', json: {} }))).toBe(true)
  })

  it('accepts close: true with binary', () => {
    expect(isPeerOctetStreamMessage(base({ kind: 'octet-stream', json: { close: true }, binary: new Uint8Array() }))).toBe(true)
  })

  it.each([
    ['string close', 'invalid'],
    ['numeric close', 1],
  ])('rejects non-boolean close (%s)', (_, close) => {
    expect(isPeerOctetStreamMessage(base({ kind: 'octet-stream', json: { close } as any }))).toBe(false)
  })

  it('rejects wrong kind', () => {
    expect(isPeerOctetStreamMessage(base({ kind: 'event-stream', json: { close: false } }))).toBe(false)
  })
})

describe('isPeerStreamCancelMessage', () => {
  it('accepts valid stream/cancel', () => {
    expect(isPeerStreamCancelMessage(base({ kind: 'stream/cancel', json: undefined, binary: undefined }))).toBe(true)
  })

  it('rejects when json is set', () => {
    expect(isPeerStreamCancelMessage(base({ kind: 'stream/cancel', json: {} }))).toBe(false)
  })

  it('rejects when binary is set', () => {
    expect(isPeerStreamCancelMessage(base({ kind: 'stream/cancel', binary: new Blob([]) }))).toBe(false)
  })

  it('rejects wrong kind', () => {
    expect(isPeerStreamCancelMessage(base({ kind: 'cancel' }))).toBe(false)
  })
})

describe('isClientPeerSendMessage', () => {
  it.each([
    ['request', { kind: 'request', json: { url: '/path' } }],
    ['cancel', { kind: 'cancel', json: undefined, binary: undefined }],
    ['event-stream', { kind: 'event-stream', json: { event: 'message' } }],
    ['octet-stream', { kind: 'octet-stream', json: { } }],
  ])('accepts %s', (_, overrides) => {
    expect(isClientPeerSendMessage(base(overrides))).toBe(true)
  })

  it.each([
    ['response', { kind: 'response', json: {} }],
    ['stream/cancel', { kind: 'stream/cancel', json: undefined, binary: undefined }],
  ])('rejects %s', (_, overrides) => {
    expect(isClientPeerSendMessage(base(overrides))).toBe(false)
  })
})

describe('isServerPeerSendMessage', () => {
  it.each([
    ['response', { kind: 'response', json: {} }],
    ['cancel', { kind: 'cancel', json: undefined, binary: undefined }],
    ['event-stream', { kind: 'event-stream', json: { event: 'message' } }],
    ['octet-stream', { kind: 'octet-stream', json: { } }],
    ['stream/cancel', { kind: 'stream/cancel', json: undefined, binary: undefined }],
  ])('accepts %s', (_, overrides) => {
    expect(isServerPeerSendMessage(base(overrides))).toBe(true)
  })

  it('rejects request', () => {
    expect(isServerPeerSendMessage(base({ kind: 'request', json: { url: '/path' } }))).toBe(false)
  })
})

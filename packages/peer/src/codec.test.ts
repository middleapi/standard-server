import { decodePeerMessage, encodePeerMessage } from './codec'
import type { PeerMessage } from './types'

describe('codec', () => {
  it('handles simple message (JSON only)', async () => {
    const message = { id: '1', kind: 'request', payload: { foo: 'bar' } }

    const encoded = await encodePeerMessage(message)
    expect(typeof encoded).toBe('string')

    const decoded = decodePeerMessage(encoded)
    expect(decoded).toEqual({ matched: true, message })
  })

  it('handles message with prefix', async () => {
    const prefix = 'PRE:'
    const message = { id: '1', kind: 'request', payload: 'test' }

    const encoded = (await encodePeerMessage(message, { prefix })) as string
    expect(encoded).toBeTypeOf('string')
    expect(encoded.startsWith(prefix)).toBe(true)

    const decoded = decodePeerMessage(encoded, { prefix })
    expect(decoded).toEqual({ matched: true, message })
  })

  it('handles message with binary data (Uint8Array)', async () => {
    const binary = new Uint8Array([1, 2, 3, 4])
    const message = { id: '1', kind: 'x', binary }

    const encoded = (await encodePeerMessage(message)) as Uint8Array<ArrayBuffer>
    expect(encoded).toBeInstanceOf(Uint8Array)

    const decoded = decodePeerMessage(encoded)
    expect(decoded).toEqual({ matched: true, message })
  })

  it('handles message with binary data (Blob)', async () => {
    const binaryData = new Uint8Array([10, 20])
    const blob = new Blob([binaryData])
    const message = { id: '2', kind: 'x', binary: blob }

    const encoded = (await encodePeerMessage(message)) as Uint8Array<ArrayBuffer>
    expect(encoded).toBeInstanceOf(Uint8Array)

    const decoded = decodePeerMessage(encoded)
    expect(decoded).toEqual({ matched: true, message: { ...message, binary: binaryData } })
  })

  it('handles message with binary data and prefix', async () => {
    const prefix = 'ABC:'
    const binary = new Uint8Array([5, 6])
    const message = { id: '3', kind: 'x', binary }

    const encoded = (await encodePeerMessage(message, { prefix })) as Uint8Array<ArrayBuffer>
    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(encoded).startsWith(prefix)).toBe(true)

    const decoded = decodePeerMessage(encoded, { prefix })
    expect(decoded).toEqual({ matched: true, message })
  })

  it('handles empty binary payload', async () => {
    const binary = new Uint8Array(0)
    const message = { id: '4', kind: 'x', binary }

    const encoded = await encodePeerMessage(message)
    expect(encoded).toBeInstanceOf(Uint8Array)

    const decoded = decodePeerMessage(encoded)
    expect(decoded).toEqual({ matched: true, message })
  })

  it('handles unicode characters in JSON', async () => {
    const message = { id: '5', kind: 'y', data: '你好世界 🌍 áéíóú' }

    const encoded = await encodePeerMessage(message)
    const decoded = decodePeerMessage(encoded)
    expect(decoded).toEqual({ matched: true, message })
  })

  it('handles multi-byte unicode prefix with binary payload', async () => {
    const prefix = '☂peer:'
    const binary = new Uint8Array([7, 8, 9])
    const message = { id: '6', kind: 'x', binary }

    const encoded = (await encodePeerMessage(message, { prefix })) as Uint8Array<ArrayBuffer>
    const decoded = decodePeerMessage(encoded, { prefix })
    expect(decoded).toEqual({ matched: true, message })
  })

  it('preserves delimiter bytes (0xFF) inside the binary payload', async () => {
    const binary = new Uint8Array([0xff, 0x00, 0xff, 0x42])
    const message = { id: '7', kind: 'x', binary }

    const encoded = await encodePeerMessage(message)
    const decoded = decodePeerMessage(encoded)
    expect(decoded).toEqual({ matched: true, message })
  })

  describe('decode', () => {
    it('can decodes a binary message without binary payload (JSON only in Uint8Array)', () => {
      const message: PeerMessage = { id: '3', kind: 'g' }
      const textEncoder = new TextEncoder()
      const encoded = textEncoder.encode(JSON.stringify(message))

      const result = decodePeerMessage(encoded)
      expect(result).toEqual({ matched: true, message })
    })

    it('returns matched: false for string mismatch prefix', () => {
      const encoded = 'WRONG:{"id":1}'
      const result = decodePeerMessage(encoded, { prefix: 'RIGHT:' })
      expect(result).toEqual({ matched: false })
    })

    it('returns matched: false for binary mismatch prefix', () => {
      const textEncoder = new TextEncoder()
      const encoded = textEncoder.encode('WRONG:{}')
      const result = decodePeerMessage(encoded, { prefix: 'RIGHT:' })
      expect(result).toEqual({ matched: false })
    })

    it('returns matched: false for malformed JSON string input', () => {
      expect(decodePeerMessage('not valid json')).toEqual({ matched: false })
    })

    it('returns matched: false for malformed JSON binary input', () => {
      const encoded = new TextEncoder().encode('not valid json')
      expect(decodePeerMessage(encoded)).toEqual({ matched: false })
    })

    it('returns matched: false for invalid peer message', async () => {
      const encoded = (await encodePeerMessage({ id: '1' } as any)) as string // missing `kind`
      expect(decodePeerMessage(encoded)).toEqual({ matched: false })
      expect(decodePeerMessage(new TextEncoder().encode(encoded))).toEqual({ matched: false })
    })

    it('returns matched: false for invalid peer message with binary', async () => {
      const encoded = await encodePeerMessage({ id: '1', binary: new Blob(['a']) } as any) // missing `kind`
      expect(decodePeerMessage(encoded)).toEqual({ matched: false })
    })

    it('returns matched: false when the payload is shorter than the prefix', () => {
      expect(decodePeerMessage('{', { prefix: 'LONG-PREFIX:' })).toEqual({ matched: false })
      expect(decodePeerMessage(new TextEncoder().encode('{'), { prefix: 'LONG-PREFIX:' })).toEqual({
        matched: false,
      })
    })
  })

  describe('security', () => {
    it('does not pollute Object.prototype when decoding __proto__ keys', () => {
      const payload =
        '{"id":"1","kind":"request","json":{"url":"/admin","__proto__":{"isAdmin":true}},"__proto__":{"polluted":true}}'

      for (const encoded of [payload, new TextEncoder().encode(payload)] as const) {
        const result = decodePeerMessage(encoded)

        expect(result.matched).toBe(true)
        expect(({} as any).polluted).toBeUndefined()
        expect(({} as any).isAdmin).toBeUndefined()
        expect(Object.getPrototypeOf(result.message)).toBe(Object.prototype)
        // the malicious key stays an inert own property
        expect(Object.getOwnPropertyDescriptor(result.message, '__proto__')?.value).toEqual({
          polluted: true,
        })
      }
    })

    it('does not pollute Object.prototype when decoding constructor.prototype keys', () => {
      const payload = '{"id":"1","kind":"cancel","constructor":{"prototype":{"polluted":true}}}'
      const result = decodePeerMessage(payload)

      expect(result.matched).toBe(true)
      expect(({} as any).polluted).toBeUndefined()
      expect((result.message as any).constructor).toEqual({ prototype: { polluted: true } })
    })
  })
})

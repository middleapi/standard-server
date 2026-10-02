import { generate } from 'selfsigned'

let pems: ReturnType<typeof generate> | undefined

/**
 * Self-signed localhost certificate generated once per test process,
 * for the TLS (https) client-server adapters.
 */
export async function generateTlsCert(): Promise<{ cert: string; key: string }> {
  pems ??= generate([{ name: 'commonName', value: 'localhost' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' }, // DNS
          { type: 7, ip: '127.0.0.1' }, // IP
        ],
      },
    ],
  })

  const { cert, private: key } = await pems

  return { cert, key }
}

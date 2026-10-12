import { createHmac } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareBrowserImport } from './browser-import.mjs'

afterEach(() => vi.unstubAllGlobals())

it('never sends bytes or credentials to an endpoint that cannot prove its identity', async () => {
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requests.push(init)
    return new Response(JSON.stringify({ proof: '00'.repeat(32), offset: 0, chunkBytes: 4194304 }))
  })
  const transfer = prepareBrowserImport(new Blob(['hello']), {
    filename: 'study.science',
    origin: 'https://research.example',
    port: 49232
  })
  await expect(transfer.send()).rejects.toThrow(/identity/i)
  expect(requests).toHaveLength(1)
  expect(new Headers(requests[0].headers).has('Authorization')).toBe(false)
  expect(requests[0].body).toBeUndefined()
})

it('rejects empty packages, unsafe filenames and insecure public websites before launch', () => {
  for (const [file, options] of [
    [new Blob(), { filename: 'study.science', origin: 'https://research.example' }],
    [new Blob(['hi']), { filename: '../study.science', origin: 'https://research.example' }],
    [new Blob(['hi']), { filename: 'study.science', origin: 'http://research.example' }]
  ] as const)
    expect(() => prepareBrowserImport(file, options)).toThrow()
})

it('keeps bytes and the secret private if the listener is replaced after a valid handshake', async () => {
  const transfer = prepareBrowserImport(new Blob(['private research']), {
    filename: 'study.science',
    origin: 'https://research.example',
    port: 49232
  })
  const secret = new URL(transfer.url).searchParams.get('secret')!
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    requests.push(init)
    if (requests.length === 1) {
      const challenge = new URL(input).searchParams.get('challenge')
      const proof = createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`open-science-import-v1:${challenge}:0:0`)
        .digest('hex')
      return new Response(
        JSON.stringify({ proof, offset: 0, accepted: false, chunkBytes: 4194304 })
      )
    }
    return new Response(JSON.stringify({ offset: 16, proof: 'forged' }))
  })
  await expect(transfer.send()).rejects.toThrow(/offset/)
  expect(requests).toHaveLength(2)
  expect(new Headers(requests[1].headers).get('Authorization')).not.toContain(secret)
  expect(
    Buffer.from(requests[1].body as Uint8Array).includes(Buffer.from('private research'))
  ).toBe(false)
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { authenticateRequest, loadOrCreateWebToken } from './auth'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const request = (headers: Record<string, string>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage

describe('web authentication', () => {
  it('creates and reuses a persistent random token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-science-web-auth-'))
    dirs.push(dir)
    const first = await loadOrCreateWebToken(dir)
    const second = await loadOrCreateWebToken(dir)
    expect(first).toHaveLength(43)
    expect(second).toBe(first)
    expect((await readFile(join(dir, 'web-token'), 'utf8')).trim()).toBe(first)
  })

  it('accepts only token-authenticated loopback requests with a same-origin Origin', () => {
    const token = 'a'.repeat(43)
    const url = new URL(`http://127.0.0.1:44100/?token=${token}`)
    expect(
      authenticateRequest(
        request({ host: '127.0.0.1:44100', origin: 'http://127.0.0.1:44100' }),
        url,
        token
      ).ok
    ).toBe(true)
    expect(authenticateRequest(request({ host: 'evil.example' }), url, token).ok).toBe(false)
    expect(
      authenticateRequest(
        request({ host: '127.0.0.1:44100', origin: 'http://evil.example' }),
        url,
        token
      ).ok
    ).toBe(false)
    expect(
      authenticateRequest(
        request({ host: '127.0.0.1:44100' }),
        new URL('http://127.0.0.1:44100/?token=wrong'),
        token
      ).ok
    ).toBe(false)
  })
})

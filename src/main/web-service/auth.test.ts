import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

  it.runIf(process.platform !== 'win32')(
    'repairs reused token permissions without rotating the credential',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'open-science-web-auth-'))
      dirs.push(dir)
      const tokenPath = join(dir, 'web-token')
      const existing = 'a'.repeat(43)
      await writeFile(tokenPath, `${existing}\n`, { mode: 0o644 })
      await chmod(tokenPath, 0o644)

      expect(await loadOrCreateWebToken(dir)).toBe(existing)
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
    }
  )

  it.runIf(process.platform !== 'win32')('repairs and reuses a read-only token file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-science-web-auth-'))
    dirs.push(dir)
    const tokenPath = join(dir, 'web-token')
    const existing = 'c'.repeat(43)
    await writeFile(tokenPath, `${existing}\n`, { mode: 0o400 })
    await chmod(tokenPath, 0o400)

    expect(await loadOrCreateWebToken(dir)).toBe(existing)
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked token without modifying its target',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'open-science-web-auth-'))
      dirs.push(dir)
      const targetPath = join(dir, 'unrelated-file')
      const tokenPath = join(dir, 'web-token')
      const target = 'b'.repeat(43)
      await writeFile(targetPath, `${target}\n`, { mode: 0o644 })
      await chmod(targetPath, 0o644)
      await symlink(targetPath, tokenPath)

      await expect(loadOrCreateWebToken(dir)).rejects.toThrow()
      expect((await readFile(targetPath, 'utf8')).trim()).toBe(target)
      expect((await stat(targetPath)).mode & 0o777).toBe(0o644)
    }
  )

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

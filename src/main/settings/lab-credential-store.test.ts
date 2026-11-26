import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./crypto', () => ({
  encryptKey: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  tryDecryptKey: (ref?: string) =>
    ref?.startsWith('enc:') ? Buffer.from(ref.slice(4), 'base64').toString('utf8') : undefined
}))

import { LabCredentialStore } from './lab-credential-store'

let root: string | undefined

const createRoot = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'open-science-lab-credentials-'))
  return root
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('Lab credential store', () => {
  it('keeps tokens out of the plaintext document', async () => {
    const dir = await createRoot()
    const store = new LabCredentialStore(dir)
    await store.saveServerUrl('https://lab.example.com')
    await store.saveSession({
      accessToken: 'at_secret_value',
      refreshToken: 'rt_secret_value',
      tokenExpiresAt: 1_000,
      sessionExpiresAt: '2026-12-15T00:00:00Z'
    })

    const contents = await readFile(join(dir, 'lab-credentials.json'), 'utf8')
    expect(contents).not.toContain('at_secret_value')
    expect(contents).not.toContain('rt_secret_value')
    expect(contents).toContain('https://lab.example.com')
    const session = await store.readSession()
    expect(session).toMatchObject({
      accessToken: 'at_secret_value',
      refreshToken: 'rt_secret_value',
      tokenExpiresAt: 1_000
    })
  })

  it('keeps one stable installation id across sessions and logout', async () => {
    const dir = await createRoot()
    const first = await new LabCredentialStore(dir).ensureInstallationId()
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/u)
    const second = await new LabCredentialStore(dir).ensureInstallationId()
    expect(second).toBe(first)

    await new LabCredentialStore(dir).saveSession({
      accessToken: 'at',
      refreshToken: 'rt',
      tokenExpiresAt: 1
    })
    await new LabCredentialStore(dir).clearSession()
    const document = await new LabCredentialStore(dir).readDocument()
    expect(document.installationId).toBe(first)
    expect(document.credentialRef).toBeUndefined()
    expect(await new LabCredentialStore(dir).readSession()).toBeUndefined()
  })

  it('treats an unreadable credential document as a missing session instead of crashing', async () => {
    const dir = await createRoot()
    await writeFile(join(dir, 'lab-credentials.json'), '{not json')
    const store = new LabCredentialStore(dir)
    await expect(store.readDocument()).rejects.toThrow()
    await expect(store.readSession()).resolves.toBeUndefined()
  })
})

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseStored, RemoteAccessRepository } from './repository'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RemoteAccessRepository', () => {
  it('starts disabled and persists only hashed trusted-browser records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-remote-repository-'))
    roots.push(root)
    const repository = new RemoteAccessRepository(root)
    expect(await repository.load()).toEqual({
      version: 4,
      mode: 'off',
      trustedBrowsers: []
    })

    await repository.save({
      version: 4,
      mode: 'remoteit',
      remoteItAppServiceId: 'service-1',
      trustedBrowsers: [
        {
          id: 'browser-1',
          browser: 'Safari',
          platform: 'iOS/iPadOS',
          tokenHash: 'a'.repeat(64),
          createdAt: 10,
          lastSeenAt: 20
        }
      ]
    })

    expect(await repository.load()).toMatchObject({
      mode: 'remoteit',
      remoteItAppServiceId: 'service-1'
    })
    const raw = await readFile(join(root, 'remote-access.json'), 'utf8')
    expect(raw).toContain('"tokenHash"')
    expect(raw).not.toContain('cookieValue')
  })

  it('migrates removed provider preferences to Off', () => {
    expect(
      parseStored({
        version: 1,
        enabled: true,
        trustedBrowsers: []
      })
    ).toEqual({ version: 4, mode: 'off', trustedBrowsers: [] })
    expect(
      parseStored({
        version: 3,
        mode: 'removed-provider-mode',
        trustedBrowsers: []
      })
    ).toEqual({ version: 4, mode: 'off', trustedBrowsers: [] })
  })

  it('migrates the legacy shared service identifier to App access', () => {
    expect(
      parseStored({
        version: 3,
        mode: 'remoteit',
        remoteItServiceId: 'service-1',
        trustedBrowsers: []
      })
    ).toMatchObject({
      version: 4,
      mode: 'remoteit',
      remoteItAppServiceId: 'service-1'
    })
  })

  it('persists separate App and Browser services with the Browser HTTPS endpoint', () => {
    expect(
      parseStored({
        version: 4,
        mode: 'remoteit-public',
        remoteItAppServiceId: 'app-service',
        remoteItBrowserServiceId: 'browser-service',
        remoteItPublicUrl: 'https://open-science.p020.r3proxy.com/',
        trustedBrowsers: []
      })
    ).toMatchObject({
      version: 4,
      mode: 'remoteit-public',
      remoteItAppServiceId: 'app-service',
      remoteItBrowserServiceId: 'browser-service',
      remoteItPublicUrl: 'https://open-science.p020.r3proxy.com/'
    })
  })

  it('accepts a later save after an earlier filesystem write fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'open-science-remote-repository-recovery-'))
    roots.push(parent)
    const configRoot = join(parent, 'config')
    await writeFile(configRoot, 'blocks directory creation')
    const repository = new RemoteAccessRepository(configRoot)

    await expect(
      repository.save({ version: 4, mode: 'remoteit', trustedBrowsers: [] })
    ).rejects.toThrow()

    await rm(configRoot)
    await repository.save({ version: 4, mode: 'remoteit-public', trustedBrowsers: [] })

    await expect(repository.load()).resolves.toMatchObject({ mode: 'remoteit-public' })
  })
})

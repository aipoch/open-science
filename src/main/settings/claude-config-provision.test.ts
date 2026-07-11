import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { APP_ASSET_SUBDIRS, provisionAppClaudeConfigDir } from './claude-config-provision'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

describe('provisionAppClaudeConfigDir', () => {
  it('creates the config dir and its app-asset subdirs', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)

    expect((await stat(configDir)).isDirectory()).toBe(true)
    const entries = (await readdir(configDir)).sort()
    for (const sub of APP_ASSET_SUBDIRS) {
      expect(entries).toContain(sub)
    }
  })

  it('is idempotent', async () => {
    root = await mkdtemp(join(tmpdir(), 'os-claude-config-'))
    const configDir = join(root, 'claude')

    await provisionAppClaudeConfigDir(configDir)
    await expect(provisionAppClaudeConfigDir(configDir)).resolves.toBeUndefined()
  })
})

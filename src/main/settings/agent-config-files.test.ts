import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { writeAgentConfigFiles } from './agent-config-files'

describe('writeAgentConfigFiles', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('does not rewrite an existing matching content-addressed file', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-config-files-'))
    const path = join(root, 'model-catalog-hash.json')
    await writeFile(path, '{"models":[]}\n')
    await chmod(path, 0o400)

    await writeAgentConfigFiles([
      {
        path,
        content: '{"models":[]}\n',
        mode: 0o600,
        contentAddressed: true
      }
    ])

    expect((await stat(path)).mode & 0o222).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('{"models":[]}\n')
  })

  it('publishes concurrent content-addressed writes as one complete file', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-config-files-race-'))
    const path = join(root, 'nested', 'model-catalog-hash.json')
    const file = {
      path,
      content: `${JSON.stringify({ models: [{ slug: 'MiniMax-M3' }] }, null, 2)}\n`,
      mode: 0o600,
      contentAddressed: true as const
    }

    await Promise.all(Array.from({ length: 8 }, () => writeAgentConfigFiles([file])))

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      models: [{ slug: 'MiniMax-M3' }]
    })
    expect(await readdir(join(root, 'nested'))).toEqual(['model-catalog-hash.json'])
  })

  it('keeps ordinary mutable config files replaceable', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-config-files-mutable-'))
    const path = join(root, 'config.toml')
    await writeFile(path, 'model = "old"\n')

    await writeAgentConfigFiles([{ path, content: 'model = "new"\n', mode: 0o600 }])

    expect(await readFile(path, 'utf8')).toBe('model = "new"\n')
  })
})

import { mkdtemp, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { pruneBackendStartupLogs } from './backend-startup-log-retention'

it('keeps the newest 20 startup logs and retries an older open log after it closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'startup logs-'))
  const names = Array.from({ length: 22 }, (_, i) => `desktop-backend-42-${1700000000000 + i}.log`)
  try {
    await Promise.all([...names, 'main.log'].map((name) => writeFile(join(root, name), '')))
    const directory = 'desktop-backend-42-1699999999999.log'
    await mkdir(join(root, directory))
    const writer = await open(join(root, names[0]), 'a')
    try {
      await pruneBackendStartupLogs(root, names[21])
      expect((await readdir(root)).sort()).toEqual(
        [names[0], ...names.slice(2), directory, 'main.log'].sort()
      )
    } finally {
      await writer.close()
    }
    await pruneBackendStartupLogs(root, names[21])
    expect((await readdir(root)).sort()).toEqual([...names.slice(2), directory, 'main.log'].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

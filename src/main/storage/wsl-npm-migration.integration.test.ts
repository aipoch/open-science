import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
vi.mock('./remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))

import { createWslNpmMigration, needsWslNpmMigration, npmMigrationPath } from './wsl-npm-migration'
import { copyAndVerify, deleteSources } from './data-migration'
import { DataRootCleanupJournal } from './data-root-cleanup'
import { readMigrationMarker, scanInventory } from './migration-marker'
import { commitDataRootSwitch, discardStagedCopy, runDataRootMigration } from './migration-service'

const distro = process.env.OPEN_SCIENCE_WSL_DISTRO
const user = process.env.OPEN_SCIENCE_WSL_USER
const enabled = process.platform === 'win32' && Boolean(distro && user)

describe.runIf(enabled)('WSL npm data migration', () => {
  let root: string
  let source: string
  let parent: string
  let target: string
  const migration = createWslNpmMigration(async () => ({ distro: distro!, user: user! }))
  const guest = (program: string, ...args: string[]): string =>
    execFileSync(
      'wsl.exe',
      [
        '-d',
        distro!,
        '-u',
        user!,
        '--cd',
        '/',
        '--exec',
        '/usr/bin/python3',
        '-I',
        '-c',
        program,
        ...args
      ],
      { encoding: 'utf8', windowsHide: true }
    )
  const cli = (dataRoot: string): string =>
    guest(
      `
import subprocess, sys
root = subprocess.check_output(['wslpath', '-a', '-u', sys.argv[1]], text=True).strip()
print(subprocess.check_output([root + '/linux-x64/bin/probe'], text=True).strip())
`,
      npmMigrationPath(dataRoot)
    ).trim()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wsl-npm-'))
    source = join(root, 'source 空 格')
    parent = join(root, 'target 空 格')
    target = join(parent, 'Open-Science')
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', join(root, 'config'))
    await mkdir(source)
    await mkdir(parent)
    guest(
      `
import os, subprocess, sys
root = subprocess.check_output(['wslpath', '-a', '-u', sys.argv[1]], text=True).strip()
os.makedirs(root + '/linux-x64/bin')
os.makedirs(root + '/linux-x64/lib/node_modules/probe')
with open(root + '/linux-x64/lib/node_modules/probe/cli.sh', 'w') as file:
    file.write('#!/bin/sh\\necho global-tool-retained\\n')
os.chmod(root + '/linux-x64/lib/node_modules/probe/cli.sh', 0o755)
os.symlink('../lib/node_modules/probe/cli.sh', root + '/linux-x64/bin/probe')
`,
      npmMigrationPath(source)
    )
    await mkdir(join(source, 'artifacts'))
    await writeFile(join(source, 'artifacts', 'keep.txt'), 'kept')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const dataRoot of [source, target]) {
      if (existsSync(npmMigrationPath(dataRoot))) await migration.remove(dataRoot)
    }
    await rm(root, { recursive: true, force: true })
  })

  const copy = (): ReturnType<typeof runDataRootMigration> =>
    runDataRootMigration(
      {
        currentDataRoot: source,
        runtime: { disconnect: vi.fn().mockResolvedValue(undefined) },
        notebook: { shutdownAll: vi.fn().mockResolvedValue({ reaped: true }) },
        disconnectProjectDb: async () => {},
        validateProvenanceState: async () => {},
        npmMigration: migration
      },
      parent,
      { signal: new AbortController().signal, onProgress: () => {} }
    )

  it('preserves runnable relative links through copy, commit, and restarted cleanup', async () => {
    expect(await copy()).toEqual({ ok: true })
    expect(cli(source)).toBe('global-tool-retained')
    expect(cli(target)).toBe('global-tool-retained')
    const dirs = [join('runtime', 'npm')]
    expect(await scanInventory(source, dirs, migration)).toEqual(
      await scanInventory(target, dirs, migration)
    )
    // The whole-runtime cleanup path must also understand nested WSL links.
    expect((await scanInventory(source, ['runtime'], migration)).fileCount).toBe(2)
    const marker = (await readMigrationMarker(target))!
    const journal = new DataRootCleanupJournal(join(root, 'config'), migration)
    const switched = vi.fn().mockResolvedValue(undefined)
    const committed = await commitDataRootSwitch(
      {
        currentDataRoot: source,
        expectedToken: marker.token,
        setDataRoot: switched,
        npmMigration: migration,
        cleanupJournal: journal,
        validateProvenanceState: async () => {},
        deleteSources: async () => ({
          deleted: [],
          failed: [{ dir: 'runtime', error: 'interrupted' }]
        })
      },
      parent
    )
    expect(committed).toEqual({ ok: true, cleanupPending: true })
    expect(switched).toHaveBeenCalledWith(target)
    const unavailable = createWslNpmMigration(async () => undefined)
    const blocked = new DataRootCleanupJournal(join(root, 'config'), unavailable)
    const remove = vi.fn(async (path: string, paths: string[]) =>
      deleteSources(path, paths, undefined, migration)
    )
    expect((await blocked.recover(target, remove)).pending).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    expect(cli(source)).toBe('global-tool-retained')
    const restarted = new DataRootCleanupJournal(join(root, 'config'), migration)
    expect(await restarted.recover(target, remove)).toEqual({ pending: false, failureCount: 0 })
    expect(existsSync(npmMigrationPath(source))).toBe(false)
    expect(cli(target)).toBe('global-tool-retained')
    expect(await readFile(join(target, 'artifacts', 'keep.txt'), 'utf8')).toBe('kept')
  }, 300_000)

  it('keeps the source when WSL is unavailable and safely discards an owned staged copy', async () => {
    expect(await needsWslNpmMigration(source, [join('runtime', 'npm')])).toBe(true)
    const unavailable = createWslNpmMigration(async () => undefined)
    const failed = await copyAndVerify({
      from: source,
      to: target,
      dirs: [join('runtime', 'npm')],
      signal: new AbortController().signal,
      onProgress: () => {},
      npmMigration: unavailable
    })
    expect(failed.ok).toBe(false)
    expect(cli(source)).toBe('global-tool-retained')
    expect(await copy()).toEqual({ ok: true })
    const marker = (await readMigrationMarker(target))!
    expect(
      await discardStagedCopy(
        { currentDataRoot: source, expectedToken: marker.token, npmMigration: migration },
        parent
      )
    ).toEqual({ ok: true })
    expect(existsSync(target)).toBe(false)
    expect(cli(source)).toBe('global-tool-retained')
  }, 300_000)

  it('refuses changed staged tools and links outside the package tree', async () => {
    expect(await copy()).toEqual({ ok: true })
    const marker = (await readMigrationMarker(target))!
    await writeFile(
      join(npmMigrationPath(target), 'linux-x64/lib/node_modules/probe/cli.sh'),
      'changed'
    )
    const switched = vi.fn()
    expect(
      await commitDataRootSwitch(
        {
          currentDataRoot: source,
          expectedToken: marker.token,
          setDataRoot: switched,
          npmMigration: migration,
          validateProvenanceState: async () => {}
        },
        parent
      )
    ).toMatchObject({
      ok: false,
      error: 'The staged copy changed after verification. Run the move again.'
    })
    expect(switched).not.toHaveBeenCalled()
    expect(cli(source)).toBe('global-tool-retained')
    guest(
      `
import os, subprocess, sys
root = subprocess.check_output(['wslpath', '-a', '-u', sys.argv[1]], text=True).strip()
os.symlink('../../../../artifacts/keep.txt', root + '/linux-x64/bin/outside')
`,
      npmMigrationPath(source)
    )
    await expect(migration.scan(source)).rejects.toThrow('outside the data being moved')
    expect(await readFile(join(source, 'artifacts', 'keep.txt'), 'utf8')).toBe('kept')
  }, 300_000)
})

it('copies native global packages without consulting WSL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-npm-move-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  try {
    await mkdir(join(npmMigrationPath(source), 'win32-x64'), { recursive: true })
    await mkdir(target)
    await writeFile(join(npmMigrationPath(source), 'win32-x64', 'tool.cmd'), 'native-tool')
    const selection = vi.fn(async () => {
      throw new Error('WSL must not be consulted')
    })
    const migration = createWslNpmMigration(selection)
    const dirs = [join('runtime', 'npm')]
    expect(await needsWslNpmMigration(source, dirs)).toBe(false)
    expect(
      await copyAndVerify({
        from: source,
        to: target,
        dirs,
        signal: new AbortController().signal,
        onProgress: () => {},
        npmMigration: migration
      })
    ).toEqual({ ok: true })
    expect(await scanInventory(source, dirs, migration)).toEqual(
      await scanInventory(target, dirs, migration)
    )
    expect(selection).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

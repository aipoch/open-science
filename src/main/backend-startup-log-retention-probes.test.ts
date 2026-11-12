import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pruneBackendStartupLogs } from './backend-startup-log-retention'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: run })
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const geteuid = Object.getOwnPropertyDescriptor(process, 'geteuid')
let root: string
let names: string[]

beforeEach(async () => {
  Object.defineProperty(process, 'geteuid', { value: () => 1000, configurable: true })
  root = await mkdtemp(join(tmpdir(), 'startup-log-probes-'))
  names = Array.from({ length: 22 }, (_, i) => `desktop-backend-42-${1700000000000 + i}.log`)
  await Promise.all(names.map((name) => writeFile(join(root, name), '')))
  run.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  if (geteuid) Object.defineProperty(process, 'geteuid', geteuid)
  else Reflect.deleteProperty(process, 'geteuid')
  vi.mocked(readdir).mockReset()
  await rm(root, { recursive: true, force: true })
})

it.each(['success', 'partial', 'warning', 'unanchored', 'killed'] as const)(
  'requires a trustworthy macOS open-file snapshot before deleting logs: %s',
  async (result) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const current = await stat(join(root, names[21]), { bigint: true })
    const occupied = await stat(join(root, names[0]), { bigint: true })
    const output = {
      stdout: result === 'unanchored' ? '' : `p42\0i${current.ino}\0i${occupied.ino}\0`,
      stderr: result === 'warning' ? 'lsof: incomplete inspection' : ''
    }
    const failure = Object.assign(new Error('lsof exited'), output, {
      code: 1,
      killed: result === 'killed'
    })
    if (result === 'partial' || result === 'killed') run.mockRejectedValue(failure)
    else run.mockResolvedValue(output)

    const pruning = pruneBackendStartupLogs(root, names[21])
    if (result === 'killed') await expect(pruning).rejects.toBe(failure)
    else await pruning
    const shouldDelete = result === 'success' || result === 'partial'
    expect((await readdir(root)).sort()).toEqual(
      names.filter((_, i) => !shouldDelete || i !== 1).sort()
    )
  }
)

it('bounds Windows batches, protects an old current log and propagates helper failures', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  names = Array.from({ length: 221 }, (_, i) => `desktop-backend-42-${1700000000000 + i}.log`)
  await Promise.all(names.map((name) => writeFile(join(root, name), '')))
  await pruneBackendStartupLogs(root, names[0])
  const batches = run.mock.calls.map(([, , options]) =>
    JSON.parse(options.env.OPEN_SCIENCE_PRUNE_LOGS)
  )
  expect(batches.map((batch) => batch.length)).toEqual([100, 100])
  expect(batches.flat().sort()).toEqual(names.slice(1, -20).sort())

  const failure = new Error('PowerShell could not inspect the directory')
  run.mockRejectedValueOnce(failure)
  await expect(pruneBackendStartupLogs(root, names[0])).rejects.toBe(failure)
})

it.each(['EACCES', 'EIO'])(
  'uses the Linux lease fallback only for denied procfs inspection: %s',
  async (code) => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const failure = Object.assign(new Error('procfs unavailable'), { code })
    vi.mocked(readdir).mockImplementationOnce(actual.readdir).mockRejectedValueOnce(failure)
    const pruning = pruneBackendStartupLogs(root, names[21])
    if (code === 'EIO') {
      await expect(pruning).rejects.toBe(failure)
      expect(run).not.toHaveBeenCalled()
    } else {
      await pruning
      expect(run).toHaveBeenCalledWith(
        '/usr/bin/python3',
        ['-I', '-S', '-c', expect.any(String), await realpath(root), names[1], names[0]],
        { timeout: 10000 }
      )
    }
    expect(readdir).toHaveBeenNthCalledWith(2, '/proc')
    expect((await readdir(root)).sort()).toEqual(names.sort())
  }
)

import { transform } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  acquireRuntimeDirectory,
  RUNTIME_LOCK_FILE,
  RuntimeDirectoryOwnership,
  RuntimeOwnershipConflict,
  type RuntimeDirectoryLease
} from './runtime-ownership'

const roots: string[] = []
const leases: RuntimeDirectoryLease[] = []
const children: ChildProcess[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'open-science-ownership-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  for (const lease of leases.splice(0)) lease.release()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('shared Node/Electron runtime ownership', () => {
  it('excludes another writer and permits acquisition after idempotent release', async () => {
    const path = await root()
    const first = await acquireRuntimeDirectory(path)
    leases.push(first)
    await expect(acquireRuntimeDirectory(path)).rejects.toBeInstanceOf(RuntimeOwnershipConflict)
    first.release()
    first.release()
    leases.push(await acquireRuntimeDirectory(path))
  })

  it('has exactly one winner among concurrent starts', async () => {
    const path = await root()
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireRuntimeDirectory(path))
    )
    const winners = results.filter((result) => result.status === 'fulfilled')
    for (const result of winners) leases.push(result.value)
    expect(winners).toHaveLength(1)
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(RuntimeOwnershipConflict)
    }
  })

  it('elects one writer when separate processes open a new lock simultaneously', async () => {
    const path = await root()
    const source = await readFile(new URL('./runtime-ownership.ts', import.meta.url), 'utf8')
    const compiled = await transform(source, { loader: 'ts', format: 'cjs', platform: 'node' })
    const modulePath = join(path, 'ownership.cjs')
    await writeFile(modulePath, compiled.code)
    const contenders = Array.from({ length: 8 }, () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        const { acquireRuntimeDirectorySync } = require(process.argv[1]);
        process.stdin.once('data', () => {
          try {
            const lease = acquireRuntimeDirectorySync(process.argv[2]);
            process.stdout.write('winner');
            setInterval(() => {}, 1000);
          } catch (error) {
            if (error.name !== 'RuntimeOwnershipConflict') throw error;
            process.stdout.write('contender');
            process.exitCode = 75;
          }
        });
      `,
          modulePath,
          join(path, 'shared')
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      children.push(child)
      return child
    })
    const outcomes = contenders.map(async (child) => {
      const [output] = await once(child.stdout!, 'data')
      return String(output)
    })
    for (const child of contenders) child.stdin!.end('start')
    expect((await Promise.all(outcomes)).filter((value) => value === 'winner')).toHaveLength(1)
  })

  it('guards a shared data root even when configuration roots differ', async () => {
    const path = await root()
    const first = new RuntimeDirectoryOwnership()
    const second = new RuntimeDirectoryOwnership()
    try {
      await first.acquire(join(path, 'config-a'))
      await second.acquire(join(path, 'config-b'))
      await first.acquire(join(path, 'data'))
      await expect(second.acquire(join(path, 'data'))).rejects.toBeInstanceOf(
        RuntimeOwnershipConflict
      )
      await first.close()
      await second.acquire(join(path, 'data'))
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('canonicalizes directory aliases without weakening exclusion', async () => {
    const path = await root()
    const target = join(path, 'data')
    const first = await acquireRuntimeDirectory(target)
    leases.push(first)
    const alias = join(path, 'alias')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(acquireRuntimeDirectory(alias)).rejects.toBeInstanceOf(RuntimeOwnershipConflict)
  })

  it('refuses corrupt lock files rather than removing them', async () => {
    const path = await root()
    await writeFile(join(path, RUNTIME_LOCK_FILE), 'not a sqlite database')
    await expect(acquireRuntimeDirectory(path)).rejects.toThrow()
  })

  it('releases OS ownership on abnormal exit without trusting a stale PID record', async () => {
    const path = await root()
    await writeFile(join(path, 'web-service.json'), JSON.stringify({ pid: process.pid, port: 1 }))
    // Exercise a real separate process and SQLite's actual file locks, not mocked liveness.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `,
        join(path, RUNTIME_LOCK_FILE)
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    children.push(child)
    await once(child.stdout!, 'data')
    await expect(acquireRuntimeDirectory(path)).rejects.toBeInstanceOf(RuntimeOwnershipConflict)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    leases.push(await acquireRuntimeDirectory(path))
  })
})

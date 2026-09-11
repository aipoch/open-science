import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  lstat,
  symlink,
  realpath
} from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Real process inventories and repeated durable rollback/commit cycles need an integration budget.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

const roots: string[] = []
async function fixture(): Promise<{ home: string; config: string; old: string; next: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'brand-migration-test-')))
  roots.push(home)
  const config = join(home, '.open-science-project')
  const old = join(home, 'OpenScience-DEV')
  await mkdir(config)
  await mkdir(join(old, 'uploads'), { recursive: true })
  await writeFile(join(old, 'uploads', 'paper.txt'), 'research\n')
  await writeFile(
    join(config, 'settings.json'),
    JSON.stringify({ version: 2, providers: [], dataRoot: old })
  )
  return { home, config, old, next: join(home, 'Open-Science-DEV') }
}
function cli(
  home: string,
  ...args: string[]
): { status: number; output: string; value: ReturnType<typeof JSON.parse> } {
  try {
    const output = execFileSync(
      process.execPath,
      [
        'scripts/migrate-brand-paths.mjs',
        '--home',
        home,
        '--app-data',
        join(home, 'appData'),
        '--mode',
        'dev',
        ...args
      ],
      { encoding: 'utf8' }
    )
    return { status: 0, output, value: JSON.parse(output) }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return {
      status: failure.status ?? 1,
      output: String(failure.stdout) + String(failure.stderr),
      value: undefined
    }
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function writer(cwd: string): Promise<import('node:child_process').ChildProcess> {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const fd = fs.openSync('uploads/paper.txt', 'a');
    process.on('message', () => { fs.writeSync(fd, 'child-write\\n'); process.send('written'); });
    process.send('ready');
  `
    ],
    { cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  )
  await once(child, 'message')
  return child
}
async function stop(child: import('node:child_process').ChildProcess): Promise<void> {
  const { once } = await import('node:events')
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

describe('offline brand migration', () => {
  it('defaults to a read-only plan and leaves both settings and file bytes untouched', async () => {
    const f = await fixture()
    const before = await readFile(join(f.config, 'settings.json'), 'utf8')
    const result = cli(f.home)
    expect(result.status, result.output).toBe(0)
    expect(result.value.mappings).toContainEqual(
      expect.objectContaining({ from: f.old, to: f.next })
    )
    expect(await readFile(join(f.config, 'settings.json'), 'utf8')).toBe(before)
    expect(await readdir(f.home)).toEqual(expect.not.arrayContaining(['Open-Science-DEV']))
  })
  it('copies, verifies and commits new roots while preserving recovery data and IDs', async () => {
    const f = await fixture()
    await mkdir(join(f.config, 'sessions', 'project'), { recursive: true })
    await writeFile(
      join(f.config, 'sessions', 'project', 'session.json'),
      JSON.stringify({
        id: 'session',
        projectId: 'project',
        cwd: f.old,
        messages: [
          {
            id: 'message',
            text: f.old,
            uploads: [{ id: 'upload', path: join(f.old, 'uploads', 'paper.txt') }]
          }
        ]
      })
    )
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    expect(result.value.status).toBe('committed')
    expect(await readFile(join(f.next, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
      f.next
    )
    const session = JSON.parse(
      await readFile(join(f.config, 'sessions', 'project', 'session.json'), 'utf8')
    )
    expect(session).toMatchObject({
      id: 'session',
      projectId: 'project',
      cwd: f.next,
      messages: [
        {
          id: 'message',
          text: f.old,
          uploads: [{ id: 'upload', path: join(f.next, 'uploads', 'paper.txt') }]
        }
      ]
    })
    expect(cli(f.home, '--execute').value.status).toBe('committed')
    const rolledBack = cli(f.home, '--rollback')
    expect(rolledBack.status, rolledBack.output).toBe(0)
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(f.old)
  })
  it('rejects two independent trees without modifying either', async () => {
    const f = await fixture()
    await mkdir(f.next)
    await writeFile(join(f.next, 'unrelated'), 'keep')
    const result = cli(f.home, '--execute')
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('conflict')
    expect(await readFile(join(f.next, 'unrelated'), 'utf8')).toBe('keep')
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
  it('does not follow an unowned source symlink', async () => {
    const f = await fixture()
    await rm(f.old, { recursive: true })
    await symlink(f.config, f.old, process.platform === 'win32' ? 'junction' : 'dir')
    const result = cli(f.home, '--execute')
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('symlink')
    expect((await lstat(f.old)).isSymbolicLink()).toBe(true)
  })
})

describe('existing migration targets', () => {
  async function targetFixture(kind: 'empty' | 'logs' = 'empty'): Promise<
    Awaited<ReturnType<typeof fixture>> & {
      from: string
      to: string
      options: { home: string; appData: string; mode: string; platform?: string; execute: boolean }
    }
  > {
    const f = await fixture()
    const from = kind === 'logs' ? join(f.home, 'Library', 'Logs', 'Open Science (DEV)') : f.old
    const to = kind === 'logs' ? join(f.home, 'Library', 'Logs', 'Open-Science (DEV)') : f.next
    await mkdir(from, { recursive: true })
    await mkdir(to, { recursive: true, mode: 0o750 })
    if (kind === 'logs') {
      await writeFile(join(from, 'main.log'), 'old log\n')
      await writeFile(join(to, 'main.log'), 'new log\n')
    }
    const options = {
      home: f.home,
      appData: join(f.home, 'appData'),
      mode: 'dev',
      ...(kind === 'logs' ? { platform: 'darwin' } : {}),
      execute: true
    }
    return { ...f, from, to, options }
  }

  it('plans an empty target without writes, then preserves it through commit and rollback', async () => {
    const f = await targetFixture()
    const stat = await lstat(f.to)
    const plan = cli(f.home)
    expect(plan.value.blockers).toEqual([])
    expect(plan.value.mappings).toContainEqual(
      expect.objectContaining({ from: f.from, state: 'move', targetHandling: 'empty' })
    )
    expect(await readdir(f.to)).toEqual([])
    await expect(lstat(`${f.config}.brand-migration`)).rejects.toMatchObject({ code: 'ENOENT' })
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    const journal = JSON.parse(
      await readFile(join(`${f.config}.brand-migration`, 'journal.json'), 'utf8')
    )
    const p = journal.participants.find((p) => p.to === f.to)
    expect(result.value.existingTargetBackups).toContainEqual({
      from: f.to,
      backup: p.previousTarget.backup,
      kind: 'empty'
    })
    expect(await readdir(p.previousTarget.backup)).toEqual([])
    expect((await lstat(p.previousTarget.backup)).ino).toBe(stat.ino)
    expect((await lstat(p.previousTarget.backup)).mode).toBe(stat.mode)
    expect(await readFile(join(f.to, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    expect(cli(f.home, '--execute').value.id).toBe(result.value.id)
    expect(cli(f.home, '--rollback').value.status).toBe('rolled-back')
    expect((await lstat(f.to)).ino).toBe(stat.ino)
    expect(await readdir(f.to)).toEqual([])
    expect(await readFile(join(f.from, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })

  it.each(['dev', 'packaged'])(
    'handles an empty %s profile but still rejects a nonempty profile',
    async (mode) => {
      const f = await fixture()
      const profile = mode === 'dev' ? 'Open Science (DEV)' : 'Open Science'
      const from = join(f.home, 'appData', profile)
      const to = join(f.home, 'appData', profile.replace('Open Science', 'Open-Science'))
      await mkdir(from, { recursive: true })
      await writeFile(join(from, 'Preferences'), 'old preferences')
      await mkdir(to)
      expect(cli(f.home, '--mode', mode).value.blockers).toEqual([])
      await writeFile(join(to, 'Preferences'), 'independent preferences')
      expect(cli(f.home, '--mode', mode, '--execute').output).toContain('Path conflict')
      expect(await readFile(join(to, 'Preferences'), 'utf8')).toBe('independent preferences')
    }
  )

  it('preserves both versions of same-name logs without merging their contents', async () => {
    const f = await targetFixture('logs')
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const result = await runMigration(f.options)
    const p = result.participants.find((p) => p.to === f.to)
    expect(result.status).toBe('committed')
    expect(p.previousTarget.kind).toBe('logs')
    expect(await readFile(join(p.previousTarget.backup, 'main.log'), 'utf8')).toBe('new log\n')
    expect(await readFile(join(p.backup, 'main.log'), 'utf8')).toBe('old log\n')
    expect(await readFile(join(f.to, 'main.log'), 'utf8')).toBe('old log\n')
    await runMigration({ ...f.options, execute: false, rollback: true })
    expect(await readFile(join(f.to, 'main.log'), 'utf8')).toBe('new log\n')
    expect(await readFile(join(f.from, 'main.log'), 'utf8')).toBe('old log\n')
  })

  it('rechecks an empty target after copying and refuses new writes before moving originals', async () => {
    const f = await targetFixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    await expect(
      runMigration(f.options, {
        async onProgress(event: { phase: string }) {
          if (event.phase === 'copied') await writeFile(join(f.to, 'new-user-file'), 'keep')
        }
      })
    ).rejects.toThrow('new writes')
    expect((await lstat(f.from)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(f.to, 'new-user-file'), 'utf8')).toBe('keep')
  })

  it.each(['target-backed-up', 'source-backed-up', 'root-published'])(
    'recovers both log trees after interruption at %s',
    async (phase) => {
      const f = await targetFixture('logs')
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration(f.options, {
          onProgress(event: { phase: string; path?: string }) {
            if (event.phase === phase && [f.from, f.to].includes(event.path ?? ''))
              throw new Error('injected interruption')
          }
        })
      ).rejects.toThrow('injected interruption')
      const result = await runMigration({ ...f.options, execute: false, resume: true })
      expect(result.status).toBe('committed')
      const p = result.participants.find((p) => p.to === f.to)
      expect(await readFile(join(p.previousTarget.backup, 'main.log'), 'utf8')).toBe('new log\n')
      expect(await readFile(join(f.to, 'main.log'), 'utf8')).toBe('old log\n')
    }
  )

  it.each(['copied', 'target-backed-up', 'source-backed-up', 'root-published'])(
    'rolls back both log trees after interruption at %s',
    async (phase) => {
      const f = await targetFixture('logs')
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration(f.options, {
          onProgress(event: { phase: string; path?: string }) {
            if (
              event.phase === phase &&
              (phase === 'copied' || [f.from, f.to].includes(event.path ?? ''))
            )
              throw new Error('injected interruption')
          }
        })
      ).rejects.toThrow('injected interruption')
      const result = await runMigration({ ...f.options, execute: false, rollback: true })
      expect(result.status).toBe('rolled-back')
      expect(await readFile(join(f.from, 'main.log'), 'utf8')).toBe('old log\n')
      expect(await readFile(join(f.to, 'main.log'), 'utf8')).toBe('new log\n')
    }
  )

  it.each(['rollback-root-parked', 'rollback-root-restored', 'rollback-target-restored'])(
    'resumes interrupted rollback at %s',
    async (phase) => {
      const f = await targetFixture('logs')
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await runMigration(f.options)
      const rollback = { ...f.options, execute: false, rollback: true }
      await expect(
        runMigration(rollback, {
          onProgress(event: { phase: string; path?: string }) {
            if (event.phase === phase && [f.from, f.to].includes(event.path ?? ''))
              throw new Error('injected interruption')
          }
        })
      ).rejects.toThrow('injected interruption')
      expect((await runMigration(rollback)).status).toBe('rolled-back')
      expect(await readFile(join(f.from, 'main.log'), 'utf8')).toBe('old log\n')
      expect(await readFile(join(f.to, 'main.log'), 'utf8')).toBe('new log\n')
    }
  )

  it('refuses rollback before any root changes if the existing-target backup was modified', async () => {
    const f = await targetFixture('logs')
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const result = await runMigration(f.options)
    const p = result.participants.find((p) => p.to === f.to)
    await writeFile(join(p.previousTarget.backup, 'main.log'), 'later write')
    await expect(runMigration({ ...f.options, execute: false, rollback: true })).rejects.toThrow(
      'new writes'
    )
    expect((await lstat(f.old)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(f.to, 'main.log'), 'utf8')).toBe('old log\n')
  })

  it('leaves both originals intact after a copy failure and can resume', async () => {
    const f = await targetFixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    await expect(
      runMigration(f.options, {
        copyTree() {
          throw new Error('injected copy failure')
        }
      })
    ).rejects.toThrow('injected copy failure')
    expect(await readdir(f.to)).toEqual([])
    expect(await readFile(join(f.from, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    expect((await runMigration({ ...f.options, execute: false, resume: true })).status).toBe(
      'committed'
    )
  })

  it('rejects a forged existing-target backup path without touching either generation', async () => {
    const f = await targetFixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const result = await runMigration(f.options)
    const p = result.participants.find((p) => p.to === f.to)
    p.previousTarget.backup = f.config
    await writeFile(join(`${f.config}.brand-migration`, 'journal.json'), JSON.stringify(result))
    await expect(runMigration({ ...f.options, execute: false, rollback: true })).rejects.toThrow(
      'Invalid journal existing target'
    )
    expect((await lstat(f.old)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(f.to, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })

  it('rejects a missing existing-target backup before rolling back any participant', async () => {
    const f = await targetFixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const result = await runMigration(f.options)
    const p = result.participants.find((p) => p.to === f.to)
    await rm(p.previousTarget.backup, { recursive: true })
    await expect(runMigration({ ...f.options, execute: false, rollback: true })).rejects.toThrow(
      'Existing-target backup is missing'
    )
    expect((await lstat(f.old)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
      f.next
    )
  })
})

describe('migration reference boundaries and recovery', () => {
  it('preserves casing and remaps only exact absolute roots including Windows and file URIs', async () => {
    const { remapPath, hyphenateBrand } = await import('../resources/brand-migration/paths.mjs')
    expect(hyphenateBrand('OPENscience open science OpenScience OPEN SCIENCE')).toBe(
      'OPEN-science open-science Open-Science OPEN-SCIENCE'
    )
    const maps = [{ from: 'C:\\Users\\a\\OpenScience', to: 'C:\\Users\\a\\Open-Science' }]
    expect(remapPath('c:/users/a/OPENSCIENCE/uploads/a.pdf', maps, 'win32')).toBe(
      'C:\\Users\\a\\Open-Science\\uploads\\a.pdf'
    )
    expect(remapPath('file:///C:/Users/a/OpenScience/a%20b.pdf', maps, 'win32')).toBe(
      'file:///C:/Users/a/Open-Science/a%20b.pdf'
    )
    expect(remapPath('C:\\Users\\a\\OpenScience-other\\a', maps, 'win32')).toBe(
      'C:\\Users\\a\\OpenScience-other\\a'
    )
    expect(remapPath('OpenScience/a', maps, 'win32')).toBe('OpenScience/a')
    expect(remapPath('$DATA/OpenScience/a', maps, 'win32')).toBe('$DATA/OpenScience/a')
  })
  it('recovers after publication fails between filesystem and database roots', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true }
    await expect(
      runMigration(options, {
        onProgress(event: { phase: string; path?: string }) {
          if (event.phase === 'root-published') throw new Error('simulated loss of power')
        }
      })
    ).rejects.toThrow('loss of power')
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(f.old)
    const result = await runMigration({ ...options, execute: false, resume: true })
    expect(result.status).toBe('committed')
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
      f.next
    )
    expect(await readFile(join(f.next, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
  it('refuses rollback after new user writes and keeps both generations', async () => {
    const f = await fixture()
    expect(cli(f.home, '--execute').status).toBe(0)
    await writeFile(join(f.next, 'uploads', 'new.txt'), 'new user data')
    const result = cli(f.home, '--rollback')
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('new writes')
    expect(await readFile(join(f.next, 'uploads', 'new.txt'), 'utf8')).toBe('new user data')
  })
  it('reports unfinished runtime operations before publishing a tree', async () => {
    const f = await fixture()
    await mkdir(join(f.old, 'runtime'))
    await writeFile(
      join(f.old, 'runtime', 'operation-journal.json'),
      JSON.stringify([{ operationId: 'pending' }])
    )
    const result = cli(f.home, '--execute')
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('runtime journal')
    expect(await readdir(f.home)).not.toContain('Open-Science-DEV')
  })
  it('allows an empty valid runtime journal instead of blocking every installed environment', async () => {
    const f = await fixture()
    await mkdir(join(f.old, 'runtime'))
    await writeFile(join(f.old, 'runtime', 'operation-journal.json'), '[]')
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
  })
})

describe('real SQLite and filesystem transaction', () => {
  async function database(f: Awaited<ReturnType<typeof fixture>>) {
    const { DatabaseSync } = await import('node:sqlite')
    const { RUNTIME_SCHEMA_TABLE_DDLS, RUNTIME_SCHEMA_INDEX_DDLS } =
      await import('../src/main/database/generated/runtime-schema')
    const db = new DatabaseSync(join(f.config, 'open-science.db'))
    for (const ddl of [...RUNTIME_SCHEMA_TABLE_DDLS, ...RUNTIME_SCHEMA_INDEX_DDLS]) db.exec(ddl)
    db.prepare('INSERT INTO Project (id,name,description,updatedAt) VALUES (?,?,?,?)').run(
      'p',
      'Research',
      f.old,
      '2026-01-01'
    )
    db.prepare(
      'INSERT INTO GrantedLocalRoot (id,path,name,access,updatedAt) VALUES (?,?,?,?,?)'
    ).run('grant', f.old, 'Data', 'ro', '2026-01-01')
    db.prepare(
      'INSERT INTO ProjectPreviewState (projectId,items,panelState,updatedAt) VALUES (?,?,?,?)'
    ).run(
      'p',
      JSON.stringify([
        { id: 'preview', kind: 'file', path: join(f.old, 'uploads', 'paper.txt'), fileId: 'stable' }
      ]),
      'open',
      '2026-01-01'
    )
    db.close()
    return (file = join(f.config, 'open-science.db')) => new DatabaseSync(file)
  }
  it.each(['database-before-commit', 'root-published'])(
    'recovers the empty profile and conflicting logs together with the real DB after %s',
    async (phase) => {
      const f = await fixture()
      const openDb = await database(f)
      const profileFrom = join(f.home, 'appData', 'Open Science (DEV)')
      const profileTo = join(f.home, 'appData', 'Open-Science (DEV)')
      const logsFrom = join(f.home, 'Library', 'Logs', 'Open Science (DEV)')
      const logsTo = join(f.home, 'Library', 'Logs', 'Open-Science (DEV)')
      for (const path of [profileFrom, profileTo, logsFrom, logsTo])
        await mkdir(path, { recursive: true })
      await writeFile(join(profileFrom, 'Preferences'), 'historical preferences')
      await writeFile(join(logsFrom, 'main.log'), 'old logs')
      await writeFile(join(logsTo, 'main.log'), 'new logs')
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      const options = {
        home: f.home,
        appData: join(f.home, 'appData'),
        mode: 'dev',
        platform: 'darwin'
      }
      await expect(
        runMigration(
          { ...options, execute: true },
          {
            onProgress(event: { phase: string; path?: string }) {
              if (event.phase === phase && (phase !== 'root-published' || event.path === profileTo))
                throw new Error('injected DB and filesystem interruption')
            }
          }
        )
      ).rejects.toThrow('injected DB and filesystem interruption')
      let db = openDb()
      try {
        expect(db.prepare('SELECT path FROM GrantedLocalRoot').get()).toEqual({ path: f.old })
      } finally {
        db.close()
      }
      const result = await runMigration({ ...options, resume: true })
      expect(result.status).toBe('committed')
      expect(await readFile(join(profileTo, 'Preferences'), 'utf8')).toBe('historical preferences')
      expect(await readFile(join(f.next, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
      db = openDb()
      try {
        expect(db.prepare('SELECT id,path FROM GrantedLocalRoot').all()).toEqual([
          { id: 'grant', path: f.next }
        ])
        expect(db.prepare('SELECT id,description FROM Project').all()).toEqual([
          { id: 'p', description: f.old }
        ])
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        db.close()
      }
      await runMigration({ ...options, rollback: true })
      expect(await readdir(profileTo)).toEqual([])
      expect(await readFile(join(profileFrom, 'Preferences'), 'utf8')).toBe(
        'historical preferences'
      )
      expect(await readFile(join(logsTo, 'main.log'), 'utf8')).toBe('new logs')
      expect(await readFile(join(logsFrom, 'main.log'), 'utf8')).toBe('old logs')
      db = openDb()
      try {
        expect(db.prepare('SELECT id,path FROM GrantedLocalRoot').all()).toEqual([
          { id: 'grant', path: f.old }
        ])
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        db.close()
      }
    }
  )
  it('updates actual schema columns in a transaction without changing content, IDs or relations', async () => {
    const f = await fixture()
    const openDb = await database(f)
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    const db = openDb()
    try {
      expect(db.prepare('SELECT id,path,access FROM GrantedLocalRoot').get()).toEqual({
        id: 'grant',
        path: f.next,
        access: 'ro'
      })
      expect(db.prepare('SELECT description FROM Project WHERE id=?').get('p')).toEqual({
        description: f.old
      })
      expect(
        JSON.parse(db.prepare('SELECT items FROM ProjectPreviewState').get()!.items as string)
      ).toEqual([
        {
          id: 'preview',
          kind: 'file',
          path: join(f.next, 'uploads', 'paper.txt'),
          fileId: 'stable'
        }
      ])
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      db.close()
    }
  })
  it('rolls back the SQLite transaction when a later update fails', async () => {
    const f = await fixture()
    const openDb = await database(f)
    const { rewriteDatabase } = await import('../resources/brand-migration/references.mjs')
    expect(() =>
      rewriteDatabase(
        join(f.config, 'open-science.db'),
        [{ from: f.old, to: f.next }],
        process.platform,
        () => {
          throw new Error('database fault')
        }
      )
    ).toThrow('database fault')
    const db = openDb()
    try {
      expect(db.prepare('SELECT path FROM GrantedLocalRoot').get()).toEqual({ path: f.old })
    } finally {
      db.close()
    }
  })
  it('keeps the original DB and files when copying or staging references fails', async () => {
    const f = await fixture()
    const openDb = await database(f)
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true }
    await expect(
      runMigration(options, {
        copyTree: async () => {
          throw Object.assign(new Error('copy failed'), { code: 'ENOSPC' })
        }
      })
    ).rejects.toThrow('copy failed')
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    const db = openDb()
    try {
      expect(db.prepare('SELECT path FROM GrantedLocalRoot').get()).toEqual({ path: f.old })
    } finally {
      db.close()
    }
    expect((await runMigration({ ...options, execute: false, resume: true })).status).toBe(
      'committed'
    )
  })
  it('rejects a unique-path collision and preserves original database rows', async () => {
    const f = await fixture()
    const openDb = await database(f)
    const db = openDb()
    db.prepare(
      'INSERT INTO GrantedLocalRoot (id,path,name,access,updatedAt) VALUES (?,?,?,?,?)'
    ).run('other', f.next, 'Other', 'rw', '2026-01-01')
    db.close()
    expect(cli(f.home, '--execute').status).not.toBe(0)
    const unchanged = openDb()
    try {
      expect(unchanged.prepare('SELECT COUNT(*) AS n FROM GrantedLocalRoot').get()).toEqual({
        n: 2
      })
    } finally {
      unchanged.close()
    }
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
  it('serializes migrations and refuses a second writer while the first is copying', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true }
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((r) => {
      started = r
    })
    const wait = new Promise<void>((r) => {
      release = r
    })
    const first = runMigration(options, {
      async onProgress(e: { phase: string; path?: string }) {
        if (e.phase === 'copied') {
          started()
          await wait
        }
      }
    })
    await Promise.race([entered, first])
    await expect(runMigration(options)).rejects.toThrow('lock')
    release()
    expect((await first).status).toBe('committed')
  })
  it('migrates a data root nested in the isolated configuration root and can roll it back', async () => {
    const f = await fixture()
    const nested = join(f.config, 'OpenScience-DEV')
    const next = join(f.config, 'Open-Science-DEV')
    const { rename } = await import('node:fs/promises')
    await rename(f.old, nested)
    await writeFile(
      join(f.config, 'settings.json'),
      JSON.stringify({ version: 2, providers: [], dataRoot: nested })
    )
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    expect(await readFile(join(next, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    const rolledBack = cli(f.home, '--rollback')
    expect(rolledBack.status, rolledBack.output).toBe(0)
    expect(await readFile(join(nested, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
})

describe('migration write boundaries', () => {
  it.each(['--execute', '--resume', '--rollback'])(
    'rejects %s combined with explicit dry-run',
    async (action) => {
      const f = await fixture()
      const result = cli(f.home, action, '--dry-run')
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('dry-run')
      expect(await readdir(f.home)).not.toContain('Open-Science-DEV')
    }
  )
  it('never opens a symlinked database as a writable staged database', async () => {
    const f = await fixture()
    const outside = join(f.home, 'outside.db')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(outside)
    db.exec('CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT)')
    db.prepare('INSERT INTO GrantedLocalRoot VALUES (?,?)').run('id', f.old)
    db.close()
    await symlink(outside, join(f.config, 'open-science.db'))
    const result = cli(f.home, '--execute')
    expect(result.status).not.toBe(0)
    const after = new DatabaseSync(outside)
    try {
      expect(after.prepare('SELECT path FROM GrantedLocalRoot').get()).toEqual({ path: f.old })
    } finally {
      after.close()
    }
  })
  it('does not rewrite a non-allowlisted file hardlinked to settings', async () => {
    const f = await fixture()
    const { link } = await import('node:fs/promises')
    await link(join(f.config, 'settings.json'), join(f.config, 'user-notes.json'))
    const original = await readFile(join(f.config, 'user-notes.json'), 'utf8')
    const result = cli(f.home, '--execute')
    expect(result.status).not.toBe(0)
    expect(await readFile(join(f.config, 'user-notes.json'), 'utf8')).toBe(original)
  })
  it('refuses a nested mapping whose destination escapes its migrated parent', async () => {
    const f = await fixture()
    const outside = join(f.home, 'outside')
    const result = cli(
      f.home,
      '--execute',
      '--map',
      JSON.stringify({ from: join(f.old, 'uploads'), to: outside })
    )
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('nested')
    expect(await readdir(f.home)).not.toContain('outside')
  })
  it('uses actual basename casing instead of migrating one physical tree twice', async () => {
    const f = await fixture()
    const { rename } = await import('node:fs/promises')
    const old = join(f.home, 'openscience-DEV')
    await rename(f.old, old)
    await writeFile(join(f.config, 'settings.json'), JSON.stringify({ version: 2, dataRoot: old }))
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
      join(f.home, 'open-science-DEV')
    )
  })
})

describe('alias transition and startup lease', () => {
  it('retires owned aliases only after all embedded legacy paths are gone', async () => {
    const f = await fixture()
    await mkdir(join(f.old, 'runtime', 'envs', 'test', 'bin'), { recursive: true })
    await writeFile(
      join(f.old, 'runtime', 'envs', 'test', 'bin', 'tool'),
      `#!${f.old}/runtime/envs/test/bin/python\n`
    )
    expect(cli(f.home, '--execute').status).toBe(0)
    expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
    expect((await lstat(f.old)).isSymbolicLink()).toBe(true)
    await writeFile(
      join(f.next, 'runtime', 'envs', 'test', 'bin', 'tool'),
      `#!${f.next}/runtime/envs/test/bin/python\n`
    )
    const audit = cli(f.home, '--audit-aliases')
    expect(audit.status, audit.output).toBe(0)
    expect(audit.value.blockers).toEqual([])
    const retired = cli(f.home, '--retire-aliases')
    expect(retired.status, retired.output).toBe(0)
    await expect(lstat(f.old)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.next, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
  it('leaves a lease for the live application so an offline rollback cannot race its writers', async () => {
    const f = await fixture()
    const result = cli(f.home, '--execute', '--startup-owner', String(process.pid))
    expect(result.status, result.output).toBe(0)
    expect(result.value.lease).toBeDefined()
    const competing = cli(f.home, '--rollback')
    expect(competing.status).not.toBe(0)
    expect(competing.output).toContain('lock')
  })
  it.each(['dev', 'packaged'])(
    'initializes a new %s installation without fabricating old data',
    async (mode) => {
      const f = await fixture()
      await rm(f.old, { recursive: true })
      await rm(f.config, { recursive: true })
      const result = cli(f.home, '--mode', mode, '--execute')
      expect(result.status, result.output).toBe(0)
      expect(result.value.userData).toBe(
        join(f.home, 'appData', mode === 'dev' ? 'Open-Science (DEV)' : 'Open-Science')
      )
      expect(await readdir(f.home)).not.toContain('OpenScience')
    }
  )
  it('keeps arbitrary overridden roots literal and maps only an explicitly confirmed root', async () => {
    const f = await fixture()
    const custom = join(f.home, 'research OpenScience results')
    await mkdir(custom)
    await writeFile(join(custom, 'settings.json'), JSON.stringify({ dataRoot: custom }))
    const result = cli(
      f.home,
      '--config-root',
      custom,
      '--user-data',
      join(f.home, 'profile OpenScience custom')
    )
    expect(result.status, result.output).toBe(0)
    expect(result.value.configRoot).toBe(custom)
    expect(result.value.mappings.some((m: { from: string }) => m.from === custom)).toBe(false)
  })
})

describe('recovery ownership', () => {
  it('rejects a forged staging path before touching an unrelated directory', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true }
    await expect(
      runMigration(options, {
        copyTree: async () => {
          throw new Error('stop')
        }
      })
    ).rejects.toThrow('stop')
    const state = join(`${f.config}.brand-migration`, 'journal.json')
    const journal = JSON.parse(await readFile(state, 'utf8'))
    const outside = join(f.home, 'unrelated')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'valuable')
    journal.participants[0].stage = outside
    await writeFile(state, JSON.stringify(journal))
    expect(cli(f.home, '--resume').status).not.toBe(0)
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('valuable')
  })
  it('does not allow startup through an offline operation lock', async () => {
    const f = await fixture()
    expect(cli(f.home, '--execute').status).toBe(0)
    await writeFile(
      join(`${f.config}.brand-migration`, 'lock'),
      JSON.stringify({ pid: process.pid, token: 'offline', ownerKind: 'offline' })
    )
    expect(cli(f.home, '--execute', '--startup-owner', String(process.pid)).status).not.toBe(0)
  })
  it('refuses new writes after a rollback was interrupted', async () => {
    const f = await fixture()
    expect(cli(f.home, '--execute').status).toBe(0)
    const state = join(`${f.config}.brand-migration`, 'journal.json')
    const journal = JSON.parse(await readFile(state, 'utf8'))
    journal.status = 'rolling-back'
    await writeFile(state, JSON.stringify(journal))
    await writeFile(join(f.next, 'new-user-data'), 'keep')
    expect(cli(f.home, '--rollback').status).not.toBe(0)
    expect(await readFile(join(f.next, 'new-user-data'), 'utf8')).toBe('keep')
  })
  it('retains an alias used by a relative symlink', async () => {
    const f = await fixture()
    await mkdir(join(f.old, 'refs'))
    await symlink('../../OpenScience-DEV/uploads/paper.txt', join(f.old, 'refs', 'paper'))
    const executed = cli(f.home, '--execute')
    expect(executed.status, executed.output).toBe(0)
    expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
    expect(await readFile(join(f.next, 'refs', 'paper'), 'utf8')).toBe('research\n')
  })
})

describe('copy and lock metadata', () => {
  it.skipIf(process.platform !== 'darwin')(
    'resumes and rolls back a receipt with legacy metadata hashes',
    async () => {
      const f = await fixture()
      const { runMigration, inventory } =
        await import('../resources/brand-migration/transaction.mjs')
      const { bundleInventory } = await import('../resources/brand-migration/reference-bundle.mjs')
      const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev' }
      await expect(
        runMigration(
          { ...options, execute: true },
          {
            onProgress(event: { phase: string }) {
              if (event.phase === 'copied') throw new Error('legacy interruption')
            }
          }
        )
      ).rejects.toThrow('legacy interruption')
      const journalFile = join(`${f.config}.brand-migration`, 'journal.json')
      const journal = JSON.parse(await readFile(journalFile, 'utf8'))
      for (const p of journal.participants) {
        p.original = p.files
          ? await bundleInventory(p.from, p.files, (path: string) =>
              inventory(path, 'scanning', 'legacy')
            )
          : await inventory(p.from, 'scanning', 'legacy')
      }
      await writeFile(journalFile, JSON.stringify(journal))
      const result = await runMigration({ ...options, resume: true })
      expect(result.id).toBe(journal.id)
      expect(result.participants.map((p) => p.original)).toEqual(
        journal.participants.map((p) => p.original)
      )
      await runMigration({ ...options, rollback: true })
      expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
      expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
        f.old
      )
    }
  )
  it.skipIf(process.platform !== 'darwin')(
    'preserves setgid on runtime cache directories during native copying',
    async () => {
      const f = await fixture()
      const cache = join(f.old, 'runtime', 'pkgs', 'cache')
      await mkdir(cache, { recursive: true })
      const { chmod } = await import('node:fs/promises')
      await chmod(cache, 0o2775)
      const { copyTree, inventory, verify } =
        await import('../resources/brand-migration/transaction.mjs')
      const original = await inventory(f.old)
      await copyTree(f.old, f.next)
      expect((await lstat(join(f.next, 'runtime', 'pkgs', 'cache'))).mode & 0o7777).toBe(0o2775)
      await verify(f.next, original)
    }
  )
  it.skipIf(process.platform !== 'darwin')(
    'preserves signature and quarantine xattrs during native copying',
    async () => {
      const f = await fixture()
      const file = join(f.old, 'uploads', 'paper.txt')
      for (const [name, value] of [
        ['com.apple.cs.CodeSignature', ''],
        ['com.apple.quarantine', '0081;65000000;Fixture;'],
        ['org.open-science.test', 'user-metadata']
      ])
        execFileSync('/usr/bin/xattr', ['-w', name, value, file])
      const { copyTree, inventory, verify } =
        await import('../resources/brand-migration/transaction.mjs')
      const original = await inventory(f.old)
      await copyTree(f.old, f.next)
      await verify(f.next, original)
    }
  )
  it.skipIf(process.platform !== 'darwin')(
    'versions macOS metadata while retaining strict verification for old receipts',
    async () => {
      const f = await fixture()
      const { inventory, verify } = await import('../resources/brand-migration/transaction.mjs')
      const current = await inventory(f.old)
      expect(current[0].metadata).toMatch(/^darwin-v2:/)
      const legacy = await inventory(f.old, 'scanning', 'legacy')
      expect(legacy[0].metadata).toMatch(/^[a-f0-9]{64}$/)
      await verify(f.old, legacy)
      const file = join(f.old, 'uploads', 'paper.txt')
      execFileSync('/usr/bin/xattr', ['-w', 'org.open-science.test', 'changed', file])
      await expect(verify(f.old, legacy)).rejects.toThrow('Integrity')
      await expect(verify(f.old, current)).rejects.toThrow('Integrity')
    }
  )
  it.each(['--state-dir', '--data-parent'])(
    'rejects relative %s before creating state',
    async (flag) => {
      const f = await fixture()
      expect(cli(f.home, flag, 'relative').status).not.toBe(0)
    }
  )
  it('does not recover a live worker lock even when its application owner has exited', async () => {
    const f = await fixture()
    await mkdir(`${f.config}.brand-migration`)
    await writeFile(
      join(`${f.config}.brand-migration`, 'lock'),
      JSON.stringify({
        pid: 2147483647,
        workerPid: process.pid,
        token: 'worker',
        ownerKind: 'transaction'
      })
    )
    expect(cli(f.home, '--execute', '--recover-lock').status).not.toBe(0)
  })
  it.skipIf(process.platform !== 'darwin')(
    'detects extended-attribute changes during copying',
    async () => {
      const f = await fixture()
      const file = join(f.old, 'uploads', 'paper.txt')
      execFileSync('/usr/bin/xattr', ['-w', 'org.open-science.test', 'original', file])
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration(
          { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
          {
            onProgress(event: { phase: string; path?: string }) {
              if (event.phase === 'copied')
                execFileSync('/usr/bin/xattr', ['-w', 'org.open-science.test', 'changed', file])
            }
          }
        )
      ).rejects.toThrow('Integrity')
      expect(await readFile(file, 'utf8')).toBe('research\n')
    }
  )
})

describe('encrypted compute path reconciliation', () => {
  it('recognizes encrypted array envelopes, updates only upload paths, and preserves ciphertext at rest', async () => {
    const f = await fixture()
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(f.config, 'open-science.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE ComputeJob(id TEXT PRIMARY KEY,inputManifest TEXT)')
    const prefix = 'open-science:protected-json:v1'
    const encode = (v: string): string =>
      JSON.stringify([prefix, `open-science:protected:v1:${Buffer.from(v).toString('base64')}`])
    const decode = (v: string): string =>
      Buffer.from(JSON.parse(v)[1].split(':').at(-1), 'base64').toString()
    const original = encode(
      JSON.stringify([
        {
          kind: 'upload',
          localPath: join(f.old, 'uploads', 'paper.txt'),
          uploadId: 'same',
          note: f.old
        }
      ])
    )
    db.prepare('INSERT INTO ComputeJob VALUES (?,?)').run('job', original)
    db.close()
    const { rewriteDatabase } = await import('../resources/brand-migration/references.mjs')
    const maps = [{ from: f.old, to: f.next }]
    const offline = rewriteDatabase(dbPath, maps, process.platform)
    expect(offline.transitions.length).toBe(1)
    rewriteDatabase(dbPath, maps, process.platform, () => {}, { decrypt: decode, encrypt: encode })
    const after = new DatabaseSync(dbPath)
    try {
      const raw = after.prepare('SELECT inputManifest FROM ComputeJob WHERE id=?').get('job')!
        .inputManifest as string
      expect(JSON.parse(raw)[0]).toBe(prefix)
      expect(JSON.parse(decode(raw))).toEqual([
        {
          kind: 'upload',
          localPath: join(f.next, 'uploads', 'paper.txt'),
          uploadId: 'same',
          note: f.old
        }
      ])
    } finally {
      after.close()
    }
  })
})

describe('real environment and interrupted rollback', () => {
  it.skipIf(process.platform !== 'darwin')(
    'keeps a real venv, user-installed module and absolute shebang executable',
    async () => {
      const f = await fixture()
      const python = '/Applications/Xcode.app/Contents/Developer/usr/bin/python3'
      const environment = join(f.old, 'runtime', 'user-venv')
      execFileSync(python, ['-m', 'venv', '--without-pip', environment])
      const interpreter = join(environment, 'bin', 'python')
      const packages = execFileSync(
        interpreter,
        ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
        { encoding: 'utf8' }
      ).trim()
      await writeFile(join(packages, 'user_research.py'), 'VALUE = "user package preserved"\n')
      const entry = join(environment, 'bin', 'research')
      await writeFile(entry, `#!${interpreter}\nfrom user_research import VALUE\nprint(VALUE)\n`, {
        mode: 0o755
      })
      expect(cli(f.home, '--execute').status).toBe(0)
      const moved = join(f.next, 'runtime', 'user-venv', 'bin', 'research')
      expect(execFileSync(moved, [], { encoding: 'utf8' }).trim()).toBe('user package preserved')
      expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
    }
  )
  it.skipIf(process.platform === 'win32')(
    'stops on a non-writable source parent without modifying source bytes',
    async () => {
      const f = await fixture()
      const { chmod } = await import('node:fs/promises')
      const parent = join(f.home, 'readonly')
      await mkdir(parent)
      const old = join(parent, 'OpenScience')
      const { rename } = await import('node:fs/promises')
      await rename(f.old, old)
      await writeFile(join(f.config, 'settings.json'), JSON.stringify({ dataRoot: old }))
      await chmod(parent, 0o500)
      try {
        expect(cli(f.home, '--execute').status).not.toBe(0)
        expect(await readFile(join(old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
      } finally {
        await chmod(parent, 0o700)
      }
    }
  )
  it.each(['rollback-aliases-removed', 'rollback-root-parked', 'rollback-root-restored'])(
    'resumes rollback after %s while keeping both generations',
    async (phase) => {
      const f = await fixture()
      expect(cli(f.home, '--execute').status).toBe(0)
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration(
          { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', rollback: true },
          {
            onProgress(e: { phase: string; path?: string }) {
              if (e.phase === phase) throw new Error('interrupted rollback')
            }
          }
        )
      ).rejects.toThrow('interrupted rollback')
      const result = cli(f.home, '--rollback')
      expect(result.status, result.output).toBe(0)
      expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
    }
  )
})

describe('committed receipts remain fail-closed', () => {
  it('rejects a new independent old tree appearing after commit', async () => {
    const f = await fixture()
    expect(cli(f.home, '--execute').status).toBe(0)
    await rm(f.old)
    await mkdir(f.old)
    await writeFile(join(f.old, 'other'), 'independent data')
    expect(cli(f.home, '--execute').status).not.toBe(0)
    expect(await readFile(join(f.old, 'other'), 'utf8')).toBe('independent data')
  })
  it('can retire aliases without changing historical session prose or database user text', async () => {
    const f = await fixture()
    await mkdir(join(f.config, 'sessions', 'p'), { recursive: true })
    await writeFile(
      join(f.config, 'sessions', 'p', 's.json'),
      JSON.stringify({ id: 's', cwd: f.old, messages: [{ text: f.old }] })
    )
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'))
    db.exec('CREATE TABLE Project(id TEXT PRIMARY KEY,description TEXT)')
    db.prepare('INSERT INTO Project VALUES (?,?)').run('p', f.old)
    db.close()
    expect(cli(f.home, '--execute').status).toBe(0)
    const audit = cli(f.home, '--audit-aliases')
    expect(audit.status, audit.output).toBe(0)
    expect(audit.value.blockers).toEqual([])
    expect(cli(f.home, '--retire-aliases').status).toBe(0)
    expect(
      JSON.parse(await readFile(join(f.config, 'sessions', 'p', 's.json'), 'utf8')).messages[0].text
    ).toBe(f.old)
  })
})

describe('independent review recovery regressions', () => {
  it('refuses rollback before changing any root when one original backup is missing', async () => {
    const f = await fixture()
    expect(cli(f.home, '--execute').status).toBe(0)
    const journal = JSON.parse(
      await readFile(join(`${f.config}.brand-migration`, 'journal.json'), 'utf8')
    )
    const data = journal.participants.find((p: { from: string }) => p.from === f.old)
    const { rename } = await import('node:fs/promises')
    await rename(data.backup, `${data.backup}.temporarily-unavailable`)
    const result = cli(f.home, '--rollback')
    expect(result.status, result.output).not.toBe(0)
    expect((await lstat(f.old)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
      f.next
    )
  })
  it.each([false, true])(
    'does not lend the application lease to another writer (multiInstance=%s)',
    async (multi) => {
      const f = await fixture()
      expect(cli(f.home, '--execute').status).toBe(0)
      await writeFile(
        join(`${f.config}.brand-migration`, 'lock'),
        JSON.stringify({
          pid: process.pid,
          token: 'app',
          ownerKind: 'application',
          userData: join(f.home, 'profile-a'),
          relayEligible: true
        })
      )
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration({
          home: f.home,
          appData: join(f.home, 'appData'),
          mode: 'dev',
          execute: true,
          startupOwner: process.pid,
          userData: join(f.home, multi ? 'profile-a' : 'profile-b'),
          allowMultiInstance: multi
        })
      ).rejects.toThrow(/lock|lease/)
    }
  )
  it('retires nested aliases deepest first and starts again without recreating them', async () => {
    const f = await fixture()
    const child = join(f.old, 'OpenScience')
    await mkdir(child)
    await writeFile(join(child, 'keep'), 'child')
    const mapping = JSON.stringify({ from: child, to: join(f.next, 'Open-Science') })
    const executed = cli(f.home, '--map', mapping, '--execute')
    expect(executed.status, executed.output).toBe(0)
    const retired = cli(f.home, '--retire-aliases')
    expect(retired.status, retired.output).toBe(0)
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    expect(await readdir(f.next)).not.toContain('OpenScience')
    expect(await readFile(join(f.next, 'Open-Science', 'keep'), 'utf8')).toBe('child')
  })
  it('restarts a rolled back transaction in the same startup state directory', async () => {
    const f = await fixture()
    expect(cli(f.home, '--execute').status).toBe(0)
    expect(cli(f.home, '--rollback').status).toBe(0)
    const restarted = cli(f.home, '--execute', '--restart-after-rollback')
    expect(restarted.status, restarted.output).toBe(0)
    expect(cli(f.home, '--execute', '--startup-owner', String(process.pid)).status).toBe(0)
    expect(await readFile(join(f.next, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
  it('does not treat retired runtime policy identities as live executable references', async () => {
    const f = await fixture()
    const oldRuntime = join(f.old, 'runtime', 'python')
    await writeFile(
      join(f.config, 'settings.json'),
      JSON.stringify({
        dataRoot: f.old,
        notebookRuntimeEnablement: {
          python: { enabled: { [oldRuntime]: false }, installAuthorized: { [oldRuntime]: true } }
        }
      })
    )
    expect(cli(f.home, '--execute').status).toBe(0)
    const result = cli(f.home, '--retire-aliases')
    expect(result.status, result.output).toBe(0)
    const settings = JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8'))
    expect(
      settings.notebookRuntimeEnablement.python.enabled[join(f.next, 'runtime', 'python')]
    ).toBe(false)
    expect(
      settings.notebookRuntimeEnablement.python.installAuthorized[join(f.next, 'runtime', 'python')]
    ).toBeUndefined()
  })
  it.skipIf(process.platform !== 'darwin')(
    'deduplicates alternate settings spelling by physical root identity',
    async () => {
      const f = await fixture()
      const { rename } = await import('node:fs/promises')
      const lower = join(f.home, 'openscience-dev')
      await rename(f.old, lower)
      // This macOS fixture volume is case insensitive; settings preserve the earlier spelling.
      if (!(await lstat(f.old).catch(() => undefined))) return
      const result = cli(f.home, '--execute')
      expect(result.status, result.output).toBe(0)
      expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(
        join(f.home, 'open-science-dev')
      )
    }
  )
  it.skipIf(process.platform !== 'darwin')(
    'detects hidden-file ACL changes before publishing any root',
    async () => {
      const f = await fixture()
      const hidden = join(f.old, '.hidden')
      await writeFile(hidden, 'private')
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration(
          { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
          {
            onProgress(e: { phase: string; path?: string }) {
              if (e.phase === 'copied')
                execFileSync('/bin/chmod', ['+a', `user:${userInfo().username} allow read`, hidden])
            }
          }
        )
      ).rejects.toThrow('Integrity')
      expect((await lstat(f.old)).isDirectory()).toBe(true)
    }
  )
  it('directly adopts a new-only tree without copying it or replacing its inode', async () => {
    const f = await fixture()
    const { rename } = await import('node:fs/promises')
    await rename(f.old, f.next)
    await writeFile(join(f.config, 'settings.json'), JSON.stringify({ dataRoot: f.next }))
    const before = await lstat(f.next)
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const result = await runMigration(
      { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
      {
        copyTree: async () => {
          throw new Error('must not copy a normalized tree')
        }
      }
    )
    expect(result.status).toBe('committed')
    expect((await lstat(f.next)).ino).toBe(before.ino)
    expect(result.participants).toEqual([])
  })
})

describe('references in already normalized roots', () => {
  it('updates stale JSON and real SQLite references without replacing normalized roots or unrelated files', async () => {
    const f = await fixture()
    const { rename } = await import('node:fs/promises')
    await rename(f.old, f.next)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'))
    db.exec('CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT)')
    db.prepare('INSERT INTO GrantedLocalRoot VALUES(?,?)').run('stable', f.old)
    db.close()
    const inode = (await lstat(f.next)).ino
    const configInode = (await lstat(f.config)).ino
    const fileInode = (await lstat(join(f.next, 'uploads', 'paper.txt'))).ino
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    expect((await lstat(f.next)).ino).toBe(inode)
    expect((await lstat(f.config)).ino).toBe(configInode)
    expect((await lstat(join(f.next, 'uploads', 'paper.txt'))).ino).toBe(fileInode)
    const after = new DatabaseSync(join(f.config, 'open-science.db'))
    expect(after.prepare('SELECT * FROM GrantedLocalRoot').all()).toEqual([
      { id: 'stable', path: f.next }
    ])
    after.close()
    expect(cli(f.home, '--rollback').status).toBe(0)
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(f.old)
    expect((await lstat(f.config)).ino).toBe(configInode)
  })
})

it.skipIf(process.platform !== 'darwin')(
  'adopts an already renamed real venv with an audited prefix alias',
  async () => {
    const f = await fixture()
    const { rename, chmod } = await import('node:fs/promises')
    const environment = join(f.old, 'runtime', 'venv')
    execFileSync('/Applications/Xcode.app/Contents/Developer/usr/bin/python3', [
      '-m',
      'venv',
      '--without-pip',
      environment
    ])
    await writeFile(
      join(environment, 'bin', 'entry'),
      `#!${join(environment, 'bin', 'python')}\nprint('preserved')\n`
    )
    await chmod(join(environment, 'bin', 'entry'), 0o755)
    await rename(f.old, f.next)
    const inode = (await lstat(f.next)).ino
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    expect(
      execFileSync(join(f.next, 'runtime', 'venv', 'bin', 'entry'), [], { encoding: 'utf8' })
    ).toBe('preserved\n')
    expect((await lstat(f.next)).ino).toBe(inode)
    expect(cli(f.home, '--execute').status).toBe(0)
    expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
  }
)

it.each(['reference-backed-up', 'reference-published'])(
  'resumes a normalized-root file transaction after %s',
  async (phase) => {
    const f = await fixture()
    const { rename } = await import('node:fs/promises')
    await rename(f.old, f.next)
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true }
    await expect(
      runMigration(options, {
        onProgress(e: { phase: string; path?: string }) {
          if (e.phase === phase) throw new Error('reference interruption')
        }
      })
    ).rejects.toThrow('reference interruption')
    const resumed = cli(f.home, '--resume')
    expect(resumed.status, resumed.output).toBe(0)
    expect(cli(f.home, '--rollback').status).toBe(0)
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8')).dataRoot).toBe(f.old)
  }
)

it.each(['resume', 'rollback'])(
  'recovers encrypted-path publication interruption through %s',
  async (action) => {
    const f = await fixture()
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'))
    db.exec('CREATE TABLE ComputeJob(id TEXT PRIMARY KEY,inputManifest TEXT)')
    const encrypt = (v: string): string =>
      JSON.stringify([
        'open-science:protected-json:v1',
        `open-science:protected:v1:${Buffer.from(v).toString('base64')}`
      ])
    const decrypt = (v: string): string =>
      Buffer.from(JSON.parse(v)[1].split(':').at(-1), 'base64').toString()
    const original = encrypt(
      JSON.stringify([
        { kind: 'upload', localPath: join(f.old, 'uploads', 'paper.txt'), uploadId: 'stable' }
      ])
    )
    db.prepare('INSERT INTO ComputeJob VALUES(?,?)').run('job', original)
    db.close()
    expect(cli(f.home, '--execute').status).toBe(0)
    const state = `${f.config}.brand-migration`
    await writeFile(
      join(state, 'lock'),
      JSON.stringify({ pid: process.pid, token: 'test-app', ownerKind: 'application' })
    )
    const { reconcileProtectedPaths } = await import('../resources/brand-migration/online.mjs')
    await expect(
      reconcileProtectedPaths(
        state,
        { encrypt, decrypt },
        {
          onProgress(e: { phase: string; path?: string }) {
            if (e.phase === 'protected-published') throw new Error('interrupted protected commit')
          }
        }
      )
    ).rejects.toThrow('interrupted protected commit')
    await rm(join(state, 'lock'))
    const result = cli(f.home, `--${action}`)
    expect(result.status, result.output).toBe(0)
    const after = new DatabaseSync(join(f.config, 'open-science.db'))
    const raw = after.prepare('SELECT inputManifest FROM ComputeJob WHERE id=?').get('job')!
      .inputManifest as string
    expect(JSON.parse(decrypt(raw))[0].localPath).toBe(
      join(action === 'rollback' ? f.old : f.next, 'uploads', 'paper.txt')
    )
    after.close()
  }
)

it('keeps runtime aliases for a proven alternate case spelling', async () => {
  const f = await fixture()
  const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
  expect(cli(f.home, '--execute').status).toBe(0)
  const state = join(`${f.config}.brand-migration`, 'journal.json')
  const journal = JSON.parse(await readFile(state, 'utf8'))
  const map = journal.mappings.find((m: { from: string }) => m.from === f.old)
  map.fromAliases = [join(f.home, 'OPENscience-DEV')]
  await mkdir(join(f.next, 'runtime'))
  await writeFile(join(f.next, 'runtime', 'prefix'), map.fromAliases[0])
  await writeFile(state, JSON.stringify(journal))
  const audit = await runMigration({
    home: f.home,
    appData: join(f.home, 'appData'),
    mode: 'dev',
    auditAliases: true
  })
  expect(audit.blockers).toContainEqual(
    expect.objectContaining({ reason: 'remaining-path-reference' })
  )
})

it('rolls back an interrupted Windows launcher generation together with the profile and data', async () => {
  const f = await fixture()
  const { installCliLauncher, planCliLauncher, migrateCliLauncherProfile } =
    await import('../src/main/cli-install/launcher')
  const oldProfile = join(f.home, 'appData', 'Open Science (DEV)')
  const nextProfile = join(f.home, 'appData', 'Open-Science (DEV)')
  const oldEnv = {
    platform: 'win32' as const,
    appExecPath: join(f.home, 'old.exe'),
    cliEntryPath: join(f.home, 'old-cli.mjs'),
    packaged: true,
    homeDir: f.home,
    userDataDir: oldProfile,
    pathVar: 'C:\\Windows'
  }
  await installCliLauncher(oldEnv, () => true)
  const oldBin = planCliLauncher(oldEnv).binDir
  const oldReceipt = {
    version: 1,
    owner: 'Open Science Windows PATH entry. Managed by the app.',
    binDir: oldBin,
    beforePath: 'C:\\Windows',
    afterPath: `C:\\Windows;${oldBin}`
  }
  await writeFile(join(oldBin, '.open-science-path-receipt'), JSON.stringify(oldReceipt))
  expect(cli(f.home, '--execute').status).toBe(0)
  const state = `${f.config}.brand-migration`
  const env = { ...oldEnv, userDataDir: nextProfile, appExecPath: join(f.home, 'new.exe') }
  await expect(
    migrateCliLauncherProfile(
      env,
      oldProfile,
      state,
      () => true,
      () => {
        throw new Error('launcher interrupted')
      }
    )
  ).rejects.toThrow('launcher interrupted')
  const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
  const commands: string[][] = []
  const result = await runMigration(
    { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', rollback: true },
    {
      rollbackWindowsPath: (_command: string, args: string[]) => {
        commands.push(args)
        return true
      }
    }
  )
  expect(result.status).toBe('rolled-back')
  expect(await readFile(planCliLauncher(oldEnv).target, 'utf8')).toBe(planCliLauncher(oldEnv).shim)
  expect(JSON.parse(await readFile(join(oldBin, '.open-science-path-receipt'), 'utf8'))).toEqual(
    oldReceipt
  )
  expect(commands.length).toBe(1)
  expect(cli(f.home, '--execute', '--restart-after-rollback').status).toBe(0)
  await migrateCliLauncherProfile(env, oldProfile, state, () => true)
  const journal = JSON.parse(await readFile(join(state, 'journal.json'), 'utf8'))
  expect(JSON.parse(await readFile(join(state, 'launcher.json'), 'utf8')).id).toBe(journal.id)
})

it.each([
  { adopt: true, receipt: true },
  { adopt: false, receipt: false },
  { adopt: true, receipt: false }
])('rolls back launcher inputs: %j', async ({ adopt, receipt }) => {
  const f = await fixture()
  const { installCliLauncher, planCliLauncher, migrateCliLauncherProfile } =
    await import('../src/main/cli-install/launcher')
  const oldProfile = join(f.home, 'appData', 'Open Science (DEV)')
  const nextProfile = join(f.home, 'appData', 'Open-Science (DEV)')
  const oldEnv = {
    platform: 'win32' as const,
    appExecPath: join(f.home, 'old.exe'),
    cliEntryPath: join(f.home, 'old-cli.mjs'),
    packaged: true,
    homeDir: f.home,
    userDataDir: oldProfile,
    pathVar: 'C:\\Windows'
  }
  await installCliLauncher(oldEnv, () => true)
  const oldBin = planCliLauncher(oldEnv).binDir
  const oldReceipt = {
    version: 1,
    owner: 'Open Science Windows PATH entry. Managed by the app.',
    binDir: oldBin,
    beforePath: 'C:\\Windows',
    afterPath: `C:\\Windows;${oldBin}`
  }
  if (receipt)
    await writeFile(join(oldBin, '.open-science-path-receipt'), JSON.stringify(oldReceipt))
  if (adopt) {
    const { rename } = await import('node:fs/promises')
    await rename(oldProfile, nextProfile)
    if (!receipt) await writeFile(join(nextProfile, 'bin', 'prefix'), oldProfile)
  }
  expect(cli(f.home, '--execute').status).toBe(0)
  const state = `${f.config}.brand-migration`
  const env = { ...oldEnv, userDataDir: nextProfile, appExecPath: join(f.home, 'new.exe') }
  await expect(
    migrateCliLauncherProfile(
      env,
      oldProfile,
      state,
      () => true,
      () => {
        throw new Error('launcher interrupted')
      }
    )
  ).rejects.toThrow('launcher interrupted')
  const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
  const commands: string[][] = []
  const result = await runMigration(
    { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', rollback: true },
    {
      rollbackWindowsPath: (_command: string, args: string[]) => {
        commands.push(args)
        return true
      }
    }
  )
  expect(result.status).toBe('rolled-back')
  expect(
    await readFile(join(adopt ? nextProfile : oldProfile, 'bin', 'open-science.cmd'), 'utf8')
  ).toBe(planCliLauncher(oldEnv).shim)
  if (receipt)
    expect(
      JSON.parse(
        await readFile(
          join(adopt ? nextProfile : oldProfile, 'bin', '.open-science-path-receipt'),
          'utf8'
        )
      )
    ).toEqual(oldReceipt)
  expect(commands.length).toBe(receipt ? 1 : 0)
  expect(cli(f.home, '--execute', '--restart-after-rollback').status).toBe(0)
  await migrateCliLauncherProfile(env, oldProfile, state, () => true)
  const journal = JSON.parse(await readFile(join(state, 'journal.json'), 'utf8'))
  expect(JSON.parse(await readFile(join(state, 'launcher.json'), 'utf8')).id).toBe(journal.id)
})

it('honors a literal profile override on later startup after a committed migration', async () => {
  const f = await fixture()
  expect(cli(f.home, '--execute').status).toBe(0)
  const profile = join(f.home, 'chosen profile OpenScience custom')
  const result = cli(f.home, '--execute', '--user-data', profile)
  expect(result.status, result.output).toBe(0)
  expect(result.value.userData).toBe(profile)
})

it('does not mistake an unrelated command argument for an application executable', async () => {
  const f = await fixture()
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'aipoch/open-science'], {
    stdio: 'ignore'
  })
  try {
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
  } finally {
    child.kill()
    await new Promise<void>((r) => child.once('exit', () => r()))
  }
})

it('blocks alias retirement while a Windows registry PATH still depends on the old root', async () => {
  const { auditAliases } = await import('../resources/brand-migration/retirement.mjs')
  const journal = {
    status: 'committed',
    platform: 'win32',
    participants: [],
    mappings: [
      {
        state: 'move',
        from: 'C:\\Users\\fixture\\Open Science',
        to: 'C:\\Users\\fixture\\Open-Science'
      }
    ]
  }
  const audit = await auditAliases(
    journal,
    async () => [],
    () => [
      { scope: 'User', value: 'C:\\Users\\fixture\\Open Science\\bin;C:\\Windows' },
      { scope: 'Machine', value: 'C:\\Users\\fixture\\Open Science-other\\bin' }
    ]
  )
  expect(audit.blockers).toEqual([
    { path: 'C:\\Users\\fixture\\Open Science\\bin', reason: 'User-PATH-reference' }
  ])
})

describe('deep review migration regressions', () => {
  it('blocks a real writer whose cwd and open handle are absent from its command line', async () => {
    const f = await fixture()
    const child = await writer(f.old)
    try {
      const result = cli(f.home, '--execute')
      expect(result.status, result.output).not.toBe(0)
      expect(result.output).toMatch(/using migration paths|occupied/)
      const { once } = await import('node:events')
      const written = once(child, 'message')
      child.send('write')
      await written
      expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe(
        'research\nchild-write\n'
      )
      await expect(lstat(f.next)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await stop(child)
    }
  })

  it('rechecks writers acquired after copying and before publication', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    let child: import('node:child_process').ChildProcess | undefined
    try {
      await expect(
        runMigration(
          { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
          {
            async onProgress(event: { phase: string }) {
              if (event.phase === 'references-prepared' && !child) child = await writer(f.old)
            }
          }
        )
      ).rejects.toThrow(/using migration paths|occupied/)
      expect((await lstat(f.old)).isSymbolicLink()).toBe(false)
    } finally {
      if (child) await stop(child)
    }
  })

  it('maps a proven alternate-case SQLite path and preserves access after alias retirement', async (ctx) => {
    const f = await fixture()
    const alternate = join(f.home, 'OPENSCIENCE-DEV')
    const alternateStat = await lstat(alternate).catch(() => undefined)
    if (!alternateStat || alternateStat.ino !== (await lstat(f.old)).ino) return ctx.skip()
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(f.config, 'open-science.db')
    const original = join(alternate, 'uploads', 'paper.txt')
    expect(await readFile(original, 'utf8')).toBe('research\n')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT)')
    db.prepare('INSERT INTO GrantedLocalRoot VALUES (?,?)').run('kept-id', original)
    db.close()
    const result = cli(f.home, '--execute')
    expect(result.status, result.output).toBe(0)
    const after = new DatabaseSync(dbPath, { readOnly: true })
    const row = after.prepare('SELECT id,path FROM GrantedLocalRoot').get()
    after.close()
    expect(row).toEqual({ id: 'kept-id', path: join(f.next, 'uploads', 'paper.txt') })
    const retired = cli(f.home, '--retire-aliases')
    expect(retired.status, retired.output).toBe(0)
    expect(await readFile(String(row!.path), 'utf8')).toBe('research\n')
  })

  it('recovers rollback interrupted again before any reference was published', async () => {
    const f = await fixture()
    const original = await readFile(join(f.config, 'settings.json'), 'utf8')
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev' }
    await expect(
      runMigration(
        { ...options, execute: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'copied') throw new Error('first interruption')
          }
        }
      )
    ).rejects.toThrow('first interruption')
    await expect(
      runMigration(
        { ...options, rollback: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'rollback-aliases-removed') throw new Error('second interruption')
          }
        }
      )
    ).rejects.toThrow('second interruption')
    expect((await runMigration({ ...options, rollback: true })).status).toBe('rolled-back')
    expect((await runMigration({ ...options, rollback: true })).status).toBe('rolled-back')
    expect(await readFile(join(f.config, 'settings.json'), 'utf8')).toBe(original)
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })

  it('recovers a dead recovery owner while preserving the abandoned lock identity', async () => {
    const f = await fixture()
    const state = `${f.config}.brand-migration`
    await mkdir(join(state, 'lock-recovery'), { recursive: true })
    await writeFile(
      join(state, 'lock'),
      JSON.stringify({ pid: 2147483647, workerPid: 2147483647, token: 'legacy-lock' })
    )
    await writeFile(
      join(state, 'lock-recovery', 'owner.json'),
      JSON.stringify({ pid: 2147483647, workerPid: 2147483647, token: 'dead-recovery' })
    )
    const result = cli(f.home, '--execute', '--recover-lock')
    expect(result.status, result.output).toBe(0)
    expect(result.value.status).toBe('committed')
  })

  it.each(['dev', 'packaged'])(
    'does not hide a later legacy %s profile behind a committed data receipt',
    async (mode) => {
      const f = await fixture()
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      const options = { home: f.home, appData: join(f.home, 'appData'), mode, execute: true }
      if (mode === 'packaged') {
        const { rename } = await import('node:fs/promises')
        await rename(f.old, join(f.home, 'OpenScience'))
      }
      await runMigration(options)
      const profile = join(options.appData, mode === 'dev' ? 'Open Science (DEV)' : 'Open Science')
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'Preferences'), 'historical preferences')
      await expect(runMigration(options)).rejects.toThrow(/uncovered|Legacy.*appeared/)
      expect(await readFile(join(profile, 'Preferences'), 'utf8')).toBe('historical preferences')
    }
  )
})

describe('hardening recovery boundaries', () => {
  const optionsFor = (
    f: Awaited<ReturnType<typeof fixture>>
  ): { home: string; appData: string; mode: string } => ({
    home: f.home,
    appData: join(f.home, 'appData'),
    mode: 'dev'
  })

  it.each(['reference-backed-up', 'reference-published', 'source-backed-up', 'before-commit'])(
    'survives two rollback interruptions after %s with a real database and both target generations',
    async (phase) => {
      const f = await fixture()
      await mkdir(f.next)
      const { DatabaseSync } = await import('node:sqlite')
      const dbPath = join(f.config, 'open-science.db')
      const db = new DatabaseSync(dbPath)
      db.exec(
        'PRAGMA foreign_keys=ON; CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT); CREATE TABLE Related(id TEXT PRIMARY KEY,rootId TEXT REFERENCES GrantedLocalRoot(id));'
      )
      db.prepare('INSERT INTO GrantedLocalRoot VALUES (?,?)').run(
        'root-id',
        join(f.old, 'uploads/paper.txt')
      )
      db.exec("INSERT INTO Related VALUES ('child-id','root-id')")
      db.close()
      const settings = await readFile(join(f.config, 'settings.json'), 'utf8')
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      const options = optionsFor(f)
      await expect(
        runMigration(
          { ...options, execute: true },
          {
            onProgress(e: { phase: string }) {
              if (e.phase === phase) throw new Error('publication interruption')
            }
          }
        )
      ).rejects.toThrow('publication interruption')
      for (const stopAt of ['rollback-aliases-removed', 'rollback-root-restored']) {
        await expect(
          runMigration(
            { ...options, rollback: true },
            {
              onProgress(e: { phase: string }) {
                if (e.phase === stopAt) throw new Error('repeated rollback interruption')
              }
            }
          )
        ).rejects.toThrow('repeated rollback interruption')
      }
      expect((await runMigration({ ...options, rollback: true })).status).toBe('rolled-back')
      expect((await runMigration({ ...options, rollback: true })).status).toBe('rolled-back')
      expect(await readFile(join(f.config, 'settings.json'), 'utf8')).toBe(settings)
      expect(await readFile(join(f.old, 'uploads/paper.txt'), 'utf8')).toBe('research\n')
      expect(await readdir(f.next)).toEqual([])
      const restored = new DatabaseSync(dbPath, { readOnly: true })
      expect(restored.prepare('SELECT * FROM GrantedLocalRoot').all()).toEqual([
        { id: 'root-id', path: join(f.old, 'uploads/paper.txt') }
      ])
      expect(restored.prepare('SELECT * FROM Related').all()).toEqual([
        { id: 'child-id', rootId: 'root-id' }
      ])
      expect(restored.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      restored.close()
    }
  )

  it('recovers the legacy v1 pre-publication rolling-back receipt with no reference stage', async () => {
    const f = await fixture()
    await mkdir(join(f.home, 'appData', 'Open Science (DEV)'), { recursive: true })
    await writeFile(join(f.home, 'appData', 'Open Science (DEV)', 'Preferences'), 'legacy profile')
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    await expect(
      runMigration(
        { ...optionsFor(f), execute: true },
        {
          onProgress(e: { phase: string }) {
            if (e.phase === 'copied') throw new Error('crash')
          }
        }
      )
    ).rejects.toThrow('crash')
    const file = join(`${f.config}.brand-migration`, 'journal.json')
    const journal = JSON.parse(await readFile(file, 'utf8'))
    journal.version = 1
    journal.status = 'rolling-back'
    await writeFile(file, JSON.stringify(journal))
    expect((await runMigration({ ...optionsFor(f), rollback: true })).status).toBe('rolled-back')
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2)
  })

  it('rejects a changed original after a pre-publication rollback interruption', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    await expect(
      runMigration(
        { ...optionsFor(f), execute: true },
        {
          onProgress(e: { phase: string }) {
            if (e.phase === 'copied') throw new Error('crash')
          }
        }
      )
    ).rejects.toThrow('crash')
    await expect(
      runMigration(
        { ...optionsFor(f), rollback: true },
        {
          onProgress(e: { phase: string }) {
            if (e.phase === 'rollback-aliases-removed') throw new Error('crash')
          }
        }
      )
    ).rejects.toThrow('crash')
    await writeFile(join(f.config, 'settings.json'), '{"changed":true}')
    await expect(runMigration({ ...optionsFor(f), rollback: true })).rejects.toThrow(
      /Integrity mismatch/
    )
    expect(await readFile(join(f.config, 'settings.json'), 'utf8')).toBe('{"changed":true}')
  })

  it.each(['root-published', 'before-commit'])(
    'detects a closed writer changing published content at %s',
    async (phase) => {
      const f = await fixture()
      const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
      await expect(
        runMigration(
          { ...optionsFor(f), execute: true },
          {
            async onProgress(e: { phase: string; path?: string }) {
              if (e.phase === phase && (phase === 'before-commit' || e.path === f.next))
                await writeFile(join(f.next, 'uploads/paper.txt'), 'new user write')
            }
          }
        )
      ).rejects.toThrow(/Integrity mismatch/)
      const journal = JSON.parse(
        await readFile(join(`${f.config}.brand-migration`, 'journal.json'), 'utf8')
      )
      expect(journal.status).not.toBe('committed')
      expect(await readFile(join(f.next, 'uploads/paper.txt'), 'utf8')).toBe('new user write')
      expect(
        await readFile(join(journal.participants[0].backup, 'uploads/paper.txt'), 'utf8')
      ).toBe('research\n')
    }
  )

  it('blocks a real descriptor after its process leaves the old cwd', async () => {
    const f = await fixture()
    const { spawn } = await import('node:child_process')
    const { once } = await import('node:events')
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs'); const fd=fs.openSync('uploads/paper.txt','a'); process.chdir('..'); process.on('message',()=>{}); process.send(fd);"
      ],
      { cwd: f.old, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    await once(child, 'message')
    try {
      const result = cli(f.home, '--execute')
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/occupied/)
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  })

  it('fails closed on unreadable, failed, empty or truncated occupancy probes', async () => {
    const { assertNoOpenFiles } = await import('../resources/brand-migration/transaction.mjs')
    for (const result of [
      { status: 1, stdout: '', stderr: '' },
      { status: 0, stdout: 'p123\0fcwd\0n/tmp\0\n', stderr: 'permission denied' },
      { status: 0, stdout: 'p123\0fcwd\0n/tmp', stderr: '' },
      { status: 0, stdout: '\n', stderr: '' },
      { status: 0, stdout: 'p123\0fNOFD\0\n', stderr: '' }
    ])
      expect(() => assertNoOpenFiles(['/tmp/fixture'], () => result)).toThrow()
  })

  it('requires explicit permission before retrying an incomplete Linux inventory with a read-only privileged probe', async () => {
    const { assertNoLinuxOpenFiles } =
      await import('../resources/brand-migration/linux-occupancy.mjs')
    const probe = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          version: 1,
          complete: false,
          permissionDenied: true,
          occupied: [],
          errors: ['Cannot inspect PID 1 maps']
        })
      })
      .mockReturnValueOnce({
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          version: 1,
          complete: true,
          permissionDenied: false,
          occupied: [],
          errors: []
        })
      })
    expect(() =>
      assertNoLinuxOpenFiles(['/tmp/fixture'], { probe, privileged: true })
    ).not.toThrow()
    expect(probe.mock.calls.map(([command]) => command)).toEqual([
      '/usr/bin/python3',
      '/usr/bin/sudo'
    ])
    expect(probe.mock.calls[1][1].slice(0, 7)).toEqual([
      '-n',
      '--',
      '/usr/bin/python3',
      '-I',
      '-S',
      '-B',
      '-c'
    ])
    probe.mockReset().mockReturnValue({
      status: 0,
      stderr: '',
      stdout: JSON.stringify({
        version: 1,
        complete: false,
        permissionDenied: true,
        occupied: [],
        errors: ['Cannot inspect PID 1 maps']
      })
    })
    expect(() => assertNoLinuxOpenFiles(['/tmp/fixture'], { probe, privileged: false })).toThrow(
      /Cannot verify.*occupancy/
    )
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('never retries away an observed Linux writer or accepts an incomplete privileged inventory', async () => {
    const { assertNoLinuxOpenFiles } =
      await import('../resources/brand-migration/linux-occupancy.mjs')
    const probe = vi.fn().mockReturnValue({
      status: 0,
      stderr: '',
      stdout: JSON.stringify({
        version: 1,
        complete: false,
        permissionDenied: true,
        occupied: [{ pid: 42, descriptor: 'fd/3' }],
        errors: ['Cannot inspect PID 1 maps']
      })
    })
    expect(() => assertNoLinuxOpenFiles(['/tmp/fixture'], { probe, privileged: true })).toThrow(
      /occupied.*PID 42/
    )
    expect(probe).toHaveBeenCalledTimes(1)
    for (const result of [
      { status: 1, stdout: '', stderr: 'sudo: a password is required' },
      { status: 0, stdout: '{}', stderr: '' },
      {
        status: 0,
        stdout: JSON.stringify({
          version: 1,
          complete: false,
          permissionDenied: true,
          occupied: [],
          errors: ['Cannot inspect PID 1 maps']
        }),
        stderr: ''
      }
    ]) {
      probe.mockReset().mockReturnValue(result)
      expect(() => assertNoLinuxOpenFiles(['/tmp/fixture'], { probe, privileged: true })).toThrow(
        /Cannot verify.*occupancy/
      )
    }
  })

  it.runIf(process.platform === 'linux')(
    'inspects real unreadable Linux system processes without elevating the migrator',
    async () => {
      const { assertNoLinuxOpenFiles } =
        await import('../resources/brand-migration/linux-occupancy.mjs')
      const { readlink } = await import('node:fs/promises')
      expect(
        process.env.OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION,
        'Linux integration requires explicit read-only probe authorization'
      ).toBe('1')
      expect(process.getuid!()).not.toBe(0)
      await expect(readlink('/proc/1/cwd')).rejects.toMatchObject({ code: 'EACCES' })
      const f = await fixture()
      expect(() => assertNoLinuxOpenFiles([f.old], { privileged: false })).toThrow(
        /Cannot verify.*occupancy/
      )
      expect(() => assertNoLinuxOpenFiles([f.old], { privileged: true })).not.toThrow()
      const child = await writer(f.old)
      try {
        expect(() => assertNoLinuxOpenFiles([f.old], { privileged: true })).toThrow(/occupied/)
        expect(cli(f.home, '--execute').status).not.toBe(0)
        await expect(lstat(f.next)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await stop(child)
      }
      expect(process.getuid!()).not.toBe(0)
    }
  )

  it.runIf(process.platform === 'linux').each(['fd', 'maps', 'cwd'])(
    'blocks a real nondumpable Linux process retaining only %s occupancy',
    async (kind) => {
      expect(process.env.OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION).toBe('1')
      const { spawn } = await import('node:child_process')
      const { once } = await import('node:events')
      const { assertNoLinuxOpenFiles } =
        await import('../resources/brand-migration/linux-occupancy.mjs')
      const f = await fixture()
      const child = spawn(
        '/usr/bin/python3',
        [
          '-I',
          '-c',
          `
import ctypes, mmap, os, sys
kind = sys.stdin.readline().strip()
file = open('uploads/paper.txt', 'r+b')
if kind == 'maps':
    mapping = mmap.mmap(file.fileno(), 0)
    file.close()
if kind != 'cwd': os.chdir('..')
else: file.close()
assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0
print('ready', flush=True)
sys.stdin.read()
`
        ],
        { cwd: f.old, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      child.stdin.write(kind + '\n')
      try {
        await once(child.stdout, 'data')
        expect(() => assertNoLinuxOpenFiles([f.old], { privileged: false })).toThrow(
          /Cannot verify.*occupancy/
        )
        expect(() => assertNoLinuxOpenFiles([f.old], { privileged: true })).toThrow(
          new RegExp('occupied.*PID ' + child.pid)
        )
        await expect(lstat(f.next)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await stop(child)
      }
    }
  )

  it.runIf(process.platform === 'linux')(
    'does not declare a thread group safe after its leader exits',
    async () => {
      const { spawn } = await import('node:child_process')
      const { once } = await import('node:events')
      const { assertNoLinuxOpenFiles } =
        await import('../resources/brand-migration/linux-occupancy.mjs')
      expect(process.env.OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION).toBe('1')
      const f = await fixture()
      const child = spawn(
        '/usr/bin/python3',
        [
          '-I',
          '-c',
          `
import ctypes, os, sys, threading
file = open('uploads/paper.txt', 'r+b')
os.chdir('..')
def worker():
    print('ready', flush=True)
    sys.stdin.read()
threading.Thread(target=worker).start()
ctypes.CDLL(None).pthread_exit(None)
`
        ],
        { cwd: f.old, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      try {
        await once(child.stdout, 'data')
        await expect
          .poll(
            async () => (await readFile('/proc/' + child.pid + '/stat', 'utf8')).split(') ')[1][0]
          )
          .toBe('Z')
        expect(() => assertNoLinuxOpenFiles([f.old], { privileged: true })).toThrow(
          /occupied|Cannot verify.*occupancy/
        )
        await expect(lstat(f.next)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await stop(child)
      }
    }
  )

  it.each(['', '{"pid":', 'empty-recovery'])(
    'requires identity approval for incomplete legacy lock %j',
    async (contents) => {
      const f = await fixture()
      const state = `${f.config}.brand-migration`
      await mkdir(state)
      const path = join(state, contents === 'empty-recovery' ? 'lock-recovery' : 'lock')
      if (contents === 'empty-recovery') await mkdir(path)
      else await writeFile(path, contents)
      const refused = cli(f.home, '--execute', '--recover-lock')
      expect(refused.status).not.toBe(0)
      const fingerprint = refused.output.match(/--recover-incomplete-lock ([a-f0-9]{64})/)?.[1]
      expect(fingerprint).toBeTruthy()
      expect(
        cli(f.home, '--execute', '--recover-lock', '--recover-incomplete-lock', '0'.repeat(64))
          .status
      ).not.toBe(0)
      const result = cli(
        f.home,
        '--execute',
        '--recover-lock',
        '--recover-incomplete-lock',
        fingerprint!
      )
      expect(result.status, result.output).toBe(0)
      expect(
        (await readdir(state)).some((name) =>
          name.startsWith(`${contents === 'empty-recovery' ? 'lock-recovery' : 'lock'}.abandoned-`)
        )
      ).toBe(true)
    }
  )

  it('serializes two recovery processes and survives consecutive recovery interruptions', async () => {
    const f = await fixture()
    const state = `${f.config}.brand-migration`
    await mkdir(join(state, 'lock-recovery'), { recursive: true })
    const dead = JSON.stringify({ pid: 2147483647, workerPid: 2147483647, token: 'dead' })
    await writeFile(join(state, 'lock'), dead)
    await writeFile(join(state, 'lock-recovery', 'owner.json'), dead)
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    for (const phase of ['recovery-lock-quarantined', 'lock-quarantined']) {
      await expect(
        runMigration(
          { ...optionsFor(f), execute: true, recoverLock: true },
          {
            onProgress(e: { phase: string }) {
              if (e.phase !== phase) return
              const contender = cli(f.home, '--execute', '--recover-lock')
              expect(contender.status).not.toBe(0)
              expect(contender.output).toMatch(/kernel lock unavailable or active/)
              throw new Error('recovery interruption')
            }
          }
        )
      ).rejects.toThrow('recovery interruption')
    }
    expect(cli(f.home, '--execute', '--recover-lock').status).toBe(0)
    expect((await readdir(state)).filter((name) => name.includes('.abandoned-'))).toHaveLength(2)
  })

  it('does not reclaim an active recovery-directory owner', async () => {
    const f = await fixture()
    const state = `${f.config}.brand-migration`
    await mkdir(join(state, 'lock-recovery'), { recursive: true })
    await writeFile(
      join(state, 'lock-recovery', 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'live' })
    )
    expect(cli(f.home, '--execute', '--recover-lock').output).toMatch(/owner is active/)
    expect(await readdir(join(state, 'lock-recovery'))).toEqual(['owner.json'])
  })

  it('rediscovers an explicit legacy root added after a custom-profile transaction', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = {
      ...optionsFor(f),
      userData: join(f.home, 'user-selected-profile'),
      execute: true
    }
    await runMigration(options)
    const from = join(f.home, 'chosen-old'),
      to = join(f.home, 'chosen-new')
    await mkdir(from)
    await writeFile(join(from, 'keep'), 'custom data')
    const journalFile = join(`${f.config}.brand-migration`, 'journal.json')
    const journal = await readFile(journalFile, 'utf8')
    await expect(runMigration({ ...options, maps: [{ from, to }] })).rejects.toThrow(/uncovered/)
    expect(await readFile(journalFile, 'utf8')).toBe(journal)
    expect((await runMigration(options)).status).toBe('committed')
  })

  it('keeps an alternate-case database reference as a retirement blocker if reintroduced after commit', async (ctx) => {
    const f = await fixture()
    const upper = join(f.home, 'OPENSCIENCE-DEV')
    if (!(await lstat(upper).catch(() => undefined))) return ctx.skip()
    expect(cli(f.home, '--execute').status).toBe(0)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'))
    db.exec('CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT)')
    db.prepare('INSERT INTO GrantedLocalRoot VALUES (?,?)').run(
      'legacy',
      join(upper, 'uploads/paper.txt')
    )
    db.close()
    expect(cli(f.home, '--audit-aliases').value.blockers).toContainEqual(
      expect.objectContaining({ reason: 'GrantedLocalRoot.path' })
    )
    expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
    expect(await readFile(join(upper, 'uploads/paper.txt'), 'utf8')).toBe('research\n')
  })
})

describe('independent hardening review regressions', () => {
  it('rolls back a saved reference publication intent before the first rename', async () => {
    const f = await fixture()
    const { inventory, copyTree, syncDirectory } =
      await import('../resources/brand-migration/transaction.mjs')
    const { bundleInventory, publishBundle, verifyBundleRollback } =
      await import('../resources/brand-migration/reference-bundle.mjs')
    const p = {
      from: f.config,
      to: f.config,
      files: ['settings.json'],
      stage: join(f.home, 'stage'),
      backup: join(f.home, 'backup'),
      original: await bundleInventory(f.config, ['settings.json'], inventory),
      published: undefined as unknown
    }
    await copyTree(f.config, p.stage)
    p.published = await bundleInventory(p.stage, p.files, inventory)
    await expect(
      publishBundle(
        p,
        async () => {
          throw new Error('intent persisted then crash')
        },
        () => {},
        inventory,
        syncDirectory
      )
    ).rejects.toThrow('intent persisted then crash')
    await expect(verifyBundleRollback(p, 'publishing', inventory)).resolves.toBeUndefined()
  })

  it('recovers its own two-link atomic lock publication window', async () => {
    const f = await fixture()
    const { link } = await import('node:fs/promises')
    const token = 'bf5b192a-27d1-4d3f-a4ab-a340739c8270'
    const state = `${f.config}.brand-migration`
    await mkdir(state)
    const prepared = join(state, `lock-owner-${token}`)
    await writeFile(
      prepared,
      JSON.stringify({ pid: 2147483647, workerPid: 2147483647, token, ownerKind: 'transaction' })
    )
    await link(prepared, join(state, 'lock'))
    const result = cli(f.home, '--execute', '--recover-lock')
    expect(result.status, result.output).toBe(0)
    expect(JSON.parse(await readFile(prepared, 'utf8')).token).toBe(token)
  })

  it('retains aliases used before shell punctuation and encoded URI separators', async () => {
    const f = await fixture()
    await writeFile(join(f.old, 'launcher.sh'), `cd ${f.old};\n`)
    expect(cli(f.home, '--execute').status).toBe(0)
    expect(cli(f.home, '--audit-aliases').value.blockers).toContainEqual(
      expect.objectContaining({ reason: 'remaining-path-reference' })
    )
    expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
  })
})

it('includes a later profile through verified rollback/restart while preserving the earlier receipt', async () => {
  const f = await fixture()
  const first = cli(f.home, '--execute')
  expect(first.status).toBe(0)
  const oldProfile = join(f.home, 'appData', 'Open Science (DEV)')
  await mkdir(oldProfile, { recursive: true })
  await writeFile(join(oldProfile, 'Preferences'), '{"history":"kept"}')
  expect(cli(f.home, '--execute').status).not.toBe(0)
  expect(cli(f.home, '--rollback').status).toBe(0)
  const second = cli(f.home, '--execute', '--restart-after-rollback')
  expect(second.status, second.output).toBe(0)
  expect(await readFile(join(f.home, 'appData', 'Open-Science (DEV)', 'Preferences'), 'utf8')).toBe(
    '{"history":"kept"}'
  )
  expect(await readFile(join(f.next, 'uploads/paper.txt'), 'utf8')).toBe('research\n')
  const archived = join(`${f.config}.brand-migration`, `journal-${first.value.id}.rolled-back.json`)
  expect(JSON.parse(await readFile(archived, 'utf8')).status).toBe('rolled-back')
  expect(cli(f.home, '--execute').status).toBe(0)
})

it('distinguishes native case identity and foreign-platform lexical simulations', async (ctx) => {
  const f = await fixture()
  const { remapPath } = await import('../resources/brand-migration/paths.mjs')
  const maps = [{ from: f.old, to: f.next }]
  expect(remapPath(`${f.old}-other/file`, maps)).toBe(`${f.old}-other/file`)
  if (process.platform === 'darwin') {
    // Linux case sensitivity is a lexical simulation here, not a Linux filesystem run.
    expect(remapPath(join(f.home, 'OPENSCIENCE-DEV/file'), maps, 'linux')).toBe(
      join(f.home, 'OPENSCIENCE-DEV/file')
    )
  }
  expect(remapPath('c:\\OLD\\child', [{ from: 'C:\\Old', to: 'C:\\New' }], 'win32')).toBe(
    'C:\\New\\child'
  )
  const upper = join(f.home, 'OPENSCIENCE-DEV')
  const stat = await lstat(upper).catch(() => undefined)
  if (!stat || stat.ino !== (await lstat(f.old)).ino) return ctx.skip()
  const { pathToFileURL } = await import('node:url')
  expect(remapPath(pathToFileURL(join(upper, 'uploads/paper.txt')).href, maps)).toBe(
    pathToFileURL(join(f.next, 'uploads/paper.txt')).href
  )
})

it('can recover a later profile from an empty legacy initialization receipt without discarding it', async () => {
  const f = await fixture()
  await rm(f.old, { recursive: true })
  await rm(f.config, { recursive: true })
  expect(cli(f.home, '--execute').status).toBe(0)
  const file = join(`${f.config}.brand-migration`, 'journal.json')
  const legacy = JSON.parse(await readFile(file, 'utf8'))
  legacy.version = 1
  delete legacy.id
  delete legacy.platform
  await writeFile(file, JSON.stringify(legacy))
  const profile = join(f.home, 'appData', 'Open Science (DEV)')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'Preferences'), 'later history')
  expect(cli(f.home, '--execute').status).not.toBe(0)
  expect(cli(f.home, '--rollback').status).toBe(0)
  const result = cli(f.home, '--execute', '--restart-after-rollback')
  expect(result.status, result.output).toBe(0)
  expect(await readFile(join(f.home, 'appData', 'Open-Science (DEV)', 'Preferences'), 'utf8')).toBe(
    'later history'
  )
})

it('recovers every member of an unprepared v1 reference bundle', async () => {
  const f = await fixture()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(f.config, 'open-science.db'))
  db.exec('CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT)')
  db.close()
  const { inventory } = await import('../resources/brand-migration/transaction.mjs')
  const { bundleInventory, verifyBundleRollback } =
    await import('../resources/brand-migration/reference-bundle.mjs')
  const files = ['settings.json', 'open-science.db']
  const p = {
    from: f.config,
    to: f.config,
    files,
    stage: join(f.home, 'absent-stage'),
    backup: join(f.home, 'absent-backup'),
    original: await bundleInventory(f.config, files, inventory)
  }
  await expect(verifyBundleRollback(p, 'rolling-back', inventory)).resolves.toBeUndefined()
})

it.each([1, 65535])('audits opaque UTF-16 prefixes at byte offset %i', async (offset) => {
  const f = await fixture()
  await writeFile(
    join(f.old, 'binary-prefix'),
    Buffer.concat([Buffer.alloc(offset), Buffer.from(f.old + '/bin/tool\0', 'utf16le')])
  )
  expect(cli(f.home, '--execute').status).toBe(0)
  expect(cli(f.home, '--audit-aliases').value.blockers).toContainEqual(
    expect.objectContaining({ reason: 'remaining-path-reference' })
  )
})

it('detects a descriptor acquired in the renamed backup and resumes only after it closes', async () => {
  const f = await fixture()
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
  const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev' }
  let child: import('node:child_process').ChildProcess | undefined
  try {
    await expect(
      runMigration(
        { ...options, execute: true },
        {
          async onProgress(e: { phase: string; path?: string }) {
            if (e.phase !== 'source-backed-up' || e.path !== f.old) return
            const journal = JSON.parse(
              await readFile(join(`${f.config}.brand-migration`, 'journal.json'), 'utf8')
            )
            child = spawn(
              process.execPath,
              [
                '-e',
                "const fs=require('node:fs'); fs.openSync('uploads/paper.txt','a'); process.chdir('..'); process.on('message',()=>{}); process.send('ready');"
              ],
              { cwd: journal.participants[0].backup, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
            )
            await once(child, 'message')
          }
        }
      )
    ).rejects.toThrow(/occupied/)
  } finally {
    if (child) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  expect((await runMigration({ ...options, resume: true })).status).toBe('committed')
  expect(await readFile(join(f.next, 'uploads/paper.txt'), 'utf8')).toBe('research\n')
})

it('releases the kernel guard after recovering processes really exit mid-recovery twice', async () => {
  const f = await fixture()
  const state = `${f.config}.brand-migration`
  await mkdir(join(state, 'lock-recovery'), { recursive: true })
  const dead = JSON.stringify({ pid: 2147483647, workerPid: 2147483647, token: 'abandoned' })
  await writeFile(join(state, 'lock'), dead)
  await writeFile(join(state, 'lock-recovery', 'owner.json'), dead)
  const { pathToFileURL } = await import('node:url')
  const { resolve } = await import('node:path')
  const moduleUrl = pathToFileURL(resolve('resources/brand-migration/transaction.mjs')).href
  for (const phase of ['recovery-lock-quarantined', 'lock-quarantined']) {
    let status = 0
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { runMigration } from ${JSON.stringify(moduleUrl)};
        let input=''; for await (const chunk of process.stdin) input+=chunk;
        const { options, phase } = JSON.parse(input);
        await runMigration(options, { onProgress(e) { if(e.phase === phase) process.exit(72); } });
      `
        ],
        {
          input: JSON.stringify({
            options: {
              home: f.home,
              appData: join(f.home, 'appData'),
              mode: 'dev',
              execute: true,
              recoverLock: true
            },
            phase
          }),
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
    } catch (error) {
      status = (error as { status: number }).status
    }
    expect(status).toBe(72)
  }
  const result = cli(f.home, '--execute', '--recover-lock')
  expect(result.status, result.output).toBe(0)
  expect((await readdir(state)).filter((name) => name.includes('.abandoned-'))).toHaveLength(2)
})

it('initializes and reopens a fresh profile without offline-only probe tools', async () => {
  const f = await fixture()
  await rm(f.old, { recursive: true })
  await rm(f.config, { recursive: true })
  for (let n = 0; n < 2; n++) {
    const result = execFileSync(
      process.execPath,
      [
        'scripts/migrate-brand-paths.mjs',
        '--home',
        f.home,
        '--app-data',
        join(f.home, 'appData'),
        '--mode',
        'dev',
        '--execute'
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: '' } }
    )
    expect(JSON.parse(result).status).toBe('committed')
  }
})

it('requires the kernel guard when restarting an empty rolled-back receipt with new legacy data', async () => {
  const f = await fixture()
  await rm(f.old, { recursive: true })
  await rm(f.config, { recursive: true })
  expect(cli(f.home, '--execute').status).toBe(0)
  expect(cli(f.home, '--rollback').status).toBe(0)
  await mkdir(f.old)
  await writeFile(join(f.old, 'keep'), 'later data')
  const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
  const { acquireKernelGuard } = await import('../resources/brand-migration/lock-guard.mjs')
  let improperlyAcquired = false
  await runMigration(
    {
      home: f.home,
      appData: join(f.home, 'appData'),
      mode: 'dev',
      execute: true,
      restartAfterRollback: true
    },
    {
      async onProgress(e: { phase: string }) {
        if (e.phase !== 'copied') return
        let other: Awaited<ReturnType<typeof acquireKernelGuard>> | undefined
        try {
          other = await acquireKernelGuard(join(`${f.config}.brand-migration`, 'lock-guard'))
          improperlyAcquired = true
        } catch (error) {
          expect(String(error)).toMatch(/kernel lock unavailable or active/)
        } finally {
          await other?.release()
        }
      }
    }
  )
  expect(improperlyAcquired).toBe(false)
})

it('replans and acquires the guard if a legacy root appears while the lease is acquired', async () => {
  const f = await fixture()
  await rm(f.old, { recursive: true })
  await rm(f.config, { recursive: true })
  const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
  const { acquireKernelGuard } = await import('../resources/brand-migration/lock-guard.mjs')
  let checked = false
  await runMigration(
    { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
    {
      async onProgress(e: { phase: string }) {
        if (e.phase === 'lease-acquired') {
          await mkdir(f.old)
          await writeFile(join(f.old, 'keep'), 'late data')
        }
        if (e.phase === 'copied') {
          await expect(
            acquireKernelGuard(join(`${f.config}.brand-migration`, 'lock-guard'))
          ).rejects.toThrow(/kernel lock unavailable or active/)
          checked = true
        }
      }
    }
  )
  expect(checked).toBe(true)
  expect(await readFile(join(f.next, 'keep'), 'utf8')).toBe('late data')
})

describe('visible migration progress', () => {
  it('reports scanning and copying before a root has finished copying', async () => {
    const f = await fixture()
    const { runMigration, copyTree } = await import('../resources/brand-migration/transaction.mjs')
    const events: Array<{ phase: string; path?: string; completed?: number }> = []
    await runMigration(
      { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
      {
        onProgress: (event) => events.push(event),
        copyTree: async (from, to) => {
          expect(events.some((e) => e.phase === 'scanning' && e.completed! > 0)).toBe(true)
          expect(events.at(-1)).toMatchObject({
            phase: 'copying',
            path: from === f.old ? f.old : f.config
          })
          await copyTree(from, to)
        }
      }
    )
    expect(events.some((e) => e.phase === 'verifying')).toBe(true)
    expect(events.at(-1)).toMatchObject({ phase: 'completed' })
  })

  it('streams CLI stages to stderr while keeping stdout a parseable receipt', async () => {
    const f = await fixture()
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(
      process.execPath,
      [
        'scripts/migrate-brand-paths.mjs',
        '--home',
        f.home,
        '--app-data',
        join(f.home, 'appData'),
        '--mode',
        'dev',
        '--execute'
      ],
      { encoding: 'utf8' }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).status).toBe('committed')
    expect(result.stderr).toContain('[brand-migration]')
    expect(result.stderr).toContain('scanning')
    expect(result.stderr).toContain('completed')
  })
})

describe('pre-publication snapshot restart', () => {
  // These cases exercise the macOS standalone log-root policy on real host files/SQLite.
  // The path/reference plan is macOS; process/metadata inspection remains host-native.
  function migrationProcess(options: Record<string, unknown>): ReturnType<typeof cli> {
    try {
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runMigration} from './resources/brand-migration/transaction.mjs';
           runMigration(JSON.parse(process.argv[1])).then(result => console.log(JSON.stringify(result)))
             .catch(error => { console.error(error.message); process.exitCode = 1; });`,
          JSON.stringify(options)
        ],
        { encoding: 'utf8' }
      )
      return { status: 0, output, value: JSON.parse(output) }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return {
        status: failure.status ?? 1,
        output: String(failure.stdout) + String(failure.stderr),
        value: undefined
      }
    }
  }

  async function interrupted(): Promise<
    Awaited<ReturnType<typeof fixture>> & {
      options: { home: string; appData: string; mode: string; platform: string }
      oldLogs: string
      newLogs: string
      state: string
      receipt: ReturnType<typeof JSON.parse>
      runMigration: typeof import('../resources/brand-migration/transaction.mjs').runMigration
    }
  > {
    const f = await fixture()
    const oldLogs = join(f.home, 'Library', 'Logs', 'Open Science (DEV)')
    const newLogs = join(f.home, 'Library', 'Logs', 'Open-Science (DEV)')
    await mkdir(oldLogs, { recursive: true })
    await mkdir(newLogs, { recursive: true })
    await writeFile(join(oldLogs, 'main.log'), 'old log\n')
    await writeFile(join(newLogs, 'main.log'), 'new log\n')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'))
    db.exec('CREATE TABLE GrantedLocalRoot(id TEXT PRIMARY KEY,path TEXT)')
    db.prepare('INSERT INTO GrantedLocalRoot VALUES (?,?)').run('stable-root', f.old)
    db.close()
    const options = {
      home: f.home,
      appData: join(f.home, 'appData'),
      mode: 'dev',
      platform: 'darwin'
    }
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    await expect(
      runMigration(
        { ...options, execute: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'copied') throw new Error('fixture interruption')
          }
        }
      )
    ).rejects.toThrow('fixture interruption')
    const state = `${f.config}.brand-migration`
    const receipt = JSON.parse(await readFile(join(state, 'journal.json'), 'utf8'))
    await writeFile(join(oldLogs, 'main.log'), 'old log\nlate old log\n')
    await writeFile(join(newLogs, 'main.log'), 'new log\nlate new log\n')
    return { ...f, options, oldLogs, newLogs, state, receipt, runMigration }
  }

  it('restarts appended source and target logs without losing either generation, SQLite IDs or prior staging', async () => {
    const f = await interrupted()
    const staged = f.receipt.participants.find((p) => p.from === f.oldLogs).stage
    const stagedBytes = await readFile(join(staged, 'main.log'), 'utf8')
    expect(migrationProcess({ ...f.options, resume: true }).status).not.toBe(0)
    const result = migrationProcess({ ...f.options, restartPreparing: true })
    expect(result.status, result.output).toBe(0)
    expect(result.value.status).toBe('committed')
    expect(result.value.id).not.toBe(f.receipt.id)
    expect(await readFile(join(f.newLogs, 'main.log'), 'utf8')).toBe('old log\nlate old log\n')
    const target = result.value.participants.find((p) => p.to === f.newLogs).previousTarget
    expect(await readFile(join(target.backup, 'main.log'), 'utf8')).toBe('new log\nlate new log\n')
    expect(await readFile(join(staged, 'main.log'), 'utf8')).toBe(stagedBytes)
    expect(
      JSON.parse(await readFile(join(f.state, `journal-${f.receipt.id}.superseded.json`), 'utf8'))
    ).toEqual(f.receipt)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'), { readOnly: true })
    expect(db.prepare('SELECT id,path FROM GrantedLocalRoot').get()).toEqual({
      id: 'stable-root',
      path: f.next
    })
    db.close()
    expect(migrationProcess({ ...f.options, restartPreparing: true }).value.id).toBe(
      result.value.id
    )
    expect(migrationProcess({ ...f.options, rollback: true }).status).toBe(0)
    expect(await readFile(join(f.oldLogs, 'main.log'), 'utf8')).toBe('old log\nlate old log\n')
    expect(await readFile(join(f.newLogs, 'main.log'), 'utf8')).toBe('new log\nlate new log\n')
  })

  it('fresh dev migration preserves rotated logs and changed configuration then rolls back to the retry snapshot', async () => {
    const f = await interrupted()
    const stage = f.receipt.participants.find((p) => p.from === f.oldLogs).stage
    const stagedBytes = await readFile(join(stage, 'main.log'), 'utf8')
    await writeFile(join(f.newLogs, 'main.1.log'), await readFile(join(f.newLogs, 'main.log')))
    await writeFile(join(f.newLogs, 'main.log'), 'new log after rotation\n')
    const settings = JSON.stringify({
      version: 2,
      providers: [],
      dataRoot: f.old,
      localePreference: 'zh-Hans'
    })
    await writeFile(join(f.config, 'settings.json'), settings)
    await writeFile(join(f.old, 'uploads', 'paper.txt'), 'latest research\n')
    const options = { ...f.options, execute: true, freshDevMigration: true }
    const result = await f.runMigration(options)
    expect(result.status).toBe('committed')
    expect(result.id).not.toBe(f.receipt.id)
    expect(
      JSON.parse(await readFile(join(f.state, `journal-${f.receipt.id}.abandoned.json`), 'utf8'))
    ).toEqual(f.receipt)
    expect(await readFile(join(stage, 'main.log'), 'utf8')).toBe(stagedBytes)
    expect(await readFile(join(f.next, 'uploads', 'paper.txt'), 'utf8')).toBe('latest research\n')
    expect(JSON.parse(await readFile(join(f.config, 'settings.json'), 'utf8'))).toMatchObject({
      dataRoot: f.next,
      localePreference: 'zh-Hans'
    })
    const target = result.participants.find((p) => p.to === f.newLogs).previousTarget.backup
    expect(await readFile(join(target, 'main.log'), 'utf8')).toBe('new log after rotation\n')
    expect(await readFile(join(target, 'main.1.log'), 'utf8')).toBe('new log\nlate new log\n')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(f.config, 'open-science.db'), { readOnly: true })
    expect(db.prepare('SELECT id,path FROM GrantedLocalRoot').get()).toEqual({
      id: 'stable-root',
      path: f.next
    })
    db.close()
    expect((await f.runMigration(options)).id).toBe(result.id)
    await f.runMigration({ ...f.options, rollback: true })
    expect(await readFile(join(f.config, 'settings.json'), 'utf8')).toBe(settings)
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('latest research\n')
    expect(await readFile(join(f.newLogs, 'main.log'), 'utf8')).toBe('new log after rotation\n')
    const restored = new DatabaseSync(join(f.config, 'open-science.db'), { readOnly: true })
    expect(restored.prepare('SELECT id,path FROM GrantedLocalRoot').get()).toEqual({
      id: 'stable-root',
      path: f.old
    })
    restored.close()
  })

  it('fresh dev migration survives an exit after archiving and another failed copy without reusing either stage', async () => {
    const f = await interrupted()
    const options = { ...f.options, execute: true, freshDevMigration: true, recoverLock: true }
    // Exit without finally/unlock, exercising the actual durable rename and abandoned lease.
    let exitStatus: number | undefined
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runMigration} from './resources/brand-migration/transaction.mjs';
         await runMigration(JSON.parse(process.argv[1]), {onProgress(event) {
           if (event.phase === 'restart-archived') process.exit(74);
         }});`,
          JSON.stringify(options)
        ],
        { stdio: 'pipe' }
      )
    } catch (error) {
      exitStatus = (error as { status?: number }).status
    }
    expect(exitStatus).toBe(74)
    await expect(readFile(join(f.state, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      f.runMigration(options, {
        onProgress(event: { phase: string }) {
          if (event.phase === 'copied') throw new Error('second copy interruption')
        }
      })
    ).rejects.toThrow('second copy interruption')
    const second = JSON.parse(await readFile(join(f.state, 'journal.json'), 'utf8'))
    expect(second.id).not.toBe(f.receipt.id)
    const result = await f.runMigration(options)
    expect(result.id).not.toBe(second.id)
    for (const receipt of [f.receipt, second]) {
      expect(
        JSON.parse(await readFile(join(f.state, `journal-${receipt.id}.abandoned.json`), 'utf8'))
      ).toEqual(receipt)
      expect((await lstat(receipt.participants[0].stage)).isDirectory()).toBe(true)
    }
  })

  it('fresh dev migration remains read-only in previews and preserves the receipt when a writer exists', async () => {
    const f = await interrupted()
    const before = await readFile(join(f.state, 'journal.json'), 'utf8')
    await f.runMigration({ ...f.options, freshDevMigration: true })
    expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    const child = await writer(f.old)
    try {
      await expect(
        f.runMigration({ ...f.options, freshDevMigration: true, execute: true })
      ).rejects.toThrow(/active|open|process|writer/i)
      expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    } finally {
      await stop(child)
    }
  })

  it('fresh dev migration refuses publication evidence and nonempty target conflicts before archiving', async () => {
    const f = await interrupted()
    const before = await readFile(join(f.state, 'journal.json'), 'utf8')
    const backup = f.receipt.participants[0].backup
    await mkdir(backup)
    await expect(
      f.runMigration({ ...f.options, execute: true, freshDevMigration: true })
    ).rejects.toThrow(/Publication evidence/)
    expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    await rm(backup, { recursive: true })
    await mkdir(f.next)
    await writeFile(join(f.next, 'user-file'), 'keep')
    await expect(
      f.runMigration({ ...f.options, execute: true, freshDevMigration: true })
    ).rejects.toThrow(/destination|conflict/i)
    expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    expect(await readFile(join(f.next, 'user-file'), 'utf8')).toBe('keep')
  })

  it('fresh dev migration CLI requires dev mode and cannot modify a rollback or resume action', async () => {
    const f = await fixture()
    expect(cli(f.home, '--fresh-dev-migration').status).toBe(0)
    expect(
      cli(f.home, '--fresh-dev-migration', '--mode', 'packaged', '--execute').output
    ).toContain('dev')
    for (const action of ['--rollback', '--resume', '--restart-preparing']) {
      expect(cli(f.home, '--fresh-dev-migration', action).status).not.toBe(0)
    }
    const result = cli(f.home, '--fresh-dev-migration', '--execute')
    expect(result.status, result.output).toBe(0)
  })

  it.each(['restoreIntent', 'restored'])(
    'fresh dev migration refuses an existing-target %s marker even without backup directories',
    async (marker) => {
      const f = await interrupted()
      f.receipt.participants[0].previousTarget[marker] = true
      const before = JSON.stringify(f.receipt)
      await writeFile(join(f.state, 'journal.json'), before)
      await expect(
        f.runMigration({ ...f.options, execute: true, freshDevMigration: true })
      ).rejects.toThrow(/restoration intent/)
      expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    }
  )

  it('fresh dev migration resumes partial publication with the original receipt instead of resetting it', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = {
      home: f.home,
      appData: join(f.home, 'appData'),
      mode: 'dev',
      execute: true,
      freshDevMigration: true
    }
    await expect(
      runMigration(options, {
        onProgress(event: { phase: string }) {
          if (event.phase === 'source-backed-up') throw new Error('publication interruption')
        }
      })
    ).rejects.toThrow('publication interruption')
    const state = `${f.config}.brand-migration`
    const receipt = JSON.parse(await readFile(join(state, 'journal.json'), 'utf8'))
    expect(receipt.status).toBe('publishing')
    const result = await runMigration(options)
    expect(result.id).toBe(receipt.id)
    expect(result.status).toBe('committed')
    expect((await readdir(state)).filter((name) => name.endsWith('.abandoned.json'))).toEqual([])
    await runMigration({
      home: f.home,
      appData: join(f.home, 'appData'),
      mode: 'dev',
      rollback: true
    })
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })

  it('reports the changed file and explicit recovery action without silently accepting the new snapshot', async () => {
    const f = await interrupted()
    const result = migrationProcess({ ...f.options, resume: true })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('main.log')
    expect(result.output).toContain('--restart-preparing')
    expect(JSON.parse(await readFile(join(f.state, 'journal.json'), 'utf8')).id).toBe(f.receipt.id)
  })

  it.each(['restart-archived', 'restart-intent', 'restart-installed'])(
    'recovers a second interruption at %s without replacing the preserved receipt',
    async (phase) => {
      const f = await interrupted()
      await expect(
        f.runMigration(
          { ...f.options, restartPreparing: true },
          {
            onProgress(event: { phase: string }) {
              if (event.phase === phase) throw new Error('restart interruption')
            }
          }
        )
      ).rejects.toThrow('restart interruption')
      const archive = await readFile(
        join(f.state, `journal-${f.receipt.id}.superseded.json`),
        'utf8'
      )
      const result = migrationProcess({ ...f.options, restartPreparing: true })
      expect(result.status, result.output).toBe(0)
      expect(result.value.status).toBe('committed')
      expect(await readFile(join(f.state, `journal-${f.receipt.id}.superseded.json`), 'utf8')).toBe(
        archive
      )
      expect(await readFile(join(f.newLogs, 'main.log'), 'utf8')).toBe('old log\nlate old log\n')
    }
  )

  it.each([
    'configuration',
    'database',
    'log rotation',
    'log truncation',
    'backup appeared',
    'publishing'
  ])('refuses to rebuild after %s and preserves the receipt', async (change) => {
    const f = await interrupted()
    if (change === 'configuration') await writeFile(join(f.config, 'settings.json'), '{}')
    if (change === 'database') {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(join(f.config, 'open-science.db'))
      db.exec("UPDATE GrantedLocalRoot SET id='changed'")
      db.close()
    }
    if (change === 'log rotation') {
      const { rename } = await import('node:fs/promises')
      await rename(join(f.oldLogs, 'main.log'), join(f.oldLogs, 'main.1.log'))
      await writeFile(join(f.oldLogs, 'main.log'), 'rotated\n')
    }
    if (change === 'log truncation') await writeFile(join(f.oldLogs, 'main.log'), '')
    if (change === 'backup appeared') await mkdir(f.receipt.participants[0].backup)
    if (change === 'publishing') {
      f.receipt.status = 'publishing'
      await writeFile(join(f.state, 'journal.json'), JSON.stringify(f.receipt))
    }
    const before = await readFile(join(f.state, 'journal.json'), 'utf8')
    const result = migrationProcess({ ...f.options, restartPreparing: true })
    expect(result.status).not.toBe(0)
    expect(result.output).not.toContain('Unknown argument')
    expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    expect(await lstat(f.old).then((s) => s.isDirectory())).toBe(true)
    expect(await lstat(f.next).catch(() => undefined)).toBeUndefined()
  })
  it.each(['new append', 'publication evidence'])(
    'rechecks %s after restart intent before installing the next receipt',
    async (change) => {
      const f = await interrupted()
      await expect(
        f.runMigration(
          { ...f.options, restartPreparing: true },
          {
            async onProgress(event: { phase: string }) {
              if (event.phase !== 'restart-intent') return
              if (change === 'new append')
                await writeFile(join(f.oldLogs, 'main.log'), 'old log\nlate old log\nmore\n')
              else await mkdir(f.receipt.participants[0].backup)
            }
          }
        )
      ).rejects.toThrow()
      const receipt = JSON.parse(await readFile(join(f.state, 'journal.json'), 'utf8'))
      expect(receipt.status).toBe('restarting')
      expect(receipt.id).toBe(f.receipt.id)
    }
  )
  it('resumes a durable restart intent but blocks ordinary automatic startup until explicit recovery', async () => {
    const f = await interrupted()
    await expect(
      f.runMigration(
        { ...f.options, restartPreparing: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'restart-intent') throw new Error('interrupted intent')
          }
        }
      )
    ).rejects.toThrow('interrupted intent')
    const pending = await readFile(join(f.state, 'journal.json'), 'utf8')
    const startup = migrationProcess({ ...f.options, execute: true })
    expect(startup.status).not.toBe(0)
    expect(startup.output).toContain('Interrupted snapshot restart')
    expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(pending)
    expect(migrationProcess({ ...f.options, resume: true }).value.status).toBe('committed')
  })

  it('survives two actual process exits while preserving the initial archive and staged files', async () => {
    const f = await interrupted()
    const { spawnSync } = await import('node:child_process')
    for (const phase of ['restart-archived', 'restart-intent']) {
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import {runMigration} from './resources/brand-migration/transaction.mjs';
        import {join} from 'node:path';
        const [home,phase] = process.argv.slice(1);
        await runMigration({home,appData:join(home,'appData'),mode:'dev',platform:'darwin',restartPreparing:true,recoverLock:true}, {
          onProgress(e) { if(e.phase === phase) process.exit(74); }
        });
      `,
          f.home,
          phase
        ],
        { encoding: 'utf8' }
      )
      expect(child.status, child.stderr).toBe(74)
    }
    const result = migrationProcess({ ...f.options, resume: true, recoverLock: true })
    expect(result.status, result.output).toBe(0)
    expect(
      JSON.parse(await readFile(join(f.state, `journal-${f.receipt.id}.superseded.json`), 'utf8'))
    ).toEqual(f.receipt)
    expect(await readFile(join(f.newLogs, 'main.log'), 'utf8')).toBe('old log\nlate old log\n')
  })

  it('rejects a competing real restart process while its owner holds the restart lease', async () => {
    const f = await interrupted()
    await f.runMigration(
      { ...f.options, restartPreparing: true },
      {
        onProgress(event: { phase: string }) {
          if (event.phase !== 'restart-intent') return
          const result = migrationProcess({
            ...f.options,
            restartPreparing: true,
            recoverLock: true
          })
          expect(result.status).not.toBe(0)
          expect(result.output).toContain('kernel lock unavailable or active')
        }
      }
    )
    expect(migrationProcess({ ...f.options, restartPreparing: true }).value.status).toBe(
      'committed'
    )
  })

  it('does not mutate the receipt when a real process holds an old-root descriptor', async () => {
    const f = await interrupted()
    const { spawn } = await import('node:child_process')
    const { once } = await import('node:events')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs=require('node:fs'); const fd=fs.openSync('main.log','a');
      process.on('message',()=>{}); process.send('ready');
    `
      ],
      { cwd: f.oldLogs, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    await once(child, 'message')
    try {
      const before = await readFile(join(f.state, 'journal.json'), 'utf8')
      const result = migrationProcess({ ...f.options, restartPreparing: true })
      expect(result.status).not.toBe(0)
      expect(result.output).toMatch(/occupied|using migration paths/)
      expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  })

  it('keeps the restart intent when its archive is tampered with or its next-stage path is forged', async () => {
    const f = await interrupted()
    await expect(
      f.runMigration(
        { ...f.options, restartPreparing: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'restart-intent') throw new Error('interrupted')
          }
        }
      )
    ).rejects.toThrow('interrupted')
    const file = join(f.state, 'journal.json'),
      archive = join(f.state, `journal-${f.receipt.id}.superseded.json`)
    const pending = await readFile(file, 'utf8'),
      original = await readFile(archive, 'utf8')
    await writeFile(archive, '{}')
    expect(migrationProcess({ ...f.options, resume: true }).output).toContain(
      'archive does not match'
    )
    expect(await readFile(file, 'utf8')).toBe(pending)
    await writeFile(archive, original)
    const forged = JSON.parse(pending)
    forged.restart.next.participants[0].stage = join(f.home, 'unrelated')
    await writeFile(file, JSON.stringify(forged))
    expect(migrationProcess({ ...f.options, resume: true }).output).toContain(
      'Invalid journal participant paths'
    )
    expect(await readFile(join(f.oldLogs, 'main.log'), 'utf8')).toBe('old log\nlate old log\n')
  })

  it('never turns a dry-run or mixed action into a snapshot restart', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    await expect(
      runMigration(
        { home: f.home, appData: join(f.home, 'appData'), mode: 'dev', execute: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'copied') throw new Error('native CLI fixture interruption')
          }
        }
      )
    ).rejects.toThrow('native CLI fixture interruption')
    const state = `${f.config}.brand-migration`
    const before = await readFile(join(state, 'journal.json'), 'utf8')
    for (const args of [
      ['--dry-run', '--restart-preparing'],
      ['--execute', '--restart-preparing'],
      ['--rollback', '--restart-preparing']
    ]) {
      expect(cli(f.home, ...args).status).not.toBe(0)
    }
    expect(cli(f.home).value.status).toBe('preparing')
    expect(await readFile(join(state, 'journal.json'), 'utf8')).toBe(before)
    const restarted = cli(f.home, '--restart-preparing')
    expect(restarted.status, restarted.output).toBe(0)
    expect(restarted.value.status).toBe('committed')
    expect(cli(f.home, '--resume').value.id).toBe(restarted.value.id)
    expect(cli(f.home, '--restart-preparing').value.id).toBe(restarted.value.id)
    expect(cli(f.home, '--rollback').status).toBe(0)
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe('research\n')
  })
  it('does not accept a data change between original verification and rebuilding its manifest', async () => {
    const f = await interrupted()
    const before = await readFile(join(f.state, 'journal.json'), 'utf8')
    let changed = false
    await expect(
      f.runMigration(
        { ...f.options, restartPreparing: true },
        {
          async onProgress(event: { phase: string; path?: string; completed?: number }) {
            if (
              !changed &&
              event.phase === 'scanning' &&
              event.path === f.old &&
              event.completed === 0
            ) {
              changed = true
              await writeFile(join(f.old, 'uploads', 'paper.txt'), 'changed user research\n')
            }
          }
        }
      )
    ).rejects.toThrow('Integrity mismatch')
    expect(changed).toBe(true)
    expect(await readFile(join(f.state, 'journal.json'), 'utf8')).toBe(before)
    expect(await readFile(join(f.old, 'uploads', 'paper.txt'), 'utf8')).toBe(
      'changed user research\n'
    )
  })
  it('resumes the accepted restart generation after it partially publishes, without creating another generation', async () => {
    const f = await interrupted()
    await expect(
      f.runMigration(
        { ...f.options, restartPreparing: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'root-published') throw new Error('partial new publication')
          }
        }
      )
    ).rejects.toThrow('partial new publication')
    const pending = JSON.parse(await readFile(join(f.state, 'journal.json'), 'utf8'))
    expect(pending.status).toBe('publishing')
    const result = migrationProcess({ ...f.options, restartPreparing: true })
    expect(result.status, result.output).toBe(0)
    expect(result.value.id).toBe(pending.id)
    expect(result.value.status).toBe('committed')
    expect(await readFile(join(f.newLogs, 'main.log'), 'utf8')).toBe('old log\nlate old log\n')
  })

  it('preflights every original before rebuilding any earlier participant staging on resume', async () => {
    const f = await fixture()
    const { runMigration } = await import('../resources/brand-migration/transaction.mjs')
    const options = { home: f.home, appData: join(f.home, 'appData'), mode: 'dev' }
    await expect(
      runMigration(
        { ...options, execute: true },
        {
          onProgress(event: { phase: string; path?: string }) {
            if (event.phase === 'copied' && event.path?.startsWith(`${f.config}.brand-stage-`))
              throw new Error('late preparation interruption')
          }
        }
      )
    ).rejects.toThrow('late preparation interruption')
    const receipt = JSON.parse(
      await readFile(join(`${f.config}.brand-migration`, 'journal.json'), 'utf8')
    )
    const stage = receipt.participants.find((p) => p.from === f.old).stage
    const before = await lstat(stage)
    await writeFile(join(f.config, 'settings.json'), '{}')
    expect(cli(f.home, '--resume').status).not.toBe(0)
    expect((await lstat(stage)).ino).toBe(before.ino)
  })
})

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
import { afterEach, describe, expect, it } from 'vitest'

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
    expect(cli(f.home, '--execute').status).toBe(0)
    expect(cli(f.home, '--retire-aliases').status).not.toBe(0)
    expect(await readFile(join(f.next, 'refs', 'paper'), 'utf8')).toBe('research\n')
  })
})

describe('copy and lock metadata', () => {
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
    expect(cli(f.home, '--map', mapping, '--execute').status).toBe(0)
    expect(cli(f.home, '--retire-aliases').status).toBe(0)
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

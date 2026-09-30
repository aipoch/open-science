import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tar from 'tar'
import * as fsPromises from 'node:fs/promises'
import { RUNTIME_SCHEMA_TABLE_DDLS } from '../database/generated/runtime-schema'
import * as diagnosticProjection from './projection'
import { runSessionDiagnosticWorker } from './collector'
import type { SessionDiagnosticWorkerInput } from '../../shared/session-diagnostics'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(): Promise<SessionDiagnosticWorkerInput> {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-test-'))
  roots.push(root)
  const input: SessionDiagnosticWorkerInput = {
    action: 'export',
    projectId: 'project',
    sessionId: 'session',
    dataRoot: join(root, 'data'),
    configRoot: join(root, 'config'),
    logPath: join(root, 'logs/main.log'),
    directory: join(root, 'output'),
    appVersion: 'test'
  }
  for (const path of [
    join(input.configRoot, 'sessions/project'),
    input.configRoot,
    join(root, 'logs'),
    input.directory!
  ])
    await mkdir(path, { recursive: true })
  return input
}
const sessionPath = (input: SessionDiagnosticWorkerInput): string =>
  join(input.configRoot, 'sessions/project/session.json')
describe('session diagnostics isolated collector', () => {
  it('exports selected diagnostic projections and leaves source bytes unchanged', async () => {
    const input = await fixture()
    const raw = JSON.stringify({
      id: 'session',
      apiKey: 'top-secret',
      inputTokens: 123,
      nested: JSON.stringify({ password: 'hidden' }),
      text: '-----BEGIN PRIVATE KEY-----\nPRIVATEBYTES\n-----END PRIVATE KEY-----',
      url: 'https://example.com/?key=secretquery'
    })
    await writeFile(sessionPath(input), raw)
    await writeFile(input.logPath!, 'unselected log evidence')
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['session'],
      includeExecutionCode: true
    })
    expect(result.kind).toBe('archive')
    const extracted = join(input.directory!, 'extracted')
    await mkdir(extracted)
    await tar.extract({ file: join(input.directory!, 'archive.tar.gz'), cwd: extracted })
    const exported = await readFile(join(extracted, 'session.json'), 'utf8')
    for (const secret of ['top-secret', 'hidden', 'PRIVATEBYTES', 'secretquery'])
      expect(exported).not.toContain(secret)
    expect(JSON.parse(exported).session.inputTokens).toBe(123)
    expect(JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))).toMatchObject({
      includeExecutionCode: false,
      notebookCoverage: { selectedSources: 0 }
    })
    expect(await readFile(sessionPath(input), 'utf8')).toBe(raw)
    expect((await readdir(extracted)).sort()).toEqual([
      'README.txt',
      'export.log',
      'manifest.json',
      'session.json'
    ])
  })
  it('exports fixed Notebook root and frame histories plus a stored-settings environment projection', async () => {
    const input = await fixture()
    const notebookRoot = join(input.dataRoot, 'notebooks/project/session')
    await mkdir(join(notebookRoot, 'frames/frame-1'), { recursive: true })
    const document = (runId: string): Record<string, unknown> => ({
      projectId: 'project',
      sessionId: 'session',
      runs: [{ runId, script: 'SECRET_SCRIPT', text: { stdout: 'SECRET_STDOUT' } }]
    })
    await writeFile(join(notebookRoot, 'run.json'), JSON.stringify(document('root-run')))
    await writeFile(
      join(notebookRoot, 'frames/frame-1/run.json'),
      JSON.stringify(document('frame-run'))
    )
    await writeFile(
      join(input.configRoot, 'settings.json'),
      JSON.stringify({ agentFrameworkId: 'codex', activeModel: 'model-1', apiKey: 'SECRET_KEY' })
    )
    const inspected = await runSessionDiagnosticWorker({ ...input, action: 'inspect' })
    expect(inspected.kind).toBe('inspection')
    if (inspected.kind === 'inspection')
      expect(inspected.inspection.items.map((item) => item.id)).toEqual(
        expect.arrayContaining(['environment', 'notebook', 'notebook:frame:frame-1'])
      )
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['environment', 'notebook', 'notebook:frame:frame-1']
    })
    expect(result).toMatchObject({ kind: 'archive', partial: false })
    const rootRun = JSON.parse(
      await readFile(join(input.directory!, 'content/notebook/run.json'), 'utf8')
    )
    const frameRun = JSON.parse(
      await readFile(join(input.directory!, 'content/notebook/frames/frame-1/run.json'), 'utf8')
    )
    const environment = JSON.parse(
      await readFile(join(input.directory!, 'content/environment.json'), 'utf8')
    )
    expect(rootRun.runs[0].runId).toBe('root-run')
    expect(frameRun.runs[0].runId).toBe('frame-run')
    expect(environment.storedDefaults.frameworkId).toBe('codex')
    const exported = JSON.stringify([rootRun, frameRun, environment])
    for (const secret of ['SECRET_SCRIPT', 'SECRET_STDOUT', 'SECRET_KEY'])
      expect(exported).not.toContain(secret)
  })
  it('exports opted-in scripts only in selected Notebook runs and records coverage', async () => {
    const input = await fixture()
    const notebookRoot = join(input.dataRoot, 'notebooks/project/session')
    await mkdir(join(notebookRoot, 'frames/frame-1'), { recursive: true })
    await mkdir(join(notebookRoot, 'frames/frame-2'), { recursive: true })
    const document = (runs: Record<string, unknown>[]): string =>
      JSON.stringify({ projectId: 'project', sessionId: 'session', runs })
    await writeFile(join(notebookRoot, 'run.json'), document([{ script: 'root code' }]))
    await writeFile(
      join(notebookRoot, 'frames/frame-1/run.json'),
      document([{ script: 'frame code' }, {}, { script: 'x'.repeat(16_100) }])
    )
    await writeFile(
      join(notebookRoot, 'frames/frame-2/run.json'),
      document([{ runId: 'unselected', script: 'SECRET_UNSELECTED' }])
    )
    await writeFile(sessionPath(input), JSON.stringify({ id: 'session', script: 'SECRET_SESSION' }))
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['session', 'notebook', 'notebook:frame:frame-1'],
      includeExecutionCode: true
    })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    const rootRun = JSON.parse(
      await readFile(join(input.directory!, 'content/notebook/run.json'), 'utf8')
    )
    const frameRun = JSON.parse(
      await readFile(join(input.directory!, 'content/notebook/frames/frame-1/run.json'), 'utf8')
    )
    const manifest = JSON.parse(
      await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')
    )
    expect(rootRun.runs[0].script).toBe('root code')
    expect(frameRun.runs[0].script).toBe('frame code')
    expect(manifest).toMatchObject({
      includeExecutionCode: true,
      notebookCoverage: {
        selectedSources: 2,
        projectedSources: 2,
        included: 2,
        missing: 1,
        truncated: 1
      }
    })
    expect(await readFile(join(input.directory!, 'content/README.txt'), 'utf8')).toContain(
      'scripts may still contain research content, private paths or credentials'
    )
    expect(await readdir(join(input.directory!, 'content/notebook/frames'))).toEqual(['frame-1'])
    expect(await readFile(join(input.directory!, 'content/session.json'), 'utf8')).not.toContain(
      'SECRET_SESSION'
    )
  })
  it('counts only delivered Notebook code when one selected file cannot be written', async () => {
    const input = await fixture()
    const notebookRoot = join(input.dataRoot, 'notebooks/project/session')
    await mkdir(join(notebookRoot, 'frames/frame-1'), { recursive: true })
    const document = (script: string): string =>
      JSON.stringify({ projectId: 'project', sessionId: 'session', runs: [{ script }] })
    await writeFile(join(notebookRoot, 'run.json'), document('root code'))
    await writeFile(join(notebookRoot, 'frames/frame-1/run.json'), document('frame code'))
    const original = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (String(args[0]).endsWith('/content/notebook/run.json'))
          throw new Error('injected output failure')
        return original(...args)
      }
    )
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['notebook', 'notebook:frame:frame-1'],
      includeExecutionCode: true
    })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    const manifest = JSON.parse(
      await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')
    )
    expect(manifest.notebookCoverage).toMatchObject({
      selectedSources: 2,
      projectedSources: 1,
      included: 1,
      missing: 0,
      truncated: 0
    })
    expect(
      manifest.items.find((item: { id: string }) => item.id === 'notebook')
    ).not.toHaveProperty('executionCodeCoverage')
    expect(
      manifest.items.find((item: { id: string }) => item.id === 'notebook:frame:frame-1')
    ).toMatchObject({ executionCodeCoverage: { included: 1, missing: 0, truncated: 0 } })
    expect(
      JSON.parse(
        await readFile(join(input.directory!, 'content/notebook/frames/frame-1/run.json'), 'utf8')
      ).runs[0]
    ).toMatchObject({ script: 'frame code', scriptStatus: 'included' })
  })
  it.each(['manifest.json', 'README.txt', 'export.log'])(
    'keeps the archive and returned report when %s cannot be written',
    async (failedName) => {
      const input = await fixture()
      await writeFile(sessionPath(input), '{"id":"session"}')
      const original = fsPromises.writeFile
      vi.spyOn(fsPromises, 'writeFile').mockImplementation(
        async (...args: Parameters<typeof original>) => {
          if (String(args[0]).endsWith(`/content/${failedName}`))
            throw new Error('injected output failure')
          return original(...args)
        }
      )
      const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
      expect(result).toMatchObject({ kind: 'archive', partial: true })
      if (result.kind !== 'archive') return
      expect(result.report).toContain(`Diagnostic output ${failedName} failed`)
      const names: string[] = []
      await tar.list({
        file: join(input.directory!, 'archive.tar.gz'),
        onReadEntry: (entry) => {
          names.push(entry.path)
        }
      })
      expect(names).toContain('session.json')
      expect(names).not.toContain(failedName)
      if (failedName !== 'manifest.json')
        expect(await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')).toContain(
          failedName
        )
      if (failedName !== 'export.log')
        expect(await readFile(join(input.directory!, 'content/export.log'), 'utf8')).toContain(
          failedName
        )
    }
  )
  it('continues later database tables after one table output fails', async () => {
    const input = await fixture()
    const db = new DatabaseSync(join(input.configRoot, 'open-science.db'))
    for (const ddl of RUNTIME_SCHEMA_TABLE_DDLS) db.exec(ddl)
    db.close()
    const original = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (String(args[0]).endsWith('/content/db/Session.json'))
          throw new Error('injected table failure')
        return original(...args)
      }
    )
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['database'] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    expect(await readFile(join(input.directory!, 'content/db/SessionRun.json'), 'utf8')).toBe('[]')
    expect(await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')).toContain(
      'db/Session.json'
    )
  })
  it('keeps other selected sources after one projection throws', async () => {
    const input = await fixture()
    await writeFile(sessionPath(input), '{"id":"session"}')
    await writeFile(
      input.logPath!,
      JSON.stringify({
        t: '2026-09-21T00:00:00.000Z',
        level: 'info',
        scope: 'unlisted-scope',
        msg: 'safe diagnostic event'
      }) + '\n'
    )
    vi.spyOn(diagnosticProjection, 'projectDiagnosticSession').mockImplementation(() => {
      throw new Error('injected projection failure')
    })
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['session', 'log:main.log']
    })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    expect(await readFile(join(input.directory!, 'content/logs/main.log'), 'utf8')).toContain(
      'safe diagnostic event'
    )
    expect(await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')).toContain(
      '"status": "failed"'
    )
  })
  it('returns a partial empty archive and failure report when all content writes fail', async () => {
    const input = await fixture()
    await writeFile(sessionPath(input), '{"id":"session"}')
    const original = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (String(args[0]).includes('/content/')) throw new Error('injected content write failure')
        return original(...args)
      }
    )
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    if (result.kind !== 'archive') return
    expect(result.report).toContain('session.json failed')
    expect(result.report).toContain('manifest.json failed')
    const names: string[] = []
    await tar.list({
      file: join(input.directory!, 'archive.tar.gz'),
      onReadEntry: (entry) => {
        names.push(entry.path)
      }
    })
    expect(names).toEqual([])
  })
  it('exports redacted sensitive evidence and explicitly selected original files', async () => {
    const input = await fixture()
    const sourceKey = 'objects/matched.bin'
    const source = join(input.dataRoot, sourceKey)
    const bytes = Buffer.from([0, 255, 1, 2])
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, bytes)
    input.sensitiveContent = {
      occurredAt: '2026-09-23T00:00:00.000Z',
      evidence: [
        {
          location: 'objects/matched.bin @4',
          offset: 4,
          rule: 'assignment',
          matchLength: 16,
          label: 'token',
          leftBoundary: 'whitespace',
          rightBoundary: 'punctuation',
          context: 'token=[redacted]',
          valueLength: 16,
          valueHash: 'a'.repeat(64),
          sourceStorageKey: sourceKey
        }
      ]
    }
    const inspection = await runSessionDiagnosticWorker({ ...input, action: 'inspect' })
    expect(inspection).toMatchObject({ kind: 'inspection' })
    if (inspection.kind !== 'inspection') return
    expect(inspection.inspection.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sensitive-evidence', available: true }),
        expect.objectContaining({
          id: 'sensitive-file:0',
          available: true,
          sizeBytes: bytes.length
        })
      ])
    )
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['sensitive-evidence', 'sensitive-file:0']
    })
    expect(result).toMatchObject({ kind: 'archive', partial: false })
    expect(
      JSON.parse(
        await readFile(join(input.directory!, 'content/sensitive-content/evidence.json'), 'utf8')
      )
    ).toEqual(input.sensitiveContent)
    expect(
      await readFile(join(input.directory!, 'content/sensitive-content/files/0-matched.bin'))
    ).toEqual(bytes)
  })
  it('uses the retained package source descriptor instead of a colliding data-root key', async () => {
    const input = await fixture()
    const sourceKey = 'objects/matched.bin'
    const retainedRoot = join(input.configRoot, 'artifacts/project/session/.session-package/source')
    const retained = Buffer.from('retained package bytes')
    const lookalike = join(input.dataRoot, sourceKey)
    await mkdir(join(retainedRoot, 'objects'), { recursive: true })
    await mkdir(dirname(lookalike), { recursive: true })
    await writeFile(join(retainedRoot, sourceKey), retained)
    await writeFile(lookalike, 'unrelated local bytes')
    input.sensitiveContent = {
      occurredAt: '2026-09-23T00:00:00.000Z',
      evidence: [
        {
          location: `${sourceKey} @4`,
          offset: 4,
          rule: 'assignment',
          matchLength: 16,
          leftBoundary: 'whitespace',
          rightBoundary: 'punctuation',
          context: 'token=[redacted]',
          valueLength: 16,
          valueHash: 'a'.repeat(64),
          sourceStorageKey: sourceKey
        }
      ]
    }
    input.sensitiveContentSources = [
      {
        storageKey: sourceKey,
        root: retainedRoot,
        relativePath: sourceKey,
        checksum: createHash('sha256').update(retained).digest('hex')
      }
    ]
    const inspection = await runSessionDiagnosticWorker({ ...input, action: 'inspect' })
    expect(inspection).toMatchObject({ kind: 'inspection' })
    if (inspection.kind !== 'inspection') return
    expect(inspection.inspection.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sensitive-file:0',
          available: true,
          sizeBytes: retained.length
        })
      ])
    )
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['sensitive-file:0']
    })
    expect(result).toMatchObject({ kind: 'archive', partial: false })
    expect(
      await readFile(join(input.directory!, 'content/sensitive-content/files/0-matched.bin'))
    ).toEqual(retained)
  })
  it('rejects ancestor symlinks and permits oversized metadata sources during inspection', async () => {
    const input = await fixture()
    await rm(join(input.configRoot, 'sessions/project'), { recursive: true })
    await symlink(input.configRoot, join(input.configRoot, 'sessions/project'))
    await writeFile(join(input.configRoot, 'session.json'), '{}')
    await writeFile(input.logPath!, Buffer.alloc(8 * 1024 * 1024 + 1))
    const result = await runSessionDiagnosticWorker({ ...input, action: 'inspect' })
    expect(result.kind).toBe('inspection')
    if (result.kind !== 'inspection') return
    expect(result.inspection.items.find((item) => item.id === 'session')?.available).toBe(false)
    expect(result.inspection.items.find((item) => item.id === 'log:main.log')?.available).toBe(true)
  })
  it('queries selected session rows read-only without copying the database', async () => {
    const input = await fixture()
    const path = join(input.configRoot, 'open-science.db')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA journal_mode=WAL')
      for (const ddl of RUNTIME_SCHEMA_TABLE_DDLS) db.exec(ddl)
      db.exec("INSERT INTO Project(id,name,updatedAt) VALUES ('project','Project',1)")
      db.exec(
        "INSERT INTO Session(id,projectId,number,title,status,presentedStatus,createdAtMs,updatedAtMs) VALUES ('session','project',1,'selected','idle','idle',1,1), ('other','project',2,'exclude','idle','idle',1,1)"
      )
      const names = (await readdir(input.configRoot)).filter((name) => name !== 'sessions')
      const before = await Promise.all(names.map((name) => readFile(join(input.configRoot, name))))
      const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['database'] })
      expect(result.kind).toBe('archive')
      const rows = JSON.parse(
        await readFile(join(input.directory!, 'content/db/Session.json'), 'utf8')
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('session')
      expect((await readdir(input.configRoot)).filter((name) => name !== 'sessions')).toEqual(names)
      for (const [index, name] of names.entries()) {
        // SQLite may update shared-memory reader coordination; persisted DB/WAL remain unchanged.
        if (!name.endsWith('-shm'))
          expect(await readFile(join(input.configRoot, name))).toEqual(before[index])
      }
      expect(await readdir(input.directory!)).not.toContain('private-database')
    } finally {
      db.close()
    }
  })
  it('does not read DB contents during inspection and reports query failures on export', async () => {
    const input = await fixture()
    const path = join(input.configRoot, 'open-science.db')
    await writeFile(path, 'not a database')
    const inspection = await runSessionDiagnosticWorker({ ...input, action: 'inspect' })
    expect(inspection.kind).toBe('inspection')
    if (inspection.kind === 'inspection')
      expect(inspection.inspection.items.find((item) => item.id === 'database')).toMatchObject({
        available: true
      })
    expect(await readdir(input.directory!)).toEqual([])
    const corruptExport = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['database']
    })
    expect(corruptExport).toMatchObject({ kind: 'archive', partial: true })
    await rm(join(input.directory!, 'content'), { recursive: true })
    await rm(join(input.directory!, 'archive.tar.gz'))
    await rm(path)
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE Session (id TEXT, projectId TEXT)')
    db.close()
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['database'] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    expect(await readFile(join(input.directory!, 'content/export.log'), 'utf8')).toContain(
      'Database table query failed'
    )
    const manifest = JSON.parse(
      await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')
    )
    expect(manifest.items.find((item: { id: string }) => item.id === 'session')).toMatchObject({
      selected: false,
      status: 'missing'
    })
  })
  it('refuses a hot rollback journal without touching it', async () => {
    const input = await fixture()
    const path = join(input.configRoot, 'open-science.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE Session (id TEXT, projectId TEXT)')
    db.close()
    await writeFile(`${path}-journal`, 'hot-journal')
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['database'] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    expect(await readFile(`${path}-journal`, 'utf8')).toBe('hot-journal')
    expect(await readdir(input.directory!)).not.toContain('private-database')
  })
  it('omits arbitrary collection error text from manifest, export log and returned report', async () => {
    const input = await fixture()
    await writeFile(sessionPath(input), '{}')
    const original = fsPromises.open
    vi.spyOn(fsPromises, 'open').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (args[0] === sessionPath(input))
          throw new Error('password=diagnostic-secret; https://example.com/?key=url-secret')
        return original(...args)
      }
    )
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    const text =
      JSON.stringify(result) +
      (await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')) +
      (await readFile(join(input.directory!, 'content/export.log'), 'utf8'))
    expect(text).not.toContain('diagnostic-secret')
    expect(text).not.toContain('url-secret')
  })
  it.each(['append', 'rotate', 'truncate'])(
    'retains initial log evidence during %s',
    async (change) => {
      const input = await fixture()
      await writeFile(
        input.logPath!,
        JSON.stringify({
          t: '2026-09-21T00:00:00.000Z',
          level: 'info',
          scope: 'session',
          msg: 'initial event'
        }) + '\n'
      )
      const original = fsPromises.open
      vi.spyOn(fsPromises, 'open').mockImplementation(
        async (...args: Parameters<typeof original>) => {
          const handle = await original(...args)
          if (args[0] === input.logPath) {
            const read = handle.read.bind(handle)
            handle.read = (async (...readArgs: Parameters<typeof read>) => {
              const result = await read(...readArgs)
              if (change === 'append') await fsPromises.appendFile(input.logPath!, 'later log\n')
              if (change === 'rotate') {
                await fsPromises.rename(input.logPath!, `${input.logPath!}.old`)
                await writeFile(input.logPath!, 'new log\n')
              }
              if (change === 'truncate') await fsPromises.truncate(input.logPath!, 0)
              return result
            }) as typeof handle.read
          }
          return handle
        }
      )
      const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['log:main.log'] })
      expect(result).toMatchObject({ kind: 'archive', partial: change !== 'append' })
      expect(await readFile(join(input.directory!, 'content/logs/main.log'), 'utf8')).toContain(
        'session'
      )
      if (change === 'append') expect(await readFile(input.logPath!, 'utf8')).toContain('later log')
    }
  )
  it('omits nested JSONL payloads, paths, private keys and credential arrays', async () => {
    const input = await fixture()
    const record = {
      t: '2026-09-21T00:00:00.000Z',
      level: 'error',
      scope: 'session',
      data: {
        inputTokens: 123,
        payload: JSON.stringify({
          password: 'nested-secret',
          auth: ['array-secret'],
          path: `${input.configRoot}/private-file`,
          keyText: '-----BEGIN PRIVATE KEY-----\nPEMSECRET\n-----END PRIVATE KEY-----'
        })
      },
      inputTokens: 123
    }
    const raw =
      JSON.stringify(record) +
      '\n' +
      '-----BEGIN PRIVATE KEY-----\nRAWPEMSECRET\n-----END PRIVATE KEY-----\n'
    await writeFile(input.logPath!, raw)
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['log:main.log'] })
    expect(result.kind).toBe('archive')
    const log = await readFile(join(input.directory!, 'content/logs/main.log'), 'utf8')
    for (const secret of [
      'nested-secret',
      'array-secret',
      'PEMSECRET',
      'RAWPEMSECRET',
      input.configRoot
    ])
      expect(log).not.toContain(secret)
    const first = JSON.parse(log.split('\n')[0])
    expect(first.diagnostics.inputTokens).toBe(123)
    expect(first.data).toBeUndefined()
    expect(await readFile(input.logPath!, 'utf8')).toBe(raw)
  })
  it('reads production session evidence from configRoot and ignores dataRoot lookalikes', async () => {
    const input = await fixture()
    await mkdir(join(input.dataRoot, 'sessions/project'), { recursive: true })
    await writeFile(join(input.dataRoot, 'sessions/project/session.json'), '{"wrongSource":true}')
    await writeFile(sessionPath(input), '{"id":"session","revision":7}')
    await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    expect(
      JSON.parse(await readFile(join(input.directory!, 'content/session.json'), 'utf8'))
    ).toMatchObject({ session: { revision: 7 } })
  })
  it('accepts the historical v1 session envelope with a matching identity', async () => {
    const input = await fixture()
    await writeFile(
      sessionPath(input),
      JSON.stringify({ version: 1, session: { id: 'session', projectId: 'project', revision: 4 } })
    )
    expect(
      await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    ).toMatchObject({ kind: 'archive', partial: false })
    const projected = JSON.parse(
      await readFile(join(input.directory!, 'content/session.json'), 'utf8')
    )
    expect(projected.session).toMatchObject({ id: 'session', projectId: 'project', revision: 4 })
  })
  it.each([
    ['flat wrong session', { id: 'other', projectId: 'project' }, 'session', 'session.json'],
    ['flat wrong project', { id: 'session', projectId: 'other' }, 'session', 'session.json'],
    [
      'envelope wrong session',
      { version: 2, session: { id: 'other', projectId: 'project' } },
      'session',
      'session.json'
    ],
    [
      'envelope wrong project',
      { version: 2, session: { id: 'session', projectId: 'other' } },
      'session',
      'session.json'
    ],
    [
      'quarantine missing identity',
      { version: 2, session: { projectId: 'project' } },
      'invalid:session.json.invalid-1-2',
      'session-invalid/session.json.invalid-1-2.txt'
    ]
  ])('retains metadata only for %s', async (_label, document, selectedId, output) => {
    const input = await fixture()
    const sourcePath =
      selectedId === 'session'
        ? sessionPath(input)
        : join(input.configRoot, 'sessions/project/session.json.invalid-1-2')
    await writeFile(sourcePath, JSON.stringify({ ...document, content: 'PRIVATE_OTHER_SESSION' }))
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: [selectedId] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    const metadata = JSON.parse(
      await readFile(join(input.directory!, `content/${output}.metadata.json`), 'utf8')
    )
    expect(metadata.omissionReason).toBe('identity-mismatch-or-missing')
    await expect(readFile(join(input.directory!, `content/${output}`), 'utf8')).rejects.toThrow()
    const manifest = JSON.parse(
      await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')
    )
    expect(manifest.items.find((item: { id: string }) => item.id === selectedId).status).toBe(
      'partial'
    )
    expect(JSON.stringify(manifest)).not.toContain('PRIVATE_OTHER_SESSION')
  })
  it('counts retained log records whose event text is missing', async () => {
    const input = await fixture()
    await writeFile(
      input.logPath!,
      [
        JSON.stringify({ t: '2026-09-21T00:00:00.000Z', level: 'info', scope: 'unknown-source' }),
        JSON.stringify({
          t: '2026-09-21T00:00:01.000Z',
          level: 'info',
          scope: 'unknown-source',
          msg: 'diagnostic event'
        })
      ].join('\n') + '\n'
    )
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['log:main.log'] })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    const metadata = JSON.parse(
      await readFile(join(input.directory!, 'content/logs/main.log.metadata.json'), 'utf8')
    )
    expect(metadata).toMatchObject({
      retainedRecords: 2,
      omittedLines: 0,
      missingEventTextRecords: 1
    })
    const manifest = JSON.parse(
      await readFile(join(input.directory!, 'content/manifest.json'), 'utf8')
    )
    expect(manifest.items.find((item: { id: string }) => item.id === 'log:main.log')).toMatchObject(
      {
        status: 'partial',
        sourceMetadata: { missingEventTextRecords: 1 }
      }
    )
  })
  it.each(['malformed', 'oversize'])(
    'retains metadata for %s session files despite a missing database',
    async (kind) => {
      const input = await fixture()
      const raw =
        kind === 'malformed'
          ? '{"credentials":["PRIVATE_A","PRIVATE_B"],"broken":'
          : 'PRIVATE_A'.repeat(1024 * 1024)
      await writeFile(sessionPath(input), raw)
      const inspection = await runSessionDiagnosticWorker({ ...input, action: 'inspect' })
      expect(inspection).toMatchObject({
        kind: 'inspection',
        inspection: {
          items: expect.arrayContaining([
            expect.objectContaining({ id: 'session', available: true })
          ])
        }
      })
      expect(
        await runSessionDiagnosticWorker({ ...input, selectedItems: ['session', 'database'] })
      ).toMatchObject({ kind: 'archive', partial: true })
      const extracted = join(input.directory!, 'extracted')
      await mkdir(extracted)
      await tar.extract({ file: join(input.directory!, 'archive.tar.gz'), cwd: extracted })
      const summary = await readFile(join(extracted, 'session.json.metadata.json'), 'utf8')
      expect(summary).not.toContain('PRIVATE_')
      expect(JSON.parse(summary)).toMatchObject({
        sizeBytes: Buffer.byteLength(raw),
        omissionReason: kind === 'malformed' ? 'invalid-json' : 'source-size-limit'
      })
      expect(await readFile(sessionPath(input), 'utf8')).toBe(raw)
    }
  )
  it('marks bounded session arrays partial and records exact omission counts', async () => {
    const input = await fixture()
    const messages = Array.from({ length: 1001 }, (_, index) => ({
      id: `message-${index}`,
      status: 'complete',
      text: 'PRIVATE_BODY'
    }))
    const raw = JSON.stringify({ version: 2, session: { id: 'session', messages } })
    await writeFile(sessionPath(input), raw)
    expect(
      await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    ).toMatchObject({ kind: 'archive', partial: true })
    const extracted = join(input.directory!, 'truncation-extracted')
    await mkdir(extracted)
    await tar.extract({ file: join(input.directory!, 'archive.tar.gz'), cwd: extracted })
    const projection = JSON.parse(await readFile(join(extracted, 'session.json'), 'utf8'))
    expect(projection.arrayCounts.messages).toEqual({ source: 1001, retained: 1000, omitted: 1 })
    expect(projection.session.messages[0].id).toBe('message-1')
    expect(projection.session.messages).toHaveLength(1000)
    expect(JSON.stringify(projection)).not.toContain('PRIVATE_BODY')
    const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))
    expect(manifest.items.find((item: { id: string }) => item.id === 'session')).toMatchObject({
      status: 'truncated',
      arrayCounts: projection.arrayCounts
    })
    expect(await readFile(join(extracted, 'export.log'), 'utf8')).toContain(
      'Session arrays truncated'
    )
    expect(await readFile(sessionPath(input), 'utf8')).toBe(raw)
  })
})

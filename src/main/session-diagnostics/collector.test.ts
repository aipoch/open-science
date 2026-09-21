import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as tar from 'tar'
import * as fsPromises from 'node:fs/promises'
import { RUNTIME_SCHEMA_TABLE_DDLS } from '../database/generated/runtime-schema'
import { readDiagnosticDatabase } from './database'
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
    const result = await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    expect(result.kind).toBe('archive')
    const exported = await readFile(join(input.directory!, 'content/session.json'), 'utf8')
    for (const secret of ['top-secret', 'hidden', 'PRIVATEBYTES', 'secretquery'])
      expect(exported).not.toContain(secret)
    expect(JSON.parse(exported).session.inputTokens).toBe(123)
    expect(await readFile(sessionPath(input), 'utf8')).toBe(raw)
    const names: string[] = []
    await tar.list({
      file: join(input.directory!, 'archive.tar.gz'),
      onReadEntry: (entry) => {
        names.push(entry.path)
      }
    })
    expect(names.sort()).toEqual(['README.txt', 'export.log', 'manifest.json', 'session.json'])
  })
  it('retains malformed JSON metadata and tolerates missing DB', async () => {
    const input = await fixture()
    await writeFile(sessionPath(input), '{"password":"do-not-leak", "broken":')
    const result = await runSessionDiagnosticWorker({
      ...input,
      selectedItems: ['session', 'database']
    })
    expect(result).toMatchObject({ kind: 'archive', partial: true })
    expect(
      await readFile(join(input.directory!, 'content/session.json.metadata.json'), 'utf8')
    ).not.toContain('do-not-leak')
    expect(await readFile(join(input.directory!, 'content/export.log'), 'utf8')).toContain(
      'Diagnostic source'
    )
    expect(await readdir(input.configRoot)).toEqual(['sessions'])
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
  it('all allowlisted queries match the current generated runtime schema', async () => {
    const input = await fixture()
    const path = join(input.configRoot, 'open-science.db')
    const db = new DatabaseSync(path)
    for (const ddl of RUNTIME_SCHEMA_TABLE_DDLS) db.exec(ddl)
    db.close()
    const results = [...readDiagnosticDatabase(path, input.projectId, input.sessionId)]
    expect(results.length).toBeGreaterThan(10)
    expect(results.filter((result) => result.error)).toEqual([])
    expect(
      results
        .filter((result) => result.table !== '_metadata')
        .every((result) => result.rows?.length === 0)
    ).toBe(true)
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
        JSON.stringify({ t: '2026-09-21T00:00:00.000Z', level: 'info', scope: 'session' }) + '\n'
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
    await writeFile(sessionPath(input), '{"revision":7}')
    await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
    expect(
      JSON.parse(await readFile(join(input.directory!, 'content/session.json'), 'utf8'))
    ).toMatchObject({ session: { revision: 7 } })
  })
  it('exports useful fixed projections without private text in the actual archive', async () => {
    const input = await fixture()
    const privateValue = 'PRIVATE_SENTINEL_DO_NOT_EXPORT'
    const raw = JSON.stringify({
      version: 2,
      session: {
        id: 'session',
        projectId: 'project',
        revision: 9,
        agentFrameworkId: 'codex',
        agentModel: 'gpt-5',
        agentBackendId: 'backend1',
        runtimeSessionAdmissions: [
          { executionId: 'execution1', promptMessageId: 'm1', runtimeSegmentId: 'segment1' }
        ],
        sessionDetailsGeneration: {
          status: 'failed',
          model: 'gpt-5',
          frameworkId: 'codex',
          queuedAt: 10,
          completedAt: 15,
          usage: { inputTokens: 5, outputTokens: 2 },
          title: privateValue
        },
        status: 'error',
        title: privateValue,
        cwd: privateValue,
        providerContinuityToken: privateValue,
        unknownField: privateValue,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            status: 'failed',
            content: privateValue,
            createdAt: 12,
            failedAt: 15,
            modelCallUsage: [{ id: 'call1', index: 1, inputTokens: 123, outputTokens: 45 }],
            uploads: [{ path: privateValue }],
            structuredOutputEvidence: { schema: privateValue }
          }
        ],
        activities: [
          {
            id: 'tool1',
            status: 'failed',
            rawInput: privateValue,
            rawOutput: privateValue,
            terminalExitCode: 2
          }
        ],
        conversationGraph: {
          schemaVersion: 1,
          rootFrameId: 'root',
          activeFrameId: 'root',
          frames: [{ id: 'root', kind: 'root', status: 'error', agentName: privateValue }],
          branches: [{ id: 'branch', agentFrameId: 'root', headMessageId: 'm1' }]
        }
      }
    })
    await writeFile(sessionPath(input), raw)
    await writeFile(
      input.logPath!,
      JSON.stringify({
        t: '2026-09-21T00:00:00.000Z',
        level: 'error',
        scope: 'session',
        msg: 'Session runtime deletion failed',
        data: {
          sessionId: 'session',
          code: 'EIO',
          inputTokens: 123,
          error: { message: privateValue, stack: privateValue },
          payload: privateValue
        }
      }) +
        '\n' +
        privateValue
    )
    await runSessionDiagnosticWorker({ ...input, selectedItems: ['session', 'log:main.log'] })
    const extracted = join(input.directory!, 'extracted')
    await mkdir(extracted)
    await tar.extract({ file: join(input.directory!, 'archive.tar.gz'), cwd: extracted })
    for (const name of [
      'session.json',
      'logs/main.log',
      'logs/main.log.metadata.json',
      'manifest.json',
      'export.log',
      'README.txt'
    ])
      expect(await readFile(join(extracted, name), 'utf8')).not.toContain(privateValue)
    const session = JSON.parse(await readFile(join(extracted, 'session.json'), 'utf8')).session
    expect(session).toMatchObject({
      revision: 9,
      agentFrameworkId: 'codex',
      agentModel: 'gpt-5',
      agentBackendId: 'backend1',
      runtimeSessionAdmissions: [{ executionId: 'execution1' }],
      sessionDetailsGeneration: {
        status: 'failed',
        frameworkId: 'codex',
        usage: { inputTokens: 5 }
      },
      status: 'error',
      messages: [
        { id: 'm1', failedAt: 15, modelCallUsage: [{ inputTokens: 123, outputTokens: 45 }] }
      ],
      activities: [{ terminalExitCode: 2 }]
    })
    expect(session.conversationGraph.branches[0].headMessageId).toBe('m1')
    const log = JSON.parse((await readFile(join(extracted, 'logs/main.log'), 'utf8')).trim())
    expect(log).toMatchObject({
      event: 'Session runtime deletion failed',
      diagnostics: { sessionId: 'session', code: 'EIO' }
    })
    expect(await readFile(sessionPath(input), 'utf8')).toBe(raw)
    expect(JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))).toMatchObject({
      projectionVersion: 2,
      arch: expect.any(String),
      osRelease: expect.any(String),
      nodeVersion: expect.any(String)
    })
  })
  it.each(['malformed', 'oversize'])('retains only metadata for %s session files', async (kind) => {
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
        items: expect.arrayContaining([expect.objectContaining({ id: 'session', available: true })])
      }
    })
    expect(
      await runSessionDiagnosticWorker({ ...input, selectedItems: ['session'] })
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
  })
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

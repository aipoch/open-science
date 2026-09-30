import { DatabaseSync } from 'node:sqlite'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { RUNTIME_SCHEMA_TABLE_DDLS } from '../database/generated/runtime-schema'
import { readDiagnosticDatabase } from './database'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): { path: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-db-'))
  roots.push(root)
  const path = join(root, 'test.db')
  const db = new DatabaseSync(path)
  for (const ddl of RUNTIME_SCHEMA_TABLE_DDLS) db.exec(ddl)
  db.exec('PRAGMA foreign_keys=OFF')
  return { path, db }
}
it('queries actual schema and ignores unrelated payloads even in a database larger than 64 MiB', () => {
  const { path, db } = fixture()
  db.exec(
    `CREATE TABLE UnrelatedSecret (payload BLOB); INSERT INTO UnrelatedSecret VALUES (zeroblob(68157440)); INSERT INTO SessionRun (sessionId, messageId, createdAtMs) VALUES ('s', 'm', 1); INSERT INTO SessionRun (sessionId, messageId, createdAtMs) VALUES ('other', 'hidden', 2)`
  )
  db.close()
  expect(statSync(path).size).toBeGreaterThan(64 * 1024 * 1024)
  const results = [...readDiagnosticDatabase(path, 'p', 's')]
  expect(results.filter((result) => result.error)).toEqual([])
  expect(results.find((result) => result.table === 'SessionRun')?.rows).toEqual([
    expect.objectContaining({ messageId: 'm' })
  ])
  expect(results.some((result) => result.table === 'UnrelatedSecret')).toBe(false)
})
it('does not hide orphan usage but rejects a parent belonging to another project', () => {
  const { path, db } = fixture()
  db.exec(
    `INSERT INTO SessionRun (sessionId, messageId, createdAtMs) VALUES ('s', 'z', 2); INSERT INTO SessionRun (sessionId, messageId, createdAtMs) VALUES ('s', 'a', 1)`
  )
  const messages = (): unknown[] | undefined =>
    [...readDiagnosticDatabase(path, 'p', 's')].find((result) => result.table === 'SessionRun')
      ?.rows
  expect(messages()).toEqual([
    expect.objectContaining({ messageId: 'z' }),
    expect.objectContaining({ messageId: 'a' })
  ])
  db.exec(
    `INSERT INTO Project (id, name, updatedAt) VALUES ('wrong', 'wrong', 1); INSERT INTO Session (id, number, projectId, title, status, presentedStatus, createdAtMs, updatedAtMs) VALUES ('s', 1, 'wrong', 'title', 'idle', 'idle', 1, 1)`
  )
  expect(messages()).toEqual([])
  db.close()
})
it('leaves database bytes unchanged and releases statements before yielding', () => {
  const { path, db } = fixture()
  db.close()
  const before = readFileSync(path)
  const entries = readdirSync(join(path, '..'))
  const iterator = readDiagnosticDatabase(path, 'p', 's')
  expect(iterator.next().value?.table).toBe('Session')
  const writer = new DatabaseSync(path)
  writer.exec('BEGIN EXCLUSIVE; CREATE TABLE WriterProbe (value TEXT); ROLLBACK')
  writer.close()
  iterator.return(undefined)
  expect(readFileSync(path)).toEqual(before)
  expect(readdirSync(join(path, '..'))).toEqual(entries)
})
it('rejects rollback recovery and symbolic-link sidecars without deleting them', () => {
  const { path, db } = fixture()
  db.close()
  writeFileSync(`${path}-journal`, 'hot')
  expect(() => [...readDiagnosticDatabase(path, 'p', 's')]).toThrow('recovery')
  expect(readFileSync(`${path}-journal`, 'utf8')).toBe('hot')
  rmSync(`${path}-journal`)
  symlinkSync(path, `${path}-wal`)
  expect(() => [...readDiagnosticDatabase(path, 'p', 's')]).toThrow('regular file')
})
it('filters associated job operations and findings without selecting credentials or encrypted payload', () => {
  const { path, db } = fixture()
  db.exec(
    `INSERT INTO ComputeJob (id, providerId, shape, sessionId, projectId, intent, command, commandHash) VALUES ('j', 'host', 'direct_ssh', 's', 'p', 'encrypted-intent', 'encrypted-command', 'hash'); INSERT INTO ComputeJobOperation (id, jobId, kind, claimToken, claimExpiresAt, updatedAt) VALUES ('op', 'j', 'cancel', 'credential-secret', 100, 1); INSERT INTO Review (id, projectId, sessionId, turnMessageId, updatedAt) VALUES ('r', 'p', 's', 'm', 1); INSERT INTO Finding (id, reviewId) VALUES ('f', 'r')`
  )
  db.close()
  const results = [...readDiagnosticDatabase(path, 'p', 's')]
  expect(results.find((result) => result.table === 'ComputeJobOperation')?.rows).toHaveLength(1)
  expect(results.find((result) => result.table === 'Finding')?.rows).toHaveLength(1)
  const text = JSON.stringify(results, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value
  )
  expect(text).not.toContain('credential-secret')
  expect(text).not.toContain('encrypted-command')
  expect(text).not.toContain('encrypted-intent')
})

it('retains recent records under row limits and reports the retained time range', () => {
  const { path, db } = fixture()
  const insert = db.prepare(
    'INSERT INTO SessionRun (sessionId, messageId, createdAtMs) VALUES (?, ?, ?)'
  )
  for (let index = 0; index < 1002; index++) insert.run('s', `message-${index}`, index)
  db.close()
  const result = [...readDiagnosticDatabase(path, 'p', 's')].find(
    (item) => item.table === 'SessionRun'
  )!
  expect(result.rows?.[0]).toMatchObject({ messageId: 'message-1001' })
  expect(result.metadata).toEqual({
    returnedCount: 1000,
    truncationReasons: ['row-limit'],
    timeRange: { column: 'createdAtMs', earliest: '2', latest: '1001' }
  })
  expect(result.truncated).toBe(true)
})

it('omits free text and protected errors while retaining presence and diagnostic attribution', () => {
  const { path, db } = fixture()
  db.exec(`
    INSERT INTO Project (id, name, updatedAt) VALUES ('p', 'PRIVATE project name', 1);
    INSERT INTO Session (id, number, projectId, title, status, presentedStatus, createdAtMs, updatedAtMs) VALUES ('s', 1, 'p', 'PRIVATE session title', 'idle', 'idle', 1, 1);
    INSERT INTO ComputeJob (id, providerId, shape, sessionId, projectId, intent, command, commandHash, lastPollError, harvestError, sensitiveDataEncrypted) VALUES ('j', 'host', 'direct_ssh', 's', 'p', 'PRIVATE intent', 'PRIVATE command', 'hash', 'PRIVATE ciphertext', 'PRIVATE error', 1);
    INSERT INTO Review (id, projectId, sessionId, turnMessageId, lifecycle, errorMessage, updatedAt) VALUES ('r', 'p', 's', 'm', 'error', 'password=PRIVATE-review', 1);
    INSERT INTO Finding (id, reviewId, claim, evidence, locator) VALUES ('f', 'r', 'PRIVATE claim', 'PRIVATE evidence', '{"path":"PRIVATE location"}');
  `)
  db.close()
  const results = [...readDiagnosticDatabase(path, 'p', 's')]
  const text = JSON.stringify(results, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value
  )
  expect(text).not.toContain('PRIVATE')
  expect(results.find((item) => item.table === 'ComputeJob')?.rows?.[0]).toMatchObject({
    lastPollErrorPresent: 1n,
    harvestErrorPresent: 1n,
    errorsProtected: 1n
  })
  expect(results.find((item) => item.table === 'Review')?.rows?.[0]).toMatchObject({
    errorMessagePresent: 1n,
    errorMessage: expect.stringContaining('[redacted]')
  })
})

it('scopes ArtifactVersion and finding dispositions through owning rows and retains safe relationships', () => {
  const { path, db } = fixture()
  db.exec(`
    INSERT INTO ArtifactLineage (id, projectId, sessionId, normalizedFilename, filename, createdAt, updatedAt) VALUES
      ('a-target', 'p', 's', 'a', 'secret-a', 1, 1), ('a-other', 'p', 'other', 'b', 'secret-b', 1, 1);
    INSERT INTO ArtifactVersion (id, artifactId, versionNumber, filename, contentStorageKey, sizeBytes, checksum, state, originKind, producerRunId, promptMessageId, agentFrameId, createdAt, updatedAt) VALUES
      ('v-target', 'a-target', 1, 'PRIVATE filename', 'PRIVATE-key-1', 12, 'hash', 'finalized', 'legacy', 'run-1', 'message-1', 'frame-1', 1, 1),
      ('v-other', 'a-other', 2, 'PRIVATE filename', 'PRIVATE-key-2', 12, 'hash', 'finalized', 'legacy', 'run-2', 'message-2', 'frame-2', 1, 1);
    INSERT INTO Review (id, projectId, sessionId, turnMessageId, scope, updatedAt) VALUES
      ('review-target', 'p', 's', 'message-1', '{"turnMessageId":"message-1","artifactVersionIds":["v-target"],"blocks":[{"text":"PRIVATE scope"}]}', 1),
      ('review-other', 'p', 'other', 'message-2', '{}', 1);
    INSERT INTO Finding (id, reviewId) VALUES ('finding-target', 'review-target'), ('finding-other', 'review-other');
    INSERT INTO ReviewFindingDisposition (id, sourceFindingId, causeReviewId, sequence, trigger, outcome, assessedArtifactVersionId) VALUES
      ('disposition-target', 'finding-target', 'review-target', 1, 'review_submission', 'resolved', 'v-target'),
      ('disposition-other', 'finding-other', 'review-other', 1, 'review_submission', 'resolved', 'v-other');
  `)
  db.close()
  const results = [...readDiagnosticDatabase(path, 'p', 's')]
  expect(results.find((item) => item.table === 'ArtifactVersion')?.rows).toEqual([
    expect.objectContaining({
      id: 'v-target',
      artifactId: 'a-target',
      producerRunId: 'run-1',
      promptMessageId: 'message-1'
    })
  ])
  expect(results.find((item) => item.table === 'ReviewFindingDisposition')?.rows).toEqual([
    expect.objectContaining({
      id: 'disposition-target',
      sourceFindingId: 'finding-target',
      assessedArtifactVersionId: 'v-target'
    })
  ])
  expect(results.find((item) => item.table === 'Review')?.rows?.[0]).toMatchObject({
    scopeMetadata: { turnMessageId: 'message-1', artifactVersionIds: ['v-target'], blockCount: 1 }
  })
  expect(
    JSON.stringify(results, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
  ).not.toContain('PRIVATE')
})

it('prioritizes unfinished jobs over newer successful jobs and recent turns over call index', () => {
  const { path, db } = fixture()
  db.exec(`
    INSERT INTO ComputeJob (id, providerId, shape, sessionId, projectId, intent, command, commandHash, status, createdAt) VALUES ('pending', 'host', 'direct_ssh', 's', 'p', '', '', 'a', 'queued', 1);
    INSERT INTO ComputeJob (id, providerId, shape, sessionId, projectId, intent, command, commandHash, status, createdAt) VALUES ('success', 'host', 'direct_ssh', 's', 'p', '', '', 'b', 'success', 2);
    INSERT INTO SessionTurnUsage (sessionId, messageId, completedAtMs, inputTokens, cacheTokens, outputTokens, isRootFrame) VALUES ('s', 'old', 1, 0, 0, 0, 1), ('s', 'recent', 2, 0, 0, 0, 1);
    INSERT INTO SessionModelCallUsage (sessionId, messageId, callId, callIndex, frameworkId, providerId, backendId, sourceInvocationId, inputTokens, cacheTokens, outputTokens) VALUES ('s', 'old', 'old-call', 0, 'framework', 'provider', 'backend', 'invocation', 1, 0, 1), ('s', 'recent', 'recent-call', 99, 'framework', 'provider', 'backend', 'invocation', 1, 0, 1);
  `)
  db.close()
  const results = [...readDiagnosticDatabase(path, 'p', 's')]
  expect(results.find((item) => item.table === 'ComputeJob')?.rows?.[0]).toMatchObject({
    id: 'pending'
  })
  expect(results.find((item) => item.table === 'SessionModelCallUsage')?.rows?.[0]).toMatchObject({
    callId: 'recent-call'
  })
})

it('exports available allowlisted columns for older schemas without reading unknown columns', () => {
  const { path, db } = fixture()
  db.exec('ALTER TABLE Session RENAME COLUMN presentedActivityAtMs TO privateUnknownColumn')
  db.close()
  const result = [...readDiagnosticDatabase(path, 'p', 's')].find(
    (item) => item.table === 'Session'
  )!
  expect(result.error).toBeUndefined()
  expect(result.metadata?.missingColumns).toEqual(['presentedActivityAtMs'])
  expect(JSON.stringify(result)).not.toContain('privateUnknownColumn')
})

it('prioritizes pending delivery over newer consumed delivery using actual lifecycle values', () => {
  const { path, db } = fixture()
  db.exec(
    `INSERT INTO BackgroundResultDelivery (id, sourceKind, sourceId, projectId, sessionId, state, createdAt, updatedAt) VALUES ('old-pending', 'local-run', 'run-1', 'p', 's', 'pending', 1, 1), ('new-consumed', 'local-run', 'run-2', 'p', 's', 'consumed', 2, 2)`
  )
  db.close()
  const result = [...readDiagnosticDatabase(path, 'p', 's')].find(
    (item) => item.table === 'BackgroundResultDelivery'
  )!
  expect(result.rows?.[0]).toMatchObject({ id: 'old-pending', state: 'pending' })
})

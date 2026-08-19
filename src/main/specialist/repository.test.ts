import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { SpecialistDocumentDegradedError, SpecialistRepository } from './repository'
import { sanitizeSpecialist } from './repository'
import type { StoredSpecialist } from './types'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'

// ---------------------------------------------------------------------------
// Sanitization unit tests
// ---------------------------------------------------------------------------

describe('sanitizeSpecialist', () => {
  const valid: StoredSpecialist = {
    id: 'uuid-1',
    name: 'RNA-seq Reviewer',
    description: 'Reviews differential expression.',
    systemPrompt: '',
    enabled: true,
    setupPending: false,
    capabilityMode: 'full',
    fullAccess: emptyFullAccessConfig(),
    selectedCapabilities: emptySelectedConfig(),
    revision: 1,
    packageVersion: '0.1.0',
    origin: 'local',
    ownedSkillIds: []
  }

  it('accepts a valid record', () => {
    expect(sanitizeSpecialist(valid)).toMatchObject({ id: 'uuid-1', name: 'RNA-seq Reviewer' })
  })

  it('drops record missing required id', () => {
    expect(sanitizeSpecialist({ ...valid, id: undefined })).toBeUndefined()
  })

  it('drops record missing required name', () => {
    expect(sanitizeSpecialist({ ...valid, name: undefined })).toBeUndefined()
  })

  it('preserves a stable public name alongside its displayName', () => {
    const legacy = { ...valid, name: 'RNA_SEQ_REVIEWER', displayName: 'RNA-seq Reviewer' }
    const result = sanitizeSpecialist(legacy)
    expect(result?.name).toBe('RNA_SEQ_REVIEWER')
    expect(result?.displayName).toBe('RNA-seq Reviewer')
  })

  it('falls back to legacy UPPER_SNAKE name when displayName is absent', () => {
    const legacy = { ...valid, name: 'RNA_SEQ_REVIEWER', displayName: undefined }
    const result = sanitizeSpecialist(legacy)
    expect(result?.name).toBe('RNA_SEQ_REVIEWER')
  })

  it('drops record with unknown capabilityMode', () => {
    expect(sanitizeSpecialist({ ...valid, capabilityMode: 'unknown' })).toBeUndefined()
  })

  it('preserves iconKey and colorKey when present', () => {
    const result = sanitizeSpecialist({ ...valid, iconKey: 'dna', colorKey: 'teal' })
    expect(result?.iconKey).toBe('dna')
    expect(result?.colorKey).toBe('teal')
  })

  it('omits iconKey/colorKey when absent', () => {
    const result = sanitizeSpecialist(valid)
    expect(result?.iconKey).toBeUndefined()
    expect(result?.colorKey).toBeUndefined()
  })

  it('defaults setupPending to false and preserves an imported pending state', () => {
    expect(sanitizeSpecialist(valid)?.setupPending).toBe(false)
    expect(sanitizeSpecialist({ ...valid, setupPending: true })?.setupPending).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Repository integration tests (real temp dir)
// ---------------------------------------------------------------------------

let tmpDir: string

const makeSpecialist = (overrides: Partial<StoredSpecialist> = {}): StoredSpecialist => ({
  id: randomUUID(),
  name: `Bot ${randomUUID().slice(0, 6)}`,
  description: 'A test specialist.',
  systemPrompt: '',
  enabled: true,
  setupPending: false,
  capabilityMode: 'full',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: emptySelectedConfig(),
  revision: 1,
  packageVersion: '0.1.0',
  origin: 'local',
  ownedSkillIds: [],
  ...overrides
})

beforeEach(async () => {
  tmpDir = join(tmpdir(), `specialist-repo-${randomUUID()}`)
  await mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('SpecialistRepository.getAll', () => {
  it('recovers a valid historical temp when the primary is missing', async () => {
    const specialist = makeSpecialist({ id: 'recovered-specialist' })
    await writeFile(
      join(tmpDir, 'specialists.json.1700000000000-1.tmp'),
      JSON.stringify({ version: 2, specialists: [specialist] }),
      'utf8'
    )

    await expect(new SpecialistRepository(tmpDir).getAll()).resolves.toMatchObject({
      specialists: [{ id: 'recovered-specialist' }]
    })
    await expect(readdir(tmpDir)).resolves.toEqual(['specialists.json'])
  })

  it('returns empty document on a fresh directory', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const doc = await repo.getAll()
    expect(doc.specialists).toHaveLength(0)
  })

  it('throws on corrupt JSON file instead of returning empty (prevents silent data loss)', async () => {
    await writeFile(join(tmpDir, 'specialists.json'), 'INVALID JSON', 'utf8')
    const repo = new SpecialistRepository(tmpDir)
    await expect(repo.getAll()).rejects.toThrow()
  })

  it('throws on non-ENOENT filesystem error instead of returning empty', async () => {
    // A directory at the expected file path makes readFile fail across supported platforms
    // without relying on POSIX permission bits, which Windows does not enforce.
    const filePath = join(tmpDir, 'specialists.json')
    await mkdir(filePath)
    const repo = new SpecialistRepository(tmpDir)
    await expect(repo.getAll()).rejects.toThrow()
  })

  it('migrates existing custom Specialists to local package metadata without changing identity or content', async () => {
    const legacy = makeSpecialist({
      id: 'existing-session-binding-id',
      name: 'LEGACY_SPECIALIST',
      systemPrompt: 'Keep these instructions unchanged.',
      revision: 7
    })
    await writeFile(
      join(tmpDir, 'specialists.json'),
      JSON.stringify({ version: 1, specialists: [legacy] }),
      'utf8'
    )

    const firstRead = await new SpecialistRepository(tmpDir).getAll()
    const secondRead = await new SpecialistRepository(tmpDir).getAll()

    expect(firstRead.version).toBe(2)
    expect(firstRead.specialists[0]).toEqual({
      ...legacy,
      displayName: legacy.name,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: []
    })
    expect(firstRead.specialists[0].importBaseline).toBeUndefined()
    expect(secondRead).toEqual(firstRead)
  })

  it('returns healthy records with safe diagnostics when one record is malformed', async () => {
    const valid = makeSpecialist({ id: 'valid-specialist' })
    const malformed = { ...makeSpecialist({ id: 'malformed-specialist' }), name: undefined }
    await writeFile(
      join(tmpDir, 'specialists.json'),
      JSON.stringify({ version: 2, specialists: [valid, malformed] }, null, 2),
      'utf8'
    )

    const snapshot = await new SpecialistRepository(tmpDir).getAllWithIntegrity()

    expect(snapshot.document.specialists.map((item) => item.id)).toEqual(['valid-specialist'])
    expect(snapshot.integrity).toEqual({
      status: 'degraded',
      issues: [{ code: 'record-invalid', recordIndex: 1 }]
    })
    expect(JSON.stringify(snapshot.integrity)).not.toContain('malformed-specialist')
  })
})

describe('SpecialistRepository.insert', () => {
  it('persists a new specialist', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist()
    await repo.insert(sp)
    const doc = await repo.getAll()
    expect(doc.specialists).toHaveLength(1)
    expect(doc.specialists[0].id).toBe(sp.id)
  })

  it('rejects duplicate id', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist()
    await repo.insert(sp)
    await expect(repo.insert(sp)).rejects.toThrow()
  })

  it('rejects duplicate name', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp1 = makeSpecialist({ name: 'SAME_NAME' })
    const sp2 = makeSpecialist({ name: 'SAME_NAME' })
    await repo.insert(sp1)
    await expect(repo.insert(sp2)).rejects.toThrow()
  })

  it('survives restart (data persists to disk)', async () => {
    const sp = makeSpecialist()
    await new SpecialistRepository(tmpDir).insert(sp)

    // New instance reads from disk.
    const doc = await new SpecialistRepository(tmpDir).getAll()
    expect(doc.specialists[0].id).toBe(sp.id)
  })
})

describe('SpecialistRepository.setEnabled', () => {
  it('toggles enabled state', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist({ enabled: true })
    await repo.insert(sp)
    await repo.setEnabled(sp.id, false)
    const doc = await repo.getAll()
    expect(doc.specialists[0].enabled).toBe(false)
  })

  it('throws for unknown id', async () => {
    const repo = new SpecialistRepository(tmpDir)
    await expect(repo.setEnabled('no-such-id', false)).rejects.toThrow()
  })

  it('rejects enabling an imported Specialist while setup is pending', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist({ enabled: false, setupPending: true, origin: 'imported' })
    await repo.insert(sp)

    await expect(repo.setEnabled(sp.id, true)).rejects.toThrow(/complete.*setup/i)
    expect((await repo.getAll()).specialists[0]).toMatchObject({
      enabled: false,
      setupPending: true,
      revision: sp.revision
    })
  })
})

describe('SpecialistRepository.update', () => {
  it('updates fields and increments revision', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist({ revision: 1 })
    await repo.insert(sp)
    await repo.update(sp.id, { displayName: 'Updated' }, 1)
    const doc = await repo.getAll()
    expect(doc.specialists[0].name).toBe(sp.name)
    expect(doc.specialists[0].displayName).toBe('Updated')
    expect(doc.specialists[0].revision).toBe(2)
  })

  it('rejects revision conflict', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist({ revision: 1 })
    await repo.insert(sp)
    await expect(repo.update(sp.id, { name: 'X' }, 99)).rejects.toThrow(/revision/i)
  })

  it('id remains immutable across update', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist({ id: 'fixed-id', revision: 1 })
    await repo.insert(sp)
    await repo.update(sp.id, { id: 'hacked-id' } as Partial<StoredSpecialist>, 1)
    const doc = await repo.getAll()
    expect(doc.specialists[0].id).toBe('fixed-id')
  })

  it('rejects any name change', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp1 = makeSpecialist({ name: 'NAME_ONE' })
    const sp2 = makeSpecialist({ name: 'NAME_TWO', revision: 1 })
    await repo.insert(sp1)
    await repo.insert(sp2)
    await expect(repo.update(sp2.id, { name: 'NAME_ONE' }, 1)).rejects.toThrow(
      'Specialist name is immutable.'
    )
  })
})

describe('SpecialistRepository — data-loss guard', () => {
  it('a read failure followed by an insert must NOT truncate the store', async () => {
    const repo = new SpecialistRepository(tmpDir)

    // Populate the store with two specialists via a healthy write.
    const sp1 = makeSpecialist()
    const sp2 = makeSpecialist()
    await repo.insert(sp1)
    await repo.insert(sp2)

    // Corrupt the file to simulate a truncated-write / disk-corruption scenario.
    await writeFile(join(tmpDir, 'specialists.json'), 'CORRUPTED', 'utf8')

    // The insert must reject (because getAll now throws) rather than silently
    // writing a document containing only the new specialist.
    const sp3 = makeSpecialist()
    await expect(repo.insert(sp3)).rejects.toThrow()

    // Restore the file to a valid state and confirm sp1 + sp2 are still there.
    await writeFile(
      join(tmpDir, 'specialists.json'),
      JSON.stringify({ version: 1, specialists: [sp1, sp2] }, null, 2),
      'utf8'
    )
    const doc = await repo.getAll()
    expect(doc.specialists).toHaveLength(2)
    expect(doc.specialists.map((s) => s.id)).toContain(sp1.id)
    expect(doc.specialists.map((s) => s.id)).toContain(sp2.id)
  })

  it('an unrelated mutation must not erase a malformed individual record from disk', async () => {
    const valid = makeSpecialist({ id: 'valid-specialist' })
    const malformed = { ...makeSpecialist({ id: 'malformed-specialist' }), name: undefined }
    const filePath = join(tmpDir, 'specialists.json')
    const original = JSON.stringify({ version: 2, specialists: [valid, malformed] }, null, 2)
    await writeFile(filePath, original, 'utf8')

    await expect(new SpecialistRepository(tmpDir).insert(makeSpecialist())).rejects.toBeInstanceOf(
      SpecialistDocumentDegradedError
    )

    expect(await readFile(filePath, 'utf8')).toBe(original)
  })

  it.each(['not-a-number', 0, -1, 1.5])(
    'blocks writes when revision %j would be normalized or retained as invalid',
    async (revision) => {
      const filePath = join(tmpDir, 'specialists.json')
      const original = JSON.stringify(
        { version: 2, specialists: [{ ...makeSpecialist(), revision }] },
        null,
        2
      )
      await writeFile(filePath, original, 'utf8')
      const repo = new SpecialistRepository(tmpDir)

      expect((await repo.getAllWithIntegrity()).integrity).toMatchObject({
        status: 'degraded',
        issues: [{ code: 'record-sanitized', recordIndex: 0 }]
      })
      await expect(repo.insert(makeSpecialist())).rejects.toBeInstanceOf(
        SpecialistDocumentDegradedError
      )
      expect(await readFile(filePath, 'utf8')).toBe(original)
    }
  )

  it.each(['update', 'setEnabled', 'delete', 'replaceAll', 'replaceAllIfUnchanged'] as const)(
    'blocks %s when any record would be lost',
    async (operation) => {
      const valid = makeSpecialist({ id: 'valid-specialist', revision: 1 })
      const raw = JSON.stringify(
        {
          version: 2,
          specialists: [valid, { ...makeSpecialist(), unexpectedFutureField: true }]
        },
        null,
        2
      )
      const filePath = join(tmpDir, 'specialists.json')
      await writeFile(filePath, raw, 'utf8')
      const repo = new SpecialistRepository(tmpDir)
      const expected = await repo.getAll()
      const replacement = {
        ...expected,
        specialists: [...expected.specialists, makeSpecialist()]
      }

      const run =
        operation === 'update'
          ? repo.update(valid.id, { description: 'changed' }, valid.revision)
          : operation === 'setEnabled'
            ? repo.setEnabled(valid.id, false)
            : operation === 'delete'
              ? repo.delete(valid.id, valid.revision)
              : operation === 'replaceAll'
                ? repo.replaceAll(replacement)
                : repo.replaceAllIfUnchanged(expected, replacement)

      await expect(run).rejects.toBeInstanceOf(SpecialistDocumentDegradedError)
      expect(await readFile(filePath, 'utf8')).toBe(raw)
    }
  )
})

describe('SpecialistRepository — old schema detection', () => {
  it('ignores old experimental schema with kebab-case agentId', async () => {
    const oldSchema = JSON.stringify({
      version: 1,
      specialists: [{ agentId: 'rna-seq-reviewer', name: 'RNA Reviewer', enabled: true }]
    })
    await writeFile(join(tmpDir, 'specialists.json'), oldSchema, 'utf8')
    const repo = new SpecialistRepository(tmpDir)
    const doc = await repo.getAll()
    expect(doc.specialists).toHaveLength(0)
    expect((await repo.getAllWithIntegrity()).integrity).toMatchObject({
      status: 'degraded',
      issues: [{ code: 'legacy-schema-unsupported' }]
    })
  })
})

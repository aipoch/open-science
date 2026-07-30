import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { SpecialistRepository } from './repository'
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
    capabilityMode: 'full',
    fullAccess: emptyFullAccessConfig(),
    selectedCapabilities: emptySelectedConfig(),
    revision: 1
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
  capabilityMode: 'full',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: emptySelectedConfig(),
  revision: 1,
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
    // Create the file then make it unreadable to trigger EACCES.
    // Skip on CI environments that run as root (root ignores chmod 000).
    const filePath = join(tmpDir, 'specialists.json')
    await writeFile(filePath, '{}', 'utf8')
    await chmod(filePath, 0o000)
    const repo = new SpecialistRepository(tmpDir)
    try {
      await expect(repo.getAll()).rejects.toThrow()
    } finally {
      await chmod(filePath, 0o644)
    }
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
})

describe('SpecialistRepository.update', () => {
  it('updates fields and increments revision', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp = makeSpecialist({ revision: 1 })
    await repo.insert(sp)
    await repo.update(sp.id, { name: 'Updated' }, 1)
    const doc = await repo.getAll()
    expect(doc.specialists[0].name).toBe('Updated')
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

  it('rejects name change to existing name', async () => {
    const repo = new SpecialistRepository(tmpDir)
    const sp1 = makeSpecialist({ name: 'NAME_ONE' })
    const sp2 = makeSpecialist({ name: 'NAME_TWO', revision: 1 })
    await repo.insert(sp1)
    await repo.insert(sp2)
    await expect(repo.update(sp2.id, { name: 'NAME_ONE' }, 1)).rejects.toThrow()
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
  })
})

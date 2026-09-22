import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase, verifyCurrentApplicationSchema } from './migration-service'

it('adds empty smart storage while preserving ordinary collections, membership and descriptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smart-migration-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    await client.literatureItem.create({
      data: { id: 'paper', itemType: 'journalArticle', title: 'Existing paper' }
    })
    await client.literatureCollection.create({
      data: {
        id: 'ordinary',
        name: 'Existing',
        nameKey: 'existing',
        description: 'Never interpret this as an AI rule',
        items: { create: { itemId: 'paper', sortOrder: 3 } }
      }
    })
    const before = await client.literatureCollection.findMany({ include: { items: true } })
    for (const table of [
      'ClassificationUsage',
      'LiteratureSmartRunItem',
      'LiteratureSmartRun',
      'LiteratureSmartRuleRevision',
      'LiteratureSmartOverride',
      'LiteratureSmartAssessment',
      'LiteratureSmartCollection'
    ])
      await client.$executeRawUnsafe(`DROP TABLE "${table}"`)
    await client.$executeRawUnsafe(
      'DELETE FROM "_open_science_migrations" WHERE id IN (\'0044_literature_smart_collections\')'
    )
    await client.sessionAuxiliaryTurnUsage.create({
      data: {
        sessionId: 'old-session',
        eventId: 'old-event',
        source: 'classification',
        frameworkId: 'codex',
        providerId: 'fixture',
        model: 'fixture',
        completedAtMs: 1700000000123n,
        inputTokens: 9n,
        outputTokens: 2n,
        cacheTokens: 0n
      }
    })
    expect(await migrateApplicationDatabase(client)).toMatchObject({
      applied: ['0044_literature_smart_collections']
    })
    expect(await client.literatureCollection.findMany({ include: { items: true } })).toEqual(before)
    expect(await client.literatureSmartCollection.count()).toBe(0)
    expect(await client.classificationUsage.findMany()).toMatchObject([
      {
        scenario: 'legacy-classification',
        sessionId: 'old-session',
        inputTokens: 9n,
        outputTokens: 2n,
        occurredAt: new Date(1700000000123),
        usageIncomplete: false
      }
    ])
    expect(
      await client.sessionAuxiliaryTurnUsage.count({ where: { source: 'classification' } })
    ).toBe(0)
    expect(
      await client.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("LiteratureSmartRun")')
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'inputTokens' }),
        expect.objectContaining({ name: 'outputTokens' }),
        expect.objectContaining({ name: 'usageIncomplete' })
      ])
    )

    await verifyCurrentApplicationSchema(client)
    await expect(
      client.literatureSmartCollection.create({
        data: { collectionId: 'ordinary', scopeKind: 'unknown' }
      })
    ).rejects.toThrow()
    await client.literatureSmartCollection.create({
      data: { collectionId: 'ordinary', scopeKind: 'library' }
    })
    expect(
      await client.literatureSmartCollection.findUnique({ where: { collectionId: 'ordinary' } })
    ).toMatchObject({ evidenceMode: 'abstract', autoUpdate: false })
    await client.literatureSmartOverride.create({
      data: { collectionId: 'ordinary', itemId: 'paper', decision: 'include' }
    })
    await client.literatureSmartAssessment.create({
      data: {
        collectionId: 'ordinary',
        itemId: 'paper',
        ruleRevision: 1,
        inputDigest: 'digest',
        policyKey: 'policy',
        verdict: 'match',
        model: 'fixture',
        evidenceJson: JSON.stringify({ mode: 'abstract' })
      }
    })
    await client.literatureSmartRuleRevision.create({
      data: {
        collectionId: 'ordinary',
        revision: 1,
        description: '',
        inclusionCriteria: 'Original studies',
        exclusionCriteria: '',
        scopeKind: 'library',
        evidenceMode: 'abstract'
      }
    })
    await client.literatureSmartRun.create({
      data: {
        id: 'run',
        collectionId: 'ordinary',
        kind: 'refresh',
        state: 'completed',
        ruleRevision: 1,
        policyKey: 'policy',
        snapshotJson: JSON.stringify({ model: 'fixture' })
      }
    })
    expect(await migrateApplicationDatabase(client)).toMatchObject({ applied: [] })
    expect(await client.literatureSmartAssessment.findFirst()).toMatchObject({
      evidenceJson: '{"mode":"abstract"}'
    })
    expect(await client.literatureSmartRun.findFirst()).toMatchObject({
      snapshotJson: '{"model":"fixture"}'
    })
    expect(await client.literatureSmartOverride.findFirst()).toMatchObject({ decision: 'include' })
    await client.literatureItem.delete({ where: { id: 'paper' } })
    expect(await client.literatureSmartOverride.count()).toBe(0)
    await client.literatureCollection.delete({ where: { id: 'ordinary' } })
    expect(await client.literatureSmartCollection.count()).toBe(0)
    expect(await client.classificationUsage.findMany()).toMatchObject([
      {
        scenario: 'legacy-classification',
        sessionId: 'old-session',
        inputTokens: 9n,
        outputTokens: 2n,
        occurredAt: new Date(1700000000123),
        usageIncomplete: false
      }
    ])
    expect(
      await client.sessionAuxiliaryTurnUsage.count({ where: { source: 'classification' } })
    ).toBe(0)
    expect(
      await client.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("LiteratureSmartRun")')
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'inputTokens' }),
        expect.objectContaining({ name: 'outputTokens' }),
        expect.objectContaining({ name: 'usageIncomplete' })
      ])
    )
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

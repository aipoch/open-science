import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ABOUT_YOU_MEMORY_CATEGORY_ID,
  MEMORY_AUTO_RECALL_CONTENT_LIMIT,
  MEMORY_CUSTOM_CATEGORY_LIMIT,
  MEMORY_SEARCH_CANDIDATE_LIMIT
} from '../../shared/memory'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { MemoryRepository } from './repository'
import { MemoryService } from './service'

describe('MemoryService', () => {
  let root = ''
  let client: PrismaClient

  const createService = (): MemoryService =>
    new MemoryService(new MemoryRepository(async () => client), { publish: vi.fn() })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-memory-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  })

  it('seeds the immutable About you category and retains user data while globally disabled', async () => {
    const service = createService()
    const initial = await service.snapshot()

    expect(initial.enabled).toBe(false)
    expect(initial.categories).toEqual([
      expect.objectContaining({
        id: ABOUT_YOU_MEMORY_CATEGORY_ID,
        systemKey: 'about-you',
        autoRecall: true,
        entries: []
      })
    ])

    const withEntry = await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: 'Prefers concise answers.'
    })
    expect(withEntry.categories[0]?.entries).toHaveLength(1)
    await expect(service.searchForAgent({ query: 'concise', limit: 5 })).rejects.toThrow(
      'Memory is turned off.'
    )
    await expect(service.recallForPrompt('concise')).resolves.toBeUndefined()
    await expect(
      service.rememberForAgent(
        { categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID, content: 'Agent-authored fact.' },
        { sessionId: 'session-1', agentId: 'specialist-1' }
      )
    ).rejects.toThrow('Memory is turned off.')
    await expect(
      service.deleteCategory({
        id: ABOUT_YOU_MEMORY_CATEGORY_ID,
        expectedRevision: initial.categories[0]!.revision
      })
    ).rejects.toThrow('The About you category cannot be deleted.')
    expect((await service.snapshot()).categories[0]?.entries).toHaveLength(1)
  })

  it('persists categories and entries across database reopen and hard-deletes category entries', async () => {
    const service = createService()
    const created = await service.createCategory({
      name: 'Experiments',
      guidance: 'Remember expensive experimental setup discoveries.',
      autoRecall: true
    })
    const category = created.categories.find((item) => !('systemKey' in item))
    expect(category).toBeDefined()
    await service.createEntry({ categoryId: category!.id, content: 'Use a 30 second exposure.' })
    await service.setEnabled({ enabled: true })

    await client.$disconnect()
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)

    const reopened = createService()
    const snapshot = await reopened.snapshot()
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: category!.id,
          entries: [expect.objectContaining({ content: 'Use a 30 second exposure.' })]
        })
      ])
    )

    await reopened.deleteCategory({ id: category!.id, expectedRevision: category!.revision })
    expect((await reopened.snapshot()).categories).toHaveLength(1)
    expect(await client.memoryEntry.count()).toBe(0)
    await expect(
      client.$queryRawUnsafe<Array<{ secure_delete: bigint }>>('PRAGMA secure_delete')
    ).resolves.toEqual([{ secure_delete: 1n }])
  })

  it('orders entries within each category by most recently updated first', async () => {
    const service = createService()
    await client.memoryEntry.createMany({
      data: [
        {
          id: 'entry-oldest',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: 'Oldest memory',
          contentKey: 'oldest memory',
          origin: 'user',
          updatedAt: new Date('2026-01-01T00:00:00.000Z')
        },
        {
          id: 'entry-newest',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: 'Newest memory',
          contentKey: 'newest memory',
          origin: 'user',
          updatedAt: new Date('2026-03-01T00:00:00.000Z')
        },
        {
          id: 'entry-middle',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: 'Middle memory',
          contentKey: 'middle memory',
          origin: 'user',
          updatedAt: new Date('2026-02-01T00:00:00.000Z')
        }
      ]
    })

    const aboutYou = (await service.snapshot()).categories.find(
      ({ id }) => id === ABOUT_YOU_MEMORY_CATEGORY_ID
    )!

    expect(aboutYou.entries.map(({ id }) => id)).toEqual([
      'entry-newest',
      'entry-middle',
      'entry-oldest'
    ])
  })

  it('enforces the 10 custom category limit under concurrent requests', async () => {
    const service = createService()
    const requests = Array.from({ length: MEMORY_CUSTOM_CATEGORY_LIMIT + 2 }, (_, index) =>
      service.createCategory({ name: `Category ${index}`, guidance: '', autoRecall: false })
    )

    const results = await Promise.allSettled(requests)
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      MEMORY_CUSTOM_CATEGORY_LIMIT
    )
    expect((await service.snapshot()).categories).toHaveLength(MEMORY_CUSTOM_CATEGORY_LIMIT + 1)
  })

  it('searches all categories explicitly but auto-recalls only opted-in categories', async () => {
    const service = createService()
    const optedIn = await service.createCategory({
      name: 'Lab setup',
      guidance: '',
      autoRecall: true
    })
    const optedOut = await service.createCategory({
      name: 'Archive',
      guidance: '',
      autoRecall: false
    })
    const lab = optedIn.categories.find((item) => 'name' in item && item.name === 'Lab setup')!
    const archive = optedOut.categories.find((item) => 'name' in item && item.name === 'Archive')!
    await service.createEntry({ categoryId: lab.id, content: 'CJK 显微镜 settings use channel A.' })
    await service.createEntry({
      categoryId: archive.id,
      content: 'CJK 显微镜 archive uses channel B.'
    })
    await service.setEnabled({ enabled: true })

    const explicit = await service.searchForAgent({ query: '显微镜', limit: 10 })
    const recalled = await service.recallForPrompt('显微镜 configuration')

    expect(explicit.map(({ content }) => content)).toEqual(
      expect.arrayContaining([
        'CJK 显微镜 settings use channel A.',
        'CJK 显微镜 archive uses channel B.'
      ])
    )
    expect(recalled).toContain('channel A')
    expect(recalled).not.toContain('channel B')
  })

  it('bounds database search candidates and automatic prompt content', async () => {
    const repository = new MemoryRepository(async () => client)
    const service = new MemoryService(repository, { publish: vi.fn() })
    await client.memoryEntry.createMany({
      data: Array.from({ length: MEMORY_SEARCH_CANDIDATE_LIMIT + 5 }, (_, index) => ({
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        content: `needle ${index}`,
        contentKey: `needle ${index}`,
        origin: 'user'
      }))
    })

    const candidates = await repository.searchCandidates({
      autoRecallOnly: false,
      terms: ['needle']
    })
    expect(candidates).toHaveLength(MEMORY_SEARCH_CANDIDATE_LIMIT)

    for (let index = 0; index < 5; index += 1) {
      await service.createEntry({
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        content: `bounded-${index} ${'x'.repeat(3_900)}`
      })
    }
    await service.setEnabled({ enabled: true })
    const recalled = await service.recallForPrompt('bounded')
    const encodedRecords = recalled?.match(/<memory_records>(.*)<\/memory_records>/u)?.[1]
    const records = JSON.parse(encodedRecords ?? '[]') as Array<{ content: string }>
    expect(records.reduce((total, record) => total + record.content.length, 0)).toBeLessThanOrEqual(
      MEMORY_AUTO_RECALL_CONTENT_LIMIT
    )
  })

  it('ranks an older exact match ahead of more than 200 recent weak matches', async () => {
    const service = createService()
    await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: 'alpha beta gamma exact durable preference'
    })
    await client.memoryEntry.createMany({
      data: Array.from({ length: MEMORY_SEARCH_CANDIDATE_LIMIT + 5 }, (_, index) => ({
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        content: `alpha unrelated recent noise ${index}`,
        contentKey: `alpha unrelated recent noise ${index}`,
        origin: 'user'
      }))
    })
    await service.setEnabled({ enabled: true })

    await expect(service.searchForAgent({ query: 'alpha beta gamma', limit: 1 })).resolves.toEqual([
      expect.objectContaining({ content: 'alpha beta gamma exact durable preference' })
    ])
  })

  it('searches long CJK queries across their full span and falls back for short queries', async () => {
    const service = createService()
    await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: '显微镜 alignment uses channel C.'
    })
    await service.setEnabled({ enabled: true })

    await expect(
      service.searchForAgent({ query: `${'前'.repeat(30)}显微镜`, limit: 5 })
    ).resolves.toEqual([expect.objectContaining({ content: '显微镜 alignment uses channel C.' })])
    await expect(service.searchForAgent({ query: '显微', limit: 5 })).resolves.toEqual([
      expect.objectContaining({ content: '显微镜 alignment uses channel C.' })
    ])
  })

  it('searches mixed short terms and samples long token lists through the tail', async () => {
    const service = createService()
    await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: '显微镜 uses channel D.'
    })
    await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: 'tailkeyword preference'
    })
    await client.memoryEntry.createMany({
      data: Array.from({ length: MEMORY_SEARCH_CANDIDATE_LIMIT }, (_, index) => ({
        categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
        content: `settings noise ${index}`,
        contentKey: `settings noise ${index}`,
        origin: 'user'
      }))
    })
    await service.setEnabled({ enabled: true })

    await expect(service.searchForAgent({ query: 'settings 显微', limit: 20 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: '显微镜 uses channel D.' })])
    )
    await expect(service.recallForPrompt('settings 显微')).resolves.toContain(
      '显微镜 uses channel D.'
    )
    await expect(
      service.searchForAgent({
        query: `${Array.from({ length: 30 }, (_, index) => `filler${index}`).join(' ')} tailkeyword`,
        limit: 5
      })
    ).resolves.toEqual([expect.objectContaining({ content: 'tailkeyword preference' })])
  })

  it('backfills recent opted-in memories when the request has no lexical match', async () => {
    const service = createService()
    const enabledSnapshot = await service.createCategory({
      name: 'Working preferences',
      guidance: 'Keep durable working preferences available.',
      autoRecall: true
    })
    const disabledSnapshot = await service.createCategory({
      name: 'Private archive',
      guidance: 'Search only when explicitly requested.',
      autoRecall: false
    })
    const enabledCategory = enabledSnapshot.categories.find(
      (category) => 'name' in category && category.name === 'Working preferences'
    )!
    const disabledCategory = disabledSnapshot.categories.find(
      (category) => 'name' in category && category.name === 'Private archive'
    )!
    await client.memoryEntry.createMany({
      data: [
        {
          id: 'about-older',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: '回答时保持亲切。',
          contentKey: '回答时保持亲切。',
          origin: 'user',
          updatedAt: new Date('2026-01-01T00:00:00.000Z')
        },
        {
          id: 'enabled-recent',
          categoryId: enabledCategory.id,
          content: '优先给出直接结论。',
          contentKey: '优先给出直接结论。',
          origin: 'user',
          updatedAt: new Date('2026-02-01T00:00:00.000Z')
        },
        {
          id: 'disabled-newest',
          categoryId: disabledCategory.id,
          content: '这条记录只允许显式搜索。',
          contentKey: '这条记录只允许显式搜索。',
          origin: 'user',
          updatedAt: new Date('2026-03-01T00:00:00.000Z')
        }
      ]
    })
    await service.setEnabled({ enabled: true })

    const recalled = await service.recallForPrompt('Please continue with the task.')
    const encodedRecords = recalled?.match(/<memory_records>(.*)<\/memory_records>/u)?.[1]
    const records = JSON.parse(encodedRecords ?? '[]') as Array<{ id: string }>

    expect(records.map(({ id }) => id)).toEqual(['enabled-recent', 'about-older'])
  })

  it('preserves repository relevance order and deduplicates automatic recall content', async () => {
    const service = createService()
    const categorySnapshot = await service.createCategory({
      name: 'Duplicate facts',
      guidance: '',
      autoRecall: true
    })
    const duplicateCategory = categorySnapshot.categories.find(
      (category) => 'name' in category && category.name === 'Duplicate facts'
    )!
    await client.memoryEntry.createMany({
      data: [
        {
          id: 'short-relevant',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: 'alpha beta',
          contentKey: 'alpha beta',
          origin: 'user',
          updatedAt: new Date('2020-01-01T00:00:00.000Z')
        },
        {
          id: 'long-recent',
          categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
          content: `alpha beta ${'noise '.repeat(100)}`,
          contentKey: `alpha beta ${'noise '.repeat(100)}`,
          origin: 'user',
          updatedAt: new Date('2030-01-01T00:00:00.000Z')
        },
        {
          id: 'duplicate-cross-category',
          categoryId: duplicateCategory.id,
          content: '  ALPHA BETA  ',
          contentKey: 'alpha beta',
          origin: 'user'
        }
      ]
    })
    await service.setEnabled({ enabled: true })

    const results = await service.searchForAgent({ query: 'alpha beta', limit: 5 })
    expect(results[0]?.id).toBe('short-relevant')

    const recalled = await service.recallForPrompt('alpha beta')
    const encodedRecords = recalled?.match(/<memory_records>(.*)<\/memory_records>/u)?.[1]
    const records = JSON.parse(encodedRecords ?? '[]') as Array<{ content: string }>
    expect(
      records.filter(({ content }) => content.trim().toLowerCase() === 'alpha beta')
    ).toHaveLength(1)
  })

  it('deduplicates before the five-record recall cap and backfills distinct facts', async () => {
    const service = createService()
    const categoryIds: string[] = [ABOUT_YOU_MEMORY_CATEGORY_ID]
    for (let index = 0; index < 4; index += 1) {
      const snapshot = await service.createCategory({
        name: `Recall ${index}`,
        guidance: '',
        autoRecall: true
      })
      categoryIds.push(
        snapshot.categories.find(
          (category) => 'name' in category && category.name === `Recall ${index}`
        )!.id
      )
    }
    for (const categoryId of categoryIds) {
      await service.createEntry({ categoryId, content: 'microscope recall' })
    }
    await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: 'microscope recall unique calibration detail'
    })
    await service.setEnabled({ enabled: true })

    const recalled = await service.recallForPrompt('microscope recall')
    const encodedRecords = recalled?.match(/<memory_records>(.*)<\/memory_records>/u)?.[1]
    const records = JSON.parse(encodedRecords ?? '[]') as Array<{ content: string }>
    expect(records.filter(({ content }) => content === 'microscope recall')).toHaveLength(1)
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'microscope recall unique calibration detail' })
      ])
    )
  })

  it('linearizes global disable before subsequent Agent reads and writes', async () => {
    const service = createService()
    await service.setEnabled({ enabled: true })
    await service.createEntry({
      categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID,
      content: 'A fact that must not escape after disable.'
    })

    const disabling = service.setEnabled({ enabled: false })
    const searching = service.searchForAgent({ query: 'escape', limit: 5 })
    const remembering = service.rememberForAgent(
      { categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID, content: 'Written after disable.' },
      { sessionId: 'session-race' }
    )

    await expect(disabling).resolves.toMatchObject({ enabled: false })
    await expect(searching).rejects.toThrow('Memory is turned off.')
    await expect(remembering).rejects.toThrow('Memory is turned off.')
    expect(await client.memoryEntry.count()).toBe(1)
  })

  it('deduplicates Agent writes and persists host-attributed provenance', async () => {
    const service = createService()
    await service.setEnabled({ enabled: true })
    const context = { sessionId: 'session-agent', agentId: 'specialist-agent' }

    const [first, second] = await Promise.all([
      service.rememberForAgent(
        { categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID, content: 'Same durable fact.' },
        context
      ),
      service.rememberForAgent(
        { categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID, content: '  same durable fact.  ' },
        context
      )
    ])

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({
      revision: 1,
      provenance: { origin: 'agent', agentId: 'specialist-agent' }
    })
    expect(await client.memoryEntry.count()).toBe(1)
    await expect(
      client.memoryEntry.findUniqueOrThrow({ where: { id: second.id } })
    ).resolves.toMatchObject({
      origin: 'agent',
      sourceSessionId: 'session-agent',
      sourceAgentId: 'specialist-agent'
    })
  })
})

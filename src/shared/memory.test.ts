import { describe, expect, it } from 'vitest'

import {
  ABOUT_YOU_MEMORY_CATEGORY_ID,
  ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY,
  memoryApplicationCommandContracts,
  memoryAgentRememberRequestSchema,
  memoryAgentResultSchema,
  memoryAgentSearchRequestSchema,
  memorySnapshotSchema
} from './memory'

describe('memory contracts', () => {
  const snapshot = {
    revision: 3,
    enabled: true,
    categories: [
      {
        id: ABOUT_YOU_MEMORY_CATEGORY_ID,
        systemKey: ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY,
        autoRecall: true,
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        entries: []
      },
      {
        id: 'category-1',
        name: 'Experiments',
        guidance: 'Keep expensive debugging results here.',
        autoRecall: false,
        revision: 2,
        createdAt: 2,
        updatedAt: 3,
        entries: [
          {
            id: 'entry-1',
            content: 'The microscopy pipeline expects TIFF input.',
            origin: 'agent' as const,
            revision: 1,
            createdAt: 3,
            updatedAt: 3
          }
        ]
      }
    ]
  }

  it('accepts a snapshot without exposing persisted comparison keys or provenance identifiers', () => {
    expect(memorySnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(() =>
      memorySnapshotSchema.parse({
        ...snapshot,
        categories: [
          {
            ...snapshot.categories[1],
            nameKey: 'experiments',
            entries: [{ ...snapshot.categories[1].entries[0], sourceSessionId: 'session-secret' }]
          }
        ]
      })
    ).toThrow()
  })

  it('strictly validates category, entry, settings, and clear-all commands', () => {
    expect(
      memoryApplicationCommandContracts.createCategory.args.parse([
        { name: 'Preferences', guidance: '', autoRecall: true }
      ])
    ).toEqual([{ name: 'Preferences', guidance: '', autoRecall: true }])
    expect(
      memoryApplicationCommandContracts.createEntry.args.parse([
        { categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID, content: 'Uses metric units.' }
      ])
    ).toEqual([{ categoryId: ABOUT_YOU_MEMORY_CATEGORY_ID, content: 'Uses metric units.' }])
    expect(memoryApplicationCommandContracts.setEnabled.args.parse([{ enabled: false }])).toEqual([
      { enabled: false }
    ])
    expect(memoryApplicationCommandContracts.clearAll.args.parse([])).toEqual([])
    expect(() =>
      memoryApplicationCommandContracts.createCategory.args.parse([
        { name: 'Preferences', guidance: '', autoRecall: true, systemKey: 'about-you' }
      ])
    ).toThrow()
  })

  it('shares strict Agent tool request validation with the host RPC boundary', () => {
    expect(() =>
      memoryAgentRememberRequestSchema.parse({ categoryId: 'category-1', content: ' ' })
    ).toThrow()
    expect(memoryAgentSearchRequestSchema.parse({ query: 'microscopy', limit: 4 })).toEqual({
      query: 'microscopy',
      limit: 4
    })
  })

  it('validates revision and bounded provenance on Agent memory results', () => {
    expect(
      memoryAgentResultSchema.parse({
        id: 'entry-1',
        categoryId: 'category-1',
        categoryName: 'Research',
        content: 'Use channel A.',
        revision: 2,
        provenance: { origin: 'agent', agentId: 'specialist-1' },
        updatedAt: 3
      })
    ).toMatchObject({ revision: 2, provenance: { origin: 'agent', agentId: 'specialist-1' } })
    expect(() =>
      memoryAgentResultSchema.parse({
        id: 'entry-1',
        categoryId: 'category-1',
        categoryName: 'Research',
        content: 'Use channel A.',
        revision: 2,
        provenance: { origin: 'agent', sessionId: 'private-session' },
        updatedAt: 3
      })
    ).toThrow()
  })
})

import { describe, expect, it } from 'vitest'

import {
  ABOUT_YOU_MEMORY_CATEGORY_ID,
  ABOUT_YOU_MEMORY_CATEGORY_SYSTEM_KEY,
  memoryApplicationCommandContracts,
  memoryAgentRememberMcpOutputSchema,
  memoryAgentRememberResultSchema,
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
            categoryId: 'category-1',
            categoryName: 'Experiments',
            projectId: 'project-1',
            projectName: 'Microscopy',
            content: 'The microscopy pipeline expects TIFF input.',
            origin: 'agent' as const,
            revision: 1,
            createdAt: 3,
            updatedAt: 3
          }
        ]
      }
    ],
    projects: [
      {
        projectId: 'project-1',
        name: 'Microscopy',
        archived: false,
        entries: [
          {
            id: 'entry-1',
            categoryId: 'category-1',
            categoryName: 'Experiments',
            projectId: 'project-1',
            projectName: 'Microscopy',
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
    expect(
      memoryApplicationCommandContracts.createEntry.args.parse([
        { projectId: 'project-1', categoryId: null, content: 'Use channel A.' }
      ])
    ).toEqual([{ projectId: 'project-1', categoryId: null, content: 'Use channel A.' }])
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
    expect(
      memoryAgentRememberRequestSchema.parse({
        content: 'Use channel A for this project.',
        categoryId: 'category-1',
        analysis: {
          scope: 'project',
          durability: 'cross-session',
          evidence: 'project-observed',
          subject: 'Microscopy channel',
          reason: 'Future sessions need the working channel.',
          categoryReason: 'This is an experimental setup detail.'
        }
      })
    ).toMatchObject({ analysis: { scope: 'project', durability: 'cross-session' } })
    expect(() =>
      memoryAgentRememberRequestSchema.parse({
        content: 'Use channel A for this project.',
        categoryId: 'category-1',
        analysis: {
          scope: 'project',
          durability: 'cross-session',
          evidence: 'project-observed',
          subject: 'Microscopy channel',
          reason: 'Future sessions need the working channel.'
        }
      })
    ).toThrow()
  })

  it('validates revision and bounded provenance on Agent memory results', () => {
    expect(
      memoryAgentResultSchema.parse({
        id: 'entry-1',
        categoryId: 'category-1',
        categoryName: 'Research',
        scope: 'project',
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
        scope: 'project',
        content: 'Use channel A.',
        revision: 2,
        provenance: { origin: 'agent', sessionId: 'private-session' },
        updatedAt: 3
      })
    ).toThrow()
  })

  it('defines structured created, existing, and non-retryable rejected remember results', () => {
    expect(
      memoryAgentRememberResultSchema.parse({
        status: 'rejected',
        retryable: false,
        code: 'invalid_analysis',
        reason: 'The note does not describe durable project knowledge.'
      })
    ).toMatchObject({ status: 'rejected', retryable: false })
  })

  it('keeps every remember result branch strict in the MCP object schema', () => {
    const memory = {
      id: 'entry-1',
      categoryId: null,
      categoryName: null,
      scope: 'project',
      content: 'Use channel A.',
      revision: 2,
      provenance: { origin: 'agent', agentId: 'specialist-1' },
      updatedAt: 3
    }

    expect(memoryAgentRememberMcpOutputSchema.parse({ status: 'created', memory })).toMatchObject({
      status: 'created'
    })
    expect(memoryAgentRememberMcpOutputSchema.parse({ status: 'existing', memory })).toMatchObject({
      status: 'existing'
    })
    expect(
      memoryAgentRememberMcpOutputSchema.parse({
        status: 'rejected',
        retryable: false,
        code: 'invalid_analysis',
        reason: 'The note does not describe durable project knowledge.'
      })
    ).toMatchObject({ status: 'rejected', retryable: false })

    expect(() => memoryAgentRememberMcpOutputSchema.parse({ status: 'created' })).toThrow()
    expect(() =>
      memoryAgentRememberMcpOutputSchema.parse({
        status: 'existing',
        memory,
        retryable: false,
        code: 'invalid_analysis',
        reason: 'A successful result cannot carry rejection fields.'
      })
    ).toThrow()
    expect(() =>
      memoryAgentRememberMcpOutputSchema.parse({
        status: 'rejected',
        memory,
        retryable: false,
        code: 'invalid_analysis',
        reason: 'A rejected result cannot carry memory.'
      })
    ).toThrow()
  })
})

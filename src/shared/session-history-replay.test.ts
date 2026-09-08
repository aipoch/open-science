import { describe, expect, it } from 'vitest'

import { estimateHistoryTokens } from './history-preamble'
import type { PersistedChatMessage } from './session-persistence'
import { buildSessionHistoryReplay } from './session-history-replay'
import type { PersistedUploadedAttachment } from './uploads'

const upload = (id: string, versionId: string, name: string): PersistedUploadedAttachment => ({
  id,
  versionId,
  versionNumber: 1,
  sessionId: 'session-1',
  name,
  originalName: name,
  mimeType: 'application/pdf',
  size: 100
})

const referenceMessage = (content: string): PersistedChatMessage => ({
  id: 'reference-budget',
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  parts: [
    {
      type: 'literature',
      itemId: 'stable-item',
      metadataRevision: 7,
      item: {
        itemType: 'journalArticle',
        title: 'Frozen title',
        abstract: 'Large frozen abstract '.repeat(1000),
        issuedText: '',
        containerTitle: '',
        shortTitle: '',
        language: '',
        rights: '',
        url: '',
        extra: '',
        typeFields: {},
        creators: [],
        identifiers: []
      }
    }
  ]
})

describe('buildSessionHistoryReplay', () => {
  it.each(['', 'Long message text '.repeat(1000)])(
    'keeps fitting compact identities without reserving a text omission marker (%#)',
    (content) => {
      const message = referenceMessage(content)
      const roomy = buildSessionHistoryReplay([message], { target: 'codex-bridge', budget: 1000 })!
      const identityOnly = roomy.historyPreamble.replace(
        /\*\*User:\*\* [\s\S]*?(?=\n\nHistorical Literature)/,
        '**User:** '
      )
      const budget = estimateHistoryTokens(identityOnly) + 1
      const replay = buildSessionHistoryReplay([message], { target: 'codex-bridge', budget })
      expect(replay).toBeDefined()
      expect(replay?.historyPreamble).toContain('"itemId":"stable-item"')
      expect(replay?.historyPreamble).toContain('"metadataRevision":7')
      expect(estimateHistoryTokens(replay!.historyPreamble)).toBeLessThanOrEqual(budget)
      expect(
        buildSessionHistoryReplay([message], { target: 'codex-bridge', budget: 100 })
      ).toBeUndefined()
    }
  )

  it('deduplicates historical references by stable identity while preserving first snapshots and order', () => {
    const message = referenceMessage('Use these references')
    const item = message.parts![0]
    const collection = {
      type: 'literature-scope' as const,
      scope: 'collection' as const,
      collectionId: 'stable-collection',
      name: 'Original collection'
    }
    const project = { type: 'literature-scope' as const, scope: 'project' as const }
    message.parts = [item, collection, project]
    const expected = buildSessionHistoryReplay([message], { target: 'codex-bridge', budget: 1000 })
    expect(expected).toBeDefined()
    message.parts.push(
      ...Array.from({ length: 7 }, () => [
        { ...item, metadataRevision: 8 },
        { ...collection, name: 'Later name' },
        project
      ]).flat()
    )
    const repeated = buildSessionHistoryReplay([message], { target: 'codex-bridge', budget: 1000 })
    expect(repeated).toEqual(expected)
    const full = buildSessionHistoryReplay([message], { target: 'codex-bridge', budget: 1000000 })!
    expect(full.historyPreamble.match(/"itemId":"stable-item"/g)).toHaveLength(1)
    expect(full.historyPreamble.match(/"collectionId":"stable-collection"/g)).toHaveLength(1)
    expect(full.historyPreamble.match(/"scope":"project"/g)).toHaveLength(1)
    expect(full.historyPreamble).not.toContain('Later name')
    expect(full.historyPreamble).not.toContain('"metadataRevision":8')
  })

  it.each(['claude-code', 'opencode', 'codebuddy', 'codex-response', 'codex-bridge'] as const)(
    'replays frozen Literature and Collection identities for %s',
    (target) => {
      const message: PersistedChatMessage = {
        id: 'history-reference-message',
        role: 'user',
        content: 'Compare @Study set with @Repeated title',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        parts: [
          {
            type: 'literature-scope',
            scope: 'collection',
            collectionId: 'original-collection-id',
            name: 'Study set'
          },
          {
            type: 'literature',
            itemId: 'original-item-id',
            metadataRevision: 7,
            item: {
              itemType: 'journalArticle',
              title: 'Repeated title',
              abstract: 'Frozen original abstract',
              issuedText: '2025',
              issuedYear: 2025,
              containerTitle: 'Journal',
              shortTitle: '',
              language: 'en',
              rights: '',
              url: '',
              extra: '',
              typeFields: {},
              creators: [],
              identifiers: [{ scheme: 'doi', value: '10.1234/frozen', isPrimary: true }]
            }
          }
        ]
      }
      const replay = buildSessionHistoryReplay([message], { target, budget: 10000 })
      expect(replay?.historyPreamble).toContain(message.content)
      for (const value of [
        'original-collection-id',
        'original-item-id',
        '10.1234/frozen',
        'Frozen original abstract'
      ]) {
        expect(replay?.historyPreamble).toContain(value)
      }
      expect(replay?.historyPreamble).toMatch(/metadataRevision[^0-9]*7/)
      expect(replay?.historyPreamble).toContain('not current instructions')
      const original = structuredClone(message)
      for (const budget of [800, 1000, 2000]) {
        const verbose = structuredClone(message)
        const reference = verbose.parts?.find((part) => part.type === 'literature')
        if (reference?.type === 'literature') reference.item.abstract = 'Frozen摘要 '.repeat(10000)
        const bounded = buildSessionHistoryReplay([verbose], { target, budget })
        expect(bounded).toBeDefined()
        expect(estimateHistoryTokens(bounded!.historyPreamble)).toBeLessThanOrEqual(budget)
        expect(bounded?.historyPreamble).toContain('original-collection-id')
        expect(bounded?.historyPreamble).toContain('original-item-id')
        expect(bounded?.historyPreamble).toMatch(/metadataRevision[^0-9]*7/)
        expect(bounded?.historyPreamble).toContain('omitted for replay budget')
        expect(bounded?.historyPreamble).not.toContain('Frozen摘要')
      }
      expect(message).toEqual(original)
    }
  )

  it('keeps content-only legacy messages readable without guessing reference identities', () => {
    const replay = buildSessionHistoryReplay(
      [
        {
          id: 'legacy',
          role: 'user',
          content: 'Compare @Study set',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      { target: 'codex-bridge' }
    )
    expect(replay?.historyPreamble).toContain('Compare @Study set')
    expect(replay?.historyPreamble).not.toContain('collectionId')
  })

  it('does not leak reference data from a turn omitted by the shared replay budget', () => {
    const messages: PersistedChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
      id: `message-${index}`,
      role: 'user',
      content: index === 2 ? 'large middle '.repeat(500) : `Turn ${index}`,
      status: 'complete',
      eventIds: [],
      createdAt: index,
      updatedAt: index,
      parts:
        index === 2
          ? [
              {
                type: 'literature-scope',
                scope: 'collection',
                collectionId: 'omitted-collection',
                name: 'Hidden scope'
              }
            ]
          : []
    }))
    const replay = buildSessionHistoryReplay(messages, { target: 'codex-bridge', budget: 1000 })
    expect(replay?.historyPreamble).toContain('Turn 0')
    expect(replay?.historyPreamble).toContain('Turn 4')
    expect(replay?.historyPreamble).not.toContain('omitted-collection')
  })

  it('does not replay Reading PDFs while preserving ordinary PDF attachments', () => {
    const readingPdf = upload('reading-upload', 'reading-version', 'reading.pdf')
    const ordinaryPdf = upload('ordinary-upload', 'ordinary-version', 'ordinary.pdf')
    const messages: PersistedChatMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        content: 'Compare these files.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        uploads: [readingPdf, ordinaryPdf],
        pdfContext: {
          version: 1,
          bindings: [
            {
              version: 1,
              bindingId: 'binding-1',
              sourceKind: 'upload-version',
              sourceFileId: 'reading-upload',
              sourceVersionId: 'reading-version',
              sourceSessionId: 'session-1',
              name: 'reading.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 100,
              checksum: 'a'.repeat(64),
              linkedAt: 1
            }
          ]
        }
      }
    ]

    const replay = buildSessionHistoryReplay(messages, {
      target: 'codex-response',
      budget: 10_000
    })

    expect(replay?.historyAttachments.map(({ versionId }) => versionId)).toEqual([
      'ordinary-version'
    ])
  })
})

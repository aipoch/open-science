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

describe('buildSessionHistoryReplay', () => {
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

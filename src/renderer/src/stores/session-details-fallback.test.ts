import { describe, expect, it } from 'vitest'

import type { PersistedChatMessage } from '../../../shared/session-persistence'
import {
  findFirstSessionDetailsMessage,
  formatFallbackSessionDetails,
  formatSessionDetailsGenerationSource
} from '../../../shared/session-details'

const message = (overrides: Partial<PersistedChatMessage> = {}): PersistedChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Review the data',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('session details fallback', () => {
  it('preserves structured mentions in display order without exposing reference identity or paths', () => {
    const source = formatSessionDetailsGenerationSource(
      message({
        content: 'ignored historical projection',
        parts: [
          { type: 'text', text: 'Use ' },
          { type: 'skill', id: 'private-skill-id', name: 'research' },
          { type: 'text', text: ' on ' },
          {
            type: 'artifact',
            id: 'private-artifact-id',
            name: 'results.csv',
            path: '/Users/person/private/results.csv',
            source: 'artifact'
          },
          { type: 'text', text: ' with ' },
          { type: 'session', sessionId: 'private-session-id', title: 'Prior analysis' }
        ]
      })
    )

    expect(source).toBe('Use /research on @results.csv with #Prior analysis')
    expect(source).not.toContain('/Users/')
    expect(source).not.toContain('private-')
  })

  it('uses safe upload display names and appends uploads missing from structured parts', () => {
    const source = formatSessionDetailsGenerationSource(
      message({
        content: '',
        parts: [{ type: 'text', text: 'Compare these files' }],
        uploads: [
          {
            id: 'upload-1',
            sessionId: 'session-1',
            name: 'staged-secret-name',
            originalName: 'observations.csv',
            path: '/private/staging/secret',
            mimeType: 'text/csv',
            size: 5,
            createdAt: '2024-01-01T00:00:00.000Z'
          }
        ]
      })
    )

    expect(source).toBe('Compare these files\n@observations.csv')
    expect(source).not.toContain('/private/')
  })

  it('reduces path-shaped reference labels to safe relative display names', () => {
    const source = formatSessionDetailsGenerationSource(
      message({
        content: '',
        parts: [
          {
            type: 'artifact',
            id: 'artifact-1',
            name: '/Users/person/private/results.csv',
            path: '/Users/person/private/results.csv',
            source: 'artifact'
          },
          {
            type: 'artifact',
            id: 'artifact-2',
            name: 'notes.md',
            source: 'linked-folder',
            relativePath: '../private\\folder/notes.md',
            rootId: 'private-root-id'
          }
        ],
        uploads: [
          {
            id: 'upload-1',
            sessionId: 'session-1',
            name: 'staged-secret-name',
            originalName: 'C:\\private\\observations.csv',
            path: '/private/staging/secret',
            mimeType: 'text/csv',
            size: 5,
            createdAt: '2024-01-01T00:00:00.000Z'
          }
        ]
      })
    )

    expect(source).toBe('@results.csv @private/folder/notes.md\n@observations.csv')
    expect(source).not.toContain('/Users/')
    expect(source).not.toContain('C:\\')
    expect(source).not.toContain('..')
  })

  it('skips hidden controls, relays, and attributed application messages', () => {
    const visible = message({ id: 'visible' })
    expect(
      findFirstSessionDetailsMessage([
        message({ id: 'control', turnIntent: 'save-as-skill' }),
        message({ id: 'relay', relayedFrom: { kind: 'side-chat', direction: 'to-main' } }),
        message({
          id: 'application',
          attribution: {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          }
        }),
        visible
      ])
    ).toBe(visible)
  })

  it('collapses formatting whitespace and enforces description length', () => {
    const source = formatSessionDetailsGenerationSource(
      message({ content: `First sentence.  \n\n\n  ${'x'.repeat(1_100)}` })
    )
    expect(source.startsWith('First sentence.\n\n')).toBe(true)
    expect(source).toHaveLength(1_000)
  })

  it('uses only a safe title as fallback and leaves the description empty', () => {
    expect(formatFallbackSessionDetails(message({ content: 'Review the data' }))).toEqual({
      title: 'Review the data',
      description: ''
    })
  })
})

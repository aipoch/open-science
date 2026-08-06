import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession } from '@/stores/session-store'

import {
  buildSessionComposerHistory,
  buildStarterComposerHistory,
  normalizeHistorySkills
} from './composer-history'

const message = (
  id: string,
  content: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const session = (
  id: string,
  messages: ChatMessage[],
  overrides: Partial<ChatSession> = {}
): ChatSession => ({
  id,
  projectId: 'project-1',
  title: id,
  cwd: '/workspace',
  status: 'idle',
  messages,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('composer history', () => {
  it('builds newest-first visible Session history and excludes entire uploaded turns', () => {
    const entries = buildSessionComposerHistory(
      session('session-1', [
        message('first', 'first'),
        message('agent', 'answer', { role: 'agent' }),
        message('upload', 'analyze this', {
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'paper.pdf',
              originalName: 'paper.pdf',
              size: 10
            }
          ]
        }),
        message('latest', 'latest')
      ])
    )

    expect(entries.map((entry) => entry.messageId)).toEqual(['latest', 'first'])
  })

  it('keeps structured mentions but falls back to full content when legacy parts disagree', () => {
    const [trimmed, structured, fallback] = buildSessionComposerHistory(
      session('session-1', [
        message('fallback', 'complete text', {
          parts: [{ type: 'text', text: 'truncated' }]
        }),
        message('structured', 'Use /Literature with @paper.pdf', {
          parts: [
            { type: 'text', text: 'Use ' },
            { type: 'skill', id: 'lit', name: 'Literature' },
            { type: 'text', text: ' with ' },
            {
              type: 'artifact',
              id: 'file-1',
              name: 'paper.pdf',
              source: 'upload',
              path: 'upload-version:project-1/session-1/file-1'
            }
          ]
        }),
        message('trimmed', '/Literature analyze', {
          parts: [
            { type: 'text', text: ' ' },
            { type: 'skill', id: 'lit', name: 'Literature' },
            { type: 'text', text: ' analyze ' }
          ]
        })
      ])
    )

    expect(trimmed.doc.nodes.some((node) => node.type === 'skill')).toBe(true)
    expect(structured.doc.nodes.map((node) => node.type)).toEqual([
      'text',
      'skill',
      'text',
      'artifact'
    ])
    expect(structured.doc.nodes.at(-1)).toMatchObject({ type: 'artifact', source: 'upload' })
    expect(fallback.doc).toEqual({ nodes: [{ type: 'text', text: 'complete text' }] })
  })

  it('orders starter history by recent activity and deduplicates copied openers', () => {
    const copiedOpener = message('shared-opener', 'shared')
    const entries = buildStarterComposerHistory([
      session('older', [message('older-opener', 'older')], { createdAt: 1, updatedAt: 10 }),
      session('branch-a', [copiedOpener], { createdAt: 2, updatedAt: 30 }),
      session('branch-b', [copiedOpener], { createdAt: 3, updatedAt: 20 }),
      session('pending', [message('pending-opener', 'pending')], {
        isPending: true,
        updatedAt: 40
      })
    ])

    expect(entries.map((entry) => entry.messageId)).toEqual(['shared-opener', 'older-opener'])
    expect(entries[0].id).toBe('branch-a:shared-opener')
  })

  it('downgrades missing and Specialist-disallowed Skills to plain text', () => {
    const source = {
      nodes: [
        { type: 'text' as const, text: 'Use ' },
        { type: 'skill' as const, id: 'allowed', name: 'Allowed' },
        { type: 'text' as const, text: ' then ' },
        { type: 'skill' as const, id: 'blocked', name: 'Blocked' },
        { type: 'text' as const, text: ' and ' },
        { type: 'skill' as const, id: 'deleted', name: 'Deleted' }
      ]
    }
    const result = normalizeHistorySkills(
      source,
      new Set(['allowed', 'blocked']),
      new Set(['allowed'])
    )

    expect(result.doc.nodes).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'skill', id: 'allowed', name: 'Allowed' },
      { type: 'text', text: ' then /Blocked and /Deleted' }
    ])
    expect(result.unavailableSkillNames).toEqual(['Blocked', 'Deleted'])

    const repeated = normalizeHistorySkills(
      source,
      new Set(['allowed', 'blocked']),
      new Set(['allowed'])
    )
    expect(repeated.doc).toEqual(result.doc)
  })
})

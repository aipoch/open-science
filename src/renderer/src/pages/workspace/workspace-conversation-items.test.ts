import { describe, expect, it } from 'vitest'

import type { ChatSession, ToolActivity } from '@/stores/session-store'
import {
  createConversationItems,
  formatActivityTitle,
  isActivityActive
} from './workspace-conversation-items'

const baseSession: ChatSession = {
  id: 'session-1',
  projectId: 'default',
  title: 'Session',
  cwd: '/workspace/project',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
}

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

describe('workspace conversation items', () => {
  it('orders messages and activities by stable runtime sort index when timestamps match', () => {
    const session: ChatSession = {
      ...baseSession,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Search this',
          status: 'complete',
          eventIds: [],
          sortIndex: 1,
          createdAt: 1710000000000,
          updatedAt: 1710000000000
        },
        {
          id: 'message-2',
          role: 'agent',
          content: 'Here are the results',
          status: 'streaming',
          eventIds: ['event-3'],
          sortIndex: 3,
          createdAt: 1710000000000,
          updatedAt: 1710000000000
        }
      ],
      activities: [
        createActivity({
          id: 'tool-web-1',
          title: '"open science repositories"',
          toolKind: 'search',
          sortIndex: 2
        })
      ]
    }

    expect(createConversationItems(session).map((item) => item.id)).toEqual([
      'message-1',
      'activity-tool-web-1',
      'message-2'
    ])
  })

  it('formats activities by tool identity without exposing title details', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-1',
          title: '"top news July 6 2026"',
          status: 'completed',
          toolKind: 'search'
        })
      )
    ).toBe('Used tool: ToolSearch')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-2',
          status: 'pending',
          toolKind: 'search'
        })
      )
    ).toBe('Using tool: ToolSearch')
  })

  it('formats non-search tools by kind instead of title details', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-fetch-1',
          title: 'Fetch https://example.com',
          status: 'completed',
          toolKind: 'fetch'
        })
      )
    ).toBe('Used tool: ToolFetch')
  })

  it('formats tools by provider identity when available without exposing title details', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-grep-1',
          title: 'grep "secret pattern" /workspace/private',
          status: 'completed',
          providerToolName: 'Grep',
          toolKind: 'search'
        })
      )
    ).toBe('Used tool: Grep')
  })

  it('falls back to readable tool kind names for unnamed tools', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-1',
          status: 'completed',
          toolKind: 'search'
        })
      )
    ).toBe('Used tool: ToolSearch')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-fetch-1',
          status: 'completed',
          toolKind: 'fetch'
        })
      )
    ).toBe('Used tool: ToolFetch')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-execute-1',
          status: 'in_progress',
          toolKind: 'execute'
        })
      )
    ).toBe('Using tool: ToolExecute')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-read-1',
          status: 'completed',
          toolKind: 'read'
        })
      )
    ).toBe('Used tool: ToolRead')

    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-unknown-1',
          status: 'completed',
          toolKind: undefined
        })
      )
    ).toBe('Used tool: tool')
  })

  it('preserves known wrapper tool titles when ACP omits a tool kind', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-wrapper-1',
          title: 'ToolSearch',
          status: 'completed',
          toolKind: undefined
        })
      )
    ).toBe('Used tool: ToolSearch')
  })

  it('marks failed and active activities by status', () => {
    expect(
      formatActivityTitle(
        createActivity({
          id: 'tool-search-1',
          status: 'failed',
          toolKind: 'search'
        })
      )
    ).toBe('Tool failed: ToolSearch')

    expect(isActivityActive(createActivity({ status: 'pending' }))).toBe(true)
    expect(isActivityActive(createActivity({ status: 'in_progress' }))).toBe(true)
    expect(isActivityActive(createActivity({ status: 'completed' }))).toBe(false)
  })
})

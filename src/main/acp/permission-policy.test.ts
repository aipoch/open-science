import type { RequestPermissionRequest, ToolKind } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  canConservativelyAutoApprove,
  isWithinWorkspace,
  resolveAllowOptionId,
  resolveAutomaticPermission
} from './permission-policy'

const createPermissionRequest = (
  kind: ToolKind,
  locations?: Array<{ path: string }>,
  overrides?: {
    title?: string
    options?: RequestPermissionRequest['options']
  }
): RequestPermissionRequest => ({
  sessionId: 'session-1',
  toolCall: {
    toolCallId: 'tool-1',
    title: overrides?.title ?? 'Tool call',
    kind,
    locations
  },
  options: overrides?.options ?? [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
  ]
})

describe('permission policy', () => {
  it('accepts only paths contained by the workspace', () => {
    expect(isWithinWorkspace('src/index.ts', '/workspace/project')).toBe(true)
    expect(isWithinWorkspace('/workspace/project/data.csv', '/workspace/project')).toBe(true)
    expect(isWithinWorkspace('../secrets.txt', '/workspace/project')).toBe(false)
    expect(isWithinWorkspace('/tmp/outside.txt', '/workspace/project')).toBe(false)
  })

  it('auto-approves structured workspace reads, searches, and edits', () => {
    for (const kind of ['read', 'search', 'edit'] as const) {
      expect(
        canConservativelyAutoApprove(
          createPermissionRequest(kind, [{ path: 'results/output.csv' }]),
          '/workspace/project'
        )
      ).toBe(true)
    }
  })

  it('never auto-approves shell, network, unlocated, or outside-workspace operations', () => {
    expect(
      canConservativelyAutoApprove(
        createPermissionRequest('execute', [{ path: 'script.py' }]),
        '/workspace/project'
      )
    ).toBe(false)
    expect(
      canConservativelyAutoApprove(createPermissionRequest('fetch'), '/workspace/project')
    ).toBe(false)
    expect(
      canConservativelyAutoApprove(createPermissionRequest('read'), '/workspace/project')
    ).toBe(false)
    expect(
      canConservativelyAutoApprove(
        createPermissionRequest('edit', [{ path: '../outside.txt' }]),
        '/workspace/project'
      )
    ).toBe(false)
  })

  it('never auto-approves MCP tools even when they report a workspace-contained low-risk kind', () => {
    expect(
      canConservativelyAutoApprove(
        createPermissionRequest('read', [{ path: 'results/output.csv' }], {
          title: 'mcp__pencil__batch_get'
        }),
        '/workspace/project'
      )
    ).toBe(false)
    expect(
      canConservativelyAutoApprove(
        createPermissionRequest('edit', [{ path: 'design.pen' }], {
          title: 'mcp__pencil__batch_design'
        }),
        '/workspace/project'
      )
    ).toBe(false)
  })

  it('grants a single-use approval only, never escalating to allow_always', () => {
    const request = createPermissionRequest('read', [{ path: 'data/input.csv' }])

    expect(resolveAllowOptionId(request)).toBe('allow')
    expect(
      resolveAllowOptionId(
        createPermissionRequest('read', [{ path: 'data/input.csv' }], {
          options: [
            { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        })
      )
    ).toBe('once')
    expect(
      resolveAllowOptionId(
        createPermissionRequest('read', [{ path: 'data/input.csv' }], {
          options: [
            { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
          ]
        })
      )
    ).toBeUndefined()
  })

  it('activates fallback review only for conservative Auto', () => {
    const request = createPermissionRequest('read', [{ path: 'data/input.csv' }])

    expect(
      resolveAutomaticPermission(request, {
        profile: 'auto',
        autoReviewStrategy: 'conservative',
        cwd: '/workspace/project'
      })
    ).toBe('allow')
    expect(
      resolveAutomaticPermission(request, {
        profile: 'ask',
        autoReviewStrategy: 'conservative',
        cwd: '/workspace/project'
      })
    ).toBeUndefined()
    expect(
      resolveAutomaticPermission(request, {
        profile: 'auto',
        autoReviewStrategy: 'native',
        cwd: '/workspace/project'
      })
    ).toBeUndefined()
  })
})

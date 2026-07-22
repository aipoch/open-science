import type { RequestPermissionRequest, ToolKind } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  canConservativelyAutoApprove,
  isMcpToolName,
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

  it('recognizes MCP tool names across frameworks', () => {
    const servers = ['open-science-artifacts', 'open-science-notebook']

    // Claude namespaces MCP tools mcp__<server>__<tool> — matched by prefix regardless of server list.
    expect(isMcpToolName('mcp__pencil__batch_get', [])).toBe(true)
    // opencode joins them <server>_<tool> — matched only against the session's known server names.
    expect(isMcpToolName('open-science-artifacts_write_artifact_file', servers)).toBe(true)
    expect(isMcpToolName('open-science-notebook', servers)).toBe(true)
    // Codex uses mcp.<server>.<tool> — the generic mcp. prefix is not trusted without a known server.
    expect(isMcpToolName('mcp.open-science-notebook.notebook_execute', servers)).toBe(true)
    expect(isMcpToolName('mcp.unconfigured-server.execute', servers)).toBe(false)
    expect(isMcpToolName('mcp.unconfigured-server.execute', [])).toBe(false)
    // Built-in framework tools never collide with a server name.
    expect(isMcpToolName('edit', servers)).toBe(false)
    expect(isMcpToolName('write_artifact_file', servers)).toBe(false)
  })

  it('recognizes Codex ACP leaf names for app-owned MCP tools', () => {
    expect(isMcpToolName('execute', ['open-science-notebook'])).toBe(true)
    expect(isMcpToolName('write', ['open-science-artifacts'])).toBe(true)
    expect(isMcpToolName('execute', ['some-other-server'])).toBe(false)
  })

  it('never auto-approves opencode-named MCP tools (<server>_<tool>) reporting a low-risk kind', () => {
    // The write_artifact_file MCP tool renamed by opencode still performs arbitrary side effects, so a
    // reported edit/read kind with a workspace location must not slip through the conservative fallback.
    expect(
      canConservativelyAutoApprove(
        createPermissionRequest('edit', [{ path: 'results/output.csv' }], {
          title: 'open-science-artifacts_write_artifact_file'
        }),
        '/workspace/project',
        ['open-science-artifacts', 'open-science-notebook']
      )
    ).toBe(false)
  })

  it('still auto-approves a genuine built-in edit when MCP server names are provided', () => {
    expect(
      canConservativelyAutoApprove(
        createPermissionRequest('edit', [{ path: 'results/output.csv' }], { title: 'Edit' }),
        '/workspace/project',
        ['open-science-artifacts', 'open-science-notebook']
      )
    ).toBe(true)
  })

  it('routes opencode MCP tools to the UI under conservative Auto instead of auto-approving', () => {
    const request = createPermissionRequest('read', [{ path: 'data/input.csv' }], {
      title: 'open-science-notebook_notebook_state'
    })

    expect(
      resolveAutomaticPermission(request, {
        profile: 'auto',
        autoReviewStrategy: 'conservative',
        cwd: '/workspace/project',
        mcpServerNames: ['open-science-artifacts', 'open-science-notebook']
      })
    ).toBeUndefined()
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

  it('auto-approves everything under Full access, including shell and network', () => {
    for (const kind of ['execute', 'fetch', 'read'] as const) {
      expect(resolveAutomaticPermission(createPermissionRequest(kind), { profile: 'full' })).toBe(
        'allow'
      )
    }
  })

  it('auto-approves MCP tools under Full access (the user opted in explicitly)', () => {
    expect(
      resolveAutomaticPermission(
        createPermissionRequest('read', undefined, { title: 'mcp__pencil__batch_design' }),
        { profile: 'full' }
      )
    ).toBe('allow')
  })

  it('falls back to allow_always for Full access only when no one-shot option is offered', () => {
    const onlyAlways = createPermissionRequest('execute', undefined, {
      options: [
        { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    })

    expect(resolveAutomaticPermission(onlyAlways, { profile: 'full' })).toBe('always')
  })
})

import { SandboxNetworkApprovalOwner } from './sandbox-network-approval-owner'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import { resolvePermissionResponseSessionId } from './response-session-admission'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime session composition', () => {
  it('shares the host network approval owner across provider runtimes', () => {
    const networkApprovalOwner = new SandboxNetworkApprovalOwner()
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      permissionWait: {
        networkApprovalOwner,
        sessions: {
          readSessionRuntimeContext: async () => ({ version: 1 as const, revision: 0 }),
          patchSessionRuntimeContext: async () => ({ version: 1 as const, revision: 0 }),
          containsMessageOnActiveBranch: async () => false,
          loadSessionForContinuation: async (): Promise<never> => {
            throw new Error('Not loaded')
          }
        }
      }
    }
    const first = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
    const second = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
    expect(first.sandboxNetworkApprovalOwner).toBe(networkApprovalOwner)
    expect(second.sandboxNetworkApprovalOwner).toBe(networkApprovalOwner)
  })

  it.each([true, false])(
    'publishes pending native questions and settlement to subscribers (incremental: %s)',
    async (incremental) => {
      const onStateChanged = vi.fn()
      const options = {
        appVersion: 'test',
        defaultCwd: '/workspace',
        callbacks: { onStateChanged, ...(incremental ? { onEvent: vi.fn() } : {}) }
      }
      const owners = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
      const answer = owners.elicitationOwner.request(
        {
          mode: 'form',
          sessionId: 'provider-session',
          toolCallId: 'question-tool',
          message: 'Choose an approach',
          requestedSchema: {
            type: 'object',
            properties: { approach: { type: 'string' } },
            required: ['approach']
          }
        },
        { sessionId: 'app-session' }
      )
      expect(onStateChanged.mock.lastCall?.[0].pendingElicitations).toEqual([
        expect.objectContaining({ sessionId: 'app-session', toolCallId: 'question-tool' })
      ])
      const request = owners.elicitationOwner.getPendingRequests()[0]
      owners.elicitationOwner.respond({ requestId: request.requestId, action: 'cancel' })
      await expect(answer).resolves.toEqual({ action: 'cancel' })
      expect(onStateChanged.mock.lastCall?.[0].pendingElicitations).toEqual([])
    }
  )

  it.each(['allow-once', 'always-allow', 'deny'])(
    'removes a cancelled network approval before another %s submission',
    async (optionId) => {
      const onStateChanged = vi.fn()
      const options = {
        appVersion: 'test',
        defaultCwd: '/workspace',
        callbacks: { onStateChanged, onEvent: vi.fn() }
      }
      const owners = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
      const cancellation = new AbortController()
      const decision = owners.permissionContext.requestAppPermission({
        sessionId: 'session-network',
        title: 'Connect to tcga-xena-hub.s3.us-east-1.amazonaws.com?',
        rawInput: {
          notebookNetworkApproval: {
            hostname: 'tcga-xena-hub.s3.us-east-1.amazonaws.com',
            runtime: 'python'
          }
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
          { optionId: 'always-allow', name: 'Global', kind: 'allow_always', scope: 'global' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ],
        signal: cancellation.signal
      })
      expect(onStateChanged.mock.lastCall?.[0].pendingPermissions).toHaveLength(1)
      const requestId = owners.publication.getSnapshot().pendingPermissions[0].requestId

      cancellation.abort(new Error('MCP error -32001: Request timed out'))
      await expect(decision).resolves.toBeUndefined()
      expect(owners.publication.getSnapshot().pendingPermissions).toEqual([])
      expect(() =>
        resolvePermissionResponseSessionId(owners.publication.getSnapshot(), {
          requestId,
          optionId
        })
      ).toThrow('Unknown permission request.')
      expect(onStateChanged.mock.lastCall?.[0].pendingPermissions).toEqual([])
    }
  )

  it.each([true, false])(
    'preserves other approvals when settlement observers fail (incremental: %s)',
    async (incremental) => {
      const onStateChanged = vi.fn()
      const options = {
        appVersion: 'test',
        defaultCwd: '/workspace',
        callbacks: {
          onStateChanged,
          ...(incremental ? { onEvent: vi.fn() } : {}),
          onPermissionSettled: vi.fn(() => {
            throw new Error('Notification unavailable')
          })
        }
      }
      const owners = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
      const cancellation = new AbortController()
      const input = {
        sessionId: 'session-network',
        title: 'Connect to data.example.org?',
        rawInput: { notebookNetworkApproval: { hostname: 'data.example.org' } },
        options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' as const }]
      }
      const cancelled = owners.permissionContext.requestAppPermission({
        ...input,
        signal: cancellation.signal
      })
      const other = owners.permissionContext.requestAppPermission({
        ...input,
        sessionId: 'other-session'
      })
      const retained = owners.publication.getSnapshot().pendingPermissions[1]
      cancellation.abort()
      await expect(cancelled).resolves.toBeUndefined()
      expect(onStateChanged.mock.lastCall?.[0].pendingPermissions).toEqual([retained])
      await owners.permissionContext.respondToPermission(
        { requestId: retained.requestId, optionId: 'deny' },
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
      await expect(other).resolves.toBe('deny')
      expect(onStateChanged.mock.lastCall?.[0].pendingPermissions).toEqual([])
    }
  )

  it.each(['allow-once', 'always-allow', 'deny'])(
    'accepts a live network approval decision: %s',
    async (optionId) => {
      const options = { appVersion: 'test', defaultCwd: '/workspace' }
      const owners = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
      const decision = owners.permissionContext.requestAppPermission({
        sessionId: 'session-network',
        title: 'Connect to tcga-xena-hub.s3.us-east-1.amazonaws.com?',
        rawInput: {
          notebookNetworkApproval: {
            hostname: 'tcga-xena-hub.s3.us-east-1.amazonaws.com',
            runtime: 'python'
          }
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
          { optionId: 'always-allow', name: 'Global', kind: 'allow_always', scope: 'global' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
      })
      const request = owners.publication.getSnapshot().pendingPermissions[0]
      const response = { requestId: request.requestId, optionId }
      expect(resolvePermissionResponseSessionId(owners.publication.getSnapshot(), response)).toBe(
        'session-network'
      )
      await expect(
        owners.permissionContext.respondToPermission(response, HUMAN_PERMISSION_ACTION_ORIGIN)
      ).resolves.toBe(true)
      await expect(decision).resolves.toBe(optionId)
    }
  )

  it('builds a fresh frozen owner graph around the supplied base owners', () => {
    const contextUsageTracker = new ContextUsageTracker()
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      contextUsageTracker
    }
    const firstBase = composeAcpRuntimeBaseOwners(options)
    const secondBase = composeAcpRuntimeBaseOwners(options)
    const first = composeAcpRuntimeSessionOwners(options, firstBase)
    const second = composeAcpRuntimeSessionOwners(options, secondBase)

    expect(Object.isFrozen(first)).toBe(true)
    expect(first.sessionRegistry).not.toBe(second.sessionRegistry)
    expect(first.sessionEnvironment).not.toBe(second.sessionEnvironment)
    expect(first.contextUsagePolicy).not.toBe(second.contextUsagePolicy)
    expect(first.publication).not.toBe(second.publication)
    expect(first.permissionContext).not.toBe(second.permissionContext)
    expect(first.reviewerSessions).not.toBe(second.reviewerSessions)
    expect(first.sessionUpdateProjector).not.toBe(second.sessionUpdateProjector)
    expect(first.publication.getSnapshot()).toMatchObject({
      cwd: resolve('/workspace'),
      sessionIds: [],
      contextUsageBySession: {}
    })
  })
})

it.each(['allow-once', 'reject-once'])(
  'keeps host provenance on the pending and %s review receipt',
  async (optionId) => {
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      callbacks: { onEvent: vi.fn() }
    }
    const owners = composeAcpRuntimeSessionOwners(options, composeAcpRuntimeBaseOwners(options))
    const decision = owners.permissionContext.requestAppPermission({
      sessionId: 'session-review',
      title: 'Review code',
      rawInput: {
        code: 'os.unlink(path)',
        notebookCodeRisk: {
          language: 'python',
          risks: [{ operation: 'os.unlink', source: 'os.unlink(path)', line: 1 }]
        }
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' }
      ]
    })
    const request = owners.publication.getSnapshot().pendingPermissions[0]
    await owners.permissionContext.respondToPermission(
      { requestId: request.requestId, optionId },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await expect(decision).resolves.toBe(optionId)
    const events = owners.publication.getSnapshot().events.filter((event) => event.kind === 'tool')
    expect(events).toHaveLength(2)
    expect(
      events.every((event) => event.appOwned === true && event.toolCallId === request.toolCallId)
    ).toBe(true)
    expect(events[1].status).toBe('completed')
  }
)

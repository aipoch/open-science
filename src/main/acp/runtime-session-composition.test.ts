import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { HUMAN_PERMISSION_ACTION_ORIGIN } from './permission-context'
import { resolvePermissionResponseSessionId } from './response-session-admission'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime session composition', () => {
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

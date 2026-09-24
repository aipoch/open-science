import { describe, expect, it } from 'vitest'
import { AcpPermissionBroker } from './permission-broker'
import { AcpRuntimePublicationOwner, projectPermissionRequest } from './runtime-publication-owner'
import { AcpRuntimeSnapshotOwner, type RuntimeSnapshotProjection } from './runtime-snapshot-owner'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { AcpPermissionRequest } from '../../shared/acp'
import { MAX_APPROVAL_PLAN_CHARS } from '../../shared/approval-plan-preview'

describe('production concrete plan projection', () => {
  it.each(['skill-publication', 'agent-configuration', 'package-installation'])(
    'preserves complete >8KB %s review through broker, publication, snapshot and coordinator re-projection',
    async (kind) => {
      const content = 'first\n' + '审阅 exact content\n'.repeat(1500) + 'LAST LINE'
      const plan = {
        kind,
        changes: { systemPrompt: content },
        files: [{ path: 'SKILL.md', content }]
      }
      const projection: RuntimeSnapshotProjection = {
        sessionIds: ['s'],
        pendingPermissions: [],
        permissionProfiles: {},
        permissionGrants: {},
        contextUsageBySession: {},
        promptInFlight: false,
        promptInFlightSessionIds: []
      }
      let published: AcpPermissionRequest | undefined
      const owner = new AcpRuntimePublicationOwner({
        snapshotOwner: new AcpRuntimeSnapshotOwner('/workspace'),
        interactions: new AcpSessionInteractionOwner(),
        snapshotProjection: () => projection,
        callbacks: {
          onPermissionRequest: (request) => {
            published = projectPermissionRequest(request)
          }
        }
      })
      const broker = new AcpPermissionBroker((request) => {
        projection.pendingPermissions = [request]
        owner.publishPermissionRequest(request)
      })
      const response = broker.requestAppApproval({
        sessionId: 's',
        title: 'Review',
        rawInput: {},
        configurationPlan: plan
      })
      expect(published?.approvalPlan?.json.length).toBeGreaterThan(8000)
      expect(JSON.parse(published!.approvalPlan!.json)).toEqual(plan)
      const snapshot = owner.getSnapshot().pendingPermissions[0]
      expect(projectPermissionRequest(snapshot).approvalPlan).toEqual(published!.approvalPlan)
      await broker.respond({
        requestId: published!.requestId,
        optionId: published!.options[0].optionId
      })
      expect(await response).toBe(true)
    }
  )
  it('rejects unsupported-size plans before publishing any allow option', () => {
    const published: AcpPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => published.push(request))
    expect(() =>
      broker.requestAppApproval({
        sessionId: 's',
        title: 'Review',
        rawInput: {},
        configurationPlan: {
          kind: 'skill-publication',
          content: 'x'.repeat(MAX_APPROVAL_PLAN_CHARS)
        }
      })
    ).toThrow('review size')
    expect(published).toEqual([])
  })
  it('retains the ordinary provider payload cap', () => {
    const request = projectPermissionRequest({
      requestId: 'r',
      sessionId: 's',
      toolCallId: 't',
      title: 'tool',
      rawInput: { content: 'x'.repeat(9000) },
      options: []
    })
    expect(request.rawInput).toBeUndefined()
  })
})

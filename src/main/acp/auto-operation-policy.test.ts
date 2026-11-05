import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  resolveAutoOperation,
  resolveAutomaticPermission,
  withTrustedMcpToolIdentity,
  type PermissionPolicyContext
} from './permission-policy'

const plan = {
  task_summary: 'Review the data',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Main',
          steps: [{ title: 'Inspect', description: 'Inspect data and report findings.' }]
        }
      ]
    }
  ],
  desired_outputs: ['Findings'],
  feasibility: { confidence: 'high', rationale: 'Data is available.' }
}
const request = (identity: string, rawInput: unknown, trusted = true): RequestPermissionRequest => {
  const params: RequestPermissionRequest = {
    sessionId: 'session',
    toolCall: {
      toolCallId: 'call',
      title: identity,
      kind: 'other',
      rawInput,
      _meta: { toolName: identity }
    },
    options: [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
  }
  return trusted ? withTrustedMcpToolIdentity(params, identity) : params
}
const context: PermissionPolicyContext = {
  profile: 'auto',
  autoReviewStrategy: 'conservative',
  mcpServerNames: ['open-science-notebook', 'open-science-plan', 'open-science-skills']
}
const cases = [
  [
    'open-science-notebook/background_run',
    { action: 'query', runId: 'run' },
    'allow_once',
    'background_run_query'
  ],
  [
    'open-science-notebook/background_run',
    { action: 'cancel', submissionIdentity: 'submission' },
    'allow_once',
    'background_run_cancel'
  ],
  [
    'open-science-notebook/manage_environments',
    { action: 'list', language: 'python', offset: 0, limit: 1 },
    'allow_once',
    'environment_list'
  ],
  ['open-science-plan/generate_plan', plan, 'inner_authorization', 'plan_content_review'],
  [
    'open-science-plan/generate_plan',
    { decision: 'approved' },
    'inner_authorization',
    'plan_record_approved'
  ],
  [
    'open-science-plan/generate_plan',
    { decision: 'rejected' },
    'inner_authorization',
    'plan_record_rejected'
  ],
  [
    'open-science-plan/generate_plan',
    { approve: true },
    'inner_authorization',
    'plan_record_approved'
  ],
  [
    'open-science-skills/request_skill_import',
    { github_url: 'https://github.com/owner/repo/tree/main/skill' },
    'inner_authorization',
    'skill_import_preview'
  ],
  [
    'open-science-skills/request_skill_import',
    { attachment_uri: 'file:///tmp/skill.zip', turn_token: '11111111-1111-4111-8111-111111111111' },
    'inner_authorization',
    'skill_import_preview'
  ]
] as const

describe('Auto operation policy through the public permission entry', () => {
  it.each(cases)('classifies %s without a remembered grant', (identity, input, kind, reason) => {
    for (const autoReviewStrategy of ['native', 'conservative'] as const) {
      const policy = { ...context, autoReviewStrategy }
      const params = request(identity, input)
      expect(resolveAutoOperation(params, policy)).toEqual({ kind, reason })
      expect(resolveAutomaticPermission(params, policy)).toBe('once')
    }
  })

  it.each(cases)(
    'requires trusted identity, configured server and one-time option for %s',
    (identity, input) => {
      expect(resolveAutomaticPermission(request(identity, input, false), context)).toBeUndefined()
      expect(
        resolveAutomaticPermission(request(identity, input), { ...context, mcpServerNames: [] })
      ).toBeUndefined()
      const params = request(identity, input)
      params.options = params.options.filter((option) => option.kind !== 'allow_once')
      expect(resolveAutomaticPermission(params, context)).toBeUndefined()
      expect(
        resolveAutomaticPermission(request(identity, input), { ...context, profile: 'ask' })
      ).toBeUndefined()
      expect(
        resolveAutomaticPermission(request(identity, input), { ...context, profile: 'full' })
      ).toBe('once')
    }
  )

  it.each([
    ['open-science-notebook/background_run', { action: 'start', runId: 'run' }],
    ['open-science-notebook/background_run', { action: 'query' }],
    ['open-science-notebook/background_run', { action: 'query', runId: 1 }],
    [
      'open-science-notebook/background_run',
      { action: 'cancel', runId: 'run', sessionId: 'other' }
    ],
    ['open-science-notebook/manage_environments', { action: 'create', name: 'new' }],
    ['open-science-notebook/manage_environments', { action: 'remove', name: 'old' }],
    ['open-science-notebook/manage_environments', { action: 'list', limit: -1 }],
    ['open-science-notebook/manage_environments', { action: 'list', execute: 'code' }],
    ['open-science-plan/generate_plan', { decision: 'maybe' }],
    ['open-science-plan/generate_plan', { approve: false }],
    ['open-science-plan/generate_plan', { decision: 'approved', approve: true }],
    ['open-science-plan/generate_plan', { decision: 'rejected', approve: true }],
    ['open-science-plan/generate_plan', { decision: 'approved', revision: 1 }],
    ['open-science-plan/generate_plan', {}],
    ['open-science-plan/generate_plan', { ...plan, decision: 'approved' }],
    ['open-science-plan/generate_plan', { ...plan, approve: true }],
    ['open-science-plan/generate_plan', { ...plan, phases: [] }],
    ['open-science-plan/generate_plan', { task_summary: 'incomplete' }],
    ['open-science-skills/request_skill_import', {}],
    ['open-science-skills/request_skill_import', { github_url: 'https://example.com/skill' }],
    ['open-science-skills/request_skill_import', { attachment_uri: 'file:///tmp/skill.zip' }],
    [
      'open-science-skills/request_skill_import',
      {
        github_url: 'https://github.com/owner/repo',
        turn_token: '11111111-1111-4111-8111-111111111111'
      }
    ],
    ['open-science-notebook/new_tool', { action: 'list' }],
    ['third-party/background_run', { action: 'query', runId: 'run' }]
  ])('retains legacy handling for invalid or excluded %s (%j)', (identity, input) => {
    expect(resolveAutoOperation(request(identity, input), context)).toEqual({ kind: 'legacy' })
    expect(resolveAutomaticPermission(request(identity, input), context)).toBeUndefined()
  })

  it('does not reinterpret invalid managed operations as conservative thinking', () => {
    for (const identity of [...cases.map(([name]) => name), 'third-party/unknown']) {
      const params = request(identity, { action: 'unknown' })
      params.toolCall = { toolCallId: 'call', kind: 'think', rawInput: { action: 'unknown' } }
      expect(resolveAutomaticPermission(params, context)).toBeUndefined()
      expect(resolveAutomaticPermission(params, { ...context, mcpServerNames: [] })).toBeUndefined()
    }
  })

  it('does not allow malformed root inputs', () => {
    for (const [identity] of cases) {
      for (const input of [null, undefined, [], 'list', 1]) {
        expect(resolveAutomaticPermission(request(identity, input), context)).toBeUndefined()
      }
    }
  })
})

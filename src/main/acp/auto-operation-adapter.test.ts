import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import { codexFramework } from '../agent-framework'
import { resolveCategoryKey } from './permission-broker'
import { AcpPermissionContext } from './permission-context'
import { resolveAutomaticPermission, trustedMcpToolIdentity } from './permission-policy'

const routing = {
  resolveAppSessionId: (id: string) => id,
  sessionSnapshot: () => ({
    cwd: '/workspace',
    frameworkId: 'codex' as const,
    permissionProfile: { selectedProfile: 'auto' as const }
  }),
  hasActivePrimarySession: () => true,
  capturePrompt: () => undefined,
  currentInteractionSequence: () => undefined,
  mcpServerNamesFor: () => [],
  reviewerContextFor: () => undefined,
  resolveReviewerPermission: () => undefined,
  currentFramework: () => codexFramework,
  resolveProjectId: () => 'probe'
}

const cases = [
  ['open-science-plan', 'generate_plan', { decision: 'approved' }],
  ['open-science-plan', 'generate_plan', { decision: 'rejected' }],
  ['open-science-plan', 'generate_plan', { approve: true }],
  ['open-science-notebook', 'background_run', { action: 'query', runId: 'run-1' }],
  ['open-science-notebook', 'background_run', { action: 'cancel', runId: 'run-1' }],
  ['open-science-notebook', 'manage_environments', { action: 'list' }],
  [
    'open-science-plan',
    'generate_plan',
    {
      task_summary: 'Probe plan',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [{ title: 'Analyze', description: 'Produce results.' }]
            }
          ]
        }
      ],
      desired_outputs: ['Result'],
      feasibility: { confidence: 'high', rationale: 'Ready.' }
    }
  ],
  [
    'open-science-skills',
    'request_skill_import',
    { github_url: 'https://github.com/owner/repo/tree/main/skill' }
  ]
] as const

// Exercise the real provider observation/restoration seam, without stamping trusted symbols in tests.
describe.each(['claude-code', 'codebuddy', 'opencode', 'codex'] as const)(
  '%s Auto operation identity correlation',
  (framework) => {
    it.each(cases)(
      'restores %s/%s from matching provider observations',
      async (server, tool, input) => {
        const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn(), routing })
        const title = modelFacingAppMcpToolName(framework, server, tool)
        const restoreContext = {
          sessionId: 'session',
          framework,
          mcpServerNames: [server],
          isCancelled: () => false
        }
        const request: RequestPermissionRequest = {
          sessionId: 'session',
          toolCall: { toolCallId: 'call', title, kind: 'other', status: 'pending' },
          options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }],
          ...(framework === 'codex' ? { _meta: { is_mcp_tool_approval: true } } : {})
        }
        try {
          context.observeToolCall(
            {
              sessionId: 'session',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call',
                title,
                kind: 'other',
                status: 'pending',
                rawInput: framework === 'codex' ? { server, tool, arguments: input } : input,
                _meta: framework === 'codex' ? { is_mcp_tool_call: true } : { toolName: title }
              }
            },
            restoreContext
          )
          const restored = await context.restoreToolCall(request, restoreContext)
          if (framework === 'codebuddy') {
            expect(trustedMcpToolIdentity(restored!)).toBeUndefined()
            expect(restored?.toolCall).toBe(request.toolCall)
          } else {
            expect(trustedMcpToolIdentity(restored!)).toBe(`${server}/${tool}`)
            expect(restored?.toolCall.rawInput).toEqual(input)
          }
          expect(restored?.options).toEqual(request.options)
          for (const autoReviewStrategy of ['native', 'conservative'] as const) {
            const policy = {
              profile: 'auto' as const,
              frameworkId: framework,
              mcpServerNames: [server],
              autoReviewStrategy
            }
            expect(resolveAutomaticPermission(restored!, policy)).toBe('once')
            expect(
              resolveAutomaticPermission({ ...restored!, options: [] }, policy)
            ).toBeUndefined()
            expect(
              resolveAutomaticPermission(
                { ...restored!, toolCall: { ...restored!.toolCall, rawInput: { unknown: true } } },
                policy
              )
            ).toBeUndefined()
            expect(resolveAutomaticPermission(request, policy)).toBeUndefined()
          }
        } finally {
          context.dispose()
        }
      }
    )

    it('does not restore a cleared session or reuse another call identity', async () => {
      const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn(), routing })
      const server = 'open-science-notebook'
      const tool = 'background_run'
      const title = modelFacingAppMcpToolName(framework, server, tool)
      const input = { action: 'query', runId: 'run-1' }
      const restoreContext = {
        sessionId: 'session',
        framework,
        mcpServerNames: [server],
        isCancelled: () => false
      }
      const request: RequestPermissionRequest = {
        sessionId: 'session',
        toolCall: {
          toolCallId: 'other-call',
          title,
          kind: 'other',
          status: 'pending',
          rawInput: input
        },
        options: [],
        ...(framework === 'codex' ? { _meta: { is_mcp_tool_approval: true } } : {})
      }
      try {
        context.observeToolCall(
          {
            sessionId: 'session',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call',
              title,
              kind: 'other',
              status: 'pending',
              rawInput: framework === 'codex' ? { server, tool, arguments: input } : input,
              _meta: framework === 'codex' ? { is_mcp_tool_call: true } : { toolName: title }
            }
          },
          restoreContext
        )
        request.options = [{ optionId: 'once', name: 'Once', kind: 'allow_once' }]
        const policy = {
          profile: 'auto' as const,
          frameworkId: framework,
          mcpServerNames: [server]
        }
        const wrongCall = (await context.restoreToolCall(request, restoreContext))!
        expect(trustedMcpToolIdentity(wrongCall)).toBeUndefined()
        expect(resolveAutomaticPermission(wrongCall, policy)).toBeUndefined()
        context.clearCorrelationsForSession('session')
        request.toolCall.toolCallId = 'call'
        const cleared = (await context.restoreToolCall(request, restoreContext))!
        expect(trustedMcpToolIdentity(cleared)).toBeUndefined()
        expect(resolveAutomaticPermission(cleared, policy)).toBeUndefined()
      } finally {
        context.dispose()
      }
    })
  }
)

it.each([
  ['open-science-library', 'search_library'],
  ['open-science-artifacts', 'write_artifact_file'],
  ['open-science-notebook', 'notebook_restart']
])('preserves unrelated CodeBuddy metadata for %s/%s', async (server, tool) => {
  const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn(), routing })
  const title = modelFacingAppMcpToolName('codebuddy', server, tool)
  const restoreContext = {
    sessionId: 'session',
    framework: 'codebuddy' as const,
    mcpServerNames: [server],
    isCancelled: () => false
  }
  const request: RequestPermissionRequest = {
    sessionId: 'session',
    toolCall: { toolCallId: 'call', title, kind: 'other', status: 'pending' },
    options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }]
  }
  try {
    context.observeToolCall(
      {
        sessionId: 'session',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call',
          title,
          kind: 'other',
          status: 'pending',
          rawInput: { query: 'example' },
          _meta: { toolName: title }
        }
      },
      restoreContext
    )
    expect(await context.restoreToolCall(request, restoreContext)).toBe(request)
  } finally {
    context.dispose()
  }
})

it.each(['list', 'create', 'remove'] as const)(
  'keeps CodeBuddy %s grant identity unchanged while Auto uses verified arguments',
  async (action) => {
    const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn(), routing })
    const server = 'open-science-notebook'
    const title = modelFacingAppMcpToolName('codebuddy', server, 'manage_environments')
    const input = { action, name: 'analysis', language: 'python' }
    const request: RequestPermissionRequest = {
      sessionId: 'session',
      toolCall: { toolCallId: 'call', title, kind: 'other' },
      options: [{ optionId: 'once', name: 'Once', kind: 'allow_once' }]
    }
    const restoreContext = {
      sessionId: 'session',
      framework: 'codebuddy' as const,
      mcpServerNames: [server],
      isCancelled: () => false
    }
    try {
      context.observeToolCall(
        {
          sessionId: 'session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call',
            title,
            kind: 'other',
            status: 'pending',
            rawInput: input,
            _meta: { toolName: title }
          }
        },
        restoreContext
      )
      const restored = (await context.restoreToolCall(request, restoreContext))!
      expect(restored.toolCall).toBe(request.toolCall)
      expect(trustedMcpToolIdentity(restored)).toBeUndefined()
      // The actual durable-grant categorizer must still refuse a title-only identity.
      expect(resolveCategoryKey(request, [server], false)).toBeUndefined()
      expect(resolveCategoryKey(restored, [server], false)).toBeUndefined()
      for (const profile of ['ask', 'auto', 'full'] as const) {
        expect(
          resolveAutomaticPermission(restored, {
            profile,
            frameworkId: 'codebuddy',
            mcpServerNames: [server],
            autoReviewStrategy: 'conservative'
          })
        ).toBe(profile === 'full' || (profile === 'auto' && action === 'list') ? 'once' : undefined)
      }
      // Correlation is one-use and cannot promote the subsequent request to a durable identity.
      expect(await context.restoreToolCall(request, restoreContext)).toBe(request)
    } finally {
      context.dispose()
    }
  }
)

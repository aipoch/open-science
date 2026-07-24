import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { AcpPermissionBroker, ConversationPermissionGrantStore } from './permission-broker'

type EmittedPermissionRequest = Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0]

const getSessionOptionId = (request: EmittedPermissionRequest): string => {
  const optionId = request.options.find((option) => option.scope === 'session')?.optionId

  if (!optionId) throw new Error('Expected an Open Science session option')
  return optionId
}

// Builds the serializable permission request shape used by broker tests.
const createPermissionRequest = (sessionId = 'session-1'): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Run command',
    status: 'pending'
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
})

// Builds a notebook tool permission request that also offers an "always allow" option.
const createNotebookPermissionRequest = (
  sessionId = 'session-1',
  title = 'mcp__open-science-notebook__notebook_execute',
  rawInput?: unknown
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${Math.random()}`,
    title,
    status: 'pending',
    rawInput: rawInput ?? { language: 'python' }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
})

// Builds a built-in tool request; provider tool name and execute kind emulate Claude Code metadata.
const createToolPermissionRequest = (
  options: {
    sessionId?: string
    title?: string
    providerToolName?: string
    kind?: RequestPermissionRequest['toolCall']['kind']
    locations?: RequestPermissionRequest['toolCall']['locations']
    rawInput?: unknown
  } = {}
): RequestPermissionRequest => {
  const {
    sessionId = 'session-1',
    title = 'Run tool',
    providerToolName,
    kind,
    locations,
    rawInput
  } = options

  return {
    sessionId,
    toolCall: {
      toolCallId: `tool-${Math.random()}`,
      title,
      status: 'pending',
      kind,
      locations,
      rawInput,
      _meta: providerToolName ? { claudeCode: { toolName: providerToolName } } : undefined
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
    ]
  }
}

const createCodexCommandPermissionRequest = (
  sessionId = 'session-1'
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${Math.random()}`,
    title: 'git worktree add -b fix/example ../example main',
    status: 'pending',
    kind: 'execute',
    rawInput: { command: 'git worktree add -b fix/example ../example main' }
  },
  options: [
    { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Allow for Session', kind: 'allow_always' },
    {
      optionId: 'accept_execpolicy_amendment',
      name: 'Allow Commands Starting With `git worktree add`',
      kind: 'allow_always'
    },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
  ]
})

// Codex MCP requests send two allow_always variants: a session-scoped one and a persistent one.
const createCodexMcpPermissionRequest = (sessionId = 'session-1'): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${Math.random()}`,
    title: 'mcp.open-science-notebook.notebook_execute',
    status: 'pending',
    rawInput: { language: 'python' }
  },
  options: [
    { optionId: 'allow_session', name: 'Allow for This Session', kind: 'allow_always' },
    { optionId: 'allow_always', name: "Allow and Don't Ask Again", kind: 'allow_always' },
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
  ]
})

describe('ACP permission broker', () => {
  it('keeps session grants app-owned while the Agent receives one-shot approvals', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const firstResponse = broker.requestPermission(
      createToolPermissionRequest({
        title: 'python train.py',
        providerToolName: 'Bash',
        rawInput: { command: 'python train.py' }
      })
    )
    const sessionOption = emitted[0].options.find((option) => option.scope === 'session')

    expect(sessionOption).toMatchObject({ name: 'This conversation', scope: 'session' })
    expect(emitted[0].options.some((option) => option.optionId === 'allow-always')).toBe(false)

    broker.respond({ requestId: emitted[0].requestId, optionId: sessionOption?.optionId })

    await expect(firstResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(broker.listGrants('session-1')).toEqual([expect.objectContaining({ scope: 'session' })])

    await expect(
      broker.requestPermission(
        createToolPermissionRequest({
          title: 'python train.py',
          providerToolName: 'Bash',
          rawInput: { command: 'python train.py' }
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(emitted).toHaveLength(1)
  })

  it('offers no session scope when the permission category is not stable', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    void broker.requestPermission(createToolPermissionRequest({ title: 'Run tool' }))

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
  })

  it('offers an app-owned session scope without a native remember option', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createToolPermissionRequest({
      title: 'python train.py',
      providerToolName: 'Bash',
      rawInput: { command: 'python train.py' }
    })
    request.options = request.options.filter((option) => option.kind !== 'allow_always')

    const response = broker.requestPermission(request)

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session'
    ])
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await expect(response).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
  })

  it('offers a conversation scope for a stable file operation without target locations', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'Write report.md',
        providerToolName: 'Write',
        kind: 'edit'
      })
    )

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session'
    ])
  })

  it('requires a stable server and tool identity before offering MCP session scope', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    void broker.requestPermission(
      createToolPermissionRequest({ title: 'open-science-notebook', kind: 'execute' }),
      { profile: 'ask', mcpServerNames: ['open-science-notebook'] }
    )

    expect(emitted[0]).toMatchObject({ isMcp: true })
    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
  })

  it('preserves structured tool metadata for risk-aware approval UI', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createToolPermissionRequest({
      title: 'Edit results.csv',
      providerToolName: 'Edit',
      kind: 'edit'
    })
    request.toolCall.locations = [{ path: '/workspace/results.csv' }]
    request.toolCall.rawInput = { file_path: '/workspace/results.csv', value: 'updated' }

    void broker.requestPermission(request)

    expect(emitted[0]).toMatchObject({
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/workspace/results.csv' }],
      rawInput: { file_path: '/workspace/results.csv', value: 'updated' }
    })
    expect(emitted[0]).not.toHaveProperty('raw')
  })

  it('preserves an explicit shell title when raw input also contains a command', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createToolPermissionRequest({
      title: 'Build project',
      providerToolName: 'Bash',
      kind: 'execute'
    })
    request.toolCall.rawInput = { command: './build.sh --verbose' }

    const response = broker.requestPermission(request)

    expect(emitted[0].title).toBe('Build project')
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await response
    expect(broker.listGrants('session-1')).toEqual([
      {
        categoryKey: 'shell:./build.sh --verbose',
        kind: 'shell',
        label: './build.sh --verbose',
        scope: 'session'
      }
    ])
  })

  it('auto-approves only conservative Auto operations accepted by policy', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))
    const request = createToolPermissionRequest({ kind: 'read' })
    request.toolCall.locations = [{ path: 'data/results.csv' }]

    await expect(
      broker.requestPermission(request, {
        profile: 'auto',
        autoReviewStrategy: 'conservative',
        cwd: '/workspace'
      })
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(emittedRequests).toEqual([])
  })

  it('emits a serializable permission request and resolves the selected option', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const responsePromise = broker.requestPermission(createPermissionRequest())
    const [requestId] = emittedRequests

    broker.respond({ requestId, optionId: 'allow-once' })

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once'
      }
    })
  })

  it('projects Codex commands to Open Science once and session scopes', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const context = { profile: 'ask' as const, frameworkId: 'codex' as const }

    const firstResponse = broker.requestPermission(createCodexCommandPermissionRequest(), context)

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session'
    ])
    expect(emitted[0].options.map((option) => option.optionId)).not.toContain('allow_always')

    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await expect(firstResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' }
    })

    await expect(
      broker.requestPermission(createCodexCommandPermissionRequest(), context)
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })

    const otherSessionResponse = broker.requestPermission(
      createCodexCommandPermissionRequest('session-2'),
      context
    )
    expect(emitted).toHaveLength(2)
    broker.cancelForSession('session-2')
    await expect(otherSessionResponse).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('removes Codex policy amendments when execute metadata is absent', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createCodexCommandPermissionRequest()
    request.toolCall.kind = undefined

    void broker.requestPermission(request, { profile: 'ask', frameworkId: 'codex' })

    expect(emitted[0].options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_once'
    ])
  })

  it('removes policy amendments while retaining the app-owned session scope', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createCodexCommandPermissionRequest()
    request.options = request.options.filter((option) => option.optionId !== 'allow_always')
    request.options.splice(2, 0, {
      optionId: 'accept_networkpolicy_amendment',
      name: 'Allow network access persistently',
      kind: 'allow_always'
    })

    void broker.requestPermission(request, { profile: 'ask', frameworkId: 'codex' })

    expect(emitted[0].options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_once',
      getSessionOptionId(emitted[0])
    ])
    expect(emitted[0].options.map((option) => option.optionId)).not.toContain(
      'accept_networkpolicy_amendment'
    )
  })

  it('does not expose a provider-owned persistent reject option', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createToolPermissionRequest({
      title: 'python train.py',
      providerToolName: 'Bash'
    })
    request.options.push({
      optionId: 'reject-always',
      name: 'Reject always',
      kind: 'reject_always'
    })

    void broker.requestPermission(request)

    expect(emitted[0].options.map((option) => option.optionId)).not.toContain('reject-always')
  })

  it('replaces Codex MCP remember options with one app-owned session scope', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    void broker.requestPermission(createCodexMcpPermissionRequest(), {
      profile: 'ask',
      frameworkId: 'codex',
      mcpServerNames: ['open-science-notebook']
    })

    expect(emitted[0].options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'decline',
      getSessionOptionId(emitted[0])
    ])
    expect(emitted[0].options.find((option) => option.scope === 'session')).toMatchObject({
      name: 'This conversation',
      kind: 'allow_always'
    })
  })

  it('projects one app-owned session scope regardless of native remember-option order', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createCodexMcpPermissionRequest()
    // Reverse the option order to verify the filter is ID-based, not position-based.
    request.options = [
      { optionId: 'allow_always', name: "Allow and Don't Ask Again", kind: 'allow_always' },
      { optionId: 'allow_session', name: 'Allow for This Session', kind: 'allow_always' },
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
    ]

    void broker.requestPermission(request, {
      profile: 'ask',
      frameworkId: 'codex',
      mcpServerNames: ['open-science-notebook']
    })

    expect(emitted[0].options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'decline',
      getSessionOptionId(emitted[0])
    ])
  })

  it('does not pass through a native MCP remember option even when it is the only one', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createCodexMcpPermissionRequest()
    request.options = [
      { optionId: 'allow_session', name: 'Allow for This Session', kind: 'allow_always' },
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
    ]

    void broker.requestPermission(request, {
      profile: 'ask',
      frameworkId: 'codex',
      mcpServerNames: ['open-science-notebook']
    })

    expect(emitted[0].options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'decline',
      getSessionOptionId(emitted[0])
    ])
  })

  it('does not auto-select a Codex amendment under Full Access when it is the only allow option', () => {
    const emitted: Array<Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0]> = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createCodexCommandPermissionRequest()
    // Only the persistent policy amendment remains as an allow-kind option.
    request.options = request.options.filter(
      (option) => option.optionId !== 'allow_once' && option.optionId !== 'allow_always'
    )

    void broker.requestPermission(request, { profile: 'full', frameworkId: 'codex' })

    // The amendment is projected away, so Full Access finds no allow option and must prompt instead
    // of auto-approving a grant that persists outside the app's revocable model.
    expect(emitted).toHaveLength(1)
    expect(emitted[0].options.map((option) => option.optionId)).toEqual(['reject_once'])
  })

  it('cancels a Codex policy amendment response that was not exposed', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))
    const response = broker.requestPermission(createCodexCommandPermissionRequest(), {
      profile: 'ask',
      frameworkId: 'codex'
    })

    broker.respond({
      requestId: emittedRequests[0],
      optionId: 'accept_execpolicy_amendment'
    })

    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(broker.listGrants('session-1')).toEqual([])
  })

  it('cancels pending requests without dropping conversation grants during a reconnect', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const grantedResponse = broker.requestPermission(
      createToolPermissionRequest({
        title: 'python train.py',
        providerToolName: 'Bash',
        rawInput: { command: 'python train.py' }
      })
    )
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: getSessionOptionId(emitted[0])
    })
    await grantedResponse

    const responsePromise = broker.requestPermission(createPermissionRequest('session-2'))

    broker.cancelAllPending()

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
    expect(broker.listGrants('session-1')).toEqual([expect.objectContaining({ scope: 'session' })])
  })

  it('auto-approves later notebook calls after the user picks This conversation', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    // First notebook request prompts; the user chooses the app-owned session option.
    const firstResponse = broker.requestPermission(createNotebookPermissionRequest())
    expect(emitted).toHaveLength(1)
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await expect(firstResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })

    // A later same-session notebook call resolves immediately as allowed, emitting no new prompt.
    const secondResponse = broker.requestPermission(createNotebookPermissionRequest())

    await expect(secondResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emitted).toHaveLength(1)
    expect(broker.getPendingRequests()).toHaveLength(0)
  })

  it('keeps prompting for notebook calls in other sessions and after allow-once', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    // allow_once must NOT establish a standing always-allow.
    const onceResponse = broker.requestPermission(createNotebookPermissionRequest('session-1'))
    broker.respond({ requestId: emitted[0].requestId, optionId: 'allow-once' })
    await onceResponse
    broker.requestPermission(createNotebookPermissionRequest('session-1'))
    expect(emitted).toHaveLength(2)

    // Always in session-1 does not leak into session-2.
    broker.respond({ requestId: emitted[1].requestId, optionId: getSessionOptionId(emitted[1]) })
    broker.requestPermission(createNotebookPermissionRequest('session-2'))
    expect(emitted).toHaveLength(3)
  })

  it('cancels only pending requests for the selected session', async () => {
    const broker = new AcpPermissionBroker(() => undefined)

    const firstResponsePromise = broker.requestPermission(createPermissionRequest('session-1'))
    const secondResponsePromise = broker.requestPermission(createPermissionRequest('session-2'))

    broker.cancelForSession('session-1')

    await expect(firstResponsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
    expect(broker.getPendingRequests().map((request) => request.sessionId)).toEqual(['session-2'])

    broker.cancelForSession('session-2')

    await expect(secondResponsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
  })

  it('clears grants when the owning Agent session ends', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createToolPermissionRequest({
      title: 'python train.py',
      providerToolName: 'Bash',
      rawInput: { command: 'python train.py' }
    })
    const firstResponse = broker.requestPermission(request)
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstResponse

    broker.clearSession('session-1')
    void broker.requestPermission(request)

    expect(emitted).toHaveLength(2)
    expect(broker.listGrants('session-1')).toEqual([])
  })

  it('applies a conversation grant to the same file operation across target paths', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const firstWrite = broker.requestPermission(
      createToolPermissionRequest({
        title: 'Write report.md',
        providerToolName: 'Write',
        kind: 'edit',
        locations: [{ path: 'report.md' }]
      }),
      { profile: 'ask', cwd: '/workspace' }
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstWrite
    expect(broker.listGrants('session-1')).toEqual([
      expect.objectContaining({
        kind: 'tool',
        label: 'Write',
        scope: 'session'
      })
    ])

    await expect(
      broker.requestPermission(
        createToolPermissionRequest({
          title: 'Write report.md',
          providerToolName: 'Write',
          kind: 'edit',
          locations: [{ path: '/workspace/report.md' }]
        }),
        { profile: 'ask', cwd: '/workspace' }
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    await expect(
      broker.requestPermission(
        createToolPermissionRequest({
          title: 'Write secrets.env',
          providerToolName: 'Write',
          kind: 'edit',
          locations: [{ path: 'secrets.env' }]
        }),
        { profile: 'ask', cwd: '/workspace' }
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'Read report.md',
        providerToolName: 'Read',
        kind: 'read',
        locations: [{ path: 'report.md' }]
      }),
      { profile: 'ask', cwd: '/workspace' }
    )

    expect(emitted).toHaveLength(2)
  })

  it('scopes MCP session grants to the stable server and tool identity', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const context = {
      profile: 'ask' as const,
      mcpServerNames: ['open-science-notebook']
    }

    const firstResponse = broker.requestPermission(
      createToolPermissionRequest({
        title: 'Run MCP tool',
        providerToolName: 'open-science-notebook_notebook_execute',
        kind: 'execute',
        rawInput: { language: 'python' }
      }),
      context
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstResponse

    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'Run MCP tool',
        providerToolName: 'open-science-notebook_notebook_state',
        kind: 'execute'
      }),
      context
    )

    expect(emitted).toHaveLength(2)
  })

  it('keeps conversation shell grants bound to the reviewed command signature', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const firstBash = broker.requestPermission(
      createToolPermissionRequest({
        title: 'Run Python',
        providerToolName: 'Bash',
        rawInput: { command: 'FOO=bar python a.py' }
      })
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstBash

    const secondBash = broker.requestPermission(
      createToolPermissionRequest({
        title: 'Run Python again',
        providerToolName: 'Bash',
        rawInput: { command: 'BAR=baz python a.py' }
      })
    )
    broker.respond({ requestId: emitted[1].requestId, optionId: 'allow-once' })
    await expect(secondBash).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })

    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'Remove build output',
        providerToolName: 'Bash',
        rawInput: { command: 'rm -rf build' }
      })
    )

    expect(broker.listGrants('session-1')).toEqual([
      {
        categoryKey: 'shell:FOO=bar python a.py',
        kind: 'shell',
        label: 'FOO=bar python a.py',
        scope: 'session'
      }
    ])
    expect(emitted[1]).toMatchObject({ title: 'Run Python again' })
    expect(emitted[1].options).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'This conversation' })])
    )
    expect(emitted[2]).toMatchObject({ title: 'Remove build output' })
    expect(emitted).toHaveLength(3)
  })

  it('offers only one-shot shell approval when raw input has no concrete command', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const request = createToolPermissionRequest({ title: 'Run command', kind: 'execute' })

    void broker.requestPermission(request)

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual(['once'])
    expect(broker.listGrants('session-1')).toEqual([])
  })

  it('resolves an app-owned MCP leaf alias to its canonical conversation grant', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const context = { profile: 'ask' as const, mcpServerNames: ['open-science-notebook'] }
    const leafRequest = createToolPermissionRequest({
      title: 'execute',
      kind: 'other',
      rawInput: { code: 'print(1)', language: 'python' }
    })

    const firstResponse = broker.requestPermission(leafRequest, context)
    expect(emitted[0]).toMatchObject({ isMcp: true })
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstResponse

    await expect(
      broker.requestPermission(
        createNotebookPermissionRequest(
          'session-1',
          'mcp__open-science-notebook__notebook_execute',
          { code: 'print(2)', language: 'python' }
        ),
        context
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    expect(emitted).toHaveLength(1)
    expect(broker.listGrants('session-1')).toEqual([
      {
        categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
        kind: 'mcp',
        label: 'Notebook REPL (Python)',
        scope: 'session'
      }
    ])
  })

  it('uses execute kind with a raw command when provider metadata is absent', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const firstBash = broker.requestPermission(
      createToolPermissionRequest({
        title: 'Build project',
        kind: 'execute',
        rawInput: { command: 'node build.js' }
      })
    )
    broker.respond({
      requestId: emitted[0].requestId,
      optionId: getSessionOptionId(emitted[0])
    })
    await firstBash

    await expect(
      broker.requestPermission(
        createToolPermissionRequest({
          title: 'Run build again',
          kind: 'execute',
          rawInput: { command: 'node build.js' }
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    expect(emitted).toHaveLength(1)
  })

  it('uses fixed notebook tool runtimes before stray payload language fields', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const replRequest = createNotebookPermissionRequest(
      'session-1',
      'mcp__open-science-notebook__repl_execute',
      { code: 'print(1)', language: 'python' }
    )

    const firstRepl = broker.requestPermission(replRequest)
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstRepl

    await expect(
      broker.requestPermission(
        createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__repl_execute', {
          code: 'x <- 1',
          language: 'r'
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    const firstBash = broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__bash_execute', {
        command: 'pwd',
        language: 'python'
      })
    )
    broker.respond({ requestId: emitted[1].requestId, optionId: getSessionOptionId(emitted[1]) })
    await firstBash

    await expect(
      broker.requestPermission(
        createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__bash_execute', {
          command: 'ls',
          language: 'r'
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    expect(emitted).toHaveLength(2)
    expect(broker.listGrants('session-1')).toEqual(
      expect.arrayContaining([
        {
          categoryKey: 'mcp:open-science-notebook/repl_execute:javascript',
          kind: 'mcp',
          label: 'Notebook REPL (JavaScript)',
          scope: 'session'
        },
        {
          categoryKey: 'mcp:open-science-notebook/bash_execute:bash',
          kind: 'mcp',
          label: 'Notebook shell (Bash)',
          scope: 'session'
        }
      ])
    )
  })

  it('keeps prompting for a different notebook sub-tool after Always on another', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const firstResponse = broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__notebook_execute')
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstResponse

    // A different notebook sub-tool is a distinct category and still prompts.
    broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__notebook_edit')
    )
    expect(emitted).toHaveLength(2)
  })

  it('keeps a per-tool session grant when the composer profile changes between calls', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    // Under Ask, the user grants the shell category for this conversation.
    const firstBash = broker.requestPermission(
      createToolPermissionRequest({
        title: 'python train.py',
        providerToolName: 'Bash',
        rawInput: { command: 'python train.py' }
      }),
      { profile: 'ask' }
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstBash

    // Switching to conservative Auto must not drop the grant. Conservative Auto never approves a
    // shell command on its own, so an auto-approval here proves the per-tool grant survived the switch.
    const secondBash = broker.requestPermission(
      createToolPermissionRequest({
        title: 'python train.py',
        providerToolName: 'Bash',
        rawInput: { command: 'python train.py' }
      }),
      { profile: 'auto', autoReviewStrategy: 'conservative', cwd: '/workspace' }
    )
    await expect(secondBash).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emitted).toHaveLength(1)
  })

  it('never auto-approves an MCP tool under conservative Auto, even for a workspace read', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const request = createToolPermissionRequest({
      title: 'mcp__pencil__batch_get',
      kind: 'read'
    })
    request.toolCall.locations = [{ path: 'data/results.csv' }]

    void broker.requestPermission(request, {
      profile: 'auto',
      autoReviewStrategy: 'conservative',
      cwd: '/workspace'
    })

    // MCP is excluded from the conservative fallback, so a prompt is still surfaced to the user.
    expect(emitted).toHaveLength(1)
  })

  it('classifies an opencode-named MCP tool as MCP, not shell, even when it reports kind execute', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const mcpServerNames = ['open-science-artifacts', 'open-science-notebook']

    // opencode renames the MCP tool <server>_<tool> and may report kind:execute; without MCP-aware
    // classification it would be grouped under the shared Bash category and mislabeled as shell.
    const grant = broker.requestPermission(
      createToolPermissionRequest({
        title: 'open-science-artifacts_write_artifact_file',
        kind: 'other',
        rawInput: {}
      }),
      { profile: 'ask', mcpServerNames }
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await grant

    expect(broker.listGrants('session-1')).toEqual([
      {
        categoryKey: 'mcp:open-science-artifacts/write_artifact_file',
        kind: 'mcp',
        label: 'open-science-artifacts/write_artifact_file',
        scope: 'session'
      }
    ])

    // The same MCP tool is now allowed for this Agent session and no longer prompts.
    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'open-science-artifacts_write_artifact_file',
        kind: 'other',
        rawInput: {}
      }),
      { profile: 'ask', mcpServerNames }
    )
    expect(emitted).toHaveLength(1)
  })

  it('uses the notebook Python default for OpenCode requests with empty metadata', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'open-science-notebook_notebook_execute',
        kind: 'other',
        rawInput: {}
      }),
      { profile: 'ask', frameworkId: 'opencode', mcpServerNames: ['open-science-notebook'] }
    )

    expect(emitted[0]).toMatchObject({
      title: 'open-science-notebook_notebook_execute',
      isMcp: true,
      providerToolName: undefined,
      rawInput: {}
    })
    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session'
    ])
  })

  it('defaults notebook_execute conversation grants to Python when language is omitted', () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    void broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'open-science-notebook_notebook_execute', {
        code: 'x = 1\nprint(x)'
      }),
      { profile: 'ask', frameworkId: 'opencode', mcpServerNames: ['open-science-notebook'] }
    )

    expect(emitted[0].options.map((option) => option.scope).filter(Boolean)).toEqual([
      'once',
      'session'
    ])
    expect(broker.listGrants('session-1')).toEqual([])
  })

  it('keeps MCP identity when raw input contains a command field', async () => {
    const emittedRequests: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request))
    const firstRequest = createToolPermissionRequest({
      title: 'mcp__runner__execute',
      kind: 'execute'
    })
    firstRequest.toolCall.rawInput = { command: 'npm publish' }

    const firstResponse = broker.requestPermission(firstRequest)

    expect(emittedRequests[0]).toMatchObject({
      title: 'mcp__runner__execute',
      isMcp: true
    })
    broker.respond({
      requestId: emittedRequests[0].requestId,
      optionId: getSessionOptionId(emittedRequests[0])
    })
    await firstResponse

    const secondRequest = createToolPermissionRequest({
      title: 'mcp__other__execute',
      kind: 'execute'
    })
    secondRequest.toolCall.rawInput = { command: 'npm publish' }
    void broker.requestPermission(secondRequest)

    expect(emittedRequests).toHaveLength(2)
  })

  it('does not remember session grants across Agent sessions', async () => {
    const emitted: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))

    const firstFetch = broker.requestPermission(
      createToolPermissionRequest({ sessionId: 'session-1', providerToolName: 'WebFetch' })
    )
    broker.respond({ requestId: emitted[0].requestId, optionId: getSessionOptionId(emitted[0]) })
    await firstFetch

    // The same category in a different session must still prompt.
    broker.requestPermission(
      createToolPermissionRequest({ sessionId: 'session-2', providerToolName: 'WebFetch' })
    )
    expect(emitted).toHaveLength(2)
  })

  it('shares conversation grants across runtime brokers and clears them on deletion', async () => {
    const store = new ConversationPermissionGrantStore()
    const firstEmitted: EmittedPermissionRequest[] = []
    const secondEmitted: EmittedPermissionRequest[] = []
    const firstBroker = new AcpPermissionBroker((request) => firstEmitted.push(request), store)
    const secondBroker = new AcpPermissionBroker((request) => secondEmitted.push(request), store)
    const request = createToolPermissionRequest({
      sessionId: 'shared-conversation',
      providerToolName: 'WebFetch'
    })

    const firstPermission = firstBroker.requestPermission(request)
    firstBroker.respond({
      requestId: firstEmitted[0].requestId,
      optionId: getSessionOptionId(firstEmitted[0])
    })
    await firstPermission

    await expect(secondBroker.requestPermission(request)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(secondEmitted).toHaveLength(0)
    expect(secondBroker.listGrants('shared-conversation')).toEqual([
      expect.objectContaining({ categoryKey: 'tool:WebFetch', scope: 'session' })
    ])

    secondBroker.clearSession('shared-conversation')
    expect(firstBroker.listGrants('shared-conversation')).toEqual([])
    void firstBroker.requestPermission(request)
    expect(firstEmitted).toHaveLength(2)
  })

  it('shares MCP grants across hyphenated and underscore-sanitized framework identities', async () => {
    const store = new ConversationPermissionGrantStore()
    const firstEmitted: EmittedPermissionRequest[] = []
    const secondEmitted: EmittedPermissionRequest[] = []
    const firstBroker = new AcpPermissionBroker((request) => firstEmitted.push(request), store)
    const secondBroker = new AcpPermissionBroker((request) => secondEmitted.push(request), store)
    const context = { profile: 'ask' as const, mcpServerNames: ['open-science-notebook'] }
    const sanitizedRequest = createNotebookPermissionRequest(
      'shared-conversation',
      'mcp__open_science_notebook__notebook_execute',
      { language: 'python', code: 'print(1)' }
    )

    const firstPermission = firstBroker.requestPermission(sanitizedRequest, context)
    firstBroker.respond({
      requestId: firstEmitted[0].requestId,
      optionId: getSessionOptionId(firstEmitted[0])
    })
    await firstPermission

    await expect(
      secondBroker.requestPermission(
        createNotebookPermissionRequest(
          'shared-conversation',
          'open-science-notebook_notebook_execute',
          { language: 'python', code: 'print(2)' }
        ),
        context
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(secondEmitted).toHaveLength(0)
    expect(secondBroker.listGrants('shared-conversation')).toEqual([
      expect.objectContaining({
        categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
        scope: 'session'
      })
    ])
  })

  it('lists per-session grants with display labels and revokes them individually', async () => {
    const emittedRequests: EmittedPermissionRequest[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request))

    const write = broker.requestPermission(
      createToolPermissionRequest({
        title: 'Write report.md',
        providerToolName: 'Write',
        kind: 'edit',
        locations: [{ path: 'report.md' }]
      }),
      { profile: 'ask', cwd: '/workspace' }
    )
    broker.respond({
      requestId: emittedRequests[0].requestId,
      optionId: getSessionOptionId(emittedRequests[0])
    })
    await write

    const bash = broker.requestPermission(
      createToolPermissionRequest({
        title: 'python a.py',
        providerToolName: 'Bash',
        rawInput: { command: 'python a.py' }
      })
    )
    broker.respond({
      requestId: emittedRequests[1].requestId,
      optionId: getSessionOptionId(emittedRequests[1])
    })
    await bash

    const notebook = broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__notebook_execute')
    )
    broker.respond({
      requestId: emittedRequests[2].requestId,
      optionId: getSessionOptionId(emittedRequests[2])
    })
    await notebook

    expect(broker.listGrants('session-1')).toEqual(
      expect.arrayContaining([
        {
          categoryKey: 'file:Write',
          kind: 'tool',
          label: 'Write',
          scope: 'session'
        },
        {
          categoryKey: 'shell:python a.py',
          kind: 'shell',
          label: 'python a.py',
          scope: 'session'
        },
        {
          categoryKey: 'mcp:open-science-notebook/notebook_execute:python',
          kind: 'mcp',
          label: 'Notebook REPL (Python)',
          scope: 'session'
        }
      ])
    )

    // Revoking one grant removes only it and makes that tool prompt again.
    broker.revokeGrant('session-1', 'file:Write')
    expect(
      broker
        .listGrants('session-1')
        .map((grant) => grant.categoryKey)
        .sort()
    ).toEqual(['shell:python a.py', 'mcp:open-science-notebook/notebook_execute:python'].sort())

    const countBeforeWrite = emittedRequests.length
    broker.requestPermission(
      createToolPermissionRequest({
        title: 'Write report.md',
        providerToolName: 'Write',
        kind: 'edit',
        locations: [{ path: 'report.md' }]
      }),
      { profile: 'ask', cwd: '/workspace' }
    )
    expect(emittedRequests).toHaveLength(countBeforeWrite + 1)
  })
})

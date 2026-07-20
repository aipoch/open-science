import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { AcpPermissionBroker } from './permission-broker'

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
  title = 'mcp__open-science-notebook__notebook_execute'
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId: `tool-${Math.random()}`,
    title,
    status: 'pending'
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
  } = {}
): RequestPermissionRequest => {
  const { sessionId = 'session-1', title = 'Run tool', providerToolName, kind } = options

  return {
    sessionId,
    toolCall: {
      toolCallId: `tool-${Math.random()}`,
      title,
      status: 'pending',
      kind,
      _meta: providerToolName ? { claudeCode: { toolName: providerToolName } } : undefined
    },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
    ]
  }
}

describe('ACP permission broker', () => {
  it('preserves structured tool metadata for risk-aware approval UI', () => {
    const emitted: Array<Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0]> = []
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

  it('resolves pending requests as cancelled when all permissions are cancelled', async () => {
    const broker = new AcpPermissionBroker(() => undefined)

    const responsePromise = broker.requestPermission(createPermissionRequest())

    broker.cancelAll()

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'cancelled'
      }
    })
  })

  it('auto-approves later notebook calls after the user picks Always, without prompting again', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    // First notebook request prompts; the user chooses the always-allow option.
    const firstResponse = broker.requestPermission(createNotebookPermissionRequest())
    expect(emittedRequests).toHaveLength(1)
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await expect(firstResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-always' }
    })

    // A later same-session notebook call resolves immediately as allowed, emitting no new prompt.
    const secondResponse = broker.requestPermission(createNotebookPermissionRequest())

    await expect(secondResponse).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emittedRequests).toHaveLength(1)
    expect(broker.getPendingRequests()).toHaveLength(0)
  })

  it('keeps prompting for notebook calls in other sessions and after allow-once', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    // allow_once must NOT establish a standing always-allow.
    const onceResponse = broker.requestPermission(createNotebookPermissionRequest('session-1'))
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-once' })
    await onceResponse
    broker.requestPermission(createNotebookPermissionRequest('session-1'))
    expect(emittedRequests).toHaveLength(2)

    // Always in session-1 does not leak into session-2.
    broker.respond({ requestId: emittedRequests[1], optionId: 'allow-always' })
    broker.requestPermission(createNotebookPermissionRequest('session-2'))
    expect(emittedRequests).toHaveLength(3)
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

  it('remembers Always for a built-in tool by tool name, while a different tool still prompts', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    // Always on Write auto-approves later Write calls (different file title, same tool category).
    const firstWrite = broker.requestPermission(
      createToolPermissionRequest({ title: 'Write report.md', providerToolName: 'Write' })
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await firstWrite

    const secondWrite = broker.requestPermission(
      createToolPermissionRequest({ title: 'Write notes.md', providerToolName: 'Write' })
    )
    await expect(secondWrite).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emittedRequests).toHaveLength(1)

    // A different built-in (Edit) is a different category and still prompts.
    broker.requestPermission(
      createToolPermissionRequest({ title: 'Edit report.md', providerToolName: 'Edit' })
    )
    expect(emittedRequests).toHaveLength(2)
  })

  it('remembers Always for shell by full command signature, not just the executable', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const firstBash = broker.requestPermission(
      createToolPermissionRequest({ title: 'python a.py', providerToolName: 'Bash' })
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await firstBash

    // The exact same command auto-approves.
    const sameBash = broker.requestPermission(
      createToolPermissionRequest({ title: 'python a.py', providerToolName: 'Bash' })
    )
    await expect(sameBash).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emittedRequests).toHaveLength(1)

    // Different arguments to the same executable are a distinct signature and still prompt.
    broker.requestPermission(
      createToolPermissionRequest({ title: 'python b.py', providerToolName: 'Bash' })
    )
    expect(emittedRequests).toHaveLength(2)
  })

  it('normalizes leading env assignments in the shell command signature', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const firstBash = broker.requestPermission(
      createToolPermissionRequest({ title: 'FOO=bar node build.js', kind: 'execute' })
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await firstBash

    // The same command without the leading env assignment shares the signature and auto-approves.
    const secondBash = broker.requestPermission(
      createToolPermissionRequest({ title: 'node build.js', kind: 'execute' })
    )
    await expect(secondBash).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emittedRequests).toHaveLength(1)

    // A different command still prompts.
    broker.requestPermission(
      createToolPermissionRequest({ title: 'node serve.js', kind: 'execute' })
    )
    expect(emittedRequests).toHaveLength(2)
  })

  it('keeps prompting for a different notebook sub-tool after Always on another', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const firstResponse = broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__notebook_execute')
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await firstResponse

    // A different notebook sub-tool is a distinct category and still prompts.
    broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__notebook_edit')
    )
    expect(emittedRequests).toHaveLength(2)
  })

  it('keeps a per-tool Always grant even when the composer profile changes between calls', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    // Under Ask, the user grants Always for a shell executable.
    const firstBash = broker.requestPermission(
      createToolPermissionRequest({ title: 'python train.py', providerToolName: 'Bash' }),
      { profile: 'ask' }
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await firstBash

    // Switching to conservative Auto must not drop the grant. Conservative Auto never approves a
    // shell command on its own, so an auto-approval here proves the per-tool grant survived the switch.
    const secondBash = broker.requestPermission(
      createToolPermissionRequest({ title: 'python train.py', providerToolName: 'Bash' }),
      { profile: 'auto', autoReviewStrategy: 'conservative', cwd: '/workspace' }
    )
    await expect(secondBash).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(emittedRequests).toHaveLength(1)
  })

  it('never auto-approves an MCP tool under conservative Auto, even for a workspace read', () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

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
    expect(emittedRequests).toHaveLength(1)
  })

  it('classifies an opencode-named MCP tool as MCP, not shell, even when it reports kind execute', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))
    const mcpServerNames = ['open-science-artifacts', 'open-science-notebook']

    // opencode renames the MCP tool <server>_<tool> and may report kind:execute; without MCP-aware
    // classification it would be grouped under the shared Bash category and mislabeled as shell.
    const grant = broker.requestPermission(
      createToolPermissionRequest({
        title: 'open-science-artifacts_write_artifact_file',
        kind: 'execute'
      }),
      { profile: 'ask', mcpServerNames }
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await grant

    expect(broker.listGrants('session-1')).toEqual([
      {
        categoryKey: 'mcp:open-science-artifacts_write_artifact_file',
        kind: 'mcp',
        label: 'open-science-artifacts_write_artifact_file'
      }
    ])

    // The same MCP tool is now always-allowed and no longer prompts.
    void broker.requestPermission(
      createToolPermissionRequest({
        title: 'open-science-artifacts_write_artifact_file',
        kind: 'execute'
      }),
      { profile: 'ask', mcpServerNames }
    )
    expect(emittedRequests).toHaveLength(1)
  })

  it('does not remember Always across sessions for built-in tools', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const firstWrite = broker.requestPermission(
      createToolPermissionRequest({ sessionId: 'session-1', providerToolName: 'Write' })
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await firstWrite

    // The same category in a different session must still prompt.
    broker.requestPermission(
      createToolPermissionRequest({ sessionId: 'session-2', providerToolName: 'Write' })
    )
    expect(emittedRequests).toHaveLength(2)
  })

  it('lists per-session grants with display labels and revokes them individually', async () => {
    const emittedRequests: string[] = []
    const broker = new AcpPermissionBroker((request) => emittedRequests.push(request.requestId))

    const write = broker.requestPermission(
      createToolPermissionRequest({ title: 'Write report.md', providerToolName: 'Write' })
    )
    broker.respond({ requestId: emittedRequests[0], optionId: 'allow-always' })
    await write

    const bash = broker.requestPermission(
      createToolPermissionRequest({ title: 'python a.py', providerToolName: 'Bash' })
    )
    broker.respond({ requestId: emittedRequests[1], optionId: 'allow-always' })
    await bash

    const notebook = broker.requestPermission(
      createNotebookPermissionRequest('session-1', 'mcp__open-science-notebook__notebook_execute')
    )
    broker.respond({ requestId: emittedRequests[2], optionId: 'allow-always' })
    await notebook

    expect(broker.listGrants('session-1')).toEqual(
      expect.arrayContaining([
        { categoryKey: 'tool:Write', kind: 'tool', label: 'Write' },
        { categoryKey: 'bash:python a.py', kind: 'shell', label: 'python a.py' },
        {
          categoryKey: 'mcp:mcp__open-science-notebook__notebook_execute',
          kind: 'mcp',
          label: 'mcp__open-science-notebook__notebook_execute'
        }
      ])
    )

    // Revoking one grant removes only it and makes that tool prompt again.
    broker.revokeGrant('session-1', 'tool:Write')
    expect(
      broker
        .listGrants('session-1')
        .map((grant) => grant.categoryKey)
        .sort()
    ).toEqual(['bash:python a.py', 'mcp:mcp__open-science-notebook__notebook_execute'].sort())

    const countBeforeWrite = emittedRequests.length
    broker.requestPermission(
      createToolPermissionRequest({ title: 'Write notes.md', providerToolName: 'Write' })
    )
    expect(emittedRequests).toHaveLength(countBeforeWrite + 1)
  })
})

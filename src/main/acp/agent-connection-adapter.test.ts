import * as acp from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework, type ResolvedAgentBackend } from '../agent-framework'
import {
  AcpAgentConnectionAdapter,
  type AcpAgentConnectionCandidate,
  type AcpAgentConnectionHooks
} from './agent-connection-adapter'
import { AcpBackendGenerationOwner } from './backend-generation-owner'
import {
  AcpConnectionResourceOwner,
  type AcpConnectionResourceAttempt
} from './connection-resource-owner'

const terminateProcessTree = vi.hoisted(() =>
  vi.fn(async (child?: { kill?: () => void }) => {
    child?.kill?.()
    return { reaped: true }
  })
)
vi.mock('../process-tree', () => ({ terminateProcessTree }))

afterEach(() => {
  vi.clearAllMocks()
})

class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  pid = 1234

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

const hooks = (): AcpAgentConnectionHooks => ({
  createElicitation: vi.fn(async () => ({ action: 'decline' as const })),
  requestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
  observeSessionUpdate: vi.fn(),
  observeClaudeSdkMessage: vi.fn(),
  filesystem: {
    resolveSessionCwd: vi.fn(() => '/workspace'),
    protectedReadRoots: vi.fn(() => [])
  },
  onBackendResolved: vi.fn(),
  onProcessSpawned: vi.fn(),
  onBackendPublished: vi.fn(),
  onProcessTreeReaped: vi.fn(),
  markProcessExitExpected: vi.fn(),
  onProcessStderr: vi.fn(),
  onProcessError: vi.fn(),
  onProcessExit: vi.fn(),
  onConnectionClosed: vi.fn(),
  reportCleanupFailure: vi.fn(),
  reportProcessTreeError: vi.fn()
})

const openConnection = async (
  process: FakeAgentProcess,
  connectionHooks: AcpAgentConnectionHooks
): Promise<{ connection: acp.ClientConnection; close: () => Promise<void> }> => {
  const owner = new AcpConnectionResourceOwner()
  const backendOwner = new AcpBackendGenerationOwner(claudeCodeFramework)
  const ready = await owner.connect(async (attempt) => {
    const candidate = await new AcpAgentConnectionAdapter().open(
      {
        epoch: attempt.epoch,
        resolveBackend: async () => ({
          framework: claudeCodeFramework,
          executablePath: '',
          env: {}
        }),
        prepareBackend: (backend) => backendOwner.prepare(attempt, backend),
        isCurrent: () => attempt.epoch === owner.epoch,
        isShuttingDown: () => owner.isShuttingDown,
        spawnAgent: () => asAgentProcess(process)
      },
      connectionHooks
    )
    candidate.transferTo(attempt)
    return attempt.publish({ close: false, delete: false, resume: false, steering: false })
  })
  return { connection: ready.connection, close: () => owner.teardown(owner.epoch) }
}

const openCandidate = async (
  process: FakeAgentProcess,
  backend: ResolvedAgentBackend = {
    framework: claudeCodeFramework,
    executablePath: '',
    env: {}
  },
  connectionHooks: AcpAgentConnectionHooks = hooks()
): Promise<AcpAgentConnectionCandidate> => {
  const backendOwner = new AcpBackendGenerationOwner(claudeCodeFramework)
  const identity = { epoch: 1, assertCurrent: vi.fn() }
  return new AcpAgentConnectionAdapter().open(
    {
      epoch: identity.epoch,
      resolveBackend: async () => backend,
      prepareBackend: (resolved) => backendOwner.prepare(identity, resolved),
      isCurrent: () => true,
      isShuttingDown: () => false,
      spawnAgent: () => asAgentProcess(process)
    },
    connectionHooks
  )
}

describe('AcpAgentConnectionAdapter', () => {
  it('binds process diagnostics and forwards the process epoch context', async () => {
    const process = new FakeAgentProcess()
    const connectionHooks = hooks()
    const candidate = await openCandidate(process, undefined, connectionHooks)

    process.stderr.emit('data', Buffer.from(' provider auth failed\n'))
    const error = new Error('pipe failed')
    process.emit('error', error)
    process.emit('exit', 1, 'SIGTERM')

    expect(connectionHooks.onProcessStderr).toHaveBeenCalledWith('provider auth failed', {
      process,
      framework: 'claude-code',
      epoch: 1
    })
    expect(connectionHooks.onProcessError).toHaveBeenCalledWith(error, {
      process,
      framework: 'claude-code',
      epoch: 1
    })
    expect(connectionHooks.onProcessExit).toHaveBeenCalledWith(1, 'SIGTERM', {
      process,
      framework: 'claude-code',
      epoch: 1,
      pid: 1234
    })

    await candidate.dispose()
    expect(connectionHooks.markProcessExitExpected).toHaveBeenCalledWith(process, 1)
  })

  it('reaps an untransferred process tree and releases every transport lease exactly once', async () => {
    const process = new FakeAgentProcess()
    const releaseBridge = vi.fn(async () => undefined)
    const releaseAnthropic = vi.fn(async () => undefined)
    const releaseProviderTransport = vi.fn(async () => undefined)
    const backend: ResolvedAgentBackend = {
      framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
      executablePath: '/bin/agent',
      env: {},
      responsesBridgeLease: {
        selectSkills: vi.fn(async () => []),
        registerReviewerSession: vi.fn(),
        unregisterReviewerSession: vi.fn(() => false),
        release: releaseBridge
      },
      anthropicBridgeLease: {
        setTarget: vi.fn(() => true),
        release: releaseAnthropic
      },
      providerTransportLease: {
        setTarget: vi.fn(() => true),
        release: releaseProviderTransport
      }
    }
    const candidate = await openCandidate(process, backend)

    await candidate.dispose()
    await candidate.dispose()

    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(terminateProcessTree.mock.calls[0]?.[0]).toBe(process)
    expect(releaseBridge).toHaveBeenCalledOnce()
    expect(releaseAnthropic).toHaveBeenCalledOnce()
    expect(releaseProviderTransport).toHaveBeenCalledOnce()
  })

  it('rejects a transfer to a different owner epoch without consuming the candidate', async () => {
    const process = new FakeAgentProcess()
    const candidate = await openCandidate(process)
    const attach = vi.fn()
    const mismatchedAttempt = {
      epoch: 2,
      attach,
      publish: vi.fn(),
      assertCurrent: vi.fn(),
      owns: vi.fn(() => false)
    } as unknown as AcpConnectionResourceAttempt

    expect(() => candidate.transferTo(mismatchedAttempt)).toThrow(/superseded/i)
    expect(attach).not.toHaveBeenCalled()

    await candidate.dispose()
    expect(terminateProcessTree).toHaveBeenCalledOnce()
  })

  it('transfers once without exposing resources and leaves teardown solely to the owner', async () => {
    const process = new FakeAgentProcess()
    const releaseBridge = vi.fn(async () => undefined)
    const releaseAnthropic = vi.fn(async () => undefined)
    const releaseProviderTransport = vi.fn(async () => undefined)
    const owner = new AcpConnectionResourceOwner()
    let candidateDispose: (() => Promise<void>) | undefined
    await owner.connect(async (attempt) => {
      const candidate = await openCandidate(process, {
        framework: claudeCodeFramework,
        executablePath: '',
        env: {},
        responsesBridgeLease: {
          selectSkills: vi.fn(async () => []),
          registerReviewerSession: vi.fn(),
          unregisterReviewerSession: vi.fn(() => false),
          release: releaseBridge
        },
        anthropicBridgeLease: {
          setTarget: vi.fn(() => true),
          release: releaseAnthropic
        },
        providerTransportLease: {
          setTarget: vi.fn(() => true),
          release: releaseProviderTransport
        }
      })
      candidateDispose = candidate.dispose
      const transferred = candidate.transferTo(attempt)

      expect(Object.keys(candidate).sort()).toEqual(['dispose', 'transferTo'])
      expect(Object.keys(transferred).sort()).toEqual([
        'authenticate',
        'backendAttempt',
        'initialize',
        'setProvider'
      ])
      expect(candidate).not.toHaveProperty('process')
      expect(candidate).not.toHaveProperty('connection')
      expect(candidate).not.toHaveProperty('bridgeLease')
      expect(transferred).not.toHaveProperty('process')
      expect(transferred).not.toHaveProperty('connection')
      expect(transferred).not.toHaveProperty('bridgeLease')
      expect(() => candidate.transferTo(attempt)).toThrow(/already transferred/i)
      await candidate.dispose()

      expect(terminateProcessTree).not.toHaveBeenCalled()
      expect(releaseBridge).not.toHaveBeenCalled()
      expect(releaseAnthropic).not.toHaveBeenCalled()
      expect(releaseProviderTransport).not.toHaveBeenCalled()
      return attempt.publish({ close: false, delete: false, resume: false, steering: false })
    })

    await candidateDispose?.()
    expect(terminateProcessTree).not.toHaveBeenCalled()
    expect(releaseBridge).not.toHaveBeenCalled()
    expect(releaseAnthropic).not.toHaveBeenCalled()
    expect(releaseProviderTransport).not.toHaveBeenCalled()

    await owner.teardown(owner.epoch)
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(releaseBridge).toHaveBeenCalledOnce()
    expect(releaseAnthropic).toHaveBeenCalledOnce()
    expect(releaseProviderTransport).toHaveBeenCalledOnce()
  })

  it('retains cleanup ownership when the resource owner rejects transfer', async () => {
    const process = new FakeAgentProcess()
    const candidate = await openCandidate(process)
    const rejectedAttempt = {
      epoch: 1,
      attach: vi.fn(() => {
        throw new Error('owner rejected transfer')
      }),
      publish: vi.fn(),
      assertCurrent: vi.fn(),
      owns: vi.fn(() => false)
    } as unknown as AcpConnectionResourceAttempt

    expect(() => candidate.transferTo(rejectedAttempt)).toThrow('owner rejected transfer')
    await candidate.dispose()

    expect(terminateProcessTree).toHaveBeenCalledOnce()
  })

  it('opens an ACP client connection over the child process streams', async () => {
    const process = new FakeAgentProcess()
    acp
      .agent({ name: 'test-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: []
      }))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const { connection, close } = await openConnection(process, hooks())

    await expect(
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'open-science', version: '0.1.0' },
        clientCapabilities: {}
      })
    ).resolves.toMatchObject({ protocolVersion: acp.PROTOCOL_VERSION })

    await close()
  })

  it('translates permission requests and returns the hook response', async () => {
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    const request = {
      sessionId: 'provider-session',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Run tests',
        kind: 'execute' as const,
        status: 'pending' as const
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }]
    }
    vi.mocked(connectionHooks.requestPermission).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    const { close } = await openConnection(process, connectionHooks)

    await expect(
      agentConnection.client.request(acp.methods.client.session.requestPermission, request)
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(connectionHooks.requestPermission).toHaveBeenCalledWith(request)

    await close()
    agentConnection.close()
  })

  it('translates form elicitation requests and returns the hook response', async () => {
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    const request = {
      mode: 'form' as const,
      sessionId: 'provider-session',
      toolCallId: 'tool-choice-1',
      message: 'Choose an approach',
      requestedSchema: {
        type: 'object' as const,
        properties: {
          question_0: {
            type: 'string' as const,
            enum: ['minimal', 'expanded']
          }
        }
      }
    }
    vi.mocked(connectionHooks.createElicitation).mockResolvedValue({
      action: 'accept',
      content: { question_0: 'minimal' }
    })
    const { close } = await openConnection(process, connectionHooks)

    await expect(
      agentConnection.client.request(acp.methods.client.elicitation.create, request)
    ).resolves.toEqual({ action: 'accept', content: { question_0: 'minimal' } })
    expect(connectionHooks.createElicitation).toHaveBeenCalledWith(request)

    await close()
    agentConnection.close()
  })

  it('returns permission hook failures over ACP without replacing their diagnostic detail', async () => {
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    vi.mocked(connectionHooks.requestPermission).mockRejectedValue(
      new Error('permission hook failed')
    )
    const { close } = await openConnection(process, connectionHooks)

    await expect(
      agentConnection.client.request(acp.methods.client.session.requestPermission, {
        sessionId: 'provider-session',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'pending'
        },
        options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
      })
    ).rejects.toMatchObject({
      code: -32603,
      data: { details: 'permission hook failed' }
    })

    await close()
    agentConnection.close()
  })

  it('delivers a session update before the following permission request', async () => {
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const actions: string[] = []
    const connectionHooks = hooks()
    vi.mocked(connectionHooks.observeSessionUpdate).mockImplementation(() => {
      actions.push('update')
    })
    vi.mocked(connectionHooks.requestPermission).mockImplementation(async () => {
      actions.push('permission')
      return { outcome: { outcome: 'cancelled' } }
    })
    const { close } = await openConnection(process, connectionHooks)

    const notification = {
      sessionId: 'provider-session',
      update: {
        sessionUpdate: 'tool_call' as const,
        toolCallId: 'tool-1',
        title: 'Run tests',
        status: 'pending' as const
      }
    }
    await agentConnection.client.notify(acp.methods.client.session.update, notification)
    await agentConnection.client.request(acp.methods.client.session.requestPermission, {
      sessionId: 'provider-session',
      toolCall: notification.update,
      options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }]
    })

    expect(connectionHooks.observeSessionUpdate).toHaveBeenCalledWith(notification)
    expect(actions).toEqual(['update', 'permission'])

    await close()
    agentConnection.close()
  })

  it('translates Claude SDK message notifications', async () => {
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    const { close } = await openConnection(process, connectionHooks)
    const notification = {
      sessionId: 'provider-session',
      message: { type: 'result', num_turns: 2, origin: { kind: 'human' } }
    }

    await agentConnection.client.notify('_claude/sdkMessage', notification)

    await vi.waitFor(() =>
      expect(connectionHooks.observeClaudeSdkMessage).toHaveBeenCalledWith(notification)
    )

    await close()
    agentConnection.close()
  })

  it('reads text files inside the session workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'acp-connection-adapter-'))
    const filePath = join(workspace, 'notes.txt')
    await writeFile(filePath, 'one\ntwo\nthree', 'utf8')
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    vi.mocked(connectionHooks.filesystem.resolveSessionCwd).mockReturnValue(workspace)
    const { close } = await openConnection(process, connectionHooks)

    await expect(
      agentConnection.client.request(acp.methods.client.fs.readTextFile, {
        sessionId: 'provider-session',
        path: filePath,
        line: 2,
        limit: 1
      })
    ).resolves.toEqual({ content: 'two' })
    expect(connectionHooks.filesystem.resolveSessionCwd).toHaveBeenCalledWith('provider-session')
    expect(connectionHooks.filesystem.protectedReadRoots).toHaveBeenCalledOnce()

    await close()
    agentConnection.close()
    await rm(workspace, { recursive: true, force: true })
  })

  it('rejects reads from protected application roots', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'acp-connection-adapter-'))
    const protectedRoot = join(workspace, '.provider-config')
    const filePath = join(protectedRoot, 'credentials.json')
    await mkdir(protectedRoot)
    await writeFile(filePath, 'secret', 'utf8')
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    vi.mocked(connectionHooks.filesystem.resolveSessionCwd).mockReturnValue(workspace)
    vi.mocked(connectionHooks.filesystem.protectedReadRoots).mockReturnValue([protectedRoot])
    const { close } = await openConnection(process, connectionHooks)

    await expect(
      agentConnection.client.request(acp.methods.client.fs.readTextFile, {
        sessionId: 'provider-session',
        path: filePath
      })
    ).rejects.toMatchObject({
      code: -32603,
      data: {
        details: 'This file belongs to a protected application directory and cannot be read.'
      }
    })

    await close()
    agentConnection.close()
    await rm(workspace, { recursive: true, force: true })
  })

  it('writes text files inside the session workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'acp-connection-adapter-'))
    const filePath = join(workspace, 'nested', 'notes.txt')
    const process = new FakeAgentProcess()
    const agentConnection = acp
      .agent({ name: 'test-agent' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )
    const connectionHooks = hooks()
    vi.mocked(connectionHooks.filesystem.resolveSessionCwd).mockReturnValue(workspace)
    const { close } = await openConnection(process, connectionHooks)

    await expect(
      agentConnection.client.request(acp.methods.client.fs.writeTextFile, {
        sessionId: 'provider-session',
        path: filePath,
        content: 'written through ACP'
      })
    ).resolves.toEqual({})
    await expect(readFile(filePath, 'utf8')).resolves.toBe('written through ACP')
    expect(connectionHooks.filesystem.resolveSessionCwd).toHaveBeenCalledWith('provider-session')

    await close()
    agentConnection.close()
    await rm(workspace, { recursive: true, force: true })
  })
})

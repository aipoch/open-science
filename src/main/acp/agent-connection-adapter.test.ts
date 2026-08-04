import * as acp from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { AcpAgentConnectionAdapter, type AcpAgentConnectionHooks } from './agent-connection-adapter'

class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
}

const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

const hooks = (): AcpAgentConnectionHooks => ({
  requestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
  observeSessionUpdate: vi.fn(),
  observeClaudeSdkMessage: vi.fn(),
  filesystem: {
    resolveSessionCwd: vi.fn(() => '/workspace'),
    protectedReadRoots: vi.fn(() => [])
  }
})

describe('AcpAgentConnectionAdapter', () => {
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

    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      hooks()
    )

    await expect(
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'open-science', version: '0.1.0' },
        clientCapabilities: {}
      })
    ).resolves.toMatchObject({ protocolVersion: acp.PROTOCOL_VERSION })

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )

    await expect(
      agentConnection.client.request(acp.methods.client.session.requestPermission, request)
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(connectionHooks.requestPermission).toHaveBeenCalledWith(request)

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )

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

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )

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

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )
    const notification = {
      sessionId: 'provider-session',
      message: { type: 'result', num_turns: 2, origin: { kind: 'human' } }
    }

    await agentConnection.client.notify('_claude/sdkMessage', notification)

    await vi.waitFor(() =>
      expect(connectionHooks.observeClaudeSdkMessage).toHaveBeenCalledWith(notification)
    )

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )

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

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )

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

    connection.close()
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
    const connection = new AcpAgentConnectionAdapter().open(
      { process: asAgentProcess(process) },
      connectionHooks
    )

    await expect(
      agentConnection.client.request(acp.methods.client.fs.writeTextFile, {
        sessionId: 'provider-session',
        path: filePath,
        content: 'written through ACP'
      })
    ).resolves.toEqual({})
    await expect(readFile(filePath, 'utf8')).resolves.toBe('written through ACP')
    expect(connectionHooks.filesystem.resolveSessionCwd).toHaveBeenCalledWith('provider-session')

    connection.close()
    agentConnection.close()
    await rm(workspace, { recursive: true, force: true })
  })
})

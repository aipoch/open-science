import * as acp from '@agentclientprotocol/sdk'
import type { ContentBlock, SessionModeState } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AcpRuntime } from './runtime'
import { AgentMcpHttpHost } from './mcp-http-host'
import { claudeCodeFramework, opencodeFramework } from '../agent-framework'
import { ArtifactRepository } from '../artifacts/repository'
import { UploadRepository } from '../uploads/repository'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

// Minimal child-process stand-in that exposes the streams the runtime expects.
class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  // Simulates a clean process shutdown and emits the normal exit signal.
  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

// Narrows the fake process into the runtime's child process type.
const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

// Creates a manually controlled promise for ordering async protocol steps.
const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return { promise, resolve, reject }
}

// Starts an in-memory fake agent that can create sessions, stream replies, and close sessions.
const startFakeAgent = (
  process: FakeAgentProcess,
  sessionIds: string[],
  options: {
    supportsResume?: boolean
    modes?: SessionModeState
    // When true, the resume handler rejects with the ACP "Resource not found" (-32002) — the signal a
    // replaced agent (e.g. after a provider switch) gives for a session id it does not hold.
    resumeNotFound?: boolean
    // When true, the resume handler rejects with a generic "Internal error" (-32603) — what some
    // agents return instead of a clean not-found after their process was replaced by an app restart.
    resumeInternalError?: boolean
    onPrompt?: (context: {
      sessionId: string
      text: string
      prompt: ContentBlock[]
    }) => Promise<void> | void
  } = {}
): {
  prompts: Array<{ sessionId: string; text: string }>
  newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  resumedSessions: Array<{ sessionId: string; cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  closedSessions: string[]
  modeChanges: Array<{ sessionId: string; modeId: string }>
  actions: string[]
} => {
  const prompts: Array<{ sessionId: string; text: string }> = []
  const newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }> = []
  const resumedSessions: Array<{
    sessionId: string
    cwd: string
    mcpServers: unknown[]
    _meta?: unknown
  }> = []
  const closedSessions: string[] = []
  const modeChanges: Array<{ sessionId: string; modeId: string }> = []
  const actions: string[] = []
  let sessionIndex = 0

  acp
    .agent({ name: 'test-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          close: {},
          ...(options.supportsResume === false ? {} : { resume: {} })
        }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      newSessions.push({
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers,
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })
      // Return deterministic ids so the tests can assert exact routing.
      const sessionId = sessionIds[sessionIndex]
      sessionIndex += 1

      return { sessionId, modes: options.modes }
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      if (options.resumeNotFound) {
        throw acp.RequestError.resourceNotFound(ctx.params.sessionId)
      }

      if (options.resumeInternalError) {
        throw acp.RequestError.internalError()
      }

      resumedSessions.push({
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers ?? [],
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })

      return { modes: options.modes }
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      modeChanges.push({ sessionId: ctx.params.sessionId, modeId: ctx.params.modeId })
      actions.push(`mode:${ctx.params.modeId}`)
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      // Flatten text blocks because these tests only exercise plain prompts.
      const text = ctx.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')

      prompts.push({ sessionId: ctx.params.sessionId, text })
      actions.push(`prompt:${text}`)
      await options.onPrompt?.({ sessionId: ctx.params.sessionId, text, prompt: ctx.params.prompt })
      // Stream one assistant chunk through the client callback path before stopping.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: {
            type: 'text',
            text: `reply for ${ctx.params.sessionId}`
          }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      closedSessions.push(ctx.params.sessionId)
      return {}
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return { prompts, newSessions, resumedSessions, closedSessions, modeChanges, actions }
}

const createModes = (
  ids: string[],
  currentModeId: string = ids[0] ?? 'default'
): SessionModeState => ({
  currentModeId,
  availableModes: ids.map((id) => ({ id, name: id }))
})

let temporaryRoot: string | undefined

const createTemporaryRoot = async (): Promise<string> => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'open-science-runtime-artifacts-'))
  return temporaryRoot
}

const getEnvValue = (mcpServer: unknown, name: string): string => {
  if (
    typeof mcpServer !== 'object' ||
    mcpServer === null ||
    !('env' in mcpServer) ||
    !Array.isArray((mcpServer as { env?: unknown }).env)
  ) {
    throw new Error('Missing MCP server env array')
  }

  const entry = (mcpServer as { env: Array<{ name?: unknown; value?: unknown }> }).env.find(
    (item) => item.name === name
  )

  if (typeof entry?.value !== 'string') {
    throw new Error(`Missing env value: ${name}`)
  }

  return entry.value
}

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('ACP runtime migration write-gate', () => {
  afterEach(() => {
    // migration-state is a module singleton; clear it so a pending gate can't leak between tests.
    clearMigrationPending()
  })

  it('rejects sendPrompt while a data-root migration is pending, then resumes once cleared', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['gated-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    beginMigration()
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'blocked' })
    ).rejects.toThrow(/moving your data/i)
    // The turn never reached the agent.
    expect(fakeAgent.prompts).toEqual([])

    clearMigrationPending()
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'allowed' })
    expect(fakeAgent.prompts).toEqual([{ sessionId: 'gated-session', text: 'allowed' }])
  })

  it('keeps migration drain pending until a prompt that already started finishes', async () => {
    const process = new FakeAgentProcess()
    const promptGate = createDeferred()
    const fakeAgent = startFakeAgent(process, ['drain-session'], {
      onPrompt: () => promptGate.promise
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    const promptPromise = runtime.sendPrompt({ sessionId: session.sessionId, text: 'running' })
    await vi.waitFor(() => expect(fakeAgent.prompts).toHaveLength(1))
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    promptGate.resolve()
    await promptPromise
    await drainPromise
    expect(drained).toBe(true)
  })
})

describe('ACP runtime session management', () => {
  it('applies native Full access before the first prompt', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['full-session'], {
      modes: createModes(['default', 'bypassPermissions'])
    })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })

    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'full',
      effectiveProfile: 'full',
      currentModeId: 'bypassPermissions',
      fullAccessAvailable: true
    })
    expect(fakeAgent.modeChanges).toEqual([
      { sessionId: 'full-session', modeId: 'bypassPermissions' }
    ])

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'continue' })

    expect(fakeAgent.actions).toEqual(['mode:bypassPermissions', 'prompt:continue'])
  })

  it('kills the agent process synchronously on shutdown so it cannot outlive the app', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['shutdown-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    expect(process.killed).toBe(false)

    // shutdown() is synchronous (will-quit cannot await): the child must be signalled before it returns.
    runtime.shutdown()
    expect(process.killed).toBe(true)

    // Calling it again after the process is gone is a no-op, not a crash.
    expect(() => runtime.shutdown()).not.toThrow()
  })

  it('kills a child that finishes spawning after shutdown began, so quit-during-connect cannot orphan it', async () => {
    const process = new FakeAgentProcess()
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      // Model the app quitting mid-spawn: shutdown() lands before this child is handed back to connect.
      spawnAgent: () => {
        runtime.shutdown()
        return asAgentProcess(process)
      }
    })

    await expect(runtime.createSession({ cwd: '/workspace' })).rejects.toThrow(/shutting down/)

    // The child that spawned after killAgentProcess ran must still be terminated, not left as an orphan.
    expect(process.killed).toBe(true)
    expect(runtime.getSnapshot().sessionId).toBeUndefined()
  })

  it('reports conservative Auto when the Agent has no native auto mode', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['auto-session'], {
      modes: createModes(['default', 'bypassPermissions'])
    })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace', permissionProfile: 'auto' })

    expect(fakeAgent.modeChanges).toEqual([])
    expect(runtime.getSnapshot().permissionProfiles[session.sessionId]).toMatchObject({
      selectedProfile: 'auto',
      currentModeId: 'default',
      autoReviewStrategy: 'conservative'
    })
  })

  it('rejects Full access when native bypass is not advertised', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['full-session'], { modes: createModes(['default']) })
    const runtime = new AcpRuntime({
      appVersion: '0.2.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.createSession({ cwd: '/workspace', permissionProfile: 'full' })
    ).rejects.toThrow('Full access is not available')
    expect(runtime.getSnapshot().sessionIds).toEqual([])
  })

  it('creates protocol sessions and routes prompts by session id', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1', 'remote-session-2'])
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    const first = await runtime.createSession({ cwd: '/workspace' })
    const second = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: first.sessionId, text: 'hello first' })
    await runtime.sendPrompt({ sessionId: second.sessionId, text: 'hello second' })

    expect(first.sessionId).toBe('remote-session-1')
    expect(second.sessionId).toBe('remote-session-2')
    expect(fakeAgent.prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'hello first' },
      { sessionId: 'remote-session-2', text: 'hello second' }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'remote-session-1', text: 'reply for remote-session-1' },
        { sessionId: 'remote-session-2', text: 'reply for remote-session-2' }
      ])
    )
  })

  it('sends staged uploads as ACP prompt content blocks', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const stagedAttachments = await uploadRepository.stageFiles({
      files: [
        {
          name: 'paste.png',
          mimeType: 'image/png',
          content: Buffer.from('png-bytes').toString('base64')
        },
        {
          name: 'notes.txt',
          mimeType: 'text/plain',
          content: Buffer.from('hello from upload').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: {
        repository: uploadRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'review these attachments',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0][0]).toEqual({
      type: 'text',
      text: 'review these attachments'
    })
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
      uri: expect.stringContaining('/uploads/default-project/remote-session-1/paste.png')
    })
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        text: 'hello from upload',
        uri: expect.stringContaining('/uploads/default-project/remote-session-1/notes.txt')
      }
    })
    await expect(
      readFile(join(root, 'uploads', 'default-project', 'remote-session-1', 'notes.txt'), 'utf8')
    ).resolves.toBe('hello from upload')
  })

  it('sends PDFs as extracted text, never as an inlined base64 file', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    // Non-PDF bytes make extraction fail deterministically; the block must still be text, not the file.
    const stagedAttachments = await uploadRepository.stageFiles({
      files: [
        {
          name: 'doc.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('not a real pdf payload').toString('base64')
        }
      ]
    })
    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'summarize this pdf',
      attachments: stagedAttachments
    })

    expect(receivedPrompts).toHaveLength(1)
    const pdfBlock = receivedPrompts[0][1]
    expect(pdfBlock.type).toBe('resource')
    expect(pdfBlock).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        uri: expect.stringContaining('/uploads/default-project/remote-session-1/doc.pdf')
      }
    })
    // The raw file bytes must never be inlined as base64 anywhere in the prompt.
    const rawBase64 = Buffer.from('not a real pdf payload').toString('base64')
    const serialized = JSON.stringify(receivedPrompts[0])
    expect(serialized).not.toContain(rawBase64)
    expect(receivedPrompts[0].some((block) => block.type === 'image')).toBe(false)
    // Headroom for the one-time dynamic import of the large pdfjs-dist bundle, whose ESM resolution
    // is markedly slower on a cold Windows CI runner and can exceed the 5s default there.
  }, 30000)

  it('appends referenced artifacts as content blocks by file type', async () => {
    const root = await createTemporaryRoot()
    const uploadRepository = new UploadRepository(root)
    const artifactRepository = new ArtifactRepository(root)

    // A referenced upload (an already-staged file) resolves through the upload path validator.
    const [uploadRef] = await uploadRepository.stageFiles({
      files: [
        {
          name: 'summary.txt',
          mimeType: 'text/plain',
          content: Buffer.from('referenced upload text').toString('base64')
        }
      ]
    })

    // A referenced image output resolves through the artifact path validator and inlines its pixels.
    const imageArtifact = await artifactRepository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'remote-session-1',
      runId: 'run-1',
      filename: 'chart.png',
      mimeType: 'image/png',
      source: {
        kind: 'inline',
        content: Buffer.from('png-bytes').toString('base64'),
        encoding: 'base64'
      }
    })

    // A referenced binary output has no rich representation, so it falls through to a resource link.
    const binaryArtifact = await artifactRepository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'remote-session-1',
      runId: 'run-1',
      filename: 'data.bin',
      mimeType: 'application/octet-stream',
      source: {
        kind: 'inline',
        content: Buffer.from([0, 1, 2, 3]).toString('base64'),
        encoding: 'base64'
      }
    })

    const process = new FakeAgentProcess()
    const receivedPrompts: ContentBlock[][] = []
    startFakeAgent(process, ['remote-session-1'], {
      onPrompt: ({ prompt }) => {
        receivedPrompts.push(prompt)
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      uploads: { repository: uploadRepository },
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: artifactRepository
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'use these files',
      referencedArtifacts: [
        {
          id: 'u1',
          name: uploadRef.originalName,
          path: uploadRef.path,
          source: 'upload',
          mimeType: uploadRef.mimeType
        },
        {
          id: 'a1',
          name: imageArtifact.name,
          path: imageArtifact.path,
          source: 'artifact',
          mimeType: imageArtifact.mimeType
        },
        {
          id: 'a2',
          name: binaryArtifact.name,
          path: binaryArtifact.path,
          source: 'artifact',
          mimeType: binaryArtifact.mimeType
        }
      ]
    })

    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0][0]).toEqual({ type: 'text', text: 'use these files' })
    // Referenced upload text file -> inline resource with its contents.
    expect(receivedPrompts[0][1]).toMatchObject({
      type: 'resource',
      resource: {
        mimeType: 'text/plain',
        text: 'referenced upload text',
        uri: expect.stringContaining('summary.txt')
      }
    })
    // Referenced image artifact -> base64 image block.
    expect(receivedPrompts[0][2]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('png-bytes').toString('base64'),
      uri: expect.stringContaining('chart.png')
    })
    // Referenced binary artifact -> resource link.
    expect(receivedPrompts[0][3]).toMatchObject({
      type: 'resource_link',
      name: 'data.bin',
      title: 'data.bin',
      mimeType: 'application/octet-stream',
      uri: expect.stringContaining('data.bin')
    })
  })

  it('gives opencode the stdio artifact MCP server + tool guidance (it accepts stdio like Claude)', async () => {
    const root = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['oc-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      // opencode accepts stdio MCP over ACP (verified live), so it gets the same stdio config as Claude.
      framework: opencodeFramework,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello opencode' })

    // The artifact server is delivered over stdio (command/args, not a url) and its tool guidance rides
    // opencode's prompt prefix. No Claude _meta is sent (that stays framework-specific).
    const servers = fakeAgent.newSessions[0].mcpServers as Array<{ command?: string; url?: string }>
    expect(servers).toHaveLength(1)
    expect(servers[0].command).toBeTruthy()
    expect(servers[0].url).toBeUndefined()
    expect(fakeAgent.newSessions[0]._meta).toBeUndefined()
    expect(fakeAgent.prompts[0].text).toContain('hello opencode')
    expect(fakeAgent.prompts[0].text).toContain('write_artifact_file')
  })

  it('serves artifact/notebook MCP over the http host for an http-only framework', async () => {
    const root = await createTemporaryRoot()
    const httpHost = new AgentMcpHttpHost()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['oc-session'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      // A synthetic http-only framework keeps the http-host path covered now that opencode uses stdio;
      // the AgentMcpHttpHost stays in the runtime for any future framework that rejects stdio MCP.
      framework: { ...opencodeFramework, acceptsStdioMcp: false },
      mcpHttpHost: httpHost,
      artifacts: {
        configRoot: root,
        dataRoot: root,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1:1/notebook', token: 'nb' })
      }
    })

    try {
      await runtime.createSession({ cwd: '/workspace' })

      const servers = fakeAgent.newSessions[0].mcpServers as Array<{
        type?: string
        name?: string
        url?: string
        headers?: Array<{ name: string; value: string }>
      }>

      // opencode gets http MCP configs (not stdio) pointing at the local host, with bearer auth.
      expect(servers.map((server) => server.type)).toEqual(['http', 'http'])
      expect(servers.map((server) => server.name)).toEqual(
        expect.arrayContaining(['open-science-artifacts', 'open-science-notebook'])
      )
      const artifactServer = servers.find((server) => server.name === 'open-science-artifacts')
      expect(artifactServer?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/artifact\//)
      expect(artifactServer?.headers?.[0]).toMatchObject({ name: 'authorization' })
    } finally {
      await httpHost.close()
    }
  })

  it('allows prompts from different sessions to run concurrently', async () => {
    const process = new FakeAgentProcess()
    const promptCanStopBySession = new Map<string, ReturnType<typeof createDeferred>>()
    const promptStartedBySession = new Map<string, ReturnType<typeof createDeferred>>()
    const prompts: Array<{ sessionId: string; text: string }> = []
    const events: Array<{ sessionId?: string; text?: string }> = []
    let sessionIndex = 0

    acp
      .agent({ name: 'parallel-test-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => {
        sessionIndex += 1
        return { sessionId: `remote-session-${sessionIndex}` }
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const text = ctx.params.prompt
          .map((content) => (content.type === 'text' ? content.text : ''))
          .join('')
        const sessionId = ctx.params.sessionId
        const promptCanStop = promptCanStopBySession.get(sessionId)
        const promptStarted = promptStartedBySession.get(sessionId)

        if (!promptCanStop || !promptStarted) {
          throw new Error(`Unexpected prompt session: ${sessionId}`)
        }

        prompts.push({ sessionId, text })
        promptStarted.resolve(undefined)

        await promptCanStop.promise
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `reply-${sessionId}`,
            content: {
              type: 'text',
              text: `reply for ${sessionId}`
            }
          }
        })

        return { stopReason: 'end_turn' }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })
    const first = await runtime.createSession({ cwd: '/workspace' })
    const second = await runtime.createSession({ cwd: '/workspace' })

    promptCanStopBySession.set(first.sessionId, createDeferred())
    promptStartedBySession.set(first.sessionId, createDeferred())
    promptCanStopBySession.set(second.sessionId, createDeferred())
    promptStartedBySession.set(second.sessionId, createDeferred())

    const firstPrompt = runtime.sendPrompt({ sessionId: first.sessionId, text: 'first prompt' })
    const secondPrompt = runtime.sendPrompt({
      sessionId: second.sessionId,
      text: 'second prompt'
    })

    await promptStartedBySession.get(first.sessionId)?.promise
    await promptStartedBySession.get(second.sessionId)?.promise

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([
      'remote-session-1',
      'remote-session-2'
    ])

    promptCanStopBySession.get(first.sessionId)?.resolve(undefined)
    await firstPrompt
    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual(['remote-session-2'])

    promptCanStopBySession.get(second.sessionId)?.resolve(undefined)
    await secondPrompt

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'first prompt' },
      { sessionId: 'remote-session-2', text: 'second prompt' }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'remote-session-1', text: 'reply for remote-session-1' },
        { sessionId: 'remote-session-2', text: 'reply for remote-session-2' }
      ])
    )
  })

  it('shares one agent connection when sessions are created concurrently', async () => {
    const initializeCanFinish = createDeferred()
    let spawnCount = 0
    let sessionIndex = 0

    const createDelayedAgentProcess = (): ChildProcessWithoutNullStreams => {
      spawnCount += 1
      const process = new FakeAgentProcess()

      acp
        .agent({ name: `delayed-agent-${spawnCount}` })
        .onRequest(acp.methods.agent.initialize, async () => {
          await initializeCanFinish.promise

          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: {
                close: {}
              }
            },
            authMethods: []
          }
        })
        .onRequest(acp.methods.agent.session.new, () => {
          sessionIndex += 1
          return { sessionId: `remote-session-${sessionIndex}` }
        })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      return asAgentProcess(process)
    }

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: createDelayedAgentProcess
    })
    const firstSession = runtime.createSession({ cwd: '/workspace' })
    const secondSession = runtime.createSession({ cwd: '/workspace' })

    initializeCanFinish.resolve(undefined)

    await expect(Promise.all([firstSession, secondSession])).resolves.toEqual([
      { sessionId: 'remote-session-1', cwd: resolve('/workspace') },
      { sessionId: 'remote-session-2', cwd: resolve('/workspace') }
    ])
    expect(spawnCount).toBe(1)
    expect(runtime.getSnapshot().sessionIds).toEqual(['remote-session-1', 'remote-session-2'])
  })

  it('invalidates an in-flight connection when disconnect is requested before initialization finishes', async () => {
    const initializeStarted = createDeferred()
    const firstInitializeCanFinish = createDeferred()
    let spawnCount = 0

    const createDelayedAgentProcess = (): ChildProcessWithoutNullStreams => {
      spawnCount += 1
      const processId = spawnCount
      const process = new FakeAgentProcess()

      acp
        .agent({ name: `disconnect-race-agent-${processId}` })
        .onRequest(acp.methods.agent.initialize, async () => {
          if (processId === 1) {
            initializeStarted.resolve(undefined)
            await firstInitializeCanFinish.promise
          }

          return {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: {
                close: {}
              }
            },
            authMethods: []
          }
        })
        .onRequest(acp.methods.agent.session.new, () => ({
          sessionId: `remote-session-${processId}`
        }))
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      return asAgentProcess(process)
    }

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: createDelayedAgentProcess
    })
    const firstConnect = runtime.connect({ cwd: '/first-workspace' })
    const firstConnectRejection = expect(firstConnect).rejects.toThrow()

    await initializeStarted.promise
    await expect(runtime.disconnect()).resolves.toMatchObject({ status: 'closed' })

    const session = await runtime.createSession({ cwd: '/second-workspace' })

    firstInitializeCanFinish.resolve(undefined)
    await firstConnectRejection

    expect(session).toEqual({
      sessionId: 'remote-session-2',
      cwd: resolve('/second-workspace')
    })
    expect(spawnCount).toBe(2)
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'connected',
      sessionIds: ['remote-session-2']
    })
  })

  it('rejects filesystem callbacks for unknown sessions instead of falling back to global cwd', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-runtime-'))
    const filePath = join(workspaceRoot, 'notes.txt')
    let filesystemError: string | undefined

    try {
      await writeFile(filePath, 'session scoped file', 'utf8')

      const process = new FakeAgentProcess()

      acp
        .agent({ name: 'unknown-fs-session-agent' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: {
              close: {}
            }
          },
          authMethods: []
        }))
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
        .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
          try {
            await ctx.client.request(acp.methods.client.fs.readTextFile, {
              sessionId: 'missing-session',
              path: filePath
            })
          } catch (error) {
            filesystemError = String(error)
          }

          return { stopReason: 'end_turn' }
        })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )

      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: workspaceRoot,
        spawnAgent: () => asAgentProcess(process)
      })
      const session = await runtime.createSession({ cwd: workspaceRoot })

      await runtime.sendPrompt({ sessionId: session.sessionId, text: 'read unknown session file' })

      expect(filesystemError).toBeDefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects permission callbacks for unknown sessions without emitting renderer prompts', async () => {
    const process = new FakeAgentProcess()
    let permissionError: string | undefined
    let emittedUnknownPermission = false

    acp
      .agent({ name: 'unknown-permission-session-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        try {
          await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: 'missing-session',
            toolCall: {
              toolCallId: 'tool-1',
              title: 'Run command',
              status: 'pending'
            },
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
          })
        } catch (error) {
          permissionError = String(error)
        }

        return { stopReason: 'end_turn' }
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onPermissionRequest: (request) => {
          emittedUnknownPermission = request.sessionId === 'missing-session'
          runtime.respondToPermission({ requestId: request.requestId, cancelled: true })
        }
      }
    })
    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({ sessionId: session.sessionId, text: 'request unknown permission' })

    expect(emittedUnknownPermission).toBe(false)
    expect(permissionError).toBeDefined()
    expect(runtime.getSnapshot().pendingPermissions).toEqual([])
  })

  it('removes a session so later prompts cannot target it', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.deleteSession({ sessionId: session.sessionId })

    expect(fakeAgent.closedSessions).toEqual(['remote-session-1'])
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'hello' })
    ).rejects.toThrow(/not found/)
  })

  it('resumes an existing protocol session so restored conversations can continue', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [])
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    await runtime.resumeSession({
      sessionId: 'remote-session-1',
      cwd: '/workspace'
    })
    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'continue restored session'
    })

    expect(fakeAgent.resumedSessions).toEqual([
      {
        sessionId: 'remote-session-1',
        cwd: resolve('/workspace'),
        mcpServers: [],
        // Every session (new or resumed) is restricted to the app-owned "user" settings scope, and
        // carries the always-on skill-privacy guardrail in its system prompt.
        _meta: {
          claudeCode: { options: { settingSources: ['user'] } },
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: expect.stringContaining('open_science_skill_privacy_instructions')
          }
        }
      }
    ])
    expect(fakeAgent.prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'continue restored session'
      }
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'remote-session-1', text: 'reply for remote-session-1' }
      ])
    )
  })

  it('times out and tears down a reconnect when the agent never answers session/resume', async () => {
    const process = new FakeAgentProcess()
    const resumeReceived = createDeferred()

    // A fresh agent that advertises resume support but leaves session/resume pending forever.
    acp
      .agent({ name: 'stuck-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {}, resume: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.resume, () => {
        resumeReceived.resolve(undefined)
        return new Promise<never>(() => {})
      })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    // Capture the injected timer callback so the test can fire the resume timeout deterministically.
    let fireResumeTimeout: (() => void) | undefined
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      resumeTimeoutMs: 1000,
      setTimer: (fn) => {
        fireResumeTimeout = fn
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })

    const resume = runtime.resumeSession({ sessionId: 'stuck-session', cwd: '/workspace' })

    // Wait until the resume request is genuinely in flight, then trip the injected timeout.
    await resumeReceived.promise
    fireResumeTimeout?.()

    await expect(resume).rejects.toThrow(/timed out/i)
    // The half-open connection is torn down so a retry reconnects cleanly.
    expect(process.killed).toBe(true)
  })

  it('adopts a fresh session under the same id when a replaced agent no longer holds it', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    // Resume fails (Resource not found) but is transparently adopted onto a new agent session, keeping
    // the requested (app-facing) id so the conversation can continue after a provider switch.
    const resumed = await runtime.resumeSession({
      sessionId: 'switched-session',
      cwd: '/workspace'
    })
    expect(resumed.sessionId).toBe('switched-session')
    // Signals the caller that agent-side context was lost so it can replay a transcript preamble.
    expect(resumed.contextReset).toBe(true)

    await runtime.sendPrompt({ sessionId: 'switched-session', text: 'keep going' })

    // The new agent session (adopted-session-1) streamed a reply, relabeled to the app-facing id.
    expect(fakeAgent.prompts).toEqual([{ sessionId: 'adopted-session-1', text: 'keep going' }])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'switched-session', text: 'reply for adopted-session-1' }
      ])
    )
  })

  it('prepends a history preamble to the agent content but not the user-facing message', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeNotFound: true })
    const messageEvents: Array<{ role?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'message' && event.role === 'user') {
            messageEvents.push({ role: event.role, text: event.text })
          }
        }
      }
    })

    await runtime.resumeSession({ sessionId: 'switched-session', cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'switched-session',
      text: 'keep going',
      historyPreamble: 'PRIOR CONTEXT: the user asked to plot data.'
    })

    // The agent sees the replayed context ahead of the user's text...
    expect(fakeAgent.prompts[0]?.text).toContain('PRIOR CONTEXT: the user asked to plot data.')
    expect(fakeAgent.prompts[0]?.text).toContain('keep going')
    // ...but the conversation bubble records only what the user actually typed.
    expect(messageEvents).toEqual([{ role: 'user', text: 'keep going' }])
  })

  it('adopts a fresh session when the agent returns a generic Internal error on resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['adopted-session-1'], { resumeInternalError: true })
    const events: Array<{ sessionId?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ sessionId: event.sessionId, text: event.text })
      }
    })

    // Resume fails with -32603 "Internal error" (what a restarted agent returns instead of a clean
    // not-found). It must still be adopted onto a fresh agent session so the thread is not dead-ended.
    const resumed = await runtime.resumeSession({
      sessionId: 'restarted-session',
      cwd: '/workspace'
    })
    expect(resumed.sessionId).toBe('restarted-session')

    await runtime.sendPrompt({ sessionId: 'restarted-session', text: 'keep going' })

    expect(fakeAgent.prompts).toEqual([{ sessionId: 'adopted-session-1', text: 'keep going' }])
    expect(events).toEqual(
      expect.arrayContaining([
        { sessionId: 'restarted-session', text: 'reply for adopted-session-1' }
      ])
    )
  })

  it('skips resume entirely for a session that last ran under a different framework', async () => {
    // A session created under Claude, then continued after switching to opencode: resume can never
    // succeed (each framework has its own session store), so the runtime must NOT send session/resume
    // (which would make the agent log a scary internal error) and adopt a fresh session directly.
    const claudeProcess = new FakeAgentProcess()
    const claudeAgent = startFakeAgent(claudeProcess, ['claude-session-1'])
    const opencodeProcess = new FakeAgentProcess()
    const opencodeAgent = startFakeAgent(opencodeProcess, ['opencode-session-1'])

    let connects = 0
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      // First connect resolves Claude, the second (after the switch) resolves opencode; each framework
      // spawns its own fake process so their session stores stay distinct.
      resolveBackend: async () => {
        connects += 1

        return {
          framework:
            connects === 1
              ? { ...claudeCodeFramework, spawn: () => asAgentProcess(claudeProcess) }
              : { ...opencodeFramework, spawn: () => asAgentProcess(opencodeProcess) },
          executablePath: '/bin/agent',
          env: {},
          args: []
        }
      }
    })

    const created = await runtime.createSession({ cwd: '/workspace' })
    expect(created.sessionId).toBe('claude-session-1')

    // Switching frameworks disconnects; the next connect resolves opencode.
    await runtime.disconnect(false)

    const resumed = await runtime.resumeSession({
      sessionId: 'claude-session-1',
      cwd: '/workspace'
    })

    // Adopted onto opencode under the same app id, with context reset so soft-replay can run.
    expect(resumed).toEqual({
      sessionId: 'claude-session-1',
      cwd: '/workspace',
      contextReset: true
    })
    // The doomed resume was never sent to opencode; it built a fresh session instead.
    expect(opencodeAgent.resumedSessions).toEqual([])
    expect(opencodeAgent.newSessions).toHaveLength(1)
    // And the original Claude agent was never asked to resume either.
    expect(claudeAgent.resumedSessions).toEqual([])
  })

  it('defers a provider reconnect until an in-flight prompt finishes', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(process, ['s1'], { onPrompt: () => gate.promise })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    // Start a prompt that stays in flight until the gate is released.
    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // A provider switch requested mid-turn must NOT disconnect the running agent.
    await runtime.requestProviderReconnect()
    expect(process.killed).toBe(false)

    // Once the turn finishes, the deferred reconnect is applied (agent torn down for a fresh spawn).
    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
  })

  it('reconnects immediately when a provider switch happens with no prompt in flight', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestProviderReconnect()

    expect(process.killed).toBe(true)
  })

  it('reloads skills immediately when no prompt is in flight', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['s1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.requestSkillsReload()

    expect(process.killed).toBe(true)
  })

  it('defers a skills reload until an in-flight prompt finishes', async () => {
    const process = new FakeAgentProcess()
    const gate = createDeferred()
    startFakeAgent(process, ['s1'], { onPrompt: () => gate.promise })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const prompt = runtime.sendPrompt({ sessionId: 's1', text: 'hi' })

    // A skill toggle mid-turn must NOT disconnect the running agent.
    await runtime.requestSkillsReload()
    expect(process.killed).toBe(false)

    // Once the turn finishes, the deferred reload is applied (agent torn down for a fresh spawn).
    gate.resolve()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(process.killed).toBe(true)
  })

  it('passes the artifact MCP server to new and resumed sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science'
      }
    })

    const createdSession = await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace'
    })

    expect(createdSession.sessionId).toBe('remote-session-1')
    expect(fakeAgent.newSessions[0].mcpServers).toHaveLength(1)
    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      name: 'open-science-artifacts',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-artifact-mcp']
    })
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_SESSION_ID')
    ).toMatch(/^artifact-session-/)
    expect(fakeAgent.resumedSessions[0].mcpServers).toHaveLength(1)
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_SESSION_ID')
    ).toBe('remote-session-2')
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining('write_artifact_file')
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining('write_artifact_file')
      }
    })
    // The skill-privacy guardrail is appended to the system prompt on both create and resume.
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('open_science_skill_privacy_instructions')
      }
    })
    expect(fakeAgent.resumedSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('open_science_skill_privacy_instructions')
      }
    })
  })

  it('scopes the artifact MCP project to a caller-supplied projectName on create and resume', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    await runtime.createSession({ cwd: '/workspace', projectName: 'project-abc' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace',
      projectName: 'project-xyz'
    })

    // The per-session projectName (not the runtime default) reaches the artifact MCP server config.
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME')
    ).toBe('project-abc')
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME')
    ).toBe('project-xyz')
  })

  it('falls back to the runtime default projectName when none is supplied', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME')
    ).toBe('default-project')
  })

  it('passes notebook MCP server and scoped notebook instructions to new and resumed sessions', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const aliases: Array<{ aliasSessionId: string; sessionId: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        }),
        registerSessionAlias: (aliasSessionId, sessionId) => {
          aliases.push({ aliasSessionId, sessionId })
        }
      }
    })

    const createdSession = await runtime.createSession({ cwd: '/workspace' })
    await runtime.resumeSession({
      sessionId: 'remote-session-2',
      cwd: '/workspace'
    })

    expect(createdSession.sessionId).toBe('remote-session-1')
    expect(fakeAgent.newSessions[0].mcpServers).toHaveLength(1)
    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      name: 'open-science-notebook',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-notebook-mcp']
    })
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
    ).toMatch(/^notebook-session-/)
    expect(
      getEnvValue(fakeAgent.newSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_WORKSPACE_CWD')
    ).toBe(resolve('/workspace'))
    expect(aliases).toEqual([
      {
        aliasSessionId: getEnvValue(
          fakeAgent.newSessions[0].mcpServers[0],
          'OPEN_SCIENCE_NOTEBOOK_SESSION_ID'
        ),
        sessionId: 'remote-session-1'
      }
    ])
    expect(fakeAgent.resumedSessions[0].mcpServers).toHaveLength(1)
    expect(
      getEnvValue(fakeAgent.resumedSessions[0].mcpServers[0], 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')
    ).toBe('remote-session-2')
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining(
          'Notebook tool instructions (only applies when using open-science-notebook tools)'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('writable session workspace')
      }
    })
  })

  it('passes workspace and notebook roots to the artifact MCP server as allowed import roots', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js'
      },
      notebook: {
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        getRpcConnection: async () => ({
          endpoint: 'http://127.0.0.1:4567',
          token: 'secret-token'
        })
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    const byName = (name: string): unknown | undefined =>
      fakeAgent.newSessions[0].mcpServers.find(
        (server) =>
          typeof server === 'object' && server !== null && 'name' in server && server.name === name
      )
    const artifactServer = byName('open-science-artifacts')
    const notebookServer = byName('open-science-notebook')

    if (!artifactServer || !notebookServer) {
      throw new Error('Expected artifact and notebook MCP servers')
    }

    const notebookSessionId = getEnvValue(notebookServer, 'OPEN_SCIENCE_NOTEBOOK_SESSION_ID')

    expect(
      JSON.parse(getEnvValue(artifactServer, 'OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS'))
    ).toEqual([
      resolve('/workspace'),
      join('/Users/example/.open-science', 'notebooks', 'default-project', notebookSessionId)
    ])
  })

  it('uses the configured main entry path for artifact MCP server config', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: '/Users/example/.open-science',
        dataRoot: '/Users/example/.open-science',
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/Applications/Open Science.app/Contents/MacOS/Open Science'
      }
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(fakeAgent.newSessions[0].mcpServers[0]).toMatchObject({
      args: ['/app/out/main/index.js', '--open-science-artifact-mcp']
    })
  })

  it('adds artifact instructions through session system prompt metadata without mutating prompts', async () => {
    const storageRoot = await createTemporaryRoot()
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['remote-session-1'])
    const events: Array<{ role?: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      callbacks: {
        onEvent: (event) => events.push({ role: event.role, text: event.text })
      },
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        repository: new ArtifactRepository(storageRoot)
      }
    })

    const session = await runtime.createSession({ cwd: '/workspace' })

    await runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'Generate a little duckling meme image and save it locally'
    })

    expect(fakeAgent.prompts[0]).toMatchObject({
      sessionId: 'remote-session-1',
      text: 'Generate a little duckling meme image and save it locally'
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: expect.stringContaining('write_artifact_file')
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining(
          'Do not save generated user-facing files directly into the workspace'
        )
      }
    })
    expect(fakeAgent.newSessions[0]._meta).toMatchObject({
      systemPrompt: {
        append: expect.stringContaining('inline content or a local source path')
      }
    })
    expect(events).toEqual(
      expect.arrayContaining([
        { role: 'user', text: 'Generate a little duckling meme image and save it locally' }
      ])
    )
  })

  it('emits an artifact event with pending files before a prompt stops', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    const events: Array<{
      kind: string
      sessionId?: string
      runId?: string
      artifactClaimId?: string
      artifactCount?: number
    }> = []
    let currentRunFile = ''
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async ({ sessionId }) => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as { runId: string }

        await repository.writePendingFile({
          projectName: 'default-project',
          sessionId: getEnvValue(
            fakeAgent.newSessions[0].mcpServers[0],
            'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
          ),
          runId: context.runId,
          filename: 'result.txt',
          source: { kind: 'inline', content: 'artifact content', encoding: 'utf8' }
        })
        expect(sessionId).toBe('remote-session-1')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron',
        repository
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') {
            events.push({
              kind: event.kind,
              sessionId: event.sessionId,
              runId: event.runId,
              artifactClaimId: event.artifactClaimId,
              artifactCount: event.artifacts?.length
            })
          }
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    currentRunFile = getEnvValue(
      fakeAgent.newSessions[0].mcpServers[0],
      'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'
    )
    await runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'make a file' })

    expect(events).toEqual([
      {
        kind: 'artifact',
        sessionId: 'remote-session-1',
        runId: expect.stringMatching(/^artifact-run-/),
        artifactClaimId: expect.stringMatching(/^artifact-claim-/),
        artifactCount: 1
      }
    ])
  })

  it('emits an artifact event for pending files even when the prompt fails', async () => {
    const storageRoot = await createTemporaryRoot()
    const repository = new ArtifactRepository(storageRoot)
    const process = new FakeAgentProcess()
    const events: Array<{
      kind: string
      sessionId?: string
      runId?: string
      artifactClaimId?: string
      artifactCount?: number
    }> = []
    let currentRunFile = ''
    const fakeAgent = startFakeAgent(process, ['remote-session-1'], {
      onPrompt: async () => {
        const context = JSON.parse(await readFile(currentRunFile, 'utf8')) as { runId: string }

        await repository.writePendingFile({
          projectName: 'default-project',
          sessionId: getEnvValue(
            fakeAgent.newSessions[0].mcpServers[0],
            'OPEN_SCIENCE_ARTIFACT_SESSION_ID'
          ),
          runId: context.runId,
          filename: 'result.txt',
          source: { kind: 'inline', content: 'artifact content', encoding: 'utf8' }
        })

        // Fail the turn after the file was written so it never reaches a clean stop.
        throw new Error('agent exploded mid-turn')
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: storageRoot,
        dataRoot: storageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron',
        repository
      },
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'artifact') {
            events.push({
              kind: event.kind,
              sessionId: event.sessionId,
              runId: event.runId,
              artifactClaimId: event.artifactClaimId,
              artifactCount: event.artifacts?.length
            })
          }
        }
      }
    })

    await runtime.createSession({ cwd: '/workspace' })
    currentRunFile = getEnvValue(
      fakeAgent.newSessions[0].mcpServers[0],
      'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE'
    )
    await expect(
      runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'make a file' })
    ).rejects.toThrow()

    expect(events).toEqual([
      {
        kind: 'artifact',
        sessionId: 'remote-session-1',
        runId: expect.stringMatching(/^artifact-run-/),
        artifactClaimId: expect.stringMatching(/^artifact-claim-/),
        artifactCount: 1
      }
    ])
  })

  it('cleans up prompt in-flight state when artifact run activation fails', async () => {
    const storageRoot = await createTemporaryRoot()
    const blockedStorageRoot = join(storageRoot, 'storage-file')
    const process = new FakeAgentProcess()
    const events: Array<{ kind: string; text?: string }> = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process),
      artifacts: {
        configRoot: blockedStorageRoot,
        dataRoot: blockedStorageRoot,
        projectName: 'default-project',
        mcpEntryPath: '/app/out/main/index.js',
        mcpCommand: '/usr/bin/electron'
      },
      callbacks: {
        onEvent: (event) => events.push({ kind: event.kind, text: event.text })
      }
    })
    startFakeAgent(process, ['remote-session-1'])
    await writeFile(blockedStorageRoot, 'not a directory', 'utf8')
    const session = await runtime.createSession({ cwd: '/workspace' })

    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'make a file' })
    ).rejects.toThrow()

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'error'
        })
      ])
    )
  })

  it('rejects restored sessions when the agent does not advertise resume support', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, [], { supportsResume: false })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await expect(
      runtime.resumeSession({
        sessionId: 'remote-session-1',
        cwd: '/workspace'
      })
    ).rejects.toThrow(/does not support session resume/)
    expect(fakeAgent.resumedSessions).toEqual([])
  })

  it('keeps a cancelling prompt in flight until the agent returns its stop response', async () => {
    const process = new FakeAgentProcess()
    const promptCanStop = createDeferred()
    const promptStarted = createDeferred()
    const prompts: string[] = []

    acp
      .agent({ name: 'cancel-test-agent' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: {
            close: {}
          }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'remote-session-1' }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        // Keep the first prompt open so cancellation can be observed while it is in flight.
        const text = ctx.params.prompt
          .map((content) => (content.type === 'text' ? content.text : ''))
          .join('')
        prompts.push(text)

        if (prompts.length === 1) {
          promptStarted.resolve()
          await promptCanStop.promise
          return { stopReason: 'cancelled' }
        }

        return { stopReason: 'end_turn' }
      })
      .onNotification(acp.methods.agent.session.cancel, () => {
        promptCanStop.resolve()
      })
      .onRequest(acp.methods.agent.session.close, () => ({}))
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const session = await runtime.createSession({ cwd: '/workspace' })
    const promptPromise = runtime.sendPrompt({
      sessionId: session.sessionId,
      text: 'first prompt'
    })

    await promptStarted.promise

    const cancelSnapshot = await runtime.cancelPrompt({ sessionId: session.sessionId })

    expect(cancelSnapshot.promptInFlightSessionIds).toEqual(['remote-session-1'])
    await expect(
      runtime.sendPrompt({ sessionId: session.sessionId, text: 'second prompt' })
    ).rejects.toThrow(/already running/)

    await promptPromise

    expect(runtime.getSnapshot().promptInFlightSessionIds).toEqual([])
    expect(prompts).toEqual(['first prompt'])
  })
})

describe('ACP runtime skill force-load + nudge', () => {
  // Builds a spawner that returns a fresh fake agent per connect, so a force-load reconnect can spawn a
  // second working agent. All agent handles are collected so tests can assert prompts across reconnects.
  const createFreshAgentSpawner = (): {
    spawn: () => ChildProcessWithoutNullStreams
    agents: Array<ReturnType<typeof startFakeAgent>>
    spawnCount: () => number
  } => {
    const agents: Array<ReturnType<typeof startFakeAgent>> = []
    let count = 0

    return {
      spawn: () => {
        count += 1
        const process = new FakeAgentProcess()
        agents.push(startFakeAgent(process, ['remote-session-1']))
        return asAgentProcess(process)
      },
      agents,
      spawnCount: () => count
    }
  }

  // A stub of the settings-service skill hooks with per-call spies for assertions.
  const createSkillsHooks = (options: {
    needForceLoad: string[]
    names: Record<string, string>
  }): {
    needForceLoad: ReturnType<typeof vi.fn<(ids: string[]) => Promise<string[]>>>
    setTurnForced: ReturnType<typeof vi.fn<(ids: string[]) => void>>
    clearTurnForced: ReturnType<typeof vi.fn<() => void>>
    namesForIds: ReturnType<typeof vi.fn<(ids: string[]) => Promise<string[]>>>
  } => ({
    needForceLoad: vi.fn<(ids: string[]) => Promise<string[]>>(async () => options.needForceLoad),
    setTurnForced: vi.fn<(ids: string[]) => void>(),
    clearTurnForced: vi.fn<() => void>(),
    namesForIds: vi.fn<(ids: string[]) => Promise<string[]>>(async (ids: string[]) =>
      ids.map((id) => options.names[id]).filter((name): name is string => name !== undefined)
    )
  })

  it('respawns and nudges when a picked skill is disabled, then restores after the turn', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({
      needForceLoad: ['research'],
      names: { research: 'Deep Research' }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    expect(spawner.spawnCount()).toBe(1)

    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['research']
    })

    // The picked skill was marked forced and the agent respawned before the prompt (resume path).
    expect(hooks.setTurnForced).toHaveBeenCalledWith(['research'])
    expect(spawner.spawnCount()).toBe(2)
    expect(spawner.agents[1].resumedSessions).toHaveLength(1)

    // The nudge is prepended to the text the agent receives (on the respawned agent).
    expect(spawner.agents[1].prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'Use the following skill(s) for this task: Deep Research.\n\nsummarize the paper'
      }
    ])

    // After the turn the force set is cleared and a restore reconnect is scheduled (agent torn down).
    expect(hooks.clearTurnForced).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.getSnapshot().status).toBe('closed')
  })

  it('nudges without any reconnect when every picked skill is already enabled', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({
      needForceLoad: [],
      names: { research: 'Deep Research' }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({
      sessionId: 'remote-session-1',
      text: 'summarize the paper',
      forcedSkillIds: ['research']
    })

    // No disabled picks → no respawn and no force set toggling, but the nudge is still prepended.
    expect(hooks.setTurnForced).not.toHaveBeenCalled()
    expect(hooks.clearTurnForced).not.toHaveBeenCalled()
    expect(spawner.spawnCount()).toBe(1)
    expect(spawner.agents[0].prompts).toEqual([
      {
        sessionId: 'remote-session-1',
        text: 'Use the following skill(s) for this task: Deep Research.\n\nsummarize the paper'
      }
    ])
  })

  it('leaves the prompt untouched when no skills are picked', async () => {
    const spawner = createFreshAgentSpawner()
    const hooks = createSkillsHooks({
      needForceLoad: ['research'],
      names: { research: 'Deep Research' }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: spawner.spawn,
      skills: hooks
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'remote-session-1', text: 'plain prompt' })

    // With no forcedSkillIds, none of the skill hooks run and the text is unchanged.
    expect(hooks.needForceLoad).not.toHaveBeenCalled()
    expect(hooks.namesForIds).not.toHaveBeenCalled()
    expect(hooks.setTurnForced).not.toHaveBeenCalled()
    expect(spawner.spawnCount()).toBe(1)
    expect(spawner.agents[0].prompts).toEqual([
      { sessionId: 'remote-session-1', text: 'plain prompt' }
    ])
  })
})

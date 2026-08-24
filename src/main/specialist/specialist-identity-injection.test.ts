// Tests for specialist first-turn identity injection.
// Covers: Claude append, Codex/OpenCode prefix, None, unavailable race.

import { describe, it, expect, vi } from 'vitest'
import {
  buildSpecialistIdentityAppend,
  buildSpecialistIdentityPrefix,
  SPECIALIST_IDENTITY_TAG
} from './identity'
import { AcpRuntime } from '../acp/runtime.test-utils'
import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'
import type { SpecialistProfileView } from '../../shared/specialist'
import * as acp from '@agentclientprotocol/sdk'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { Readable, Writable } from 'node:stream'

// ---------------------------------------------------------------------------
// Fake agent process helpers (mirrors runtime.test.ts pattern)
// ---------------------------------------------------------------------------

class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const asAgentProcess = (p: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  p as unknown as ChildProcessWithoutNullStreams

interface FakeAgentResult {
  newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  prompts: Array<{ sessionId: string; text: string }>
}

const startFakeAgent = (process: FakeAgentProcess, sessionIds: string[]): FakeAgentResult => {
  const newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }> = []
  const prompts: Array<{ sessionId: string; text: string }> = []
  let sessionIndex = 0

  acp
    .agent({ name: 'test-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, resume: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.providers.set, () => ({}))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      newSessions.push({
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers,
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })
      const sessionId = sessionIds[sessionIndex++]
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.resume, () => ({}))
    .onRequest(acp.methods.agent.session.setMode, () => ({}))
    .onRequest(acp.methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')
      prompts.push({ sessionId: ctx.params.sessionId, text })
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: { type: 'text', text: 'ok' }
        }
      })
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return { newSessions, prompts }
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

const CODEX_MODES = {
  currentModeId: 'agent',
  availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
}

// startFakeAgent with optional modes (Codex requires modes to configure permission profile)
const startFakeAgentWithModes = (
  process: FakeAgentProcess,
  sessionIds: string[],
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> }
): FakeAgentResult => {
  const newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }> = []
  const prompts: Array<{ sessionId: string; text: string }> = []
  let sessionIndex = 0

  acp
    .agent({ name: 'test-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, resume: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.providers.set, () => ({}))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      newSessions.push({
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers,
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })
      const sessionId = sessionIds[sessionIndex++]
      return { sessionId, ...(modes ? { modes } : {}) }
    })
    .onRequest(acp.methods.agent.session.resume, () => ({}))
    .onRequest(acp.methods.agent.session.setMode, () => ({}))
    .onRequest(acp.methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')
      prompts.push({ sessionId: ctx.params.sessionId, text })
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: { type: 'text', text: 'ok' }
        }
      })
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return { newSessions, prompts }
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

const makeProfile = (overrides: Partial<SpecialistProfileView> = {}): SpecialistProfileView => ({
  id: 'uuid-sp1',
  name: 'RNA-seq Reviewer',
  description: 'Reviews RNA-seq analysis quality.',
  systemPrompt: 'You are RNA-seq Reviewer. Focus on batch effects and QC.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: emptySelectedConfig(),
  revision: 1,
  ...overrides
})

// ---------------------------------------------------------------------------
// Tests: Claude Code first-turn append
// ---------------------------------------------------------------------------

describe('specialist identity injection — Claude Code', () => {
  it('includes SPECIALIST_IDENTITY_TAG in session _meta when specialistId is provided', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-sp1'])
    const profile = makeProfile()
    const registerSessionSpecialist = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      }),
      resolveSpecialistIdentity: async (specialistId, frameworkId) => {
        expect(specialistId).toBe('uuid-sp1')
        expect(frameworkId).toBe('claude-code')
        return { append: buildSpecialistIdentityAppend(profile), prefix: '' }
      },
      notebook: {
        projectId: 'test',
        mcpEntryPath: '/test/mcp.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1', token: 'test' }),
        registerSessionSpecialist
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'uuid-sp1' })

    const metaStr = JSON.stringify(fakeAgent.newSessions[0]._meta)
    expect(metaStr).toContain(SPECIALIST_IDENTITY_TAG)
    expect(metaStr).toContain('RNA-seq Reviewer')
    expect(registerSessionSpecialist).toHaveBeenCalledWith('session-sp1', 'uuid-sp1')
  })

  it('does NOT inject specialist tag when specialistId is absent', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-no-sp'])
    const resolveSpecialistIdentity = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      }),
      resolveSpecialistIdentity
    })

    await runtime.createSession({ cwd: '/workspace' })

    expect(resolveSpecialistIdentity).not.toHaveBeenCalled()
    const metaStr = JSON.stringify(fakeAgent.newSessions[0]._meta ?? {})
    expect(metaStr).not.toContain(SPECIALIST_IDENTITY_TAG)
  })

  it('throws when specialist is unavailable', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, ['session-unavail'])

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      }),
      resolveSpecialistIdentity: async () => undefined
    })

    await expect(
      runtime.createSession({ cwd: '/workspace', specialistId: 'uuid-deleted' })
    ).rejects.toThrow(/unavailable/)
  })

  it('fails closed when startup did not wire a specialist resolver', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-no-resolver'])

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      })
    })

    await expect(
      runtime.createSession({ cwd: '/workspace', specialistId: 'uuid-sp1' })
    ).rejects.toThrow(/identity resolution is unavailable/)
    expect(fakeAgent.newSessions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Codex first-turn prefix
// ---------------------------------------------------------------------------

describe('specialist identity injection — Codex', () => {
  it('includes SPECIALIST_IDENTITY_TAG in first-turn prompt prefix', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgentWithModes(process, ['session-codex-sp1'], CODEX_MODES)
    const profile = makeProfile()
    const registerSessionSpecialist = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {}
      }),
      framework: codexFramework,
      resolveSpecialistIdentity: async (_id, frameworkId) => {
        expect(frameworkId).toBe('codex')
        return { append: '', prefix: buildSpecialistIdentityPrefix(profile) }
      },
      notebook: {
        projectId: 'test',
        mcpEntryPath: '/test/mcp.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1', token: 'test' }),
        registerSessionSpecialist
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'uuid-sp1' })
    await runtime.sendPrompt({ sessionId: 'session-codex-sp1', text: 'Hello' })

    expect(fakeAgent.prompts[0].text).toContain(SPECIALIST_IDENTITY_TAG)
    expect(fakeAgent.prompts[0].text).toContain('RNA-seq Reviewer')
    expect(registerSessionSpecialist).toHaveBeenCalledWith('session-codex-sp1', 'uuid-sp1')
  })

  it('does NOT inject specialist tag for Codex when no specialistId', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgentWithModes(process, ['session-codex-no-sp'], CODEX_MODES)
    const resolveSpecialistIdentity = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {}
      }),
      framework: codexFramework,
      resolveSpecialistIdentity
    })

    await runtime.createSession({ cwd: '/workspace' })
    await runtime.sendPrompt({ sessionId: 'session-codex-no-sp', text: 'Hello' })

    expect(resolveSpecialistIdentity).not.toHaveBeenCalled()
    expect(fakeAgent.prompts[0].text).not.toContain(SPECIALIST_IDENTITY_TAG)
  })
})

// ---------------------------------------------------------------------------
// Tests: OpenCode first-turn prefix
// ---------------------------------------------------------------------------

describe('specialist identity injection — OpenCode', () => {
  it('includes SPECIALIST_IDENTITY_TAG in first-turn prompt prefix', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-opencode-sp1'])
    const profile = makeProfile()
    const registerSessionSpecialist = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...opencodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/opencode-acp',
        env: {}
      }),
      framework: opencodeFramework,
      resolveSpecialistIdentity: async (_id, frameworkId) => {
        expect(frameworkId).toBe('opencode')
        return { append: '', prefix: buildSpecialistIdentityPrefix(profile) }
      },
      notebook: {
        projectId: 'test',
        mcpEntryPath: '/test/mcp.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1', token: 'test' }),
        registerSessionSpecialist
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'uuid-sp1' })
    await runtime.sendPrompt({ sessionId: 'session-opencode-sp1', text: 'Hello' })

    expect(fakeAgent.prompts[0].text).toContain(SPECIALIST_IDENTITY_TAG)
    expect(registerSessionSpecialist).toHaveBeenCalledWith('session-opencode-sp1', 'uuid-sp1')
  })
})

describe('specialist identity injection — fresh provider adoption', () => {
  it.each([
    {
      path: 'Codex non-UUID adoption',
      framework: codexFramework,
      previousFrameworkId: 'codex' as const,
      appSessionId: 'ses_0458258b7ffeH2DeqPYBPk6fh2',
      providerSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
      modes: CODEX_MODES
    },
    {
      path: 'OpenCode cross-framework adoption',
      framework: opencodeFramework,
      previousFrameworkId: 'claude-code' as const,
      appSessionId: 'stable-app-session',
      providerSessionId: 'provider-session',
      modes: undefined
    }
  ])(
    'keeps the Specialist prefix after $path',
    async ({ framework, previousFrameworkId, appSessionId, providerSessionId, modes }) => {
      const process = new FakeAgentProcess()
      const fakeAgent = startFakeAgentWithModes(process, [providerSessionId], modes)
      const profile = makeProfile()
      const runtime = new AcpRuntime({
        appVersion: '0.1.0',
        defaultCwd: '/workspace',
        resolveBackend: () => ({
          framework: { ...framework, spawn: () => asAgentProcess(process) },
          executablePath: '/bin/agent-acp',
          env: {}
        }),
        framework,
        resolveSpecialistIdentity: async (specialistId, frameworkId) => {
          expect(specialistId).toBe(profile.id)
          expect(frameworkId).toBe(framework.id)
          return { append: '', prefix: buildSpecialistIdentityPrefix(profile) }
        }
      })

      const resumed = await runtime.resumeSession({
        sessionId: appSessionId,
        cwd: '/workspace',
        previousFrameworkId,
        specialistId: profile.id
      })
      expect(resumed).toMatchObject({ sessionId: appSessionId, contextReset: true })

      await runtime.sendPrompt({
        sessionId: appSessionId,
        text: 'Continue the analysis',
        historyPreamble: 'PRIOR CONTEXT: the last result was incomplete.'
      })

      expect(fakeAgent.prompts[0]).toMatchObject({ sessionId: providerSessionId })
      expect(fakeAgent.prompts[0].text).toContain('PRIOR CONTEXT: the last result was incomplete.')
      expect(fakeAgent.prompts[0].text).toContain(SPECIALIST_IDENTITY_TAG)
    }
  )
})

// ---------------------------------------------------------------------------
// Tests: Hot-switching specialist on a live session
// ---------------------------------------------------------------------------

describe('specialist hot-switch — Claude Code', () => {
  it('switchSpecialist replaces the session and re-bakes the new identity append', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-claude', 'session-claude-reset'])
    const profileA = makeProfile({ id: 'sp-a', name: 'Specialist A', systemPrompt: 'You are A.' })
    const profileB = makeProfile({ id: 'sp-b', name: 'Specialist B', systemPrompt: 'You are B.' })
    const registerSessionSpecialist = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      }),
      resolveSpecialistIdentity: async (specialistId: string) =>
        specialistId === 'sp-a'
          ? { append: buildSpecialistIdentityAppend(profileA), prefix: '' }
          : { append: buildSpecialistIdentityAppend(profileB), prefix: '' },
      resolveSpecialistSkills: async () => ({
        kind: 'specialist',
        skillIds: ['allowed'],
        frameworkNames: ['Allowed Skill'],
        missingSkillIds: []
      }),
      notebook: {
        projectId: 'test',
        mcpEntryPath: '/test/mcp.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1', token: 'test' }),
        registerSessionSpecialist
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-a' })
    expect(JSON.stringify(fakeAgent.newSessions[0]._meta)).toContain('Specialist A')

    const result = await runtime.switchSpecialist('session-claude', 'sp-b')

    // Claude bakes identity at session creation, so a switch must replace the session.
    expect(result.contextReset).toBe(true)
    expect(fakeAgent.newSessions).toHaveLength(2)
    expect(JSON.stringify(fakeAgent.newSessions[1]._meta)).toContain('Specialist B')
    expect(JSON.stringify(fakeAgent.newSessions[1]._meta)).not.toContain('Specialist A')
    expect(fakeAgent.newSessions[1]._meta).toMatchObject({
      claudeCode: { options: { skills: ['Allowed Skill'] } }
    })
    expect(registerSessionSpecialist).toHaveBeenLastCalledWith('session-claude', 'sp-b')
  })

  it('switchSpecialist to undefined (Main Agent) resets and drops the identity append', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-claude2', 'session-claude2-reset'])
    const profile = makeProfile()
    const registerSessionSpecialist = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      }),
      resolveSpecialistIdentity: async () => ({
        append: buildSpecialistIdentityAppend(profile),
        prefix: ''
      }),
      notebook: {
        projectId: 'test',
        mcpEntryPath: '/test/mcp.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1', token: 'test' }),
        registerSessionSpecialist
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'uuid-sp1' })
    const result = await runtime.switchSpecialist('session-claude2', undefined)

    expect(result.contextReset).toBe(true)
    expect(fakeAgent.newSessions).toHaveLength(2)
    expect(JSON.stringify(fakeAgent.newSessions[1]._meta ?? {})).not.toContain(
      SPECIALIST_IDENTITY_TAG
    )
    expect(registerSessionSpecialist).toHaveBeenLastCalledWith('session-claude2', undefined)
  })

  it('replays persisted and live user tasks after a resumed session is replaced without projecting a second user message', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgent(process, ['session-claude-replacement'])
    const profileA = makeProfile({ id: 'sp-a', name: 'Specialist A' })
    const profileB = makeProfile({ id: 'sp-b', name: 'Specialist B' })
    const userMessages: string[] = []
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      callbacks: {
        onEvent: (event) => {
          if (event.kind === 'message' && event.role === 'user' && event.text) {
            userMessages.push(event.text)
          }
        }
      },
      resolveBackend: () => ({
        framework: { ...claudeCodeFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/agent',
        env: {}
      }),
      resolveSpecialistIdentity: async (specialistId: string) =>
        specialistId === 'sp-a'
          ? { append: buildSpecialistIdentityAppend(profileA), prefix: '' }
          : { append: buildSpecialistIdentityAppend(profileB), prefix: '' }
    })

    await runtime.resumeSession({
      sessionId: 'session-claude-replay',
      cwd: '/workspace',
      specialistId: 'sp-a'
    })
    await runtime.sendPrompt({
      sessionId: 'session-claude-replay',
      text: 'Load the experiment',
      provenanceContext: { promptMessageId: 'live-user-1' },
      historyPreamble: '**User:** Earlier task\n\n**Assistant:** Earlier answer'
    })
    await runtime.sendPrompt({
      sessionId: 'session-claude-replay',
      text: 'Analyse the experiment',
      provenanceContext: { promptMessageId: 'live-user-2' }
    })

    runtime.prepareClaudeCodeHandoffReplay({
      sessionId: 'session-claude-replay',
      capturedCompletion: { kind: 'returned', value: { afterAwait: 'complete' } },
      supportedTaskContext: [
        { messageId: 'persisted-user-1', text: 'Open the project saved before restart' },
        { messageId: 'live-user-1', text: 'Load the experiment' }
      ],
      switchReadBack: {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId: 'session-claude-replay',
          specialistId: 'sp-b',
          targetName: 'Specialist B',
          revision: 4
        }
      }
    })
    await runtime.switchSpecialist('session-claude-replay', 'sp-b')
    const continuation = runtime.createClaudeCodeContinuationRequest({
      sessionId: 'session-claude-replay',
      switchReadBack: {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId: 'session-claude-replay',
          specialistId: 'sp-b',
          targetName: 'Specialist B',
          revision: 4
        }
      }
    })
    await runtime.sendPrompt(continuation)

    const replacementMeta = fakeAgent.newSessions[0]._meta as {
      systemPrompt?: { append?: string }
    }
    const replacementAppend = replacementMeta.systemPrompt?.append ?? ''
    expect(replacementAppend).toContain('Specialist B')
    expect(replacementAppend).toContain('Open the project saved before restart')
    expect(replacementAppend).toContain('Load the experiment')
    expect(replacementAppend).toContain('Analyse the experiment')
    expect(replacementAppend).toContain('"revision":4')
    expect(replacementAppend).toContain('"afterAwait":"complete"')
    expect(replacementAppend).not.toContain('Earlier answer')
    expect(fakeAgent.prompts[2]).toEqual({
      sessionId: 'session-claude-replacement',
      text: expect.not.stringContaining('Analyse the experiment')
    })
    expect(userMessages).toEqual(['Load the experiment', 'Analyse the experiment'])
  })
})

describe('specialist hot-switch — Codex', () => {
  it('switchSpecialist updates the per-turn prefix without resetting the session', async () => {
    const process = new FakeAgentProcess()
    const fakeAgent = startFakeAgentWithModes(process, ['session-codex'], CODEX_MODES)
    const profileA = makeProfile({ id: 'sp-a', name: 'Specialist A', systemPrompt: 'You are A.' })
    const profileB = makeProfile({ id: 'sp-b', name: 'Specialist B', systemPrompt: 'You are B.' })
    const registerSessionSpecialist = vi.fn()

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      resolveBackend: () => ({
        framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
        executablePath: '/bin/codex-acp',
        env: {}
      }),
      framework: codexFramework,
      resolveSpecialistIdentity: async (specialistId: string) =>
        specialistId === 'sp-a'
          ? { append: '', prefix: buildSpecialistIdentityPrefix(profileA) }
          : { append: '', prefix: buildSpecialistIdentityPrefix(profileB) },
      notebook: {
        projectId: 'test',
        mcpEntryPath: '/test/mcp.js',
        getRpcConnection: async () => ({ endpoint: 'http://127.0.0.1', token: 'test' }),
        registerSessionSpecialist
      }
    })

    await runtime.createSession({ cwd: '/workspace', specialistId: 'sp-a' })
    await runtime.sendPrompt({ sessionId: 'session-codex', text: 'Hello' })
    expect(fakeAgent.prompts[0].text).toContain('Specialist A')

    // Codex carries identity as a per-turn prefix, so switching updates the map only — no reset.
    const result = await runtime.switchSpecialist('session-codex', 'sp-b')
    expect(result.contextReset).toBe(false)
    expect(fakeAgent.newSessions).toHaveLength(1)

    await runtime.sendPrompt({ sessionId: 'session-codex', text: 'Again' })
    expect(fakeAgent.prompts[1].text).toContain('Specialist B')
    expect(fakeAgent.prompts[1].text).toContain(
      'supersedes and revokes every earlier Specialist identity'
    )
    expect(fakeAgent.prompts[1].text).not.toContain('Specialist A')
    expect(registerSessionSpecialist).toHaveBeenLastCalledWith('session-codex', 'sp-b')
  })
})

// ---------------------------------------------------------------------------
// Tests: Session persistence round-trip for specialistId
// ---------------------------------------------------------------------------

describe('session-persistence specialistId field', () => {
  it('round-trips specialistId through normalizeSessionFile', async () => {
    const { normalizeSessionFile } = await import('../../shared/session-persistence')
    const raw = {
      id: 'session-sp',
      projectId: 'proj-1',
      title: 'Specialist session',
      cwd: '/workspace',
      status: 'idle',
      specialistId: 'uuid-sp1',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const restored = normalizeSessionFile(raw)
    expect(restored?.specialistId).toBe('uuid-sp1')
  })

  it('omits specialistId when absent', async () => {
    const { normalizeSessionFile } = await import('../../shared/session-persistence')
    const raw = {
      id: 'session-no-sp',
      projectId: 'proj-1',
      title: 'No specialist',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const restored = normalizeSessionFile(raw)
    expect(restored?.specialistId).toBeUndefined()
  })

  it('rejects arbitrary objects as specialistId', async () => {
    const { normalizeSessionFile } = await import('../../shared/session-persistence')
    const raw = {
      id: 'session-bad-sp',
      projectId: 'proj-1',
      title: 'Bad specialist',
      cwd: '/workspace',
      status: 'idle',
      specialistId: { __proto__: null, id: 'injection' },
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const restored = normalizeSessionFile(raw)
    expect(restored?.specialistId).toBeUndefined()
  })
})

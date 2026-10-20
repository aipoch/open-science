import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))

import { claudeCodeFramework } from '../agent-framework/claude-code'
import { AcpRuntime } from './runtime.test-utils'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { createClaudeCodeCompletionGateRuntime } from '../agents/claude-code-handoff'
import { withApprovedSpecialistBinding } from '../agents/production-completion-handoff'
import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository
} from '../agents/completion-handoff-lifecycle'
import {
  SessionSpecialistReconfiguration,
  type PersistedSessionSpecialistBinding
} from '../specialist/session-reconfiguration'

// Real runtime, ACP adapter and SDK processes; only model inference is deterministic.
// A never-prompted Claude session has no transcript to resume after a Skill reload.
it('recovers an approved Specialist handoff through real Claude lazy-session replacement', async () => {
  // npm ci installs the SDK platform binary; never fall back to a personal CLI.
  const require = createRequire(import.meta.url)
  const executablePath = require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`
  )
  const root = await mkdtemp(join(tmpdir(), 'specialist-claude-contract-'))
  const cwd = join(root, 'project')
  const requests: string[] = []
  let disconnectRuntime = async (): Promise<void> => undefined
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages')) {
        response.writeHead(404).end()
        return
      }
      requests.push(Buffer.concat(chunks).toString('utf8'))
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: `msg_${requests.length}`,
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 }
            }
          }
        ],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'HANDOFF_OK' }
          }
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 }
          }
        ],
        ['message_stop', { type: 'message_stop' }]
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
      )
    })
  })
  onTestFinished(async () => {
    try {
      await disconnectRuntime()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    }
  })
  await mkdir(cwd)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env: Record<string, string> = {}
  for (const key of [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL'
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  }
  Object.assign(env, {
    ANTHROPIC_API_KEY: 'synthetic-specialist-contract-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'local-appdata'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    NO_PROXY: '127.0.0.1,localhost'
  })
  const wireRequests: Array<{
    method?: string
    params?: { sessionId?: string; cwd?: string; _meta?: unknown }
  }> = []
  let processCount = 0
  let liveRuntime!: AcpRuntime
  const runtime = new AcpRuntimeCoordinator(
    (callbacks) =>
      (liveRuntime = new AcpRuntime({
        callbacks,
        appVersion: '0.1.0',
        defaultCwd: root,
        resolveBackend: () => ({
          framework: {
            ...claudeCodeFramework,
            spawn: (input) =>
              claudeCodeFramework.spawn({
                ...input,
                spawnProcess: (command, args, options) => {
                  processCount++
                  // Preserve the production spawner, but allowlist environment to exclude host credentials.
                  const child = spawn(command, args, {
                    ...options,
                    env: {
                      ...env,
                      CLAUDE_CODE_EXECUTABLE: executablePath,
                      ELECTRON_RUN_AS_NODE: '1'
                    }
                  })
                  let pending = ''
                  const write = child.stdin.write.bind(child.stdin)
                  child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
                    pending +=
                      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
                    let newline: number
                    while ((newline = pending.indexOf('\n')) !== -1) {
                      const line = pending.slice(0, newline)
                      pending = pending.slice(newline + 1)
                      if (line) {
                        wireRequests.push(JSON.parse(line))
                      }
                    }
                    return Reflect.apply(write, child.stdin, [chunk, ...rest])
                  }) as typeof child.stdin.write
                  return child
                }
              })
          },
          executablePath,
          env,
          sessionOptions: { settingSources: [], tools: [], strictMcpConfig: true }
        }),
        resolveSpecialistIdentity: async () => ({
          append: 'RESEARCH_SPECIALIST_IDENTITY',
          prefix: ''
        }),
        resolveSpecialistSkills: async () => ({
          kind: 'specialist',
          skillIds: ['research'],
          frameworkNames: ['research'],
          missingSkillIds: []
        }),
        skills: { needForceLoad: async (ids) => ids, namesForIds: async (ids) => ids }
      }))
  )
  disconnectRuntime = async () => {
    await runtime.disconnect()
  }
  try {
    const { sessionId } = await runtime.createSession({ cwd, projectId: 'contract-project' })
    await runtime.sendPrompt({
      sessionId,
      text: 'ORIGINAL_APPROVED_TASK',
      provenanceContext: { promptMessageId: 'origin' }
    })
    let binding: string | undefined
    let persisted: PersistedSessionSpecialistBinding = {}
    const pendingTransitions: boolean[] = []
    const reconfiguration = new SessionSpecialistReconfiguration({
      sessionBinding: {
        resolve: async () => ({ kind: 'main' }),
        setBinding: (_id, target) => {
          binding = target
        },
        clearSession: () => undefined
      },
      loadBinding: async () => persisted,
      persistBinding: async (_id, specialistId, pending) => {
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
        pendingTransitions.push(pending)
      },
      applyRuntime: (id, target) => runtime.switchSpecialist(id, target)
    })
    const lifecycle = new CompletionHandoffLifecycle(
      new FileCompletionHandoffRepository(join(root, 'handoffs')),
      withApprovedSpecialistBinding(
        createClaudeCodeCompletionGateRuntime({
          sessionFramework: (id) => runtime.getSessionFramework(id),
          cancelPrompt: ({ sessionId: id }) => runtime.stopPromptForHandoff(id),
          waitForPromptOwnershipRelease: (id) => runtime.waitForPromptOwnershipRelease(id),
          resolveSpecialistId: () => binding,
          resolveSwitchReadBack: async (id, targetName) => ({
            status: 'approved',
            operation: 'switch',
            binding: { sessionId: id, specialistId: binding, targetName, revision: 1 }
          }),
          prepareReplayContext: async (input) => runtime.prepareClaudeCodeHandoffReplay(input),
          discardReplayContext: async (id) => runtime.discardClaudeCodeHandoffReplay(id),
          switchSpecialist: (id, target) => reconfiguration.applyPersisted(id, target),
          createContinuationRequest: async (input) =>
            runtime.createClaudeCodeContinuationRequest(input),
          sendAppContinuation: async (request) => {
            expect(persisted.specialistBindingPending).toBeUndefined()
            return runtime.sendAppContinuation(request)
          }
        }),
        {
          getSpecialistBinding: () => binding,
          getSpecialist: () => ({ name: 'Research Specialist', revision: 1, enabled: true })
        }
      ),
      Date.now,
      undefined,
      async () => ({ specialistId: 'research', revision: 1 })
    )
    runtime.setPromptAdmissionGuard(async (id) => {
      await reconfiguration.assertUserPromptReady(id)
      if (!(await lifecycle.canStartUserPrompt(id))) throw new Error('Handoff is still pending')
    })
    const context = {
      sessionId,
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'switch-1'
    }
    await reconfiguration.commitDesired(sessionId, 'research')
    await expect(reconfiguration.assertUserPromptReady(sessionId)).rejects.toThrow(
      'not been applied'
    )
    await expect(runtime.sendPrompt({ sessionId, text: 'BLOCKED_USER_TASK' })).rejects.toThrow(
      'not been applied'
    )
    await lifecycle.approve({ context, targetName: 'Research Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: { status: 'approved' } })
    const outcome = await lifecycle.run(context)
    expect(outcome).toMatchObject({ stage: 'continued' })
    expect(pendingTransitions).toEqual([true, false])
    expect(await lifecycle.canStartUserPrompt(sessionId)).toBe(true)
    await expect(reconfiguration.assertUserPromptReady(sessionId)).resolves.toBeUndefined()
    expect(processCount).toBe(2)
    expect(liveRuntime.liveSessionProjectId(sessionId)).toBe('contract-project')
    const resumes = wireRequests.filter((request) => request.method === 'session/resume')
    expect(resumes).toHaveLength(1)
    expect(resumes[0].params?.sessionId).not.toBe(sessionId)
    expect(resumes[0].params?.cwd).toBe(cwd)
    const sessions = wireRequests.filter((request) => request.method === 'session/new')
    expect(sessions).toHaveLength(3)
    expect(sessions.every((request) => request.params?.cwd === cwd)).toBe(true)
    expect(JSON.stringify(sessions[2].params?._meta)).toContain('Approved switch read-back:')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain('Approved switch read-back:')
    expect(requests[1]).toContain('ORIGINAL_APPROVED_TASK')
    expect(requests[1]).toContain('RESEARCH_SPECIALIST_IDENTITY')
    await runtime.switchSpecialist(sessionId, undefined)
    expect(
      JSON.stringify(
        wireRequests.filter((request) => request.method === 'session/new').at(-1)?.params?._meta
      )
    ).not.toContain('Approved switch read-back:')
    await runtime.sendPrompt({ sessionId, text: 'FOLLOW_UP_USER_TASK' })
    expect(requests).toHaveLength(3)
    expect(requests[2]).toContain('FOLLOW_UP_USER_TASK')
    expect(requests[2]).not.toContain('Approved switch read-back:')
  } finally {
    await runtime.disconnect()
  }
}, 60_000)

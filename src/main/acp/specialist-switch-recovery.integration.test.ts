import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))

import { claudeCodeFramework } from '../agent-framework/claude-code'
import { createCodexFramework } from '../agent-framework/codex'
import { opencodeFramework } from '../agent-framework/opencode'
import { codeBuddyFramework } from '../agent-framework/codebuddy'
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

it.runIf(Boolean(process.env.CODEX_ACP_PATH && process.env.CODEX_NATIVE_PATH)).each([
  ['codex-responses', 0],
  ['codex-responses', 5000],
  ['codex-bridge', 0],
  ['codex-bridge', 5000]
] as const)(
  'applies consecutive Specialist selections before the first real %s prompt after %i ms idle',
  async (modelRoute, idleMs) => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-codex-unprompted-'))
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'http://127.0.0.1:9/v1',
        key: 'synthetic-no-inference-key',
        apiEndpoints: modelRoute === 'codex-bridge' ? ['chat-completions'] : ['responses'],
        model: 'gpt-5.4',
        contextWindow: 128000
      },
      {
        storageRoot: root,
        executablePath: process.env.CODEX_ACP_PATH!,
        ...(modelRoute === 'codex-bridge'
          ? {
              responsesConnection: {
                baseUrl: 'http://127.0.0.1:9/v1',
                token: 'synthetic-loopback-key'
              }
            }
          : {})
      }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: cwd,
      resolveBackend: () => ({
        framework: {
          ...framework,
          spawn: () => {
            const child = spawn(process.execPath, [process.env.CODEX_ACP_PATH!], {
              cwd,
              env: {
                PATH: process.env.PATH,
                TMPDIR: process.env.TMPDIR,
                ...config.env,
                CODEX_PATH: process.env.CODEX_NATIVE_PATH!
              },
              stdio: 'pipe'
            })
            return child
          }
        },
        executablePath: process.env.CODEX_ACP_PATH!,
        env: config.env ?? {},
        authentication: config.authentication,
        providerConfiguration: config.providerConfiguration,
        modelRoute
      }),
      resolveSpecialistIdentity: async (id) => ({ append: '', prefix: `Specialist ${id}` })
    })
    onTestFinished(async () => {
      await runtime.disconnect()
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    })
    let persisted: PersistedSessionSpecialistBinding = {}
    const errors: unknown[] = []
    const reconfiguration = new SessionSpecialistReconfiguration({
      sessionBinding: {
        resolve: async () => ({ kind: 'main' }),
        setBinding: () => undefined,
        clearSession: () => undefined
      },
      loadBinding: async () => persisted,
      persistBinding: async (_id, specialistId, pending) => {
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime: async (id, target) => {
        try {
          return await runtime.switchSpecialist(id, target)
        } catch (error) {
          errors.push(error)
          throw error
        }
      }
    })
    const first = await reconfiguration.requestSwitch('app-session', 'first')
    // Waiting alone must not be mistaken for creating a restorable native rollout.
    if (idleMs > 0) await new Promise((resolve) => setTimeout(resolve, idleMs))
    const second = await reconfiguration.requestSwitch('app-session', 'second')
    const retry = await reconfiguration.requestSwitch('app-session', 'second')
    expect(
      { first, second, retry },
      JSON.stringify(
        errors.map((error) => ({
          message: (error as Error).message,
          data: (error as { data?: unknown }).data
        }))
      )
    ).toMatchObject({
      first: { status: 'applied' },
      second: { status: 'applied' },
      retry: { status: 'applied' }
    })
  },
  30_000
)

it.for([
  { framework: claudeCodeFramework, modelRoute: 'claude-anthropic' },
  { framework: opencodeFramework, modelRoute: 'opencode-anthropic' },
  { framework: opencodeFramework, modelRoute: 'opencode-openai' },
  { framework: codeBuddyFramework, modelRoute: 'codebuddy-openai' }
] as const)(
  'applies consecutive unprompted Specialist selections through real $modelRoute',
  { timeout: 30_000 },
  async ({ framework, modelRoute }, context) => {
    const executablePath =
      framework.id === 'claude-code'
        ? createRequire(import.meta.url).resolve(
            `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`
          )
        : framework.id === 'opencode'
          ? process.env.OPENCODE_ACP_PATH
          : process.env.CODEBUDDY_ACP_PATH
    if (!executablePath) return context.skip()
    const root = await mkdtemp(join(tmpdir(), 'specialist-unprompted-'))
    let disconnectRuntime = async (): Promise<void> => undefined
    onTestFinished(async () => {
      try {
        await disconnectRuntime()
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      }
    })
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        baseUrl: 'http://127.0.0.1:9/v1',
        key: 'synthetic-no-inference-key',
        apiEndpoints: modelRoute.endsWith('anthropic') ? ['messages'] : ['chat-completions'],
        model: modelRoute.endsWith('anthropic') ? 'claude-sonnet-4-5' : 'probe-model'
      },
      { storageRoot: root, executablePath }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
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
      HOME: root,
      USERPROFILE: root,
      APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'local-appdata'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // The synthetic model is registered by the app; no remote catalog is needed.
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      ELECTRON_RUN_AS_NODE: '1',
      ...config.env
    })
    if (framework.id === 'opencode' && process.env.OPENCODE_TEST_PLUGIN_DEPENDENCIES) {
      const target = join(root, 'opencode', 'config', 'opencode')
      for (const entry of ['package.json', 'package-lock.json', 'node_modules']) {
        await cp(join(process.env.OPENCODE_TEST_PLUGIN_DEPENDENCIES, entry), join(target, entry), {
          recursive: true
        })
      }
    }
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: cwd,
      resolveBackend: () => ({
        framework: {
          ...framework,
          spawn: (input) =>
            framework.spawn({
              ...input,
              spawnProcess: (command, args, options) =>
                spawn(command, args, { ...options, env, cwd })
            })
        },
        executablePath,
        args: config.args,
        env,
        authentication: config.authentication,
        providerConfiguration: config.providerConfiguration,
        modelRoute,
        sessionOptions: {
          settingSources: [],
          tools: [],
          strictMcpConfig: true
        }
      }),
      resolveSpecialistIdentity: async (id) => ({
        append: `Specialist ${id}`,
        prefix: `Specialist ${id}`
      })
    })
    disconnectRuntime = async () => {
      await runtime.disconnect()
    }
    const { sessionId } = await runtime.createSession({ cwd, projectId: 'contract-project' })
    let persisted: PersistedSessionSpecialistBinding = {}
    const reconfiguration = new SessionSpecialistReconfiguration({
      sessionBinding: {
        resolve: async () => ({ kind: 'main' }),
        setBinding: () => undefined,
        clearSession: () => undefined
      },
      loadBinding: async () => persisted,
      persistBinding: async (_id, specialistId, pending) => {
        persisted = {
          specialistId,
          ...(pending ? { specialistBindingPending: true as const } : {})
        }
      },
      applyRuntime: (id, target) => runtime.switchSpecialist(id, target)
    })
    for (const target of ['first', 'second', undefined, 'third']) {
      await expect(reconfiguration.requestSwitch(sessionId, target)).resolves.toEqual({
        status: 'applied',
        contextReset: framework.id === 'claude-code'
      })
      expect(persisted.specialistId).toBe(target)
      expect(persisted.specialistBindingPending).toBeUndefined()
      await expect(reconfiguration.assertUserPromptReady(sessionId)).resolves.toBeUndefined()
      expect(runtime.liveSessionProjectId(sessionId)).toBe('contract-project')
    }
  }
)

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

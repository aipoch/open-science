import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { CODEX_SUBSCRIPTION_PROVIDER_ID, type AgentFrameworkId } from '../../shared/settings'
import {
  claudeCodeFramework,
  codeBuddyFramework,
  codexFramework,
  opencodeFramework,
  type AgentSpawnInput,
  type ResolvedAgentBackend
} from '../agent-framework'
import {
  createProductionDelegatedFrameworkRuntime,
  DELEGATED_CHILD_SYSTEM_PROMPT_APPEND,
  withDelegatedChildContext
} from './production-framework-runtime'

const safeOpenCodeConfig = JSON.stringify({
  permission: { task: 'deny' },
  agent: {
    general: { disable: true },
    explore: { disable: true },
    scout: { disable: true }
  }
})

const session = (frameworkId: AgentFrameworkId): PersistedChatSession => ({
  id: `session-${frameworkId}`,
  projectId: 'project-1',
  title: frameworkId,
  cwd: '/root',
  status: 'idle',
  agentFrameworkId: frameworkId,
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 1
})

const backend = (frameworkId: AgentFrameworkId): ResolvedAgentBackend => {
  if (frameworkId === 'claude-code') {
    return {
      framework: claudeCodeFramework,
      executablePath: '/claude-agent-acp.js',
      env: {}
    }
  }
  if (frameworkId === 'opencode') {
    return {
      framework: opencodeFramework,
      executablePath: '/opencode',
      env: {
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_CONFIG_CONTENT: safeOpenCodeConfig
      }
    }
  }
  if (frameworkId === 'codebuddy') {
    return {
      framework: codeBuddyFramework,
      executablePath: '/codebuddy',
      args: ['--tools', 'Read,Write,Edit,Glob,Grep,Bash'],
      env: {
        CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
        CODEBUDDY_DISABLE_BACKGROUND_TASKS: '1',
        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1'
      }
    }
  }
  return {
    framework: codexFramework,
    executablePath: '/codex-acp.js',
    env: {
      CODEX_CONFIG: JSON.stringify({
        features: { multi_agent: false, multi_agent_v2: false }
      })
    }
  }
}

const delegatedSession = (frameworkId: AgentFrameworkId): PersistedChatSession => ({
  ...session(frameworkId),
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root-frame',
    activeFrameId: 'child-frame',
    frames: [
      {
        id: 'root-frame',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'root-branch',
        createdAt: 1,
        completedAt: 2
      },
      {
        id: 'child-frame',
        parentFrameId: 'root-frame',
        originMessageId: 'root-prompt',
        originBindingState: 'validated',
        kind: 'delegate',
        status: 'running',
        activeBranchId: 'child-branch',
        createdAt: 2
      }
    ],
    branches: [
      {
        id: 'root-branch',
        agentFrameId: 'root-frame',
        headMessageId: 'root-prompt',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-branch',
        agentFrameId: 'child-frame',
        headMessageId: 'child-prompt',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    messages: [
      {
        id: 'root-prompt',
        role: 'user',
        content: 'Coordinate',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        agentFrameId: 'root-frame',
        introducedOnBranchId: 'root-branch',
        revisionRootMessageId: 'root-prompt'
      },
      {
        id: 'child-prompt',
        role: 'user',
        content: 'Investigate',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt'
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: []
  }
})

describe('production delegated framework runtime bridge', () => {
  it('copies CodeBuddy configuration into each delegated Attempt runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delegated-codebuddy-config-'))
    const sourceConfigDir = join(root, 'shared-codebuddy')
    const runtimeHome = join(root, 'attempt')
    await mkdir(sourceConfigDir, { recursive: true })
    await writeFile(join(sourceConfigDir, 'models.json'), '{"models":[]}\n')

    try {
      const spawn = await codeBuddyFramework.prepareDelegatedSpawn!(
        {
          ...backend('codebuddy'),
          env: {
            ...backend('codebuddy').env,
            CODEBUDDY_CONFIG_DIR: sourceConfigDir,
            CODEBUDDY_API_KEY: 'secret'
          }
        },
        runtimeHome
      )

      expect(spawn.env.CODEBUDDY_CONFIG_DIR).toBe(join(runtimeHome, 'codebuddy'))
      expect(spawn.env.CODEBUDDY_API_KEY).toBe('secret')
      await expect(readFile(join(runtimeHome, 'codebuddy', 'models.json'), 'utf8')).resolves.toBe(
        '{"models":[]}\n'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies app-owned Codex subscription authentication before spawning a delegated Attempt', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-codex-auth-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-codex-workspace-'))
    const sourceHome = join(dataRoot, 'codex-subscription')
    await mkdir(sourceHome, { recursive: true })
    await writeFile(join(sourceHome, 'auth.json'), '{"tokens":{"access_token":"secret"}}\n', {
      mode: 0o600
    })
    await writeFile(
      join(sourceHome, 'config.toml'),
      [
        'cli_auth_credentials_store = "file"',
        'model_provider = "subscription-route"',
        '',
        '[model_providers."subscription-route"]',
        'name = "Subscription route"',
        'base_url = "http://127.0.0.1:43123/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        '',
        '[mcp_servers.persisted-tool]',
        'command = "unsafe-tool"',
        ''
      ].join('\n'),
      { mode: 0o600 }
    )
    const issueDelegatedNotebookConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:1',
      token: 'attempt-token',
      release: () => undefined,
      revoke: async () => undefined
    }))
    const admittedBackend: ResolvedAgentBackend = {
      ...backend('codex'),
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      env: {
        ...backend('codex').env,
        HOME: sourceHome,
        CODEX_HOME: sourceHome
      }
    }
    let spawnedInput: AgentSpawnInput | undefined
    let spawnedAuthJson: string | undefined
    let spawnedConfigToml: string | undefined
    let child: ChildProcessWithoutNullStreams | undefined
    const spawnSpy = vi.spyOn(codexFramework, 'spawn').mockImplementation((input) => {
      spawnedInput = input
      spawnedAuthJson = readFileSync(join(input.env.CODEX_HOME!, 'auth.json'), 'utf8')
      spawnedConfigToml = readFileSync(join(input.env.CODEX_HOME!, 'config.toml'), 'utf8')
      child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
        stdio: 'pipe'
      })
      return child
    })
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: { settingsService: {} } as never,
      notebookRpcServer: () => ({ issueDelegatedNotebookConnection }) as never,
      readSession: async () => delegatedSession('codex')
    })

    try {
      const selected = await frameworks.forSession(session('codex'))
      const reservation = await selected.execution.reserve(1)
      const running = selected.execution.run(
        {
          session: { projectId: 'project-1', sessionId: 'session-codex' },
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          runtimeSegmentId: 'runtime-1',
          executionModel: {
            frameworkId: 'codex',
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            backendId: `codex:${CODEX_SUBSCRIPTION_PROVIDER_ID}`,
            modelRoute: 'codex-responses',
            model: 'gpt-5.4',
            reasoningEffort: 'medium'
          },
          executionBackend: admittedBackend,
          task: 'Investigate',
          inputs: [],
          workspaceCwd,
          continuation: false
        },
        reservation.slotIds[0]
      )

      await vi.waitFor(() => expect(spawnedInput).toBeDefined())
      const childHome = spawnedInput!.env.CODEX_HOME!
      expect(childHome).not.toBe(sourceHome)
      expect(spawnedAuthJson).toContain('secret')
      expect(spawnedConfigToml).toContain('cli_auth_credentials_store = "file"')
      expect(spawnedConfigToml).toContain('model_provider = "subscription-route"')
      expect(spawnedConfigToml).toContain('base_url = "http://127.0.0.1:43123/v1"')
      expect(spawnedConfigToml).not.toContain('mcp_servers')
      expect(spawnedConfigToml).not.toContain('unsafe-tool')

      child?.kill()
      await expect(running.completion).rejects.toBeDefined()
    } finally {
      child?.kill()
      spawnSpy.mockRestore()
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy'] as const)(
    'adds child-only identity and canonical delivery context for %s without replacing backend rules',
    (frameworkId) => {
      const decorated = withDelegatedChildContext({
        ...backend(frameworkId),
        systemPromptAppends: ['Keep the existing specialist and safety rules.']
      })
      expect(decorated.systemPromptAppends).toEqual([
        'Keep the existing specialist and safety rules.',
        DELEGATED_CHILD_SYSTEM_PROMPT_APPEND
      ])
      expect(DELEGATED_CHILD_SYSTEM_PROMPT_APPEND).toContain('delegated Attempt for the Main Agent')
      expect(DELEGATED_CHILD_SYSTEM_PROMPT_APPEND).toContain(
        'final response is automatically preserved'
      )
      expect(DELEGATED_CHILD_SYSTEM_PROMPT_APPEND).toContain(
        "host.sendFrameMessage('parent', ...) only while the Attempt is still running"
      )
      expect(DELEGATED_CHILD_SYSTEM_PROMPT_APPEND).toContain(
        'submitting it with host.submitOutput(value) remains mandatory'
      )
      expect(DELEGATED_CHILD_SYSTEM_PROMPT_APPEND).toContain(
        'never replaces your ordinary final response'
      )
      expect(DELEGATED_CHILD_SYSTEM_PROMPT_APPEND).toContain('Do not duplicate your final response')
    }
  )
  it('prepares an admitted Attempt from its transient backend after the provider was deleted', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-framework-deleted-provider-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-framework-workspace-'))
    const resolveAdmittedSubagentBackend = vi.fn(async () => {
      throw new Error('configured provider is unavailable')
    })
    const issueDelegatedNotebookConnection = vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:1',
      token: 'attempt-token',
      release: () => undefined,
      revoke: async () => undefined
    }))
    const durable = delegatedSession('opencode')
    const admittedBackend = backend('opencode')
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: { settingsService: { resolveAdmittedSubagentBackend } } as never,
      notebookRpcServer: () => ({ issueDelegatedNotebookConnection }) as never,
      readSession: async () => durable
    })

    try {
      const selected = await frameworks.forSession(session('opencode'))
      const reservation = await selected.execution.reserve(1)
      const executionModel = {
        frameworkId: 'opencode' as const,
        providerId: 'deleted-provider',
        backendId: 'opencode:deleted-provider',
        modelRoute: 'opencode-openai' as const,
        model: 'admitted-model',
        reasoningEffort: 'high' as const
      }
      const running = selected.execution.run(
        {
          session: { projectId: 'project-1', sessionId: 'session-opencode' },
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          runtimeSegmentId: 'runtime-1',
          executionModel,
          executionBackend: admittedBackend,
          task: 'Investigate',
          inputs: [],
          workspaceCwd,
          continuation: true
        },
        reservation.slotIds[0]
      )

      await expect(running.completion).rejects.not.toThrow('configured provider is unavailable')
      expect(resolveAdmittedSubagentBackend).not.toHaveBeenCalled()
      expect(issueDelegatedNotebookConnection).toHaveBeenCalledOnce()
    } finally {
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })

  it('certifies framework availability without consulting the process Active model', async () => {
    const selected: AgentFrameworkId[] = []
    const release = vi.fn(async () => undefined)
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 3,
      dataRoot: '/data',
      runtime: {
        settingsService: {
          async resolveAgentBackend({ frameworkId }: { frameworkId: AgentFrameworkId }) {
            selected.push(frameworkId)
            return {
              ...backend(frameworkId),
              providerTransportLease: { setTarget: () => true, release }
            }
          }
        }
      } as never,
      notebookRpcServer: () => {
        throw new Error('runtime must not start during pre-admission certification')
      },
      readSession: async () => undefined
    })

    for (const frameworkId of ['claude-code', 'opencode', 'codex', 'codebuddy'] as const) {
      const selectionsBeforeComposition = selected.length
      const certified = await frameworks.forSession(session(frameworkId))
      expect(certified.frameworkId).toBe(frameworkId)
      expect(selected).toHaveLength(selectionsBeforeComposition)
      await expect(certified.assertAvailable()).resolves.toBeUndefined()
    }

    expect(selected).toEqual([])
    expect(release).not.toHaveBeenCalled()
  })

  it('keeps Session certification non-secret and defers exact model resolution to Attempt preparation', async () => {
    const release = vi.fn(async () => undefined)
    const resolveAgentBackend = vi.fn(async () => ({
      ...backend('opencode'),
      env: {
        ...backend('opencode').env,
        OPENAI_API_KEY: 'attempt-only-secret'
      },
      providerTransportLease: { setTarget: () => true, release }
    }))
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot: '/data',
      runtime: { settingsService: { resolveAgentBackend } } as never,
      notebookRpcServer: () => {
        throw new Error('runtime must not start during pre-admission certification')
      },
      readSession: async () => undefined
    })

    const certified = await frameworks.forSession(session('opencode'))

    expect(resolveAgentBackend).not.toHaveBeenCalled()
    expect(JSON.stringify(certified)).not.toContain('attempt-only-secret')

    await certified.assertAvailable()

    expect(resolveAgentBackend).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(JSON.stringify(certified)).not.toContain('attempt-only-secret')
  })

  it('re-resolves changed Settings for a new Attempt and releases the rejected fresh lease', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-framework-fresh-attempt-'))
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'delegated-framework-workspace-'))
    const release = vi.fn(async () => undefined)
    let currentConfig = safeOpenCodeConfig
    const durable: PersistedChatSession = {
      ...session('opencode'),
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'root-frame',
        activeFrameId: 'child-frame',
        frames: [
          {
            id: 'root-frame',
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: 'root-branch',
            createdAt: 1,
            completedAt: 2
          },
          {
            id: 'child-frame',
            parentFrameId: 'root-frame',
            originMessageId: 'root-prompt',
            originBindingState: 'validated',
            kind: 'delegate',
            status: 'running',
            activeBranchId: 'child-branch',
            createdAt: 2
          }
        ],
        branches: [
          {
            id: 'root-branch',
            agentFrameId: 'root-frame',
            headMessageId: 'root-prompt',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'child-branch',
            agentFrameId: 'child-frame',
            headMessageId: 'child-prompt',
            createdAt: 2,
            updatedAt: 2
          }
        ],
        messages: [
          {
            id: 'root-prompt',
            role: 'user',
            content: 'Coordinate',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1,
            agentFrameId: 'root-frame',
            introducedOnBranchId: 'root-branch',
            revisionRootMessageId: 'root-prompt'
          },
          {
            id: 'child-prompt',
            role: 'user',
            content: 'Investigate',
            status: 'complete',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2,
            agentFrameId: 'child-frame',
            introducedOnBranchId: 'child-branch',
            revisionRootMessageId: 'child-prompt'
          }
        ],
        activities: [],
        activityGroups: [],
        runtimeSegments: []
      },
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  status: 'running',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: ['runtime-1'],
                  startedAt: 2
                }
              ]
            }
          ]
        }
      }
    }
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: {
        settingsService: {
          async resolveAdmittedSubagentBackend() {
            return {
              ...backend('opencode'),
              env: {
                OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
                OPENCODE_CONFIG_CONTENT: currentConfig,
                OPENAI_API_KEY: currentConfig === safeOpenCodeConfig ? 'old-secret' : 'new-secret'
              },
              providerTransportLease: { setTarget: () => true, release }
            }
          }
        }
      } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => ({
            endpoint: 'http://127.0.0.1:1',
            token: 'attempt-token',
            release: () => undefined,
            revoke: async () => undefined
          })
        }) as never,
      readSession: async () => durable
    })

    try {
      const selected = await frameworks.forSession(durable)
      await selected.assertAvailable()
      currentConfig = JSON.stringify({ permission: { task: 'allow' }, agent: {} })
      const reservation = await selected.execution.reserve(1)
      const running = selected.execution.run(
        {
          session: { projectId: durable.projectId, sessionId: durable.id },
          frameId: 'child-frame',
          attemptId: 'attempt-1',
          runtimeSegmentId: 'runtime-1',
          executionModel: {
            frameworkId: 'opencode',
            providerId: 'provider-a',
            backendId: 'opencode:provider-a',
            modelRoute: 'opencode-openai',
            model: 'model-a',
            reasoningEffort: 'default'
          },
          task: 'Investigate',
          inputs: [],
          workspaceCwd,
          continuation: false
        },
        reservation.slotIds[0]
      )

      await expect(running.completion).rejects.toMatchObject({ code: 'unsupported_framework' })
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await Promise.all([
        rm(dataRoot, { recursive: true, force: true }),
        rm(workspaceCwd, { recursive: true, force: true })
      ])
    }
  })
})

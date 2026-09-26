import { SettingsService } from '../settings/service'
import { SettingsRepository } from '../settings/repository'
import { SkillRegistry } from '../skills/registry'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import {
  loadSkillDocument,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION
} from '../skills/runtime-mcp-server'
import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

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
import * as runtimeComposition from '../acp/runtime-composition'
import * as openCodePreparation from './opencode-runtime-preparation'
import { createDelegateExecutionBackendLease } from './execution-backend-lease'
import {
  createProductionDelegatedFrameworkRuntime,
  DELEGATED_CHILD_SYSTEM_PROMPT_APPEND,
  withDelegatedChildContext
} from './production-framework-runtime'

import { DelegatedProcessOwnership } from './process-ownership'

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
        agents: { enabled: false },
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
  it.each([
    ['claude-code', true],
    ['opencode', true],
    ['codex', true],
    ['codebuddy', true],
    ['opencode', false]
  ] as const)(
    'prepares bound Skills before %s starts and requires tree shutdown to remove them (reaped: %s)',
    async (frameworkId, reaped) => {
      const prepareOpenCode = openCodePreparation.prepareOpenCodeRuntime
      let releasePort: (() => void) | undefined
      const disposePort = vi.fn(() => releasePort?.())
      const prepareSpy = vi
        .spyOn(openCodePreparation, 'prepareOpenCodeRuntime')
        .mockImplementation(async (...args) => {
          const prepared = await prepareOpenCode(...args)
          releasePort = prepared.dispose
          return { ...prepared, dispose: disposePort }
        })
      const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-bound-skills-'))
      const bundle = join(dataRoot, 'bundle')
      await mkdir(join(bundle, 'research', 'references'), { recursive: true })
      await writeFile(
        join(bundle, 'research', 'SKILL.md'),
        '---\nname: research\ndescription: Research experiments.\n---\nDELEGATED_RESEARCH_DOCUMENT'
      )
      await writeFile(
        join(bundle, 'research', 'references', 'method.md'),
        'complete research resource'
      )
      await writeFile(
        join(bundle, 'manifest.json'),
        JSON.stringify({
          version: 1,
          skills: [
            {
              id: 'research',
              name: 'Research',
              source: 'featured',
              updatedAt: '2026-01-01T00:00:00.000Z'
            }
          ]
        })
      )
      const settings = new SettingsService({
        repository: new SettingsRepository(dataRoot),
        configRoot: dataRoot,
        skillRegistry: new SkillRegistry(bundle)
      })
      await settings.setSkillEnabled({ id: 'research', enabled: false })
      const admitted = backend(frameworkId)
      admitted.sessionOptions = {
        [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
          root: join(dataRoot, 'main-projection'),
          command: process.execPath,
          entryPath: '/skill-runtime.js'
        }
      }
      const original = JSON.stringify(admitted)
      let child: ChildProcessWithoutNullStreams | undefined
      let spawnInput: AgentSpawnInput | undefined
      const spawnSpy =
        frameworkId === 'codex' || frameworkId === 'codebuddy'
          ? vi.spyOn(admitted.framework, 'spawn').mockImplementation((input) => {
              spawnInput = input
              // Native delegates spawn before createRuntime: the complete file must already exist.
              const skillFile =
                frameworkId === 'codex'
                  ? join(input.env.CODEX_HOME, 'skills', 'research', 'references', 'method.md')
                  : join(
                      input.env.CODEBUDDY_CONFIG_DIR,
                      'skill-runtime',
                      '.claude',
                      'skills',
                      'research',
                      'references',
                      'method.md'
                    )
              expect(readFileSync(skillFile, 'utf8')).toBe('complete research resource')
              child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe' })
              return child
            })
          : undefined
      let observed: runtimeComposition.AcpRuntimeCompositionOptions | undefined
      let finish!: () => void
      const pending = new Promise<{ stopReason: 'end_turn' }>((resolve) => {
        finish = () => resolve({ stopReason: 'end_turn' })
      })
      const runtimeSpy = vi
        .spyOn(runtimeComposition, 'createAcpRuntime')
        .mockImplementation((options) => {
          observed = options
          return {
            createSession: async () => ({ sessionId: 'ephemeral-child' }),
            sendAppContinuation: (request: { permissionPrompts?: 'none' }) => {
              expect(request.permissionPrompts).toBe('none')
              options.runtimeCallbacks!.onProviderPromptAccepted?.('ephemeral-child')
              return pending
            },
            deleteSession: async () => undefined,
            shutdownForQuit: async () => {
              child?.kill()
              return { reaped }
            }
          } as never
        })
      let completion: Promise<unknown> | undefined
      try {
        const frameworks = createProductionDelegatedFrameworkRuntime({
          capacity: 1,
          dataRoot,
          runtime: {
            settingsService: settings,
            specialistService: {
              resolveRunnableById: async () => ({
                enabled: true,
                capabilityMode: 'selected',
                selectedCapabilities: { skillIds: ['research'], connectorIds: [] },
                fullAccess: { excludedSkillIds: [], excludedConnectorIds: [] }
              })
            }
          } as never,
          notebookRpcServer: () =>
            ({
              issueDelegatedNotebookConnection: async (scope: { permissionPrompts?: 'none' }) => {
                expect(scope.permissionPrompts).toBe('none')
                return {
                  endpoint: 'http://127.0.0.1:1',
                  token: 'test',
                  release: () => undefined,
                  revoke: async () => undefined
                }
              }
            }) as never,
          readSession: async () => delegatedSession(frameworkId)
        })
        const selected = await frameworks.forSession(session(frameworkId))
        const reservation = await selected.execution.reserve(1)
        const running = selected.execution.run(
          {
            session: { projectId: 'project-1', sessionId: `session-${frameworkId}` },
            frameId: 'child-frame',
            attemptId: 'bound-attempt',
            permissionPrompts: 'none',
            runtimeSegmentId: 'child-segment',
            executionModel: {
              frameworkId,
              providerId: 'provider',
              backendId: `${frameworkId}:provider`,
              modelRoute:
                frameworkId === 'claude-code'
                  ? 'claude-anthropic'
                  : frameworkId === 'opencode'
                    ? 'opencode-openai'
                    : frameworkId === 'codebuddy'
                      ? 'codebuddy-openai'
                      : 'codex-responses',
              model: 'admitted-model',
              reasoningEffort: 'default'
            },
            executionBackend: admitted,
            task: 'Research experiments.',
            inputs: [],
            workspaceCwd: join(dataRoot, 'workspace'),
            profile: 'researcher',
            continuation: false
          },
          reservation.slotIds[0]
        )
        completion = running.completion
        await running.accepted
        const runtimeHome = join(
          dataRoot,
          'delegation',
          'project-1',
          `session-${frameworkId}`,
          'runtime',
          'bound-attempt'
        )
        expect(observed!.delegatedRuntimeHome).toBe(runtimeHome)
        const projection = observed!.fixedBackend!.sessionOptions![
          OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION
        ] as { root: string; skillsDirectory: string }
        expect(observed!.preparedSkills?.skillIds).toEqual(['research'])
        expect(observed!.preparedSkills?.catalog).toContainEqual(
          expect.objectContaining({
            name: 'research',
            path: join(projection.skillsDirectory, 'research', 'SKILL.md')
          })
        )
        await expect(
          loadSkillDocument({ ...projection, allowedNames: new Set(['research']) }, 'research')
        ).resolves.toContain('DELEGATED_RESEARCH_DOCUMENT')
        await expect(
          readFile(join(projection.skillsDirectory, 'research', 'references', 'method.md'), 'utf8')
        ).resolves.toBe('complete research resource')
        expect(await settings.skillsNeedingForceLoad(['research'])).toEqual(['research'])
        if (frameworkId === 'opencode')
          expect(projection.skillsDirectory).toBe(
            join(observed!.fixedBackend!.env.XDG_CONFIG_HOME, 'opencode', 'skills')
          )
        if (frameworkId === 'claude-code')
          expect(observed!.fixedBackend!.sessionOptions).toMatchObject({
            additionalDirectories: [projection.root],
            sandbox: { filesystem: { allowRead: [projection.root], denyWrite: [projection.root] } }
          })
        if (spawnInput) expect(observed!.fixedBackend!.env).toEqual(spawnInput.env)
        finish()
        if (reaped) {
          await expect(completion).resolves.toMatchObject({ status: 'completed' })
          await expect(stat(runtimeHome)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          await expect(completion).resolves.toMatchObject({
            status: 'completed',
            cleanupError: expect.objectContaining({ name: 'DelegateExecutionCleanupError' })
          })
          expect((await stat(runtimeHome)).isDirectory()).toBe(true)
          expect(
            await readFile(join(projection.skillsDirectory, 'research', 'SKILL.md'), 'utf8')
          ).toContain('DELEGATED_RESEARCH_DOCUMENT')
        }
        if (frameworkId === 'opencode') {
          expect(disposePort).toHaveBeenCalledTimes(reaped ? 1 : 0)
        }
        expect(JSON.stringify(admitted)).toBe(original)
      } finally {
        finish()
        await completion?.catch(() => undefined)
        child?.kill()
        spawnSpy?.mockRestore()
        runtimeSpy.mockRestore()
        prepareSpy.mockRestore()
        releasePort?.()
        await settings.dispose()
        await observed?.preparedSkills?.dispose()
        await rm(dataRoot, { recursive: true, force: true })
      }
    }
  )

  it.each([false, true])(
    'cleans copied read-only OpenCode Skills without a Specialist (prepare failure: %s)',
    async (prepareFailure) => {
      const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-readonly-copy-'))
      const sourceRoot = join(dataRoot, 'main-config', 'opencode')
      const sourceSkill = join(sourceRoot, 'skills', 'os-example')
      const sourceFile = join(sourceSkill, '.catalog_stamp')
      await mkdir(sourceSkill, { recursive: true })
      await writeFile(sourceFile, 'main-owned snapshot')
      await chmod(sourceFile, 0o444)
      await chmod(sourceSkill, 0o555)
      const admitted = backend('opencode')
      admitted.env.XDG_CONFIG_HOME = dirname(sourceRoot)
      const runtimeHome = join(
        dataRoot,
        'delegation',
        'project-1',
        'session-opencode',
        'runtime',
        'copied-attempt'
      )
      const revoke = vi.fn(async () => undefined)
      const runtimeSpy = vi.spyOn(runtimeComposition, 'createAcpRuntime').mockImplementation(
        (options) =>
          ({
            createSession: async () => ({ sessionId: 'ephemeral-child' }),
            sendAppContinuation: async () => {
              options.runtimeCallbacks!.onProviderPromptAccepted?.('ephemeral-child')
              const copy = join(runtimeHome, 'config', 'opencode', 'skills', 'os-example')
              expect(await readFile(join(copy, '.catalog_stamp'), 'utf8')).toBe(
                'main-owned snapshot'
              )
              if (process.platform !== 'win32') {
                expect((await stat(copy)).mode & 0o222).toBe(0)
                // Reproduce a child removing every permission before it exits.
                await chmod(copy, 0o000)
              }
              await symlink(
                sourceSkill,
                join(dirname(copy), 'external-skill'),
                process.platform === 'win32' ? 'junction' : 'dir'
              )

              return { stopReason: 'end_turn' }
            },
            deleteSession: async () => undefined,
            shutdownForQuit: async () => ({ reaped: true })
          }) as never
      )
      try {
        const frameworks = createProductionDelegatedFrameworkRuntime({
          capacity: 1,
          dataRoot,
          runtime: { settingsService: {} } as never,
          notebookRpcServer: () =>
            ({
              issueDelegatedNotebookConnection: async () => {
                if (prepareFailure) throw new Error('Notebook preparation failed')
                return {
                  endpoint: 'http://127.0.0.1:1',
                  token: 'test',
                  release: () => undefined,
                  revoke
                }
              }
            }) as never,
          readSession: async () => delegatedSession('opencode')
        })
        const selected = await frameworks.forSession(session('opencode'))
        const reservation = await selected.execution.reserve(1)
        const running = selected.execution.run(
          {
            session: { projectId: 'project-1', sessionId: 'session-opencode' },
            frameId: 'child-frame',
            attemptId: 'copied-attempt',
            runtimeSegmentId: 'child-segment',
            executionModel: {
              frameworkId: 'opencode',
              providerId: 'provider',
              backendId: 'opencode:provider',
              modelRoute: 'opencode-openai',
              model: 'admitted-model',
              reasoningEffort: 'default'
            },
            executionBackend: admitted,
            task: 'Investigate',
            inputs: [],
            workspaceCwd: dataRoot,
            continuation: false
          },
          reservation.slotIds[0]
        )
        if (prepareFailure) {
          await expect(running.completion).rejects.toThrow('Notebook preparation failed')
        } else {
          await expect(running.completion).resolves.toMatchObject({ status: 'completed' })
          expect(revoke).toHaveBeenCalledOnce()
        }
        await expect(stat(runtimeHome)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(sourceFile, 'utf8')).toBe('main-owned snapshot')
        if (process.platform !== 'win32') expect((await stat(sourceSkill)).mode & 0o222).toBe(0)
      } finally {
        runtimeSpy.mockRestore()
        await new ClaudeCodeSkillMaterializer().sync(join(runtimeHome, 'config', 'opencode'), [], {
          directoryLayout: 'agent-facing'
        })
        await chmod(sourceSkill, 0o755)
        await chmod(sourceFile, 0o644)
        await rm(dataRoot, { recursive: true, force: true })
      }
    }
  )

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

// Production composition is exercised up to ACP; pending prompts keep sibling resources live.
it('isolates concurrent OpenCode Attempts and a continuation without releasing sibling resources', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-opencode-isolation-'))
  const admitted = backend('opencode')
  const sourceConfig = join(dataRoot, 'shared-config', 'opencode')
  admitted.env.XDG_CONFIG_HOME = join(dataRoot, 'shared-config')
  admitted.env.XDG_DATA_HOME = join(dataRoot, 'shared-data')
  admitted.env.OPENCODE_APP_API_KEY = 'synthetic-provider-key'
  admitted.args = ['--port', '42424', '--hostname', '127.0.0.1']
  admitted.opencodeUsageApi = {
    baseUrl: 'http://127.0.0.1:42424',
    authorization: 'Basic synthetic'
  }
  admitted.opencodeConfigFiles = [
    { path: join(sourceConfig, 'opencode.json'), content: safeOpenCodeConfig }
  ]
  const release = vi.fn(async () => undefined)
  admitted.providerTransportLease = { setTarget: () => true, release }
  const admission = createDelegateExecutionBackendLease(admitted)
  const original = JSON.stringify({
    env: admitted.env,
    args: admitted.args,
    files: admitted.opencodeConfigFiles
  })
  const controls: Array<{ backend: ResolvedAgentBackend; finish(): void; fail(): void }> = []
  const settlements: Promise<unknown>[] = []
  const spy = vi.spyOn(runtimeComposition, 'createAcpRuntime').mockImplementation((options) => {
    const childBackend = options.fixedBackend!
    const key = childBackend.env.XDG_CONFIG_HOME
    let finish!: () => void
    let fail!: () => void
    const completion = new Promise<{ stopReason: 'end_turn' }>((resolve, reject) => {
      finish = () => resolve({ stopReason: 'end_turn' })
      fail = () => reject(new Error('Synthetic child failure'))
    })
    controls.push({ backend: childBackend, finish, fail })
    return {
      createSession: async () => ({ sessionId: key }),
      sendAppContinuation: () => {
        options.runtimeCallbacks!.onProviderPromptAccepted?.(key)
        return completion
      },
      deleteSession: async () => undefined,
      shutdownForQuit: async () => ({ reaped: true })
    } as never
  })
  try {
    await mkdir(sourceConfig, { recursive: true })
    await writeFile(join(sourceConfig, 'opencode.json'), 'shared source must stay untouched')
    const skillSource = join(dataRoot, 'skill-source')
    await mkdir(join(skillSource, 'references'), { recursive: true })
    await writeFile(join(skillSource, 'SKILL.md'), '---\nname: example\n---\nExample')
    await writeFile(join(skillSource, '.catalog_stamp'), 'catalog-stamp')
    await writeFile(join(skillSource, 'references', 'guide.md'), 'nested resource')
    await new ClaudeCodeSkillMaterializer().sync(sourceConfig, [
      {
        id: 'example',
        name: 'example',
        displayName: 'Example',
        description: 'Example',
        source: 'featured',
        sourceDir: skillSource,
        updatedAt: '2026-09-17'
      }
    ])
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 3,
      dataRoot,
      runtime: { settingsService: {} } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => ({
            endpoint: 'http://127.0.0.1:1',
            token: 'synthetic',
            release: () => undefined,
            revoke: async () => undefined
          })
        }) as never,
      readSession: async () => delegatedSession('opencode')
    })
    const selected = await frameworks.forSession(session('opencode'))
    const reservation = await selected.execution.reserve(3)
    const start = (
      index: number,
      slotId: string,
      continuation = false
    ): { handle: ReturnType<typeof selected.execution.run>; settled: Promise<unknown> } => {
      const claim = admission.claim()
      const handle = selected.execution.run(
        {
          session: { projectId: 'project-1', sessionId: 'session-opencode' },
          frameId: 'child-frame',
          attemptId: `isolation-${index}`,
          runtimeSegmentId: `runtime-${index}`,
          executionModel: {
            frameworkId: 'opencode',
            providerId: 'provider',
            backendId: 'opencode:provider',
            modelRoute: 'opencode-openai',
            model: 'admitted-model',
            reasoningEffort: 'default'
          },
          executionBackend: claim.backend,
          task: 'Investigate',
          inputs: [],
          workspaceCwd: join(dataRoot, 'workspace', String(index)),
          continuation
        },
        slotId
      )
      // The durable work owner, not the runtime, owns this claim.
      const settled = handle.completion.then(
        async (value) => {
          await claim.release()
          return { value }
        },
        async (error: unknown) => {
          await claim.release()
          return { error }
        }
      )
      settlements.push(settled)
      return { handle, settled }
    }
    const running = [0, 1, 2].map((index) => start(index, reservation.slotIds[index]))
    await Promise.all(running.map(({ handle }) => handle.accepted))
    expect(controls.length).toBe(3)
    const first = [...controls]
    for (const key of [
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'OPENCODE_TEST_HOME'
    ]) {
      expect(new Set(first.map(({ backend }) => backend.env[key])).size).toBe(3)
    }
    expect(new Set(first.map(({ backend }) => backend.opencodeUsageApi!.baseUrl)).size).toBe(3)
    expect(new Set(first.map(({ backend }) => backend.env.OPENCODE_SERVER_PASSWORD)).size).toBe(3)
    for (const { backend: child } of first) {
      const port = child.args![child.args!.indexOf('--port') + 1]
      expect(child.opencodeUsageApi).toEqual({
        baseUrl: `http://127.0.0.1:${port}`,
        authorization: `Basic ${Buffer.from(`opencode:${child.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
      })
      expect(child.env.OPENCODE_APP_API_KEY).toBe('synthetic-provider-key')
      expect(child.providerTransportLease).toBeUndefined()
      expect(
        await readFile(join(child.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8')
      ).toBe(safeOpenCodeConfig)
    }
    // A child can replace any runtime directory or add nested links before it exits.
    const external = join(dataRoot, 'external-private')
    await mkdir(external, { mode: 0o700 })
    await writeFile(join(external, 'secret'), 'private data', { mode: 0o600 })
    const externalMode = (await stat(external)).mode
    const secretMode = (await stat(join(external, 'secret'))).mode
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const firstConfig = join(first[0].backend.env.XDG_CONFIG_HOME, 'opencode')
    await symlink(external, join(firstConfig, 'skills', 'os-linked'), linkType)
    const nested = join(firstConfig, 'skills', 'os-example', 'references')
    await chmod(nested, 0o755)
    await symlink(external, join(nested, 'linked-directory'), linkType)
    if (process.platform !== 'win32') {
      await symlink(join(external, 'secret'), join(nested, 'linked-file'), 'file')
    }
    await chmod(nested, 0o555)
    const secondConfig = join(first[1].backend.env.XDG_CONFIG_HOME, 'opencode')
    await new ClaudeCodeSkillMaterializer().sync(secondConfig, [])
    await rm(join(secondConfig, 'skills'), { recursive: true })
    await symlink(external, join(secondConfig, 'skills'), linkType)
    first[0].fail()
    const failedIndex = Number(
      basename(dirname(first[0].backend.env.XDG_CONFIG_HOME)).slice('isolation-'.length)
    )
    const failed = running[failedIndex]
    expect(await failed.settled).toHaveProperty('error')
    await expect(
      readFile(join(first[0].backend.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    for (const { backend: child } of first.slice(1)) {
      await expect(
        readFile(join(child.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8')
      ).resolves.toBe(safeOpenCodeConfig)
    }
    expect(release).not.toHaveBeenCalled()
    const nextReservation = await selected.execution.reserve(1)
    const next = start(3, nextReservation.slotIds[0], true)
    await next.handle.accepted
    await admission.release()
    expect(controls.length).toBe(4)
    const continued = [...controls][3]
    expect(first.slice(1).map(({ backend }) => backend.opencodeUsageApi!.baseUrl)).not.toContain(
      continued.backend.opencodeUsageApi!.baseUrl
    )
    for (const control of [...first.slice(1), continued]) control.finish()
    const completed = await Promise.all([
      ...running.filter((_, index) => index !== failedIndex).map(({ settled }) => settled),
      next.settled
    ])
    for (const result of completed) expect(result).toHaveProperty('value')
    for (const { backend: child } of controls) {
      await expect(stat(dirname(child.env.XDG_CONFIG_HOME))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
    expect(
      await readFile(join(sourceConfig, 'skills', 'os-example', '.catalog_stamp'), 'utf8')
    ).toBe('catalog-stamp')
    if (process.platform !== 'win32') {
      expect((await stat(join(sourceConfig, 'skills', 'os-example'))).mode & 0o222).toBe(0)
    }
    expect(await readFile(join(external, 'secret'), 'utf8')).toBe('private data')
    expect((await stat(external)).mode).toBe(externalMode)
    expect((await stat(join(external, 'secret'))).mode).toBe(secretMode)
    expect(release).toHaveBeenCalledOnce()
    expect(
      JSON.stringify({
        env: admitted.env,
        args: admitted.args,
        files: admitted.opencodeConfigFiles
      })
    ).toBe(original)
    expect(await readFile(join(sourceConfig, 'opencode.json'), 'utf8')).toBe(
      'shared source must stay untouched'
    )
  } finally {
    for (const control of controls) control.finish()
    await Promise.allSettled(settlements)
    await admission.release()
    spy.mockRestore()
    for (const { backend: child } of controls) {
      const config = join(child.env.XDG_CONFIG_HOME, 'opencode')
      const skills = join(config, 'skills')
      const entry = await lstat(skills).catch(() => undefined)
      if (entry?.isSymbolicLink()) await rm(skills, { force: true })
      else {
        await chmod(join(skills, 'os-example', 'references'), 0o755).catch(() => undefined)
        for (const relativePath of [
          'os-linked',
          'os-example/references/linked-directory',
          'os-example/references/linked-file'
        ]) {
          await rm(join(skills, relativePath), { force: true }).catch(() => undefined)
        }
      }
      await new ClaudeCodeSkillMaterializer().sync(config, [])
    }
    await new ClaudeCodeSkillMaterializer().sync(sourceConfig, [])
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it.each([
  'malformed-config',
  'unsafe-file-policy',
  'capability-failure',
  'construction-failure'
] as const)(
  'fails %s without spawning a child process and cleans only the failed Attempt runtime directory',
  async (failure) => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'opencode-preparation-failure-'))
    const admitted = backend('opencode')
    const source = join(dataRoot, 'source', 'opencode')
    admitted.env.XDG_CONFIG_HOME = dirname(source)
    admitted.opencodeConfigFiles = [
      {
        path: join(source, 'opencode.json'),
        content:
          failure === 'malformed-config'
            ? '{synthetic-secret-must-not-escape'
            : failure === 'unsafe-file-policy'
              ? JSON.stringify({ permission: { task: 'allow' } })
              : safeOpenCodeConfig
      }
    ]
    const createRuntime = vi.spyOn(runtimeComposition, 'createAcpRuntime')
    if (failure === 'construction-failure')
      createRuntime.mockImplementation(() => {
        throw new Error('Runtime construction failed')
      })
    const revoke = vi.fn(async () => undefined)
    const capability = vi.fn(async () => {
      if (failure === 'capability-failure') throw new Error('Synthetic capability failure')
      return {
        endpoint: 'http://127.0.0.1:1',
        token: 'synthetic',
        release: () => undefined,
        revoke
      }
    })
    try {
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'keep'), 'shared')
      const skill = join(source, 'skills', 'os-example')
      await mkdir(skill, { recursive: true })
      await writeFile(join(skill, '.catalog_stamp'), 'preserve source')
      await chmod(skill, 0o555)
      const frameworks = createProductionDelegatedFrameworkRuntime({
        capacity: 1,
        dataRoot,
        runtime: { settingsService: {} } as never,
        notebookRpcServer: () => ({ issueDelegatedNotebookConnection: capability }) as never,
        readSession: async () => delegatedSession('opencode')
      })
      const selected = await frameworks.forSession(session('opencode'))
      const reservation = await selected.execution.reserve(1)
      const handle = selected.execution.run(
        {
          session: { projectId: 'project-1', sessionId: 'session-opencode' },
          frameId: 'child-frame',
          attemptId: 'failed-preparation',
          runtimeSegmentId: 'runtime-failure',
          executionModel: {
            frameworkId: 'opencode',
            providerId: 'provider',
            backendId: 'opencode:provider',
            modelRoute: 'opencode-openai',
            model: 'admitted-model',
            reasoningEffort: 'default'
          },
          executionBackend: admitted,
          task: 'Investigate',
          inputs: [],
          workspaceCwd: join(dataRoot, 'workspace'),
          continuation: false
        },
        reservation.slotIds[0]
      )
      await expect(handle.accepted).rejects.toBeInstanceOf(Error)
      const failureResult = await handle.completion.catch((error: Error) => error)
      expect(failureResult).toBeInstanceOf(Error)
      expect(String(failureResult)).not.toContain('synthetic-secret')
      if (failure === 'capability-failure') {
        expect(String(failureResult)).toContain('Synthetic capability failure')
      }
      await expect(
        stat(
          join(
            dataRoot,
            'delegation',
            'project-1',
            'session-opencode',
            'runtime',
            'failed-preparation'
          )
        )
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(String(failureResult).length).toBeLessThan(1024)
      expect(createRuntime).toHaveBeenCalledTimes(failure === 'construction-failure' ? 1 : 0)
      expect(revoke).toHaveBeenCalledTimes(
        failure === 'unsafe-file-policy' || failure === 'construction-failure' ? 1 : 0
      )
      await expect(
        readFile(
          join(
            dataRoot,
            'delegation',
            'project-1',
            'session-opencode',
            'runtime',
            'failed-preparation',
            'config',
            'opencode',
            'opencode.json'
          )
        )
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(source, 'keep'), 'utf8')).toBe('shared')
      await expect(selected.execution.reserve(1)).resolves.toBeDefined()
    } finally {
      createRuntime.mockRestore()
      await new ClaudeCodeSkillMaterializer().sync(source, [])
      await rm(dataRoot, { recursive: true, force: true })
    }
  }
)
it('does not retain backend leases when pending ownership rejects repeated preparation', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'delegated-blocked-backend-'))
  const durable = delegatedSession('opencode')
  const key = { projectId: durable.projectId, sessionId: durable.id }
  let liveLeases = 0
  const owner = new DelegatedProcessOwnership(dataRoot)
  owner.recordFailure({
    ...key,
    frameId: 'child-frame',
    attemptId: 'old-attempt',
    frameworkId: 'opencode'
  })
  const frameworks = createProductionDelegatedFrameworkRuntime({
    capacity: 1,
    dataRoot,
    runtime: {
      settingsService: {
        async resolveAdmittedSubagentBackend() {
          liveLeases++
          return {
            ...backend('opencode'),
            providerTransportLease: {
              setTarget: () => true,
              release: async () => {
                liveLeases--
              }
            }
          }
        }
      }
    } as never,
    notebookRpcServer: () => {
      throw new Error('blocked preparation must not start Notebook')
    },
    readSession: async () => durable
  })
  try {
    const selected = await frameworks.forSession(durable, owner)
    for (let index = 0; index < 2; index++) {
      const reservation = await selected.execution.reserve(1)
      const running = selected.execution.run(
        {
          session: key,
          frameId: 'child-frame',
          attemptId: `retry-${index}`,
          runtimeSegmentId: `runtime-${index}`,
          task: 'Investigate',
          inputs: [],
          workspaceCwd: dataRoot,
          continuation: false,
          executionModel: {
            frameworkId: 'opencode',
            providerId: 'provider-a',
            backendId: 'opencode:provider-a',
            modelRoute: 'opencode-openai',
            model: 'model-a',
            reasoningEffort: 'default'
          }
        },
        reservation.slotIds[0]
      )
      await expect(running.completion).rejects.toThrow(/cleanup is unconfirmed/)
      await reservation.releaseAll()
    }
    expect(liveLeases).toBe(0)
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it('settles owned CodeBuddy processes when ACP runtime construction throws', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'codebuddy-construction-cleanup-'))
  const owner = new DelegatedProcessOwnership(dataRoot)
  const key = { projectId: 'project-1', sessionId: 'session-codebuddy' }
  let child: ChildProcessWithoutNullStreams | undefined
  const spawnSpy = vi.spyOn(codeBuddyFramework, 'spawn').mockImplementation((input) => {
    child = input.spawnProcess!(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: 'pipe',
      env: process.env
    })
    return child
  })
  const createRuntime = vi.spyOn(runtimeComposition, 'createAcpRuntime').mockImplementation(() => {
    throw new Error('controlled ACP construction failure')
  })
  try {
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: { settingsService: {} } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => ({
            endpoint: 'http://127.0.0.1:1',
            token: 'synthetic',
            release: () => undefined,
            revoke: async () => undefined
          })
        }) as never,
      readSession: async () => delegatedSession('codebuddy')
    })
    const selected = await frameworks.forSession(session('codebuddy'), owner)
    const reservation = await selected.execution.reserve(1)
    const running = selected.execution.run(
      {
        session: key,
        frameId: 'child-frame',
        attemptId: 'failed-start',
        runtimeSegmentId: 'runtime-1',
        executionModel: {
          frameworkId: 'codebuddy',
          providerId: 'provider',
          backendId: 'codebuddy:provider',
          modelRoute: 'codebuddy-openai',
          model: 'admitted-model',
          reasoningEffort: 'default'
        },
        executionBackend: backend('codebuddy'),
        task: 'Investigate',
        inputs: [],
        workspaceCwd: dataRoot,
        continuation: false
      },
      reservation.slotIds[0]
    )
    await expect(running.completion).rejects.toThrow('controlled ACP construction failure')
    expect(spawnSpy).toHaveBeenCalledOnce()
    expect(createRuntime).toHaveBeenCalledOnce()
    // Windows confirms the native Job is empty before its ChildProcess exit poll runs.
    await expect.poll(() => child?.exitCode !== null || child?.signalCode !== null).toBe(true)
    expect(owner.receipts(key)).toEqual([])
    await expect(
      stat(join(dataRoot, 'delegation', key.projectId, key.sessionId, 'runtime', 'failed-start'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    const next = await selected.execution.reserve(1)
    await next.releaseAll()
  } finally {
    await owner.recover(key, true)
    spawnSpy.mockRestore()
    createRuntime.mockRestore()
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it('cleans copied read-only OpenCode Skills after successful execution without changing the source', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'opencode-readonly-cleanup-'))
  const source = join(dataRoot, 'shared-config', 'opencode', 'skills', 'os-example')
  const runtimeHome = join(
    dataRoot,
    'delegation',
    'project-1',
    'session-opencode',
    'runtime',
    'readonly-attempt'
  )
  const copied = join(runtimeHome, 'config', 'opencode', 'skills', 'os-example')
  const admitted = backend('opencode')
  admitted.env.XDG_CONFIG_HOME = join(dataRoot, 'shared-config')
  const runtime = vi.spyOn(runtimeComposition, 'createAcpRuntime').mockReturnValue({
    createSession: async () => ({ sessionId: 'provider' }),
    sendAppContinuation: async () => ({ stopReason: 'end_turn' }),
    deleteSession: async () => undefined,
    shutdownForQuit: async () => ({ reaped: true })
  } as never)
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, '.catalog_stamp'), 'shared evidence')
    await chmod(source, 0o555)
    const frameworks = createProductionDelegatedFrameworkRuntime({
      capacity: 1,
      dataRoot,
      runtime: { settingsService: {} } as never,
      notebookRpcServer: () =>
        ({
          issueDelegatedNotebookConnection: async () => ({
            endpoint: 'http://127.0.0.1:1',
            token: 'synthetic',
            release: () => undefined,
            revoke: async () => undefined
          })
        }) as never,
      readSession: async () => delegatedSession('opencode')
    })
    const selected = await frameworks.forSession(session('opencode'))
    const reservation = await selected.execution.reserve(1)
    const running = selected.execution.run(
      {
        session: { projectId: 'project-1', sessionId: 'session-opencode' },
        frameId: 'child-frame',
        attemptId: 'readonly-attempt',
        runtimeSegmentId: 'runtime-1',
        executionModel: {
          frameworkId: 'opencode',
          providerId: 'provider',
          backendId: 'opencode:provider',
          modelRoute: 'opencode-openai',
          model: 'admitted-model',
          reasoningEffort: 'default'
        },
        executionBackend: admitted,
        task: 'Investigate',
        inputs: [],
        workspaceCwd: dataRoot,
        continuation: false
      },
      reservation.slotIds[0]
    )
    await expect(running.completion).resolves.toMatchObject({ status: 'completed' })
    await expect(stat(runtimeHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, '.catalog_stamp'), 'utf8')).toBe('shared evidence')
    if (process.platform !== 'win32') expect((await stat(source)).mode & 0o777).toBe(0o555)
  } finally {
    runtime.mockRestore()
    await chmod(source, 0o755)
    await chmod(copied, 0o755).catch(() => undefined)
    await rm(dataRoot, { recursive: true, force: true })
  }
})

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createApplicationCommandRouter } from '../application-command-router'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { ApplicationEventHub } from '../application-events'
import { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'
import {
  bootstrapApplicationCommandGroup,
  registerBootstrapApplicationCommands
} from './bootstrap-application-commands'
import { HeadlessTaskApi } from '../web-service/task-api'
import { startWebHttpServer, type RunningWebServer } from '../web-service/http-server'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import type { CodexAuthStatus } from './codex-auth'
import type { OpenScienceClient as PublicClient } from '../../../packages/open-science/index'
import type { TaskAgentPort } from '../tasks/task-runner'
// @ts-expect-error The JavaScript CLI command intentionally has no declaration file.
import { codexLoginCommand } from '../../../packages/open-science/codex-login.mjs'
// @ts-expect-error The published ESM entry uses a sibling index.d.ts.
import { OpenScienceClient } from '../../../packages/open-science/index.mjs'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', getAppPath: () => '/nonexistent', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }
}))

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')

it('bootstraps through real local HTTP, restarts the profile, and submits a persisted Task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'osci-bootstrap-integration-'))
  const adapterPath = join(root, 'adapter.mjs')
  const nativePath = join(root, 'codex')
  let installed = false
  const install = vi.fn(async () => {
    await writeFile(nativePath, 'synthetic runtime')
    await writeFile(adapterPath, 'synthetic adapter')
    installed = true
    return {
      result: { installId: 'fixture', ok: true },
      adapterPath,
      adapterVersion: '1.6.2',
      codexPath: nativePath,
      codexVersion: '0.114.0'
    }
  })
  const status = async (): Promise<CodexAuthStatus> => ({
    mode: 'isolated' as const,
    supported: true,
    authenticated: await readFile(join(root, 'codex-subscription', 'auth.json'), 'utf8').then(
      () => true,
      () => false
    )
  })
  const options = {
    configRoot: root,
    userClaudeDir: join(root, 'external-claude'),
    userCodexDir: join(root, 'external-codex'),
    userAgentsDir: join(root, 'external-agents'),
    detectDeps: {
      env: {},
      homePath: root,
      platform: process.platform,
      isExecutable: async () => false,
      getVersion: async () => undefined,
      resolveNpmBinDirs: async () => []
    },
    codexDetectDeps: {
      env: {},
      homePath: root,
      platform: process.platform,
      managedAdapterPath: adapterPath,
      managedCodexPath: nativePath,
      isRunnable: async () => installed,
      getAdapterVersion: async () => (installed ? '1.6.2' : undefined),
      getCodexVersion: async () => (installed ? '0.114.0' : undefined),
      smokeInitialize: async () => true,
      resolveNpmBinDirs: async () => []
    },
    installManagedCodexImpl: install,
    codexAuth: {
      getStatus: status,
      loginIsolated: status,
      cancelLogin: async () => {},
      logoutIsolated: status
    }
  }
  let service = new SettingsService(options)
  const db = createProjectDbClient(root)
  await migrateApplicationDatabase(db)
  const projects = new ProjectRepository(async () => db)
  const sessions = new SessionRepository(root)
  // No files are produced by the synthetic model; the real session coordinator owns all writes.
  const coordinator = new SessionPersistenceCoordinator(sessions, {
    syncSession: async () => [],
    softDeleteSession: async () => 'deleted',
    restoreSession: async () => {},
    softDeleteProject: async () => 'deleted',
    reconcileActiveSessions: async () => {},
    reconcileProjectSessions: async () => {},
    markReconciliationIncomplete: () => {}
  })
  let api: HeadlessTaskApi | undefined
  let server: RunningWebServer | undefined
  const prompt = vi.fn<TaskAgentPort['prompt']>(async () => {})
  const start = async (): Promise<PublicClient> => {
    const events = new ApplicationEventHub()
    const router = createApplicationCommandRouter()
    registerBootstrapApplicationCommands(router.registrar, {
      service,
      emitInstallEvent: () => {},
      snapshotCommits: new SettingsSnapshotCommitOwner(service, events)
    })
    const commands: ApplicationCommandByNameDispatcher = {
      commandNames: router.dispatcher.commandNames,
      invoke: async (name, invocation) => {
        const args = invocation.args
        switch (name) {
          case 'settings:get-settings':
            return service.getSettingsView()
          case 'projects:list':
            return projects.list()
          case 'sessions:load-all':
            return sessions.loadAll()
          case 'sessions:save-session':
            return coordinator.saveSession(args[0] as Parameters<typeof coordinator.saveSession>[0])
          case 'sessions:stage-task-completion':
            return coordinator.stageTaskCompletion(
              args[0] as Parameters<typeof coordinator.stageTaskCompletion>[0]
            )
          case 'sessions:settle-task-completion':
            return coordinator.settleTaskCompletion(
              args[0] as Parameters<typeof coordinator.settleTaskCompletion>[0]
            )
          case 'sessions:fail-task-run':
            return coordinator.failTaskRun(args[0] as Parameters<typeof coordinator.failTaskRun>[0])
          default: {
            const command = bootstrapApplicationCommandGroup.commands.find(
              (command) => command.name === name
            )
            if (!command) throw new Error(`Unexpected application command: ${name}`)
            return router.dispatcher.invoke(command, {
              ...invocation,
              args: invocation.args as readonly [import('../../shared/bootstrap').BootstrapRequest]
            })
          }
        }
      }
    }
    api = new HeadlessTaskApi({
      commands,
      agent: {
        withSessionAvailable: async (_project, _session, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => {
          const settings = await service.getSettingsView()
          expect(settings.activeProviderId).toBe('builtin-codex-subscription')
          return {
            sessionId: 'first-cli-session',
            frameworkId: settings.agentFrameworkId,
            backendId: settings.activeProviderId
          }
        },
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => {},
        setMemoryEnabled: async () => {},
        prompt,
        cancelPrompt: async () => {}
      }
    })
    server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'fixture',
      staticRoot: root,
      applicationCommands: {
        localWeb: commands,
        remoteWeb: { ...commands, rejectedCommandNames: () => [] }
      },
      applicationEvents: events,
      tasks: api,
      bootstrap: {
        appName: 'Open Science',
        appVersion: 'test',
        configRoot: root,
        platform: process.platform,
        versions: { electron: '', chrome: '', node: process.version }
      }
    })
    return new OpenScienceClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'fixture' })
  }
  let client = await start()
  const runCodex = vi.fn(async (_path, args) => {
    if (args.includes('--device-auth')) {
      const home = join(root, 'codex-subscription')
      await mkdir(home, { recursive: true })
      await writeFile(
        join(home, 'auth.json'),
        JSON.stringify({
          last_refresh: '2026-09-12T00:00:00Z',
          tokens: {
            access_token: 'synthetic-token',
            refresh_token: 'synthetic-refresh',
            id_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signature'
          }
        })
      )
      return { code: 0 }
    }
    return { code: (await status()).authenticated ? 0 : 1 }
  })
  try {
    const dependencies = {
      locateApp: async () => ({ packaged: false }),
      connect: async () => client,
      runCodex,
      log: vi.fn()
    }
    await codexLoginCommand({ configRoot: root }, dependencies)
    expect(install).toHaveBeenCalledOnce()
    const beforeStatus = await new SettingsRepository(root).getSettings()
    expect(await service.bootstrap({ action: 'status' }, () => {})).toMatchObject({
      ok: true,
      next: { provider: ['codex', 'login', '--force'] }
    })
    expect(await new SettingsRepository(root).getSettings()).toEqual(beforeStatus)
    expect((await service.getPreflight()).providerReadiness).toEqual({ status: 'ready' })
    await server!.close()
    await api!.dispose()
    await service.dispose()
    service = new SettingsService(options)
    client = await start()
    await codexLoginCommand({ configRoot: root }, dependencies)
    expect(install).toHaveBeenCalledOnce()
    expect(runCodex.mock.calls.filter(([, args]) => args.includes('--device-auth'))).toHaveLength(1)
    expect((await new SettingsRepository(root).getSettings()).activeProviderId).toBe(
      'builtin-codex-subscription'
    )
    expect((await service.getPreflight()).runtimeReadiness).toEqual({ status: 'ready' })
    const project = await projects.create({ name: 'First CLI research' })
    const run = await client.startRun({
      project: project.id,
      prompt: 'Synthetic first research task',
      cwd: root
    })
    await expect.poll(async () => (await client.getRun(run.id)).status).toBe('completed')
    expect(prompt).toHaveBeenCalledOnce()
    const persisted = (await new SessionRepository(root).loadAll()).sessions.find(
      (session) => session.id === run.sessionId
    )
    expect(persisted).toMatchObject({
      projectId: project.id,
      status: 'idle',
      agentFrameworkId: 'codex'
    })
    expect(
      persisted?.messages.some((message) => message.content === 'Synthetic first research task')
    ).toBe(true)
    expect(
      // @ts-expect-error Exercise server-side validation independently of SDK types.
      await client.bootstrap({ action: 'provider', key: 'secret', unexpected: true })
    ).toEqual({ ok: false, code: 'invalid_request' })
  } finally {
    await server?.close()
    await api?.dispose()
    await service.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

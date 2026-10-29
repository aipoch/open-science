// Diagnostic scenarios, not attribution of the reported incident. Only the provider transport and
// external catalogs are controlled; Specialist storage, production composition and send are real.
import * as acp from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { expect, it, onTestFinished, vi, type Mock } from 'vitest'
import {
  claudeCodeFramework,
  codexFramework,
  opencodeFramework,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createSpecialistService } from '../specialist/service'
import { disconnectProjectDbClient } from '../projects/prisma-client'
import {
  emptySelectedConfig,
  type SpecialistView,
  type SpecialistSkillCatalogEntry
} from '@aipoch/specialists'
import { createAcpHandlerWorkflows } from './handler-workflows'
import { ConnectorSettingsModule } from '../settings/connector-settings'
import { SettingsRepository } from '../settings/repository'
import { SkillRegistry } from '@aipoch/skills'
import { SkillCatalogModule } from '../skills/catalog'
import { createAcpRuntime, type AcpRuntimeCompositionOptions } from './runtime-composition'
import { projectDiagnosticLog } from '../session-diagnostics/projection'

vi.mock('electron', () => ({
  app: { getVersion: () => 'test', getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
const roots = vi.hoisted(() => ({ path: '' }))
const diagnosticRecords = vi.hoisted(() => [] as unknown[])
vi.mock('@aipoch/diagnostics/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/diagnostics/node')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({
      ...actual.createLogger(scope),
      warn: (...args: unknown[]) => {
        diagnosticRecords.push({ scope, level: 'warn', args })
      },
      error: (...args: unknown[]) => {
        diagnosticRecords.push({ scope, level: 'error', args })
      }
    })
  }
})
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => roots.path,
  resolveDataRoot: () => roots.path
}))

class ProviderProcess extends EventEmitter {
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

const harness = async (
  backend: Pick<ResolvedAgentBackend, 'framework' | 'modelRoute'> = { framework: opencodeFramework }
): Promise<{
  service: ReturnType<typeof createSpecialistService>
  profile: SpecialistView
  settings: {
    listSpecialistSkillCatalog: Mock<() => Promise<SpecialistSkillCatalogEntry[]>>
    provisionedConnectorSkillNames: Mock<() => Promise<string[]>>
    getConnectors: Mock<ConnectorSettingsModule['getConnectors']>
  }
  runtime: ReturnType<typeof createAcpRuntime>
  session: Awaited<ReturnType<ReturnType<typeof createAcpRuntime>['createSession']>>
  send: () => Promise<void>
  prompts: string[]
  cwd: string
  connectors: ConnectorSettingsModule
}> => {
  const root = await mkdtemp(join(tmpdir(), 'specialist-send-'))
  roots.path = root
  const service = createSpecialistService(root)
  const profile = await service.create({ name: 'LITERATURE_EXPERT' })
  const connectors = new ConnectorSettingsModule(new SettingsRepository(root))
  const prompts: string[] = []
  const processes: ProviderProcess[] = []
  const modeState =
    backend.framework.id === 'codex'
      ? {
          modes: {
            currentModeId: 'read-only',
            availableModes: [
              { id: 'read-only', name: 'Read only' },
              { id: 'auto', name: 'Auto' },
              { id: 'full-access', name: 'Full access' }
            ]
          }
        }
      : {}
  const settings = {
    listSpecialistSkillCatalog: vi.fn(async () => [
      { id: 'literature', frameworkName: 'literature' }
    ]),
    provisionedConnectorSkillNames: vi.fn(async () => ['mcp-pubmed']),
    getConnectors: vi.fn(() => connectors.getConnectors()),
    skillsNeedingForceLoad: vi.fn(async () => []),
    skillNudgeNamesForIds: vi.fn(async (ids: string[]) => ids),
    rememberCodexAutoHttpsFallback: vi.fn(async () => false)
  }
  const runtime = createAcpRuntime({
    appVersion: 'test',
    mcpEntryPath: join(root, 'unused-mcp.js'),
    settingsService: settings,
    specialistService: service,
    // Avoid unrelated Artifact/Notebook storage; no tools are executed by the fake provider.
    delegatedNotebookConnection: { endpoint: 'unused', token: 'unused' },
    notebookRpcServer: {},
    fixedBackend: { ...backend, executablePath: 'unused', env: {} },
    spawnAgent: () => {
      const process = new ProviderProcess()
      processes.push(process)
      acp
        .agent({ name: 'controlled-provider' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } },
          authMethods: []
        }))
        .onRequest(acp.methods.agent.session.new, () => ({
          sessionId: 'bound-session',
          ...modeState
        }))
        .onRequest(acp.methods.agent.session.resume, () => modeState)
        .onRequest(acp.methods.agent.session.setMode, () => ({}))
        .onRequest(acp.methods.agent.session.close, () => ({}))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => {
          prompts.push(JSON.stringify(ctx.params.prompt))
          return { stopReason: 'end_turn' }
        })
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )
      return process as unknown as ChildProcessWithoutNullStreams
    }
  } as unknown as AcpRuntimeCompositionOptions)
  // Production composition installs a dispatch admission guard. Admit this test Session while
  // retaining the coordinator's real pre-acceptance error wrapping at that boundary.
  runtime.setPromptDispatchAdmissionGuard(async (_sessionId, dispatch) => dispatch())
  onTestFinished(async () => {
    await runtime.disconnect()
    await disconnectProjectDbClient()
    for (const process of processes) {
      process.stdin.destroy()
      process.stdout.destroy()
      process.stderr.destroy()
    }
    await rm(root, { recursive: true, force: true })
  })
  const session = await runtime.createSession({ cwd: root, specialistId: profile.id })
  const workflows = createAcpHandlerWorkflows(runtime, {} as never)
  const send = async (): Promise<void> => {
    await workflows.sendPrompt({ sessionId: session.sessionId, text: 'Continue the analysis' })
    await vi.waitFor(() => expect(runtime.getState().promptInFlight).toBe(false))
  }
  await send()
  expect(prompts).toHaveLength(1)
  return { service, profile, settings, runtime, session, send, prompts, cwd: root, connectors }
}

const reloadAndSend = async (h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
  const previousPromptCount = h.prompts.length
  // Mirrors the profiles-changed lifecycle used by composition/session-surfaces.ts.
  await h.runtime.requestSkillsReload()
  await h.runtime.resumeSession({
    sessionId: h.session.sessionId,
    cwd: h.cwd,
    specialistId: h.profile.id
  })
  await h.send()
  expect(h.prompts).toHaveLength(previousPromptCount + 1)
}

it('continues after editing the bound Specialist Skill selection', async () => {
  const h = await harness()
  await h.service.update({
    id: h.profile.id,
    revision: h.profile.revision,
    capabilityMode: 'selected',
    selectedCapabilities: { ...emptySelectedConfig(), skillIds: ['literature'] }
  })
  await h.send()
  expect(h.prompts).toHaveLength(2)
  await reloadAndSend(h)
})

it('continues after editing the bound Specialist Connector selection', async () => {
  const h = await harness()
  await h.service.update({
    id: h.profile.id,
    revision: h.profile.revision,
    capabilityMode: 'selected',
    selectedCapabilities: { ...emptySelectedConfig(), connectorIds: ['pubmed'] }
  })
  await h.send()
  expect(h.prompts).toHaveLength(2)
  await reloadAndSend(h)
})

it('continues after editing a personal Skill body through the real catalog', async () => {
  const h = await harness()
  const bundleRoot = join(h.cwd, 'bundled-skills')
  await mkdir(bundleRoot)
  await writeFile(join(bundleRoot, 'manifest.json'), JSON.stringify({ version: 1, skills: [] }))
  const catalog = new SkillCatalogModule({
    repository: new SettingsRepository(h.cwd),
    storageRoot: h.cwd,
    skillRegistry: new SkillRegistry(bundleRoot),
    userClaudeDir: join(h.cwd, 'claude'),
    userCodexDir: join(h.cwd, 'codex'),
    userAgentsDir: join(h.cwd, 'agents')
  })
  await catalog.createSkill({
    name: 'literature',
    description: 'Literature review',
    body: 'Original instructions'
  })
  h.settings.listSpecialistSkillCatalog.mockImplementation(() =>
    catalog.listSpecialistSkillCatalog()
  )
  await h.send()
  const detail = await catalog.getSkillDetail('personal-literature')
  await catalog.updateSkill({
    id: detail.id,
    etag: detail.etag,
    description: 'Revised literature review',
    body: 'Revised instructions'
  })
  expect((await catalog.getSkillDetail(detail.id)).body).toContain('Revised instructions')
  await h.send()
  expect(h.prompts).toHaveLength(3)
  await reloadAndSend(h)
})

it('continues after changing a custom Connector URL in Settings', async () => {
  const h = await harness()
  await h.connectors.addCustomServer({
    id: 'research',
    name: 'research',
    displayName: 'Research',
    transport: 'streamable_http',
    url: 'https://example.com/mcp'
  })
  h.settings.provisionedConnectorSkillNames.mockResolvedValue(['mcp-research'])
  await h.send()
  await h.connectors.updateCustomServer({
    id: 'research',
    transport: 'streamable_http',
    url: 'https://example.org/mcp'
  })
  expect(
    (await h.connectors.getConnectors())?.customMcpServers?.find(
      (server) => server.id === 'research'
    )?.url
  ).toBe('https://example.org/mcp')
  await h.send()
  expect(h.prompts).toHaveLength(3)
  await reloadAndSend(h)
})

it('continues after disabling a bundled Connector in Settings', async () => {
  const h = await harness()
  await h.connectors.setConnectorEnabled({ id: 'pubmed', enabled: false })
  await h.send()
  expect(h.prompts).toHaveLength(2)
  await reloadAndSend(h)
})

it.each(['skill-removed', 'connector-removed'] as const)(
  'continues when the catalog reflects %s',
  async (operation) => {
    const h = await harness()
    if (operation === 'skill-removed') h.settings.listSpecialistSkillCatalog.mockResolvedValue([])
    else h.settings.provisionedConnectorSkillNames.mockResolvedValue([])
    await h.send()
    expect(h.prompts).toHaveLength(2)
    await reloadAndSend(h)
  }
)

const backends = [
  { label: 'claude-code', framework: claudeCodeFramework, modelRoute: 'claude-anthropic' },
  { label: 'opencode', framework: opencodeFramework, modelRoute: 'opencode-openai' },
  { label: 'codex-responses', framework: codexFramework, modelRoute: 'codex-responses' },
  { label: 'codex-bridge', framework: codexFramework, modelRoute: 'codex-bridge' }
] satisfies Array<{ label: string } & Pick<ResolvedAgentBackend, 'framework' | 'modelRoute'>>

it.each(
  backends.flatMap((backend) =>
    (
      ['listSpecialistSkillCatalog', 'provisionedConnectorSkillNames', 'getConnectors'] as const
    ).map((boundary) => ({ ...backend, boundary }))
  )
)(
  '$label distinguishes a $boundary read failure from a missing Specialist and permits retry after recovery',
  async ({ boundary, ...backend }) => {
    const h = await harness(backend)
    const failure = new Error(`injected ${boundary} failure`)
    diagnosticRecords.length = 0
    const read: Mock<() => Promise<unknown>> = h.settings[boundary]
    await read.withImplementation(
      () => Promise.reject(failure),
      async () => {
        await expect(h.send()).rejects.toMatchObject({
          name: 'DelegateMessagePreAcceptanceError',
          message: 'The Specialist Skills or Connectors could not be loaded. Try sending again.'
        })
        expect(h.prompts).toHaveLength(1)
        const warmFailure = diagnosticRecords as Array<{
          scope: string
          args: [string, Record<string, unknown>]
        }>
        const exportedWarm = warmFailure.map(({ scope, args }) =>
          projectDiagnosticLog({ scope, msg: args[0], data: args[1] })
        )
        expect(exportedWarm).toContainEqual(
          expect.objectContaining({
            diagnostics: expect.objectContaining({
              phase: boundary === 'listSpecialistSkillCatalog' ? 'skills' : 'connectors',
              sessionId: h.session.sessionId,
              specialistId: h.profile.id,
              frameworkId: backend.framework.id,
              modelRoute: backend.modelRoute,
              reason: 'capability-read-failed'
            })
          })
        )
        await h.runtime.requestSkillsReload()
        await expect(
          h.runtime.resumeSession({
            sessionId: h.session.sessionId,
            cwd: h.cwd,
            specialistId: h.profile.id
          })
        ).resolves.toMatchObject({ sessionId: h.session.sessionId })
        await expect(h.send()).rejects.toMatchObject({
          name: 'DelegateMessagePreAcceptanceError',
          message: 'The Specialist Skills or Connectors could not be loaded. Try sending again.'
        })
        expect(h.prompts).toHaveLength(1)
        expect(JSON.stringify(diagnosticRecords)).not.toContain(failure.message)
        expect(diagnosticRecords).toContainEqual(
          expect.objectContaining({
            args: expect.arrayContaining([
              expect.objectContaining({ reason: 'capability-read-failed', errorCategory: 'error' })
            ])
          })
        )
        expect(diagnosticRecords).toContainEqual(
          expect.objectContaining({
            args: expect.arrayContaining([
              expect.objectContaining({
                specialistId: h.profile.id,
                phase: boundary === 'listSpecialistSkillCatalog' ? 'skills' : 'connectors'
              })
            ])
          })
        )
      }
    )
    await h.send()
    expect(h.prompts).toHaveLength(2)
    expect((await h.service.resolveRunnableById(h.profile.id)).enabled).toBe(true)
  }
)

it.each(['delete', 'disable'] as const)(
  'records the send result after Specialist %s',
  async (operation) => {
    const h = await harness()
    if (operation === 'delete') await h.service.delete(h.profile.id)
    else await h.service.setEnabled(h.profile.id, false)
    await expect(h.send()).rejects.toMatchObject({
      name: 'DelegateMessagePreAcceptanceError',
      message:
        operation === 'delete'
          ? 'The bound specialist is unavailable.'
          : 'The bound specialist is disabled.'
    })
    expect(h.prompts).toHaveLength(1)
    // Match the reported sequence: resume an already attached session, then send again.
    await h.runtime.resumeSession({ sessionId: h.session.sessionId, cwd: h.cwd })
    await expect(h.send()).rejects.toMatchObject({
      name: 'DelegateMessagePreAcceptanceError',
      message:
        operation === 'delete'
          ? 'The bound specialist is unavailable.'
          : 'The bound specialist is disabled.'
    })
    expect(h.prompts).toHaveLength(1)
  }
)

it.each(
  backends.flatMap((backend) =>
    ['delete', 'disable', 'invalid-capabilities', 'invalid-json'].map((operation) => ({
      ...backend,
      operation
    }))
  )
)(
  '$label diagnoses a cold resume after Specialist $operation without exporting private content',
  async ({ operation, ...backend }) => {
    const h = await harness(backend)
    if (operation === 'delete') await h.service.delete(h.profile.id)
    else if (operation === 'disable') await h.service.setEnabled(h.profile.id, false)
    else {
      const file = join(h.cwd, 'specialists.json')
      const document = JSON.parse(await readFile(file, 'utf8'))
      document.specialists[0].fullAccess = null
      document.specialists[0].capabilityMode = 'full'
      await writeFile(
        file,
        operation === 'invalid-json'
          ? 'PRIVATE_SPECIALIST_PROMPT invalid json'
          : JSON.stringify(document)
      )
    }
    await h.runtime.disconnect()
    diagnosticRecords.length = 0
    await expect(
      h.runtime.resumeSession({
        sessionId: h.session.sessionId,
        cwd: h.cwd,
        specialistId: h.profile.id,
        previousFrameworkId: backend.framework.id
      })
    ).rejects.toThrow('The bound specialist is unavailable.')
    expect(h.prompts).toHaveLength(1)
    const entries = diagnosticRecords as Array<{
      scope: string
      args: [string, Record<string, unknown>]
    }>
    expect(entries).toContainEqual(
      expect.objectContaining({
        args: [
          'bound specialist identity resolution failed',
          expect.objectContaining({
            specialistId: h.profile.id,
            sessionId: h.session.sessionId,
            frameworkId: backend.framework.id,
            phase: 'identity',
            reason: 'unavailable'
          })
        ]
      })
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        args: [
          'bound specialist profile resolution failed',
          expect.objectContaining({
            specialistId: h.profile.id,
            phase: 'profile',
            reason: operation === 'disable' ? 'disabled' : 'profile-read-failed',
            resolver: 'identity'
          })
        ]
      })
    )
    if (operation === 'delete' || operation === 'invalid-capabilities') {
      expect(entries).toContainEqual(
        expect.objectContaining({
          args: [
            'runnable specialist lookup failed',
            expect.objectContaining({
              specialistId: h.profile.id,
              reason: operation === 'delete' ? 'not-found' : 'invalid-capabilities'
            })
          ]
        })
      )
    }
    const exported = entries.map(({ scope, args }) =>
      projectDiagnosticLog({ scope, msg: args[0], data: args[1] })
    )
    expect(exported).toContainEqual(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          specialistId: h.profile.id,
          sessionId: h.session.sessionId,
          frameworkId: backend.framework.id,
          phase: 'identity',
          reason: 'unavailable'
        })
      })
    )
    expect(JSON.stringify(entries)).not.toContain('PRIVATE_SPECIALIST_PROMPT')
    expect(JSON.stringify(exported)).not.toContain('PRIVATE_SPECIALIST_PROMPT')
  }
)

// Diagnostic evidence of controlled failures does not attribute the external incident.
it('retains the catalog failure category without arbitrary error text in diagnostic evidence', async () => {
  const h = await harness()
  diagnosticRecords.length = 0
  const failure = new Error('investigation-skill-catalog-read-failed')
  h.settings.listSpecialistSkillCatalog.mockRejectedValue(failure)
  await expect(h.send()).rejects.toMatchObject({
    name: 'DelegateMessagePreAcceptanceError',
    message: 'The Specialist Skills or Connectors could not be loaded. Try sending again.'
  })
  expect(h.prompts).toHaveLength(1)
  expect(JSON.stringify(diagnosticRecords)).not.toContain(failure.message)
  expect(diagnosticRecords).toContainEqual(
    expect.objectContaining({
      args: expect.arrayContaining([
        expect.objectContaining({ reason: 'capability-read-failed', errorCategory: 'error' })
      ])
    })
  )
})

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { flushLogs, getLogFilePath, initLogger } from '@aipoch/diagnostics/node'
import { create as createTar, extract as extractTar } from 'tar'
import { expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import type { ResolveArtifactVersionDescriptorsRequest } from '../../shared/artifacts'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PackageOperationRequest } from '../../shared/session-package'
import type { LoadSessionRequest, PersistedChatSession } from '../../shared/session-persistence'
import { createApplicationCommandRouter } from '../application-command-router'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition-contract'
import { ApplicationEventHub } from '../application-events'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import {
  dataContentApplicationCommands,
  registerDataContentApplicationCommands
} from '../data-content-application-commands'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { NotebookExecutionIntentOwner } from '../notebook/execution-intent'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { FileTaskRunJournal } from '../tasks/task-run-journal'
import { startWebHttpServer } from '../web-service/http-server'
import { HeadlessTaskApi } from '../web-service/task-api'
import { SessionPackageDesktop } from './desktop'
import { SessionPackageService } from './service'

const cli = resolve('packages/open-science/cli.mjs')
const exec = promisify(execFile)
const source = { projectId: 'project', sessionId: 'session' }
const artifactPackage = resolve(
  'src/main/session-package/fixtures/session-package-v0.31.1-artifact.science'
)
const resetOwnership = configureTestRuntimeMetadata()
const { confirmNative } = vi.hoisted(() => ({ confirmNative: vi.fn() }))
vi.mock('../desktop-interaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../desktop-interaction')>()),
  desktopFileInteraction: () => ({ confirm: confirmNative })
}))
type CliResult = Promise<{ stdout: string; stderr: string }>

const content = (
  call: Awaited<ReturnType<Client['callTool']>>
): { result?: unknown; error?: unknown } => call.structuredContent ?? {}

const report = '# Published research\n\nMean: 14.\n'
type ExportReviewDecision = Extract<PackageOperationRequest, { action: 'respond-export-review' }>

const approvalFor = (observed: unknown): Omit<ExportReviewDecision, 'action'> => {
  const { operationId, sensitiveExportReview } = observed as {
    operationId: string
    sensitiveExportReview: {
      destinationPath: string
      expiresAt: number
      fileDigest: { sizeBytes: number; checksum: string }
    }
  }
  const { destinationPath, expiresAt, fileDigest } = sensitiveExportReview
  return {
    operationId,
    destinationPath,
    expiresAt,
    sizeBytes: fileDigest.sizeBytes,
    sha256: fileDigest.checksum,
    source: 'user_relay',
    decision: 'approved'
  }
}

async function exportPublishedResearch(): Promise<Buffer> {
  const fixture = await createProvenanceTestFixture()
  const { storageRoot, client } = fixture
  initDataRoot(storageRoot)
  const sessions = new SessionRepository(storageRoot)
  const provenance = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId)
  })
  const service = new SessionPackageService({ storageRoot, getClient: async () => client })
  try {
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'question',
        role: 'user',
        content: 'Report the mean',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer',
        role: 'agent',
        content: 'The mean is 14.',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
    const conversationGraph = createLinearConversationGraph({
      sessionId: source.sessionId,
      messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    await client.project.create({ data: { id: source.projectId, name: 'Published research' } })
    const session = await sessions.saveSession({
      id: source.sessionId,
      projectId: source.projectId,
      title: 'Published research',
      cwd: storageRoot,
      status: 'idle',
      messages,
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    })
    const scope = {
      projectId: source.projectId,
      appSessionId: source.sessionId,
      artifactRunId: 'research',
      rootFrameId: conversationGraph.rootFrameId,
      agentFrameId: conversationGraph.activeFrameId,
      messageBranchId: conversationGraph.branches[0].id,
      runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
      promptMessageId: 'question'
    }
    await fixture.compatibilityRepository.writePendingFile({
      ...source,
      runId: scope.artifactRunId,
      filename: 'report.md',
      source: { kind: 'inline', content: report, encoding: 'utf8' }
    })
    const version = await provenance.createVersion({
      ...scope,
      artifactStorageSessionId: source.sessionId,
      writeOperationId: 'write-report',
      writeRequestChecksum: 'a'.repeat(64),
      filename: 'report.md',
      contentType: 'text/markdown'
    })
    const finalization = { ...scope, artifactVersionIds: [version.versionId], messageId: 'answer' }
    await provenance.finalizeRun(finalization)
    await provenance.activateFinalizedRun(finalization)
    await sessions.saveSession({
      ...session,
      artifacts: [
        {
          id: version.id,
          artifactId: version.artifactId,
          versionId: version.versionId,
          kind: 'managed-file',
          name: version.name,
          path: version.path,
          size: version.size,
          mimeType: version.mimeType
        }
      ]
    })
    const archive = join(storageRoot, 'source.science')
    await service.exportTo(source, archive)
    return await readFile(archive)
  } finally {
    await service.close()
    initDataRoot(undefined)
    await fixture.dispose()
  }
}

async function withPackageService(
  test: (context: {
    root: string
    sdk: Client
    callCli: (name: string, args: object) => CliResult
    service: SessionPackageService
    invokePackageRpc: (
      request: PackageOperationRequest,
      auth?: 'bearer' | 'cookie' | 'browser-origin'
    ) => Promise<Response>
    restartPackageService: () => Promise<void>
    respondAsDesktop: (
      request: PackageOperationRequest
    ) => ReturnType<SessionPackageDesktop['respond']>
  }) => Promise<void>,
  options: {
    afterAdmission?: () => Promise<void>
    afterDecision?: () => Promise<void>
    captureLogs?: boolean
    sensitive?: boolean
    advertisePackageOperations?: boolean
    seedSource?: boolean
    executionIntents?: NotebookExecutionIntentOwner
  } = {}
): Promise<void> {
  const fixture = await createProvenanceTestFixture()
  const root = fixture.storageRoot
  if (options.captureLogs) initLogger({ logDir: join(root, 'logs'), mirrorToConsole: false })
  const events = new ApplicationEventHub()
  initDataRoot(root)
  const sessions = new SessionRepository(root)
  const provenance = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId)
  })
  const service = new SessionPackageService({
    storageRoot: root,
    getClient: async () => fixture.client,
    assertForkExecutionAllowed: (request) =>
      options.executionIntents?.current(request)?.assertExecutable()
  })
  const createOwner = (): SessionPackageDesktop =>
    new SessionPackageDesktop({
      service,
      translate: englishNativeTranslator,
      withDataRootWrite: (work) => work(),
      afterImport: async () => undefined
    })
  let owner = createOwner()
  const router = createApplicationCommandRouter()
  const command = dataContentApplicationCommands.sessionPackageOperation
  const installation = registerDataContentApplicationCommands(router.registrar, {
    electron: {
      sessionPackageOperation: ({ args }: { args: readonly [PackageOperationRequest] }) =>
        owner.respond(args[0])
    }
  } as never)
  const localWeb: ApplicationCommandByNameDispatcher = {
    commandNames: () => (options.advertisePackageOperations === false ? [] : [command.name]),
    invoke: async (name, invocation) => {
      if (name !== command.name) throw new Error(`Unexpected package RPC: ${name}`)
      const response = await router.dispatcher.invoke(command, {
        ...invocation,
        args: invocation.args as [PackageOperationRequest]
      })
      const { action } = invocation.args[0] as PackageOperationRequest
      if (action.startsWith('agent-')) await options.afterAdmission?.()
      if (action === 'respond-export-review') await options.afterDecision?.()
      return response
    }
  }
  const sdk = new Client({ name: 'package-test', version: '1' })
  let server: Awaited<ReturnType<typeof startWebHttpServer>> | undefined
  try {
    if (options.seedSource !== false)
      await fixture.client.project.create({ data: { id: source.projectId, name: 'Research' } })
    if (options.seedSource !== false)
      await sessions.saveSession({
        id: source.sessionId,
        projectId: source.projectId,
        title: 'Retained research',
        cwd: '',
        status: 'idle',
        messages: options.sensitive
          ? [
              {
                id: 'synthetic-message',
                role: 'user',
                content: 'Authorization: Bearer synthetic-private-value',
                status: 'complete',
                eventIds: [],
                createdAt: 1,
                updatedAt: 1
              }
            ]
          : [],
        createdAt: 1,
        updatedAt: 2
      })
    const token = 'synthetic-package-fixture-token'
    const serverOptions = {
      host: '127.0.0.1',
      port: 0,
      token,
      staticRoot: root,
      applicationCommands: {
        localWeb,
        remoteWeb: { ...localWeb, rejectedCommandNames: () => [] }
      },
      applicationEvents: events,
      tasks: new HeadlessTaskApi(
        {
          commands: {
            commandNames: () => [
              'projects:list',
              'sessions:load-all',
              'sessions:load-one',
              'artifacts:resolve-version-descriptors'
            ],
            invoke: async (name, { args }) => {
              if (name === 'sessions:load-one') {
                const request = args[0] as LoadSessionRequest
                const projectId =
                  request.projectId ?? (await sessions.locateSession(request.sessionId))?.projectId
                return projectId ? sessions.loadSession(projectId, request.sessionId) : undefined
              }
              if (name === 'sessions:load-all') return sessions.loadAll()
              if (name === 'artifacts:resolve-version-descriptors') {
                return provenance.resolveVersionDescriptors(
                  args[0] as ResolveArtifactVersionDescriptorsRequest
                )
              }
              if (name !== 'projects:list') throw new Error(`Unexpected task command: ${name}`)
              const projects = await fixture.client.project.findMany({
                select: { id: true, name: true }
              })
              return projects.map((project) => ({
                ...project,
                description: '',
                isExample: false,
                createdAt: 1,
                updatedAt: 1
              }))
            }
          },
          agent: {} as never
        },
        { runJournal: new FileTaskRunJournal(root), submissionRoot: root }
      ),
      bootstrap: {
        appName: 'Open-Science',
        appVersion: 'test',
        configRoot: root,
        platform: process.platform,
        versions: { electron: 'test', chrome: 'test', node: process.versions.node }
      }
    } satisfies Parameters<typeof startWebHttpServer>[0]
    const startAndAdvertise = async (): Promise<void> => {
      server = await startWebHttpServer(serverOptions)
      await writeFile(
        join(root, 'web-service.json'),
        JSON.stringify({ pid: process.pid, port: server.port, startedAt: new Date().toISOString() })
      )
    }
    const restartPackageService = async (): Promise<void> => {
      await server?.close()
      await owner.close()
      owner = createOwner()
      await startAndAdvertise()
    }
    await startAndAdvertise()
    await writeFile(join(root, 'web-token'), token)
    await sdk.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', '--profile', root],
        stderr: 'pipe'
      })
    )
    const callCli = (name: string, args: object): CliResult => {
      const result = exec(
        process.execPath,
        [cli, 'tools', 'call', name, '--profile', root, '--json'],
        {
          encoding: 'utf8',
          timeout: 10_000
        }
      )
      result.child.stdin?.end(JSON.stringify(args))
      return result
    }
    const invokePackageRpc = (
      request: PackageOperationRequest,
      auth: 'bearer' | 'cookie' | 'browser-origin' = 'bearer'
    ): Promise<Response> =>
      fetch(`http://127.0.0.1:${server!.port}/rpc/sessions%3Apackage-operation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(auth === 'cookie'
            ? { cookie: `open_science_web_token=${token}` }
            : { authorization: `Bearer ${token}` }),
          ...(auth === 'browser-origin' ? { origin: `http://127.0.0.1:${server!.port}` } : {})
        },
        body: JSON.stringify({ protocolVersion: 1, args: [request] })
      })
    const respondAsDesktop = (
      request: PackageOperationRequest
    ): ReturnType<SessionPackageDesktop['respond']> =>
      owner.respond(request, 'fixture-desktop-client')
    await test({
      root,
      sdk,
      callCli,
      service,
      invokePackageRpc,
      respondAsDesktop,
      restartPackageService
    })
  } finally {
    await sdk.close()
    await server?.close()
    installation.uninstall()
    router.dispose()
    await owner.close()
    await service.close()
    if (options.captureLogs) await flushLogs()
    await resetOwnership()
    initDataRoot(undefined)
    await fixture.dispose()
  }
}

it('asks the user to update a service without Agent package support before writing', async () => {
  let attempts = 0
  await withPackageService(
    async ({ root, sdk }) => {
      const destinationPath = join(root, 'unsupported.science')
      const request = await sdk.callTool({
        name: 'export_session',
        arguments: { ...source, destinationPath }
      })
      expect(request.isError).toBe(true)
      expect(content(request).error).toMatchObject({
        code: 'unsupported_capability',
        requiresUser: true,
        next: [{ action: 'update_service' }]
      })
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(attempts).toBe(0)
    },
    {
      advertisePackageOperations: false,
      afterAdmission: async () => {
        attempts++
      }
    }
  )
})

it('imports an attached archive into a fresh profile and inspects the read-only Session', async () => {
  const archive = await exportPublishedResearch()
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const sourcePath = join(root, 'attached.science')
      await writeFile(sourcePath, archive)
      const imported = await sdk.callTool({
        name: 'import_session',
        arguments: { sourcePath, newProjectName: 'From package' }
      })
      expect(imported.isError, JSON.stringify(content(imported))).not.toBe(true)
      const result = content(imported).result as {
        session: { projectId: string; sessionId: string }
        operationId: string
        correlationId: string
      }
      expect(result).toMatchObject({
        kind: 'import',
        sourcePath,
        newProjectName: 'From package',
        operationId: expect.any(String),
        correlationId: expect.any(String),
        completionStatus: 'completed',
        waitMs: 30_000,
        session: { projectId: expect.any(String), sessionId: expect.any(String), readOnly: true },
        packageSummary: { title: 'Published research', fileCount: expect.any(Number) }
      })
      expect(result.session.sessionId).not.toBe(source.sessionId)
      const scope = { projectId: result.session.projectId, sessionId: result.session.sessionId }
      expect(JSON.parse((await callCli('get_session', scope)).stdout)).toMatchObject({
        result: {
          id: scope.sessionId,
          projectId: scope.projectId,
          title: 'Published research',
          status: 'idle',
          artifactCount: 1,
          output: 'The mean is 14.',
          readOnly: true,
          packageOrigin: { sourceProjectId: source.projectId, sourceSessionId: source.sessionId }
        }
      })
      const listed = await sdk.callTool({ name: 'list_sessions', arguments: {} })
      expect(content(listed).result).toHaveLength(1)
      const artifacts = await sdk.callTool({
        name: 'list_artifacts',
        arguments: { sessionId: scope.sessionId }
      })
      expect(content(artifacts).result).toEqual([
        expect.objectContaining({
          name: 'report.md',
          downloadId: expect.any(String),
          bytes: Buffer.byteLength(report)
        })
      ])
      const lookup = JSON.parse(
        (
          await callCli('get_package_operation', {
            kind: 'import',
            sourcePath,
            correlationId: result.correlationId,
            newProjectName: 'From package'
          })
        ).stdout
      )
      expect(lookup.result).toMatchObject({
        operationId: result.operationId,
        completionStatus: 'completed',
        session: { ...scope, readOnly: true },
        packageSummary: { title: 'Published research' }
      })
      const requestId = 'read-only-import'
      expect(
        content(
          await sdk.callTool({
            name: 'start_run',
            arguments: { ...scope, requestId, prompt: 'Continue this history' }
          })
        ).result
      ).toMatchObject({ requestId })
      expect(
        content(
          await sdk.callTool({
            name: 'wait_submission',
            arguments: { requestId }
          })
        ).result
      ).toMatchObject({
        receipt: { requestId, status: 'failed', error: { code: 'session_read_only' } }
      })
      const write = await sdk.callTool({
        name: 'update_session_configuration',
        arguments: { ...scope, expectedRevision: 0, memoryEnabled: false }
      })
      expect(write.isError).toBe(true)
      expect(content(write).error).toMatchObject({ code: 'session_read_only', retryable: false })
    },
    { seedSource: false }
  )
})

it('forks inspected research and recovers the writable copy when the CLI loses its response', async () => {
  const releaseResponse = Promise.withResolvers<void>()
  let holdResponse = false
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const sourcePath = join(root, 'attached.science')
      await copyFile(artifactPackage, sourcePath)
      const imported = content(
        await sdk.callTool({ name: 'import_session', arguments: { sourcePath } })
      ).result as { session: { projectId: string; sessionId: string } }
      const { projectId, sessionId } = imported.session
      expect(
        content(await sdk.callTool({ name: 'get_session', arguments: { projectId, sessionId } }))
          .result
      ).toMatchObject({ readOnly: true, title: 'Artifact research' })
      expect(
        content(await sdk.callTool({ name: 'list_sessions', arguments: {} })).result
      ).toHaveLength(1)

      // The Agent calls this separately after the user agrees to Fork.
      const fork = await sdk.callTool({ name: 'fork_session', arguments: { projectId, sessionId } })
      expect(fork.isError, JSON.stringify(content(fork))).not.toBe(true)
      const result = content(fork).result as {
        operationId: string
        session: { projectId: string; sessionId: string; readOnly: boolean }
      }
      expect(result).toMatchObject({
        projectId,
        sessionId,
        kind: 'fork',
        operationId: expect.any(String),
        completionStatus: 'completed',
        waitMs: 30_000,
        session: { projectId, sessionId: expect.any(String), readOnly: false }
      })
      expect(result.session.sessionId).not.toBe(sessionId)
      expect(
        JSON.parse(
          (
            await callCli('get_package_operation', {
              kind: 'fork',
              operationId: result.operationId,
              projectId,
              sessionId
            })
          ).stdout
        ).result
      ).toMatchObject({ completionStatus: 'completed', session: result.session })
      const copy = await sdk.callTool({
        name: 'get_session',
        arguments: {
          projectId,
          sessionId: result.session.sessionId
        }
      })
      expect(content(copy).result).toMatchObject({
        readOnly: false,
        status: 'idle',
        forkOrigin: { sourceProjectId: 'project-1', sourceSessionId: 'session-1' }
      })
      expect(
        content(await sdk.callTool({ name: 'get_session', arguments: { projectId, sessionId } }))
          .result
      ).toMatchObject({ readOnly: true })
      try {
        holdResponse = true
        const { stdout } = await exec(
          process.execPath,
          [
            cli,
            'session',
            'fork',
            sessionId,
            '--project',
            projectId,
            '--timeout-ms',
            '150',
            '--profile',
            root,
            '--json'
          ],
          { encoding: 'utf8', timeout: 10_000 }
        )
        const lost = JSON.parse(stdout).result
        expect(lost).toMatchObject({
          kind: 'fork',
          projectId,
          sessionId,
          correlationId: expect.any(String),
          completionStatus: 'unconfirmed',
          retryable: false,
          waitMs: 150
        })
        await expect
          .poll(
            async () =>
              content(
                await sdk.callTool({
                  name: 'get_package_operation',
                  arguments: {
                    correlationId: lost.correlationId,
                    projectId,
                    sessionId,
                    kind: 'fork'
                  }
                })
              ).result,
            { timeout: 5000 }
          )
          .toMatchObject({
            completionStatus: 'completed',
            session: { projectId, readOnly: false }
          })
        expect(
          content(
            await sdk.callTool({
              name: 'get_package_operation',
              arguments: {
                operationId: result.operationId,
                projectId,
                sessionId,
                kind: 'fork'
              }
            })
          ).result
        ).toMatchObject({ completionStatus: 'unconfirmed', retryable: false })
        expect(
          content(await sdk.callTool({ name: 'list_sessions', arguments: {} })).result
        ).toHaveLength(3)
      } finally {
        releaseResponse.resolve()
      }
    },
    {
      seedSource: false,
      afterAdmission: async () => {
        if (holdResponse) await releaseResponse.promise
      }
    }
  )
})

it('keeps a stopped Notebook attached to the source and refuses to Fork around it', async () => {
  const executionIntents = new NotebookExecutionIntentOwner()
  executionIntents.create(source).block('test-refusal')
  await withPackageService(
    async ({ sdk, callCli }) => {
      const fork = await sdk.callTool({ name: 'fork_session', arguments: source })
      const failure = {
        ...source,
        kind: 'fork',
        code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION',
        completionStatus: 'failed',
        retryable: false,
        requiresUser: true,
        owner: 'user',
        next: [{ action: 'continue_notebook_in_app', ...source }]
      }
      expect(fork.isError).toBe(true)
      expect(content(fork).error).toMatchObject(failure)
      const rejected = await callCli('fork_session', source).catch((error) => error)
      expect(JSON.parse(rejected.stderr).error).toMatchObject(failure)
      expect(
        content(await sdk.callTool({ name: 'list_sessions', arguments: {} })).result
      ).toHaveLength(1)
    },
    { executionIntents }
  )
})

it('recovers the original import after a lost admission response and does not confuse a later import', async () => {
  const releaseResponse = Promise.withResolvers<void>()
  let holdResponse = true
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const sourcePath = join(root, 'restore.science')
      await copyFile(artifactPackage, sourcePath)
      const placement = { sourcePath, newProjectName: 'Restored' }
      try {
        const call = await sdk.callTool({
          name: 'import_session',
          arguments: { ...placement, waitMs: 150 }
        })
        expect(call.isError).not.toBe(true)
        const first = content(call).result as { correlationId: string }
        expect(first).toMatchObject({
          ...placement,
          completionStatus: 'unconfirmed',
          retryable: false
        })
        const query = { ...placement, kind: 'import', correlationId: first.correlationId }
        await expect
          .poll(
            async () =>
              content(
                await sdk.callTool({
                  name: 'get_package_operation',
                  arguments: query
                })
              ).result,
            { timeout: 5000 }
          )
          .toMatchObject({
            completionStatus: 'completed',
            session: { readOnly: true }
          })
        const listed = await sdk.callTool({ name: 'list_sessions', arguments: {} })
        expect(content(listed).result).toHaveLength(1)
        holdResponse = false
        const second = JSON.parse((await callCli('import_session', placement)).stdout)
        expect(second.result).toMatchObject({
          ...placement,
          completionStatus: 'completed',
          waitMs: 30_000,
          session: { readOnly: true }
        })
        expect(second.result.correlationId).not.toBe(first.correlationId)
        const stale = await sdk.callTool({ name: 'get_package_operation', arguments: query })
        expect(content(stale).result).toMatchObject({
          completionStatus: 'unconfirmed',
          retryable: false
        })
        const alias = await exec(
          process.execPath,
          [
            cli,
            'session',
            'import',
            sourcePath,
            '--non-interactive',
            '--project',
            second.result.session.projectId,
            '--timeout-ms',
            '3000',
            '--profile',
            root,
            '--json'
          ],
          { encoding: 'utf8', cwd: root, timeout: 10_000 }
        )
        expect(JSON.parse(alias.stdout).result).toMatchObject({
          sourcePath,
          completionStatus: 'completed',
          waitMs: 3000,
          targetProjectId: second.result.session.projectId,
          session: { projectId: second.result.session.projectId, readOnly: true }
        })
      } finally {
        releaseResponse.resolve()
      }
    },
    {
      seedSource: false,
      afterAdmission: async () => {
        if (holdResponse) await releaseResponse.promise
      }
    }
  )
})

it('reports invalid and missing input without creating a Session through either entry point', async () => {
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const invalid = join(root, 'corrupt.science')
      await writeFile(invalid, 'Not an Open-Science Session package')
      const staging = join(root, 'archive-staging')
      await mkdir(staging)
      await extractTar({ cwd: staging, file: artifactPackage })
      const manifestPath = join(staging, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const entries = ['manifest.json', 'session.json', 'records.json', 'README.md', 'objects']
      const tampered = join(root, 'checksum-mismatch.science')
      const readme = join(staging, 'README.md')
      const bytes = await readFile(readme)
      bytes[0] ^= 1
      await writeFile(readme, bytes)
      await createTar({ cwd: staging, file: tampered, gzip: true }, entries)
      const future = join(root, 'newer.science')
      await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }))
      await createTar({ cwd: staging, file: future, gzip: true }, ['manifest.json'])
      for (const [sourcePath, code] of [
        [invalid, 'package_invalid_archive'],
        [tampered, 'package_invalid_archive'],
        [join(root, 'missing.science'), 'package_source_unavailable'],
        [future, 'package_requires_update']
      ]) {
        const call = await sdk.callTool({ name: 'import_session', arguments: { sourcePath } })
        expect(call.isError).toBe(true)
        expect(content(call).error).toMatchObject({
          sourcePath,
          code,
          operationId: expect.any(String),
          completionStatus: 'failed',
          retryable: false
        })
        const failed = await callCli('import_session', { sourcePath }).catch((error) => error)
        expect(JSON.parse(failed.stderr).error).toMatchObject({
          sourcePath,
          code,
          operationId: expect.any(String),
          completionStatus: 'failed',
          retryable: false
        })
      }
      expect(content(await sdk.callTool({ name: 'list_sessions', arguments: {} })).result).toEqual(
        []
      )
      expect(content(await sdk.callTool({ name: 'list_projects' })).result).toEqual([])
    },
    { seedSource: false }
  )
})

it('exports verified archives through real CLI JSON and MCP stdio with exact operation lookup', async () => {
  await withPackageService(async ({ root, sdk, callCli, service }) => {
    const catalog = await sdk.callTool({
      name: 'list_capabilities',
      arguments: { group: 'delivery', checkService: true }
    })
    expect(content(catalog).result).toMatchObject({
      groups: {
        delivery: expect.arrayContaining([
          expect.objectContaining({ name: 'export_session', serviceSupport: 'supported' }),
          expect.objectContaining({ name: 'get_package_operation', serviceSupport: 'supported' })
        ])
      }
    })
    const check = async (
      output: { result?: unknown },
      destinationPath: string
    ): Promise<string> => {
      const bytes = await readFile(destinationPath)
      expect(output).toMatchObject({
        result: {
          ...source,
          destinationPath,
          kind: 'export',
          operationId: expect.any(String),
          completionStatus: 'completed',
          waitMs: 30_000,
          delivery: {
            status: 'verified',
            file: {
              path: destinationPath,
              sizeBytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            }
          }
        }
      })
      await expect(service.inspect(destinationPath)).resolves.toMatchObject({
        title: 'Retained research',
        projectName: 'Research'
      })
      return (output.result as { operationId: string }).operationId
    }

    const cliDestination = join(root, 'cli.science')
    const cliResult = JSON.parse(
      (await callCli('export_session', { ...source, destinationPath: cliDestination })).stdout
    )
    const cliId = await check(cliResult, cliDestination)
    const cliLookup = await sdk.callTool({
      name: 'get_package_operation',
      arguments: { operationId: cliId, ...source, destinationPath: cliDestination }
    })
    expect(cliLookup.isError).not.toBe(true)
    expect(content(cliLookup).result).toMatchObject({
      operationId: cliId,
      completionStatus: 'completed',
      delivery: cliResult.result.delivery
    })

    const mcpDestination = join(root, 'mcp.science')
    const call = await sdk.callTool({
      name: 'export_session',
      arguments: { ...source, destinationPath: mcpDestination }
    })
    expect(call.isError).not.toBe(true)
    const mcpId = await check(content(call), mcpDestination)
    expect(mcpId).not.toBe(cliId)
    const wrongSource = await sdk.callTool({
      name: 'get_package_operation',
      arguments: { operationId: mcpId, projectId: 'different-project' }
    })
    expect(content(wrongSource).result).toMatchObject({
      operationId: mcpId,
      completionStatus: 'unconfirmed',
      retryable: false
    })
    const replaced = Buffer.from(await readFile(mcpDestination))
    replaced[0] ^= 1
    await writeFile(mcpDestination, replaced)
    const unverified = await sdk.callTool({
      name: 'get_package_operation',
      arguments: { operationId: mcpId }
    })
    expect(content(unverified).result).toMatchObject({
      operationId: mcpId,
      completionStatus: 'unconfirmed',
      delivery: { status: 'unconfirmed' }
    })
    expect(
      JSON.parse(
        (
          await callCli('get_package_operation', {
            operationId: cliId,
            ...source,
            destinationPath: cliDestination
          })
        ).stdout
      )
    ).toMatchObject({
      result: { operationId: cliId, completionStatus: 'unconfirmed', retryable: false }
    })
  })
})

it('recovers a published package after dropping the admission response without repeating the export', async () => {
  const releaseResponse = Promise.withResolvers<void>()
  let attempts = 0
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const destinationPath = join(root, 'recover.science')
      try {
        const exportCall = await sdk.callTool({
          name: 'export_session',
          arguments: { ...source, destinationPath, waitMs: 100 }
        })
        expect(attempts).toBe(1)
        expect(content(exportCall).result).toMatchObject({
          ...source,
          destinationPath,
          correlationId: expect.any(String),
          completionStatus: 'unconfirmed',
          retryable: false,
          waitMs: 100
        })
        const { correlationId } = content(exportCall).result as { correlationId: string }
        await expect
          .poll(
            async () =>
              JSON.parse(
                (await callCli('get_package_operation', { ...source, correlationId })).stdout
              ).result,
            { timeout: 5000 }
          )
          .toMatchObject({
            correlationId,
            operationId: expect.any(String),
            completionStatus: 'completed',
            delivery: { status: 'verified', file: { path: destinationPath } }
          })
        expect(attempts).toBe(1)
      } finally {
        releaseResponse.resolve()
      }
    },
    {
      afterAdmission: () => {
        attempts++
        return releaseResponse.promise
      }
    }
  )
})

it('refuses existing files, directories and symbolic links without altering the destination', async () => {
  await withPackageService(async ({ root, sdk }) => {
    const file = join(root, 'file.science')
    const directory = join(root, 'directory.science')
    const link = join(root, 'link.science')
    await writeFile(file, 'existing contents')
    await mkdir(directory)
    await symlink(directory, link, 'junction')
    for (const destinationPath of [file, directory, link]) {
      const call = await sdk.callTool({
        name: 'export_session',
        arguments: { ...source, destinationPath }
      })
      expect(call.isError).toBe(true)
      expect(content(call).error).toMatchObject({
        code: 'package_destination_conflict',
        completionStatus: 'failed',
        requiresUser: false,
        retryable: false
      })
    }
    expect(await readFile(file, 'utf8')).toBe('existing contents')
    expect((await lstat(directory)).isDirectory()).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })
})

it('relays a specific user export approval between CLI JSON and MCP stdio', async () => {
  await withPackageService(
    async ({ root, sdk, callCli, invokePackageRpc }) => {
      const destinationPath = join(root, 'user-reviewed.science')
      const attempt = await sdk.callTool({
        name: 'export_session',
        arguments: { ...source, destinationPath }
      })
      expect(attempt.isError).toBe(true)
      const { operationId } = content(attempt).error as { operationId: string }
      const observed = JSON.parse((await callCli('get_package_operation', { operationId })).stdout)
      expect(observed.result).toMatchObject({
        ...source,
        operationId,
        completionStatus: 'pending',
        sensitiveExportReview: {
          destinationPath,
          expiresAt: expect.any(Number),
          fileDigest: {
            sizeBytes: expect.any(Number),
            checksum: expect.stringMatching(/^[a-f0-9]{64}$/)
          },
          fileScope: { fileCount: 0, includesSessionHistory: true },
          findings: [{ source: 'session_metadata', rule: expect.any(String) }],
          actions: ['approved', 'rejected'],
          responseCapability: 'respond_export_review'
        }
      })
      expect(content(attempt).error).toMatchObject({
        sensitiveExportReview: observed.result.sensitiveExportReview
      })
      expect(JSON.stringify([attempt, observed])).not.toContain('synthetic-private-value')
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })

      const decision = approvalFor(observed.result)
      const rpc = { ...decision, action: 'respond-export-review' } as const
      for (const auth of ['cookie', 'browser-origin'] as const) {
        expect((await invokePackageRpc(rpc, auth)).ok).toBe(false)
      }
      for (const change of [
        { operationId: '00000000-0000-4000-8000-000000000001' },
        { destinationPath: join(root, 'other.science') },
        { sha256: 'a'.repeat(64) },
        { sizeBytes: decision.sizeBytes + 1 },
        { expiresAt: decision.expiresAt + 1 }
      ]) {
        const refused = await sdk.callTool({
          name: 'respond_export_review',
          arguments: { ...decision, ...change }
        })
        expect(content(refused).error).toMatchObject({ code: 'package_export_review_unavailable' })
      }
      for (const change of [{ source: 'delegated_agent' }, { force: true }]) {
        const refused = await sdk.callTool({
          name: 'respond_export_review',
          arguments: { ...decision, ...change }
        })
        expect(content(refused).error).toMatchObject({ code: 'invalid_request' })
      }
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const approved = JSON.parse((await callCli('respond_export_review', decision)).stdout)
      expect(approved.result).toMatchObject({
        operationId,
        sensitiveExportDecision: { source: 'user_relay', decision: 'approved' }
      })
      const query = async (): Promise<unknown> =>
        content(await sdk.callTool({ name: 'get_package_operation', arguments: { operationId } }))
          .result
      await expect.poll(query).toMatchObject({
        operationId,
        completionStatus: 'completed',
        delivery: {
          status: 'verified',
          file: { path: destinationPath, sizeBytes: decision.sizeBytes, sha256: decision.sha256 }
        },
        sensitiveExportDecision: { source: 'user_relay', decision: 'approved' }
      })
      const original = await readFile(destinationPath)
      expect(createHash('sha256').update(original).digest('hex')).toBe(decision.sha256)
      const duplicate = await sdk.callTool({ name: 'respond_export_review', arguments: decision })
      expect(content(duplicate).result).toEqual(await query())
      const conflict = await sdk.callTool({
        name: 'respond_export_review',
        arguments: { ...decision, decision: 'rejected' }
      })
      expect(content(conflict).error).toMatchObject({
        operationId,
        code: 'package_export_review_conflict'
      })
      await unlink(destinationPath)
      const afterRemoval = await sdk.callTool({
        name: 'respond_export_review',
        arguments: decision
      })
      expect(content(afterRemoval).result).toMatchObject({
        operationId,
        completionStatus: 'unconfirmed',
        sensitiveExportDecision: { source: 'user_relay', decision: 'approved' }
      })
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await flushLogs()
      const logs = await readFile(getLogFilePath()!, 'utf8')
      expect(logs).toContain('session-package.export')
      expect(logs).not.toContain('synthetic-private-value')
    },
    { sensitive: true, captureLogs: true }
  )
})

it('recovers the original result after the relayed decision response is lost', async () => {
  const decided = Promise.withResolvers<void>()
  const unblock = Promise.withResolvers<void>()
  await withPackageService(
    async ({ root, sdk, callCli }) => {
      const destinationPath = join(root, 'decision-response-lost.science')
      const attempt = await sdk.callTool({
        name: 'export_session',
        arguments: { ...source, destinationPath }
      })
      const decision = approvalFor(content(attempt).error)
      const controller = new AbortController()
      const reply = sdk.callTool(
        { name: 'respond_export_review', arguments: decision },
        undefined,
        { signal: controller.signal }
      )
      try {
        await Promise.race([
          decided.promise,
          reply.then(() => {
            throw new Error('Decision reply was not held.')
          })
        ])
        controller.abort(new Error('Test client stopped observing the decision'))
        await expect(reply).rejects.toThrow()
        await expect
          .poll(
            async () =>
              JSON.parse(
                (await callCli('get_package_operation', { operationId: decision.operationId }))
                  .stdout
              ).result
          )
          .toMatchObject({
            operationId: decision.operationId,
            completionStatus: 'completed',
            sensitiveExportDecision: { source: 'user_relay', decision: 'approved' },
            delivery: {
              status: 'verified',
              file: { path: destinationPath, sha256: decision.sha256 }
            }
          })
      } finally {
        unblock.resolve()
      }
    },
    {
      sensitive: true,
      afterDecision: () => {
        decided.resolve()
        return unblock.promise
      }
    }
  )
})

it.each(['rejected', 'expired', 'changed', 'restarted'] as const)(
  'does not publish a %s candidate in the external review flow',
  async (scenario) => {
    const expire = new AbortController()
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const clock = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === 10 * 60_000 ? expire.signal : realTimeout(milliseconds)
      )
    try {
      await withPackageService(
        async ({ root, sdk, service, restartPackageService }) => {
          let stagedPath: string | undefined
          const exportTo = service.exportTo.bind(service)
          vi.spyOn(service, 'exportTo').mockImplementation((request, path, options) => {
            stagedPath = path
            return exportTo(request, path, options)
          })
          const destinationPath = join(root, 'unpublished-candidate.science')
          const attempt = await sdk.callTool({
            name: 'export_session',
            arguments: { ...source, destinationPath }
          })
          const approved = approvalFor(content(attempt).error)
          const originalStage = stagedPath!
          const decision = {
            ...approved,
            decision: scenario === 'rejected' ? 'rejected' : 'approved'
          }
          if (scenario === 'changed') {
            const bytes = await readFile(stagedPath!)
            bytes[bytes.length - 1] ^= 1
            await writeFile(stagedPath!, bytes)
          }
          if (scenario === 'expired') expire.abort(new Error('Test review expired'))
          if (scenario === 'restarted') {
            await restartPackageService()
            const replacement = await sdk.callTool({
              name: 'export_session',
              arguments: { ...source, destinationPath: join(root, 'other-candidate.science') }
            })
            expect(content(replacement).error).toMatchObject({ code: 'package_sensitive_content' })
          }
          const response = await sdk.callTool({
            name: 'respond_export_review',
            arguments: decision
          })
          if (scenario === 'expired' || scenario === 'restarted') {
            expect(content(response).error).toMatchObject({
              code: 'package_export_review_unavailable'
            })
          } else {
            expect(content(response).result).toMatchObject({
              sensitiveExportDecision: { source: 'user_relay', decision: decision.decision }
            })
          }

          const query = async (): Promise<unknown> =>
            content(
              await sdk.callTool({
                name: 'get_package_operation',
                arguments: { operationId: approved.operationId }
              })
            ).result
          await expect.poll(query).toMatchObject({
            operationId: approved.operationId,
            completionStatus:
              scenario === 'changed'
                ? 'failed'
                : scenario === 'restarted'
                  ? 'unconfirmed'
                  : 'cancelled',
            ...(scenario === 'expired' ? { code: 'package_export_review_expired' } : {}),
            ...(scenario === 'changed' ? { code: 'package_sensitive_export_changed' } : {})
          })
          await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(lstat(originalStage)).rejects.toMatchObject({ code: 'ENOENT' })
          if (scenario === 'rejected') {
            const duplicate = await sdk.callTool({
              name: 'respond_export_review',
              arguments: decision
            })
            expect(content(duplicate).result).toEqual(await query())
          }
        },
        { sensitive: true }
      )
    } finally {
      clock.mockRestore()
    }
  }
)

it('publishes the reviewed archive only after native confirmation and retains the original operation', async () => {
  await withPackageService(
    async ({ root, sdk, callCli, invokePackageRpc, respondAsDesktop }) => {
      const destinationPath = join(root, 'blocked.science')
      const request = { ...source, destinationPath }
      const attempt = await sdk.callTool({
        name: 'export_session',
        arguments: request
      })
      expect(attempt.isError).toBe(true)
      expect(content(attempt).error).toMatchObject({
        ...request,
        operationId: expect.any(String),
        code: 'package_sensitive_content',
        requiresUser: true,
        owner: 'user',
        retryable: false
      })
      const { operationId } = content(attempt).error as { operationId: string }
      expect(JSON.stringify(attempt)).not.toContain('synthetic-private-value')
      const observed = JSON.parse((await callCli('get_package_operation', { operationId })).stdout)
      expect(observed.result).toMatchObject({
        operationId,
        completionStatus: 'pending',
        code: 'package_sensitive_content',
        requiresUser: true
      })
      expect(
        content(
          await sdk.callTool({ name: 'export_session', arguments: { ...request, force: true } })
        ).error
      ).toMatchObject({ code: 'invalid_request' })
      const forged = await invokePackageRpc({
        action: 'export-with-sensitive-content',
        operationId
      })
      expect(forged.ok).toBe(false)
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })

      confirmNative.mockClear()
      expect(() =>
        respondAsDesktop({ action: 'export-with-sensitive-content', operationId: 'stale' })
      ).toThrow()
      expect(confirmNative).not.toHaveBeenCalled()
      const nativeReply = Promise.withResolvers<{ response: number }>()
      confirmNative.mockReturnValueOnce(nativeReply.promise)
      const confirmation = respondAsDesktop({
        action: 'export-with-sensitive-content',
        operationId
      })
      expect(confirmNative).toHaveBeenCalledWith(
        expect.objectContaining({
          cancelId: 0,
          defaultId: 0,
          detail: expect.stringContaining(destinationPath)
        }),
        'fixture-desktop-client',
        expect.any(AbortSignal)
      )
      await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const nativeDetail = confirmNative.mock.calls[0]![0].detail as string
      const responseDuringDialog = await sdk.callTool({
        name: 'respond_export_review',
        arguments: approvalFor(observed.result)
      })
      expect(content(responseDuringDialog).error).toMatchObject({
        code: 'package_export_review_conflict'
      })
      nativeReply.resolve({ response: 1 })
      await confirmation
      await expect
        .poll(
          async () =>
            content(
              await sdk.callTool({
                name: 'get_package_operation',
                arguments: { operationId }
              })
            ).result
        )
        .toMatchObject({
          operationId,
          completionStatus: 'completed',
          delivery: { status: 'verified', file: { path: destinationPath } },
          sensitiveExportDecision: { source: 'desktop', decision: 'approved' }
        })
      expect(nativeDetail).toContain(
        createHash('sha256')
          .update(await readFile(destinationPath))
          .digest('hex')
      )

      const aliasPath = join(root, 'alias-blocked.science')
      const alias = exec(
        process.execPath,
        [
          cli,
          'session',
          'export',
          source.sessionId,
          '--project',
          source.projectId,
          '--output',
          aliasPath,
          '--profile',
          root,
          '--json'
        ],
        { encoding: 'utf8', timeout: 10_000 }
      )
      const rejected = await alias.catch((error) => error)
      expect(JSON.parse(rejected.stderr)).toMatchObject({
        error: {
          code: 'package_sensitive_content',
          requiresUser: true,
          destinationPath: aliasPath,
          operationId: expect.any(String)
        }
      })
      await expect(lstat(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const rejectedId = JSON.parse(rejected.stderr).error.operationId
      confirmNative.mockResolvedValueOnce({ response: 0 })
      await respondAsDesktop({ action: 'export-with-sensitive-content', operationId: rejectedId })
      await expect
        .poll(
          async () =>
            content(
              await sdk.callTool({
                name: 'get_package_operation',
                arguments: { operationId: rejectedId }
              })
            ).result
        )
        .toMatchObject({ operationId: rejectedId, completionStatus: 'cancelled' })
      await expect(lstat(aliasPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    { sensitive: true }
  )
})

it.each(['changed', 'expired'] as const)(
  'does not publish a %s sensitive candidate after the native dialog was opened',
  async (scenario) => {
    const expire = new AbortController()
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const clock = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) =>
        milliseconds === 10 * 60_000 ? expire.signal : realTimeout(milliseconds)
      )
    try {
      await withPackageService(
        async ({ root, sdk, service, respondAsDesktop }) => {
          let stagedPath: string | undefined
          const exportTo = service.exportTo.bind(service)
          vi.spyOn(service, 'exportTo').mockImplementation((request, path, options) => {
            stagedPath = path
            return exportTo(request, path, options)
          })
          const destinationPath = join(root, 'review.science')
          const attempt = await sdk.callTool({
            name: 'export_session',
            arguments: { ...source, destinationPath }
          })
          expect(content(attempt).error).toMatchObject({ code: 'package_sensitive_content' })
          const { operationId } = content(attempt).error as { operationId: string }
          const nativeReply = Promise.withResolvers<{ response: number }>()
          confirmNative.mockReturnValueOnce(nativeReply.promise)
          const confirmation = respondAsDesktop({
            action: 'export-with-sensitive-content',
            operationId
          })
          if (scenario === 'changed') {
            const bytes = await readFile(stagedPath!)
            bytes[bytes.length - 1] ^= 1
            await writeFile(stagedPath!, bytes)
            nativeReply.resolve({ response: 1 })
            await confirmation
          } else {
            expire.abort(new Error('Test review expired'))
            nativeReply.resolve({ response: 1 })
            await expect(confirmation).rejects.toThrow('Test review expired')
          }
          await expect
            .poll(
              async () =>
                content(
                  await sdk.callTool({
                    name: 'get_package_operation',
                    arguments: { operationId }
                  })
                ).result
            )
            .toMatchObject({
              operationId,
              ...(scenario === 'changed'
                ? {
                    completionStatus: 'failed',
                    code: 'package_sensitive_export_changed',
                    retryable: false
                  }
                : { completionStatus: 'cancelled' })
            })
          await expect(lstat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(lstat(stagedPath!)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(() =>
            respondAsDesktop({ action: 'export-with-sensitive-content', operationId })
          ).toThrow()
        },
        { sensitive: true }
      )
    } finally {
      clock.mockRestore()
    }
  }
)

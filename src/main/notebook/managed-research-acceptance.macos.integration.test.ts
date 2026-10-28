// @ts-expect-error The published ESM entry uses a sibling index.d.ts.
import { OpenScienceClient } from '../../../packages/open-science/index.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ResearchExecutionProfileStore } from '../research-execution-profiles/store'
import { ManagedRuntimeViews } from '../managed-runtime-views'
import { runtimeViewLaunchSchema, type RuntimeViewLaunch } from '../../shared/runtime-view'
import {
  researchEnvironmentVariableSchema,
  researchNetworkHostSchema
} from '../../shared/research-execution-profile'
import {
  ephemeralAcceptanceCipher,
  readAcceptanceBudgetSeal,
  readAcceptanceCredentials,
  recordAcceptanceAdmissionFailure,
  type AcceptanceAdmissionFailure,
  recordAcceptanceTrialUsage,
  reserveAcceptanceTrial
} from './research-acceptance.test-support'
import {
  readAcceptanceResume,
  copyAcceptanceResume,
  verifyAcceptanceMaterialFiles,
  verifyAcceptanceResumeReservations,
  type ValidatedAcceptanceResume
} from './research-acceptance-resume.test-support'
import { ApplicationEventHub } from '../application-events'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { createManagedExecutionExternalPort } from '../managed-execution-external-port'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { SessionPackageHeadless } from '../session-package/headless'
import { SessionPackageService } from '../session-package/service'
import { UploadRepository } from '../uploads/repository'
import { startWebHttpServer } from '../web-service/http-server'
import { HeadlessTaskApi } from '../web-service/task-api'
import { createManagedExecutionTurnPort } from './managed-execution-port'
import { ManagedExecutionService } from './managed-execution-service'
import type { ManagedExecutionProvenance } from './managed-execution-output'
import { ManagedResearchEnvironmentOwner } from './managed-research-environment'
import { createManagedResearchNodeRuntimeRegistry } from './managed-research-node-runtime'
import {
  createResearchMaterialAuthority,
  resolvePreparedResearchMaterialInput
} from './research-material-authority'
import { inspectResearchMaterials, type ResearchMaterialInspection } from './research-materials'
import {
  createSessionOperationTestHarness,
  operationTestScope,
  type SessionOperationTestHarness
} from './session-operation.test-support'
import type { SessionPackageRequest } from '../../shared/session-package'
import type { ExecuteManagedEnvironmentRequest } from '../../shared/managed-execution'
import { parseResearchReproductionDescription } from '../../shared/research-reproduction'
import { parseResearchDemoDescription } from '../../shared/research-demo'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { fetch: globalThis.fetch },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

// These explicit opt-ins select reviewed local materials and a NEW directory for retained evidence.
// No project-specific API, command, outcome or material path belongs in this generic harness.
const materialsRoot = process.env.OPEN_SCIENCE_MANAGED_RESEARCH_MATERIALS
const evidenceRoot = process.env.OPEN_SCIENCE_MANAGED_RESEARCH_OUTPUT
const resumeRoot = process.env.OPEN_SCIENCE_MANAGED_RESEARCH_RESUME_FROM
const validateResumeOnly = process.env.OPEN_SCIENCE_MANAGED_RESEARCH_RESUME_VALIDATE_ONLY === '1'
const packageOnly = process.env.OPEN_SCIENCE_MANAGED_RESEARCH_PACKAGE_ONLY === '1'
const cleanups: Array<() => Promise<unknown>> = []
async function disposeCleanups(from = 0): Promise<void> {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(from).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Research acceptance cleanup failed.')
}
afterEach(() => disposeCleanups())
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const scope = { projectId: operationTestScope.projectId, sessionId: operationTestScope.sessionId }
type Acceptance = {
  title: string
  descriptorFilename: string
  planKey: string
  // Older reviewed engineering fixtures predate this optional harness expectation.
  planScope?: 'end-to-end' | 'downstream-only' | 'alternative-conditions' | 'engineering-check'
  command: string
  localServicePort?: number
  projectView?: RuntimeViewLaunch
  timeoutMs: number
  outputs: ExecuteManagedEnvironmentRequest['outputs']
  live?: {
    budgetFilename: string
    providersFilename: string
    usageReceiptFilename: string
    trialEnvironmentVariable: string
    trialIds: Record<'author' | 'external' | 'ordinary' | 'fork', string>
  }
  expect: { jsonAssertions: Array<{ path: string; pointer: string; equals: unknown }> }
}

const packageService = (h: SessionOperationTestHarness): SessionPackageService => {
  const service = new SessionPackageService({
    storageRoot: h.fixture.storageRoot,
    getClient: async () => h.fixture.client
  })
  cleanups.push(() => service.close())
  return service
}

const transfer = (service: SessionPackageService): SessionPackageHeadless => {
  const owner = new SessionPackageHeadless({
    service,
    assertCanStart: () => undefined,
    withDataRootWrite: (operation) => operation(),
    reserveExport: async () => () => undefined,
    reserveImport: async () => () => undefined,
    afterImport: async () => undefined
  })
  cleanups.push(() => owner.close())
  return owner
}

async function client(
  h: SessionOperationTestHarness,
  packages: SessionPackageHeadless,
  service?: ManagedExecutionService
): Promise<import('../../../packages/open-science/index').OpenScienceClient> {
  const forbidModel = vi.fn(async (): Promise<never> => {
    throw new Error('Research execution acceptance must not start another Agent or model.')
  })
  const tasks = new HeadlessTaskApi({
    commands: { commandNames: () => [], invoke: forbidModel },
    agent: {
      withSessionAvailable: async (_project, _session, operation) => operation(),
      listAttachedSessionIds: async () => [],
      createSession: forbidModel,
      resumeSession: forbidModel,
      setPermissionProfile: forbidModel,
      setMemoryEnabled: forbidModel,
      prompt: forbidModel,
      cancelPrompt: forbidModel
    },
    sessionPackages: packages,
    managedExecution: service
      ? createManagedExecutionExternalPort({ service, assertOpen: () => undefined })
      : undefined
  })
  cleanups.push(async () => {
    await tasks.dispose()
    expect(forbidModel).not.toHaveBeenCalled()
  })
  const token = randomUUID()
  const server = await startWebHttpServer({
    host: '127.0.0.1',
    port: 0,
    token,
    staticRoot: h.fixture.storageRoot,
    applicationEvents: new ApplicationEventHub(),
    applicationCommands: {
      localWeb: { commandNames: () => [], invoke: forbidModel },
      remoteWeb: { commandNames: () => [], rejectedCommandNames: () => [], invoke: forbidModel }
    },
    tasks,
    bootstrap: {
      appName: 'Managed research acceptance',
      appVersion: 'test',
      configRoot: h.fixture.storageRoot,
      platform: process.platform,
      versions: { electron: 'test', chrome: 'test', node: process.versions.node }
    }
  })
  cleanups.push(() => server.close())
  return new OpenScienceClient({ baseUrl: `http://127.0.0.1:${server.port}`, token })
}

async function publishMaterials(
  root: string,
  output: string,
  acceptance: Acceptance
): Promise<string> {
  const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
  await h.mutate(scope, (session) => ({ ...session, title: acceptance.title }))
  const index = JSON.parse(await readFile(join(root, 'material-file-index.json'), 'utf8')) as {
    description: string
    descriptionSha256: string
    files: Array<{ key: string; relativePath: string; sha256: string; sizeBytes: number }>
    demo?: { relativePath: string; sha256: string; sizeBytes: number }
  }
  const descriptorBytes = await readFile(join(root, index.description))
  expect(sha(descriptorBytes)).toBe(index.descriptionSha256)
  const parsed = parseResearchReproductionDescription(descriptorBytes.toString('utf8'))
  if (parsed.status !== 'valid')
    throw new Error('Acceptance materials require a valid description.')
  const materials = parsed.description.materials.filter((item) => item.availability === 'included')
  expect(index.files).toHaveLength(materials.length)
  const workspace = (await h.read(scope))!.cwd!
  const inputs = [{ filename: acceptance.descriptorFilename, bytes: descriptorBytes }]
  for (const material of materials) {
    const item = index.files.find((entry) => entry.key === material.key)!
    expect(item).toBeDefined()
    const sourcePath = resolve(root, item.relativePath)
    expect(sourcePath.startsWith(resolve(root) + '/')).toBe(true)
    const bytes = await readFile(sourcePath)
    expect(bytes.length).toBe(item.sizeBytes)
    expect(sha(bytes)).toBe(item.sha256)
    expect(material).toMatchObject({ sha256: item.sha256, sizeBytes: item.sizeBytes })
    inputs.push({ filename: material.filename, bytes })
  }
  // An optional demo is a separate ordinary Artifact: it pins the unchanged descriptor.
  // Keeping it outside descriptor.materials avoids a descriptor/demo checksum cycle.
  if (index.demo) {
    const sourcePath = resolve(root, index.demo.relativePath)
    expect(sourcePath.startsWith(resolve(root) + '/')).toBe(true)
    const bytes = await readFile(sourcePath)
    expect(bytes.length).toBe(index.demo.sizeBytes)
    expect(sha(bytes)).toBe(index.demo.sha256)
    const demo = parseResearchDemoDescription(bytes.toString('utf8'))
    expect(demo.status).toBe('valid')
    if (demo.status !== 'valid') throw new Error('Invalid reviewed demo material.')
    expect(demo.description.descriptorSha256).toBe(index.descriptionSha256)
    inputs.push({ filename: 'research-demo.json', bytes })
  }
  for (const input of inputs) {
    expect(basename(input.filename)).toBe(input.filename)
    await writeFile(join(workspace, input.filename), input.bytes, { flag: 'wx' })
  }
  await h.owner.start({
    ...scope,
    requestId: 'publish-reviewed-materials',
    requestFingerprint: sha(index.descriptionSha256),
    requestText:
      'Publish the selected reviewed research materials. Publication does not execute their research plan.',
    execute: async (context, signal) => {
      // A real copying command records exactly how these selected public input copies were published.
      // It does not fabricate a historical study, Notebook Run or producer assertion.
      const result = await h.notebook.executeShell(
        {
          ...scope,
          workspaceCwd: context.workspaceCwd,
          provenanceContext: context.provenanceContext,
          executionInvocationId: context.operationId,
          command: inputs
            .map(({ filename }) => `/bin/cp ${quote(join(workspace, filename))} ${quote(filename)}`)
            .join(' && ')
        },
        signal
      )
      expect(result.exitCode).toBe(0)
      const run = (
        await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
      ).find((item) => item.submissionIdentity === context.operationId)!
      expect(run.status).toBe('completed')
      await context.recordRun(run.runId)
      for (const { filename } of inputs)
        await context.saveOutput({
          filename,
          producerRunId: run.runId,
          contentType: filename.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          source: { kind: 'localPath', path: filename }
        })
      return { text: 'Fixed materials published; scientific trials performed: zero.' }
    }
  })
  const done = await h.owner.wait({ ...scope, requestId: 'publish-reviewed-materials' })
  expect(done, JSON.stringify(done)).toMatchObject({ status: 'completed' })
  await h.snapshots.captureFinalizedMessages((await h.read(scope))!)
  const api = await client(h, transfer(packageService(h)))
  const path = join(output, 'research.science')
  await api.packages.export({ ...scope, filePath: path })
  return path
}

async function verifyResumedNativeArchives(
  output: string,
  snapshot: ValidatedAcceptanceResume,
  descriptorSha256: string
): Promise<void> {
  const cleanupStart = cleanups.length
  try {
    const h = await createSessionOperationTestHarness(cleanups, { canonicalStorageRoot: true })
    const packages = packageService(h),
      api = await client(h, transfer(packages))
    const versions = new ManagedFileVersionService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    const inputAuthority = new ImmutableInputAuthority({
      storageRoot: h.fixture.storageRoot,
      managedFileVersions: versions
    })
    const catalog = new ManagedFileIndexRepository(
      async () => h.fixture.client,
      h.fixture.storageRoot,
      versions,
      new UploadRepository(h.fixture.storageRoot, { getClient: async () => h.fixture.client })
    )
    for (const entry of [undefined, ...snapshot.report.entries]) {
      const filePath = join(output, entry ? `${entry.entry}-results.science` : 'research.science')
      const preview = await api.packages.preflightImport({
        filePath,
        target: { projectId: scope.projectId }
      })
      const imported = await api.packages.commitImport({ preflightId: preview.preflightId })
      expect(imported.cleanupPending).not.toBe(true)
      const target = { projectId: imported.projectId, sessionId: imported.sessionId }
      const authority = await createResearchMaterialAuthority(
        {
          catalog,
          inputAuthority,
          readSession: (projectId, sessionId) => h.read({ projectId, sessionId }),
          readOrigin: (request) => packages.readOrigin(request)
        },
        {
          projectId: target.projectId,
          targetSessionId: scope.sessionId,
          sourceSessionId: target.sessionId
        }
      )
      const matchingDescriptors = authority.versions.filter(
        (version) =>
          (version.descriptor || version.filename === 'research-reproduction.json') &&
          version.sha256 === descriptorSha256
      )
      expect(matchingDescriptors.length).toBeGreaterThan(0)
      const inspected = await inspectResearchMaterials(authority, {
        descriptorVersionId: matchingDescriptors.sort((a, b) =>
          a.versionId.localeCompare(b.versionId)
        )[0].versionId
      })
      expect(inspected.status).toBe('ready')
      expect(inspected.descriptor?.sha256).toBe(descriptorSha256)
      if (!entry) continue
      const origin = await packages.readOrigin(target)
      const mappedRunId = origin.identities[entry.notebookRunId]
      expect(typeof mappedRunId).toBe('string')
      const runs = await h.fixture.notebookRepository.readSessionRuns(
        target.projectId,
        target.sessionId
      )
      expect(runs.find((run) => run.runId === mappedRunId)).toMatchObject({
        status: 'completed',
        exitCode: 0
      })
      const session = (await h.read(target))!
      for (const [path, bytes] of snapshot.files) {
        if (!path.startsWith(entry.entry + '/')) continue
        const filename = path.slice(entry.entry.length + 1)
        const candidates = (session.artifacts ?? []).filter(
          (artifact) => artifact.name === filename && artifact.versionId
        )
        let verified = false
        for (const artifact of candidates) {
          const version = await h.fixture.client.artifactVersion.findUnique({
            where: { id: artifact.versionId! }
          })
          if (version?.producerRunId !== mappedRunId) continue
          expect(await readFile(join(h.fixture.storageRoot, version.contentStorageKey))).toEqual(
            bytes
          )
          verified = true
        }
        expect(verified, `Resume package has no matching current producer for ${filename}`).toBe(
          true
        )
      }
    }
  } finally {
    await disposeCleanups(cleanupStart)
  }
}

it.skipIf(process.platform !== 'darwin' || !packageOnly || !materialsRoot || !evidenceRoot)(
  'publishes reviewed materials and exports a package without starting engineering Runs or scientific trials',
  async () => {
    const root = await realpath(materialsRoot!)
    const output = resolve(evidenceRoot!)
    // A package-only receipt must never replace an earlier package or experiment's evidence.
    await mkdir(output, { recursive: false })
    const acceptance = JSON.parse(
      await readFile(join(root, 'acceptance.json'), 'utf8')
    ) as Acceptance
    const startedAt = new Date().toISOString()
    const forbidExecution = async (): Promise<never> => {
      throw new Error('Materials-only packaging must not execute a research or engineering plan.')
    }
    const externalExecution = vi
      .spyOn(ManagedExecutionService.prototype, 'execute')
      .mockImplementation(forbidExecution)
    const turnExecution = vi
      .spyOn(ManagedExecutionService.prototype, 'executeInTurn')
      .mockImplementation(forbidExecution)
    try {
      // publishMaterials runs only its fixed copying command. It never reads acceptance.command
      // as executable code or launches the material driver, project service or research plan.
      const archive = await publishMaterials(root, output, acceptance)
      const bytes = await readFile(archive)
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(externalExecution).not.toHaveBeenCalled()
      expect(turnExecution).not.toHaveBeenCalled()
      await disposeCleanups()
      await writeFile(
        join(output, 'materials-package-receipt.json'),
        JSON.stringify(
          {
            mode: 'materials-only',
            status: 'packaged',
            title: acceptance.title,
            startedAt,
            finishedAt: new Date().toISOString(),
            packageFilename: basename(archive),
            sourcePackageSha256: sha(bytes),
            sizeBytes: bytes.byteLength,
            materialIndexSha256: sha(await readFile(join(root, 'material-file-index.json'))),
            publication: 'fixed-copy-command-only',
            engineeringRunsStarted: 0,
            scientificTrialsStarted: 0,
            experimentAcceptance: 'not-performed'
          },
          null,
          2
        ) + '\n',
        { flag: 'wx' }
      )
    } finally {
      externalExecution.mockRestore()
      turnExecution.mockRestore()
    }
  },
  120_000
)

it.skipIf(process.platform !== 'darwin' || packageOnly || !materialsRoot || !evidenceRoot)(
  'imports reviewed real research through the SDK and executes the same material plan through all three entries in the native sandbox',
  async () => {
    const root = await realpath(materialsRoot!)
    const output = resolve(evidenceRoot!)
    if (validateResumeOnly && !resumeRoot)
      throw new Error('Resume validation requires explicit prior evidence.')
    await mkdir(output, { recursive: false })
    const acceptance = JSON.parse(
      await readFile(join(root, 'acceptance.json'), 'utf8')
    ) as Acceptance
    const expectedPlanScope = acceptance.planScope ?? 'engineering-check'
    const projectView =
      acceptance.projectView === undefined
        ? undefined
        : runtimeViewLaunchSchema.parse(acceptance.projectView)
    if (projectView && acceptance.localServicePort === undefined)
      throw new Error('A declared project view requires an owned local service port.')
    expect([
      'end-to-end',
      'downstream-only',
      'alternative-conditions',
      'engineering-check'
    ]).toContain(expectedPlanScope)
    const budgetPath = acceptance.live ? resolve(root, acceptance.live.budgetFilename) : undefined
    if (
      acceptance.live &&
      (!budgetPath!.startsWith(root + '/') ||
        (process.env.OPEN_SCIENCE_MANAGED_RESEARCH_ALLOW_PAID !== '1' && !validateResumeOnly))
    )
      throw new Error(
        'Live acceptance requires a sealed budget and an explicit operator start; no inference was dispatched.'
      )
    // This is before any credential file read, network grant, preparation or trial dispatch.
    const budget = budgetPath ? await readAcceptanceBudgetSeal(budgetPath) : undefined
    const usageReceiptFilename = acceptance.live?.usageReceiptFilename
    if (
      acceptance.live &&
      (!usageReceiptFilename ||
        basename(usageReceiptFilename) !== usageReceiptFilename ||
        !acceptance.outputs?.some(
          (item) => item.filename === usageReceiptFilename && !item.optional
        ))
    )
      throw new Error('Live acceptance requires a declared usage receipt output.')
    const providersPath = acceptance.live
      ? resolve(root, acceptance.live.providersFilename)
      : undefined
    if (providersPath && !providersPath.startsWith(root + '/'))
      throw new Error('Provider settings must be reviewed materials.')
    const providers = providersPath
      ? z
          .object({
            environment: z.record(researchEnvironmentVariableSchema, z.string()),
            allowedNetworkHosts: z.array(researchNetworkHostSchema).max(32),
            changesFromAuthorEnv: z.array(z.string()).optional()
          })
          .passthrough()
          .parse(JSON.parse(await readFile(providersPath, 'utf8')))
      : undefined
    const trialIds = acceptance.live ? Object.values(acceptance.live.trialIds) : []
    if (
      budget &&
      (trialIds.length !== 4 ||
        new Set(trialIds).size !== 4 ||
        trialIds.some((id) => !budget.trialIds.includes(id)))
    )
      throw new Error('The four acceptance entries must map exactly to the sealed trial IDs.')
    const descriptorSha256 = await verifyAcceptanceMaterialFiles(
      root,
      acceptance.descriptorFilename
    )
    if (resumeRoot && (!acceptance.live || !budget))
      throw new Error(
        'Resume requires the same reviewed live acceptance budget and four entry identities.'
      )
    const resumed = resumeRoot
      ? await readAcceptanceResume(resumeRoot, {
          title: acceptance.title,
          planKey: acceptance.planKey,
          planScope: expectedPlanScope,
          budgetSha256: budget!.sha256,
          usageReceiptFilename: usageReceiptFilename!,
          trialIds: acceptance.live!.trialIds,
          outputs: acceptance.outputs ?? [],
          assertions: acceptance.expect.jsonAssertions
        })
      : undefined
    let archive: string
    if (resumed) {
      await verifyAcceptanceResumeReservations(
        resumed,
        budgetPath!,
        budget!,
        acceptance.live!.trialIds,
        usageReceiptFilename!
      )
      await copyAcceptanceResume(resumed, output)
      // Import each saved archive through the native package validator and bind output bytes to
      // the mapped completed Notebook producer before skipping any paid entry.
      await verifyResumedNativeArchives(output, resumed, descriptorSha256)
      archive = join(output, 'author-results.science')
    } else archive = await publishMaterials(root, output, acceptance)
    const evidence: unknown[] = [...(resumed?.report.entries ?? [])]
    const sourcePackageSha256 = resumed?.report.sourcePackageSha256 ?? sha(await readFile(archive))
    const writeEvidence = async (status: 'passed' | 'in-progress'): Promise<void> => {
      await writeFile(
        join(output, 'acceptance-results.json'),
        JSON.stringify(
          {
            status,
            title: acceptance.title,
            planKey: acceptance.planKey,
            planScope: expectedPlanScope,
            sourcePackageSha256,
            descriptorSha256,
            ...(resumed ? { resumedFrom: resumed.provenance } : {}),
            entries: evidence
          },
          null,
          2
        )
      )
    }
    const entries = acceptance.live
      ? (['author', 'external', 'ordinary', 'fork'] as const)
      : (['external', 'ordinary', 'fork'] as const)
    await writeEvidence('in-progress')
    const remainingEntries = entries.slice(resumed?.report.entries.length ?? 0)
    if (validateResumeOnly) {
      await writeFile(
        join(output, 'resume-validation.json'),
        JSON.stringify(
          {
            status: 'validated',
            completedEntries: resumed!.report.entries.map((entry) => entry.entry),
            remainingEntries,
            nativeArchivesVerified: true,
            credentialsRead: false,
            executionEntriesInvoked: 0
          },
          null,
          2
        ),
        { flag: 'wx' }
      )
      await disposeCleanups()
      return
    }
    for (const entry of remainingEntries) {
      const cleanupStart = cleanups.length
      let reservedTrialId: string | undefined
      let dispatchAttempted = false
      let pendingPrepare: Pick<AcceptanceAdmissionFailure, 'source' | 'request'> | undefined
      try {
        console.info(
          JSON.stringify({ event: 'research-acceptance-entry', entry, phase: 'prepare' })
        )
        const h = await createSessionOperationTestHarness(cleanups, {
          canonicalStorageRoot: true,
          nativeSandbox: true,
          approvedNetworkHosts: providers?.allowedNetworkHosts
        })
        await h.notebook.recoverInterruptedOperations()
        const packages = packageService(h)
        const versions = new ManagedFileVersionService({
          storageRoot: h.fixture.storageRoot,
          getClient: async () => h.fixture.client
        })
        const inputAuthority = new ImmutableInputAuthority({
          storageRoot: h.fixture.storageRoot,
          managedFileVersions: versions
        })
        const catalog = new ManagedFileIndexRepository(
          async () => h.fixture.client,
          h.fixture.storageRoot,
          versions,
          new UploadRepository(h.fixture.storageRoot, { getClient: async () => h.fixture.client })
        )
        const runtimes = createManagedResearchNodeRuntimeRegistry({
          trustedCandidates: [process.execPath]
        })
        const environments = new ManagedResearchEnvironmentOwner({
          dataRoot: h.fixture.storageRoot,
          socketRoot: '/private/tmp',
          verifyRuntime: (runtime) => runtimes.verify(runtime),
          stopExecution: async (identity) => ({
            verified: (await h.notebook.confirmManagedShellCleanup(identity, { retry: true }))
              .reaped
          })
        })
        cleanups.push(() => environments.close())
        const cipher = ephemeralAcceptanceCipher()
        cleanups.push(async () => cipher.destroy())
        const profiles = new ResearchExecutionProfileStore(
          join(h.fixture.storageRoot, 'acceptance-profile-config'),
          cipher
        )
        const views = new ManagedRuntimeViews()
        cleanups.push(async () => views.close())
        const service = new ManagedExecutionService({
          registerProjectService: (registration) => views.register(registration),
          profiles,
          artifacts: h.artifacts,
          dataRoot: h.fixture.storageRoot,
          notebooks: h.fixture.notebookRepository,
          environments,
          operations: h.owner,
          runtime: h.notebook,
          runtimes,
          materials: (request) =>
            createResearchMaterialAuthority(
              {
                catalog,
                inputAuthority,
                readSession: (projectId, sessionId) => h.read({ projectId, sessionId }),
                readOrigin: (request) => packages.readOrigin(request)
              },
              request
            ),
          resolvePreparedInputs: (receipt) =>
            Promise.all(
              (receipt.prepared?.inputs ?? []).map((input) =>
                resolvePreparedResearchMaterialInput(
                  { catalog, inputAuthority },
                  {
                    projectId: receipt.projectId,
                    versionId: input.versionId,
                    sha256: input.sha256,
                    sizeBytes: input.sizeBytes
                  }
                )
              )
            ),
          createSession: async () => {
            throw new Error('Acceptance uses existing ordinary or actual fork Sessions.')
          },
          withWritableSession: async (_scope, operation) => operation()
        })
        const api = await client(h, transfer(packages), service)
        const inputPackageSha256 = sha(await readFile(archive))
        const preview = await api.packages.preflightImport({
          filePath: archive,
          target: { projectId: scope.projectId }
        })
        const importedResult = await api.packages.commitImport({
          preflightId: preview.preflightId
        })
        expect(importedResult.cleanupPending).not.toBe(true)
        const imported: SessionPackageRequest = {
          projectId: importedResult.projectId,
          sessionId: importedResult.sessionId
        }
        const sourceBefore = JSON.stringify(await h.read(imported))
        const target = entry === 'fork' ? await packages.fork(imported) : scope
        expect((await h.read(target))?.packageOrigin).toBeUndefined()
        if (entry === 'fork') expect((await h.read(target))?.forkOrigin).toBeDefined()
        await h.mutate(target, (session) => ({
          ...session,
          title: `${acceptance.title} — ${entry}`
        }))
        const inspected = (await api.execution.inspectMaterials({
          ...target,
          sourceSessionId: imported.sessionId
        })) as ResearchMaterialInspection
        expect(inspected.status).toBe('ready')
        expect(inspected.descriptor?.sha256).toBe(descriptorSha256)
        const plan = inspected.description!.plans.find((item) => item.key === acceptance.planKey)!
        expect(plan.scope).toBe(expectedPlanScope)
        let profileId: string | undefined
        if (acceptance.live && budget && providers) {
          const preflightScope = {
            ...target,
            sourceSessionId: imported.sessionId,
            sourceIdentity: inspected.source.identity,
            descriptorVersionId: inspected.descriptor!.versionId,
            planKey: acceptance.planKey
          }
          const before = await service.preflight(preflightScope)
          if (
            !before.binding ||
            before.issues.some(
              (issue) => !['profile-required', 'credential-required'].includes(issue.code)
            )
          )
            throw new Error(
              'Live acceptance material/runtime preflight is blocked; no inference was dispatched.'
            )
          const envPath = process.env.OPEN_SCIENCE_MANAGED_RESEARCH_ENV_FILE
          if (!envPath)
            throw new Error(
              'Live acceptance requires an explicitly selected local credential file.'
            )
          const credentials = await readAcceptanceCredentials(envPath, before.slots)
          try {
            const profile = await service.saveExecutionProfile({
              ...preflightScope,
              ...before.binding,
              displayName: 'Isolated research acceptance',
              variables: {
                ...providers.environment,
                [researchEnvironmentVariableSchema.parse(acceptance.live.trialEnvironmentVariable)]:
                  acceptance.live.trialIds[entry]
              },
              allowedNetworkHosts: providers.allowedNetworkHosts,
              conditionChanges: [
                ...(providers.changesFromAuthorEnv ?? []),
                'Acceptance-only AES-GCM cipher; OS credential vault UI was not exercised.'
              ],
              credentials
            })
            profileId = profile.profileId
          } finally {
            for (const key of Object.keys(credentials)) delete credentials[key]
          }
          if ((await api.execution.preflight({ ...preflightScope, profileId })).status !== 'ready')
            throw new Error(
              'Live acceptance local profile is not ready; no inference was dispatched.'
            )
          // Consume a slot before preparation, preserving failed/uncertain attempts without reruns.
          await reserveAcceptanceTrial(budgetPath!, budget, acceptance.live.trialIds[entry])
          reservedTrialId = acceptance.live.trialIds[entry]
        }
        const available = await api.execution.runtimes()
        const materialVersions = Object.fromEntries(
          plan.materialKeys.map((key) => {
            const material = inspected.materials?.find((item) => item.key === key)
            if (material?.status !== 'available' || !material.versionIds?.length)
              throw new Error('Reviewed plan material has no verified immutable version.')
            // Equal-content versions can have distinct lineage (for example an author's config output).
            // The harness explicitly selects the stable first matching source-closure ID.
            return [key, [...material.versionIds].sort()[0]]
          })
        )
        const prepareRequest = {
          ...target,
          requestId: 'prepare-research',
          sourceSessionId: imported.sessionId,
          sourceIdentity: inspected.source.identity,
          runtimeId: available.runtimes[0].runtimeId,
          materials: {
            descriptorVersionId: inspected.descriptor!.versionId,
            materialKeys: plan.materialKeys,
            materialVersions
          }
        }
        pendingPrepare = {
          source: {
            inputPackageSha256,
            descriptorSha256,
            sourceIdentity: inspected.source.identity,
            ...target
          },
          request: {
            method: 'execution.prepare',
            requestId: prepareRequest.requestId,
            sha256: sha(JSON.stringify(prepareRequest))
          }
        }
        await writeFile(
          join(output, `${entry}-material-selection.json`),
          JSON.stringify(
            {
              sourceIdentity: inspected.source.identity,
              descriptorSha256,
              materialVersions,
              choice: 'lexicographically-first-verified-source-version'
            },
            null,
            2
          ),
          { flag: 'wx' }
        )
        const prepared = await api.execution.prepare(prepareRequest)
        pendingPrepare = undefined
        const request = {
          ...target,
          requestId: 'run-research',
          ...(profileId ? { profileId } : {}),
          environmentId: prepared.environmentId,
          command: acceptance.command,
          timeoutMs: acceptance.timeoutMs,
          localServicePort: acceptance.localServicePort,
          ...(projectView ? { projectView } : {}),
          outputs: acceptance.outputs,
          description: `Execute the ${acceptance.title} plan in Open Science with scope ${expectedPlanScope}.`
        }
        const previousRuns = new Set(
          (
            await h.fixture.notebookRepository.readSessionRuns(target.projectId, target.sessionId)
          ).map((run) => run.runId)
        )
        let nativeRunId: string | undefined
        // Once an execution entry has been invoked, any lost reply remains uncertain.
        dispatchAttempted = true
        console.info(
          JSON.stringify({ event: 'research-acceptance-entry', entry, phase: 'execute' })
        )
        if (entry === 'external' || entry === 'author') {
          await api.execution.execute(request)
        } else {
          await h.owner.start({
            ...target,
            requestId: request.requestId,
            requestFingerprint: sha(JSON.stringify(request)),
            requestText: request.description,
            execute: async (context, signal) => {
              const handle = h.artifactTurns.handleForExecution(context.operationId)
              const port = createManagedExecutionTurnPort({
                dataRoot: h.fixture.storageRoot,
                service,
                artifacts: h.artifacts,
                notebooks: h.fixture.notebookRepository,
                trackArtifactWrite: (_sessionId, _executionId, write) =>
                  h.artifactTurns.trackWrite(handle, write)
              })
              const result = await port.call('execute', request, {
                ...target,
                ownerExecutionId: context.operationId,
                artifactRunId: h.artifactTurns.snapshot(handle).runId,
                artifactStorageSessionId: target.sessionId,
                workspaceCwd: context.workspaceCwd,
                invocationId: 'research-execution-call',
                provenanceContext: context.provenanceContext as ManagedExecutionProvenance,
                signal,
                assertActive: () => signal.throwIfAborted()
              })
              expect(result).toMatchObject({ status: 'completed' })
              nativeRunId = (result as { runId: string }).runId
              expect(typeof nativeRunId).toBe('string')
              return { text: 'Declared research task completed in the existing turn.' }
            }
          })
        }
        let done: Awaited<ReturnType<typeof api.execution.waitOperation>>
        const waitDeadline = Date.now() + acceptance.timeoutMs + 60_000
        do {
          done = await api.execution.waitOperation({
            ...target,
            requestId: request.requestId,
            timeoutMs: 60_000
          })
          if (done && ['completed', 'failed', 'cancelled', 'interrupted'].includes(done.status))
            break
        } while (Date.now() < waitDeadline)
        // Retain failure diagnostics before assertions, without exposing auth tokens or private input.
        await writeFile(join(output, `${entry}-operation.json`), JSON.stringify(done, null, 2), {
          flag: 'wx'
        })
        const current = (await h.read(target))!
        const runs = (
          await h.fixture.notebookRepository.readSessionRuns(target.projectId, target.sessionId)
        ).filter((run) => !previousRuns.has(run.runId))
        await writeFile(
          join(output, `${entry}-notebook-runs.json`),
          JSON.stringify(
            runs.map((run) => ({
              runId: run.runId,
              status: run.status,
              exitCode: run.exitCode,
              text: run.text,
              shellErrorCode: run.shellErrorCode,
              interruptionReason: run.interruptionReason,
              promptMessageId: run.promptMessageId,
              submissionIdentity: run.submissionIdentity
            })),
            null,
            2
          ),
          { flag: 'wx' }
        )
        const resultRoot = join(output, entry)
        await mkdir(resultRoot)
        // A package fork may retain the author's outputs. Only this trial's new producer can
        // provide current result/usage evidence, even when the imported file name is identical.
        const currentRunIds = new Set(runs.map((run) => run.runId))
        const publishedArtifacts = (
          await Promise.all(
            (current.artifacts ?? []).map(async (artifact) => {
              if (!artifact.versionId) return undefined
              const version = await h.fixture.client.artifactVersion.findUnique({
                where: { id: artifact.versionId }
              })
              return currentRunIds.has(version?.producerRunId ?? '') ? artifact : undefined
            })
          )
        ).filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined)
        for (const selection of acceptance.outputs ?? []) {
          const artifact = publishedArtifacts.find((item) => item.name === selection.filename)
          if (artifact) await copyFile(artifact.path, join(resultRoot, selection.filename))
        }
        if (
          acceptance.live &&
          budget &&
          usageReceiptFilename &&
          publishedArtifacts.some((item) => item.name === usageReceiptFilename)
        ) {
          const receipt = JSON.parse(await readFile(join(resultRoot, usageReceiptFilename), 'utf8'))
          if (
            receipt.trialId !== acceptance.live.trialIds[entry] ||
            receipt.budgetDocumentSha256 !== budget.sha256
          )
            throw new Error(
              'Usage receipt does not belong to this reserved trial and reviewed budget.'
            )
          await recordAcceptanceTrialUsage(
            budgetPath!,
            budget,
            acceptance.live.trialIds[entry],
            receipt.usage
          )
        }
        expect(done, JSON.stringify(done)).toMatchObject({ status: 'completed' })
        if (!done) throw new Error('The admitted research operation disappeared.')
        // The native port borrows a current turn; it does not write an external-operation ledger.
        // Both entries must instead prove their actual new Notebook Run and output provenance.
        expect(runs).toHaveLength(1)
        const run = runs[0]
        expect(run.status).toBe('completed')
        if (entry === 'external' || entry === 'author')
          expect(done.notebookRunIds).toEqual([run.runId])
        else expect(nativeRunId).toBe(run.runId)
        for (const assertion of acceptance.expect.jsonAssertions) {
          let actual: unknown = JSON.parse(await readFile(join(resultRoot, assertion.path), 'utf8'))
          for (const part of assertion.pointer.split('/').slice(1))
            actual = (actual as Record<string, unknown>)[
              part.replaceAll('~1', '/').replaceAll('~0', '~')
            ]
          expect(actual, `${entry}: ${assertion.path}${assertion.pointer}`).toEqual(
            assertion.equals
          )
        }
        expect(JSON.stringify(await h.read(imported))).toBe(sourceBefore)
        expect(h.kernelExecute).not.toHaveBeenCalled()
        await h.snapshots.captureFinalizedMessages(current)
        const resultArchive = join(output, `${entry}-results.science`)
        await api.packages.export({ ...target, filePath: resultArchive })
        const roundtripPreview = await api.packages.preflightImport({
          filePath: resultArchive,
          target: { projectId: scope.projectId }
        })
        const roundtrip = await api.packages.commitImport({
          preflightId: roundtripPreview.preflightId
        })
        expect(roundtrip.cleanupPending).not.toBe(true)
        const origin = await packages.readOrigin({
          projectId: roundtrip.projectId,
          sessionId: roundtrip.sessionId
        })
        for (const selection of acceptance.outputs ?? []) {
          const artifact = publishedArtifacts.find((item) => item.name === selection.filename)
          if (!artifact?.versionId) continue
          const mapped = await h.fixture.client.artifactVersion.findUniqueOrThrow({
            where: { id: origin.identities[artifact.versionId] }
          })
          expect(await readFile(join(h.fixture.storageRoot, mapped.contentStorageKey))).toEqual(
            await readFile(artifact.path)
          )
          expect(mapped.producerRunId).toBe(origin.identities[run.runId])
        }
        await api.execution.releaseEnvironment({ ...target, environmentId: prepared.environmentId })
        // Published Artifact versions survive removal of the mutable output/environment directories.
        for (const artifact of current.artifacts ?? []) await readFile(artifact.path)
        evidence.push({
          entry,
          inputPackageSha256,
          sourceIdentity: inspected.source.identity,
          operation: done,
          notebookRunId: run.runId,
          packageSha256: sha(await readFile(resultArchive)),
          outputCount: publishedArtifacts.length
        })
        if (entry === 'author') archive = resultArchive
        await writeEvidence('in-progress')
        console.info(
          JSON.stringify({ event: 'research-acceptance-entry', entry, phase: 'verified' })
        )
      } catch (error) {
        if (reservedTrialId && budget && !dispatchAttempted) {
          // Admission/prepare failed before any execution entry. Record explicit zero requests,
          // but retain the full reservation and require manual reconciliation before any retry.
          await recordAcceptanceTrialUsage(budgetPath!, budget, reservedTrialId, {
            unit: 'tokens',
            state: 'complete',
            knownUnits: 0,
            requestCount: 0,
            requestsWithUsage: 0,
            requestsWithoutUsage: 0
          })
          if (pendingPrepare) {
            await recordAcceptanceAdmissionFailure(
              join(output, `${entry}-before-execution-entry-failure.json`),
              {
                schemaVersion: 1,
                kind: 'acceptance-before-execution-entry-failure',
                status: 'failed',
                evidenceBasis: 'harness-catch',
                recordedAt: new Date().toISOString(),
                trialId: reservedTrialId,
                budgetDocumentSha256: budget.sha256,
                phase: 'prepare',
                dispatchAttempted: false,
                usage: {
                  unit: 'tokens',
                  state: 'complete',
                  knownUnits: 0,
                  requestCount: 0,
                  requestsWithUsage: 0,
                  requestsWithoutUsage: 0
                },
                errorCode: 'PREPARE_FAILED',
                ...pendingPrepare,
                nativeOperationId: null,
                notebookRunIds: [],
                basisFiles: []
              }
            )
          }
        }
        throw error
      } finally {
        // Native policy has one process owner. End this isolated application before starting the
        // next entry, including when an assertion or package transfer fails.
        await disposeCleanups(cleanupStart)
      }
    }
    await disposeCleanups()
    await writeEvidence('passed')
  },
  // Four explicit entries may each use the existing 600-second managed-execution ceiling.
  // Keep publication, collection and cleanup within a separate bounded harness allowance.
  2_700_000
)

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()

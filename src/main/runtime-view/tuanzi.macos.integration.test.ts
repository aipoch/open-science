import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, lstat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import type { ManagedEnvironmentReference } from '../../shared/managed-execution'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { createArtifactHandlers } from '../artifacts/ipc'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPersistenceReconciliationOwner } from '../session-persistence/reconciliation-owner'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { initDataRoot } from '../storage-root'
import { createNotebookArtifactSourceScopeProvider } from '../notebook/artifact-source-scope'
import { ManagedExecutionService } from '../notebook/managed-execution-service'
import { ManagedResearchEnvironmentOwner } from '../notebook/managed-research-environment'
import { createManagedResearchNodeRuntimeRegistry } from '../notebook/managed-research-node-runtime'
import { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { getNotebookDataRoot, NotebookRunRepository } from '../notebook/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import {
  SessionOperationOwner,
  type SessionOperationDependencies
} from '../notebook/session-operation-owner'
import { ManagedRuntimeViews } from '../managed-runtime-views'
import { chromium, _electron, type Page, type FrameLocator } from '@playwright/test'
import { createCallerContext } from '../caller-context'
import { RunObservationOwner } from '../run-observation/owner'
import { ObservationViewers } from '../run-observation/viewers'
import { ReplayViewerHttpHost } from '../replay-viewer/http-host'
import { createReplayViewerAssetReader } from '../replay-viewer/assets'
import { createManagedRunObservationReader } from '../managed-run-observation'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

const scope = { projectId: 'project-1', sessionId: 'session-1' }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

type Harness = {
  root: string
  notebookRoot: string
  notebooks: NotebookRunRepository
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  notebook: NotebookRuntimeService
  sandbox: NotebookNetworkSandboxOwner
  environments: ManagedResearchEnvironmentOwner
  operations: SessionOperationOwner
  service: ManagedExecutionService
  views: ManagedRuntimeViews
  environment: ManagedEnvironmentReference
  read: SessionOperationDependencies['sessions']['read']
  kernelExecute: ReturnType<typeof vi.fn>
  globalGrants: ReturnType<typeof vi.fn>
}

type Material = { path: string; body: Buffer; versionId: string }
async function setup(materials: Material[], identity: string): Promise<Harness> {
  const fixture = await createProvenanceTestFixture()
  const root = await realpath(fixture.storageRoot)
  // Reproduce mixed logical/canonical storage roots even when TMPDIR has no /var alias.
  const notebookRoot = join(root, 'logical-storage')
  await symlink(root, notebookRoot, 'dir')
  initDataRoot(root)
  await fixture.client.project.create({
    data: { id: scope.projectId, name: 'Generic managed execution' }
  })
  const workspace = join(root, 'ordinary-workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'unrelated.txt'), 'ordinary workspace stays separate')
  const sessions = new SessionRepository(root)
  await sessions.saveSession({
    id: scope.sessionId,
    projectId: scope.projectId,
    title: 'Offline engineering check',
    cwd: workspace,
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  const read: SessionOperationDependencies['sessions']['read'] = async ({
    projectId,
    sessionId
  }) => {
    const loaded = await sessions.loadSessionWithDiagnostics(projectId, sessionId, {
      preserveRuntimeState: true
    })
    if (loaded.status === 'unreadable') throw new Error('Fixture Session is unreadable')
    return loaded.status === 'found' ? loaded.session : undefined
  }
  let tail: Promise<unknown> = Promise.resolve()
  const mutate: SessionOperationDependencies['sessions']['mutate'] = (identity, change) => {
    const mutation = tail.then(async () => {
      const session = await read(identity)
      if (!session) throw new Error('Fixture Session is missing')
      return sessions.saveSession(change(session), session.revision)
    })
    tail = mutation.catch(() => undefined)
    return mutation
  }
  const artifacts = new ArtifactProvenanceRepository({
    ...fixture.repositoryOptions,
    storageRoot: root,
    loadSession: (projectId, sessionId) => read({ projectId, sessionId })
  })
  const registry = new ArtifactRunRegistry()
  const handlers = createArtifactHandlers(fixture.compatibilityRepository, registry, {
    provenance: artifacts
  })
  const runtimeSessions = new RuntimeSessionOwner({
    loadSession: read,
    mutateSession: mutate,
    finalizeArtifacts: handlers.finalizeRunArtifacts
  })
  const artifactTurns = new ArtifactTurnOwner({
    dataRoot: root,
    repository: fixture.compatibilityRepository,
    runRegistry: registry,
    provenance: artifacts,
    notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(root)
  })
  const sandbox = new NotebookNetworkSandboxOwner({
    resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
    temporaryRoot: join(root, 'commands'),
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    requestDecision: async () => 'deny'
  })
  const notebooks = new NotebookRunRepository(notebookRoot)
  const kernelExecute = vi.fn(() => {
    throw new Error('No kernel or model may run in this fixture')
  })
  const globalGrants = vi.fn(async () => [
    { id: 'global-user-root', path: workspace, name: 'ordinary workspace', access: 'rw' as const }
  ])
  const notebook = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: notebookRoot,
    projectId: scope.projectId,
    repository: notebooks,
    processSandbox: sandbox,
    getGrantedLocalRoots: globalGrants,
    executorFactory: () => ({ execute: kernelExecute, shutdown: async () => ({ reaped: true }) })
  })
  await notebook.recoverInterruptedOperations()
  const reconciliation = new SessionPersistenceReconciliationOwner({
    repository: sessions,
    artifactStorage: artifacts,
    fileIndex: { syncSession: async () => [], reconcileActiveSessions: async () => undefined }
  })
  const operations = new SessionOperationOwner({
    dataRoot: root,
    sessions: { read, mutate },
    runtimeSessions,
    artifactTurns,
    artifacts,
    notebooks,
    reserveSession: async () => () => undefined,
    recoverNotebookOperations: async () => {
      await notebook.recoverInterruptedOperations()
    },
    retryArtifactFinalization: async (request) => {
      const session = await read(request)
      if (!session) throw new Error('Fixture Session missing during recovery')
      return reconciliation.retryArtifactFinalization(session, request)
    }
  })
  const runtimes = createManagedResearchNodeRuntimeRegistry({
    trustedCandidates: [process.execPath]
  })
  const discovered = await runtimes.discover()
  expect(discovered.runtimes).toHaveLength(1)
  const environments = new ManagedResearchEnvironmentOwner({
    dataRoot: root,
    socketRoot: '/private/tmp',
    verifyRuntime: (runtime) => runtimes.verify(runtime),
    stopExecution: async (request) => ({
      verified: (await notebook.confirmManagedShellCleanup(request, { retry: true })).reaped
    })
  })
  const views = new ManagedRuntimeViews()
  const service = new ManagedExecutionService({
    artifacts,
    dataRoot: root,
    notebooks,
    environments,
    operations,
    runtime: notebook,
    runtimes,
    registerProjectService: (registration) => views.register(registration),
    // This acceptance freezes independently verified source bytes. Package selection/import
    // is not the subject of this UI transport test and remains covered in its own suites.
    materials: async () => ({
      source: { projectId: scope.projectId, sessionId: 'tuanzi-source', identity },
      versions: materials.map((material) => ({
        versionId: material.versionId,
        sourceIdentity: identity,
        filename: material.path,
        sha256: sha(material.body),
        sizeBytes: material.body.length
      })),
      readVersion: async (versionId: string) => {
        const material = materials.find((entry) => entry.versionId === versionId)
        if (!material) throw new Error('Unknown fixed material')
        return material.body
      }
    }),
    resolvePreparedInputs: async () => [],
    createSession: async () => {
      throw new Error('This fixture uses its real existing Session')
    },
    withWritableSession: async (_scope, operation) => operation()
  })
  const prepared = (await service.prepare({
    ...scope,
    requestId: 'prepare-node',
    sourceSessionId: 'tuanzi-source',
    sourceIdentity: identity,
    runtimeId: discovered.runtimes[0].runtimeId,
    materials: {
      files: materials.map((entry) => ({ versionId: entry.versionId, restorePath: entry.path }))
    }
  })) as { environmentId: string }
  return {
    root,
    notebookRoot,
    notebooks,
    fixture,
    notebook,
    sandbox,
    environments,
    operations,
    service,
    views,
    environment: { ...scope, environmentId: prepared.environmentId },
    read,
    kernelExecute,
    globalGrants
  }
}

const enabled = process.platform === 'darwin' && process.env.RUN_TUANZI_STAGE3_ACCEPTANCE === '1'
const sourceRoot = '/Users/jszhang/github/projects/tuanzi-gs'
const stage2 =
  '/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-managed-execution-stage2'
const sourceCommit = 'b6d5810fef3baac1195c980fe728ce7a8a69408b'
const manifestHash = 'bf39136f481c6d7a76d35c4e386cc2d3b9a4e88a03eabea13d11345017ea4319'
const startup = String.raw`
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net';
import {once} from 'node:events';
for (const key of Object.keys(process.env)) {
  if (/^(TYPESAFE_|JEV_|LLM_|OPENAI_|ANTHROPIC_|GS_LAB_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/.test(key)) delete process.env[key];
}
process.env.PORT='4173'; process.env.MAX_SERVER_CALLS='1';
process.env.GS_LAB_OUTPUT_DIR=path.join(process.env.OPEN_SCIENCE_OUTPUT_DIR,'server-archives');
const denied = await new Promise(resolve => {
  const server=net.createServer();server.once('error',e=>resolve(e.code));
  server.listen({host:'127.0.0.1',port:0},()=>server.close(()=>resolve('allowed')));
});
if(!['EACCES','EPERM'].includes(denied))throw Error('TCP_SANDBOX_REQUIRED');
const {server}=await import('./project/server.mjs');
if(!server.listening)await once(server,'listening');
fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_OUTPUT_DIR,'ui-service.json'),JSON.stringify({
  scope:'interface-only',pid:process.pid,version:process.version,tcpBind:denied,
  scientificTrialsStarted:0,engineeringRunsStarted:0,sourceModified:false
}));
console.log('TUANZI_UI_READY: interface-only; no experiment start or step');
`

type TuanziSnapshot = {
  runId: string
  status: string
  physicalActions: number
  requests: number
  externalRequests: number
  startedAt: string | null
  lastSeq: number
  config: { backend: string; generator: string; allowLive: boolean }
}
async function readState(frame: FrameLocator): Promise<TuanziSnapshot> {
  return frame
    .locator('body')
    .evaluate(() =>
      (window as unknown as { gsLabViewer: { snapshot(): TuanziSnapshot } }).gsLabViewer.snapshot()
    )
}
async function inspectProject(frame: FrameLocator): Promise<Record<string, unknown>> {
  return frame.locator('body').evaluate(async () => {
    const status = await (await fetch('/api/status')).json()
    const view = (
      window as unknown as { gsLabViewer: { snapshot(): TuanziSnapshot; cursor(): number } }
    ).gsLabViewer
    const state = view.snapshot()
    const headers = { 'x-gs-token': status.token }
    const events = await (
      await fetch(`/api/lab/runs/${state.runId}/events?after=0`, { headers })
    ).json()
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 3000)
    let stream = ''
    try {
      const response = await fetch(`/api/lab/runs/${state.runId}/stream?after=0`, {
        headers: { ...headers, 'last-event-id': String(Math.max(0, state.lastSeq - 1)) },
        signal: abort.signal
      })
      if (!response.ok || !response.body) throw Error('SSE unavailable')
      const reader = response.body.getReader()
      while (!stream.includes('event: lab')) {
        const value = await reader.read()
        if (value.done) break
        stream += new TextDecoder().decode(value.value)
      }
    } finally {
      clearTimeout(timeout)
      abort.abort()
    }
    const ids = [...stream.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
    return {
      status: {
        version: status.version,
        providerCalls: status.providerCalls,
        jevReady: status.jevReady,
        llmReady: status.llmReady
      },
      state,
      cursor: view.cursor(),
      eventSeqs: events.events.map((event: { seq: number }) => event.seq),
      sseIds: ids,
      sseAfterCursor: Math.max(0, state.lastSeq - 1),
      sseHasEvents: stream.includes('event: lab'),
      sourceHasCanvas: document.querySelectorAll('canvas,svg,.world,.board').length > 0,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth
      },
      projectOrigin: location.origin
    }
  })
}
async function createReady(frame: FrameLocator): Promise<TuanziSnapshot> {
  await frame.locator('#new-run').waitFor({ state: 'visible' })
  await expect.poll(() => frame.locator('#new-run').isEnabled()).toBe(true)
  await frame.locator('#new-run').click()
  await frame.locator('#preset').selectOption('offline')
  expect(await frame.locator('#backend').inputValue()).toBe('rule')
  expect(await frame.locator('#generator').inputValue()).toBe('local')
  expect(await frame.locator('#allow-live').isChecked()).toBe(false)
  await frame.locator('#advanced-config > summary').click()
  for (const [id, value] of Object.entries({
    requests: '12',
    'max-actions': '4',
    'max-steps': '6',
    'max-g': '6',
    'max-depth': '0',
    'jev-retries': '0',
    seed: '91001',
    deadline: '30000'
  }))
    await frame.locator(`#${id}`).fill(value)
  await frame.locator('#experience').selectOption('off')
  await frame.locator('#create').click()
  await expect.poll(async () => (await readState(frame))?.status).toBe('ready')
  await expect
    .poll(async () =>
      frame
        .locator('body')
        .evaluate(
          () =>
            (
              window as unknown as { gsLabViewer: { view(): { connected: boolean } } }
            ).gsLabViewer.view().connected
        )
    )
    .toBe(true)
  const state = await readState(frame)
  expect(state).toMatchObject({
    status: 'ready',
    physicalActions: 0,
    requests: 0,
    externalRequests: 0,
    config: { backend: 'rule', generator: 'local', allowLive: false }
  })
  expect(state.startedAt == null).toBe(true)
  return state
}

it.skipIf(!enabled)(
  'embeds unchanged Tuanzi v0.5.6 in the real managed sandbox and production Replay without starting trials',
  async () => {
    const evidence = join(
      '/Users/jszhang/github/projects/tuanzi-gs-research/tuanzi-v056-replay-live-stage3',
      new Date().toISOString().replaceAll(':', '-')
    )
    await mkdir(evidence, { recursive: true })
    const receipt: Record<string, unknown> = {
      schema: 'tuanzi-stage3-ui-acceptance-v1',
      startedAt: new Date().toISOString(),
      sourceCommit,
      scope: 'interface-only',
      scientificTrialsStarted: 0,
      engineeringRunsStarted: 0,
      providerCalls: null,
      originalSourceModified: false,
      installedClientTouched: false,
      productionReplayBundle: true,
      webSecurity: true
    }
    let h: Harness | undefined
    let host: ReplayViewerHttpHost | undefined
    let viewers: ObservationViewers | undefined
    let observation: RunObservationOwner | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined
    let stage = 'verify immutable source'
    try {
      const manifestBytes = await readFile(join(stage2, 'source-manifest.json'))
      expect(sha(manifestBytes)).toBe(manifestHash)
      const manifest = JSON.parse(manifestBytes.toString()) as {
        source: { commit: string }
        files: { path: string; sha256: string; sizeBytes: number }[]
      }
      expect(manifest.source.commit).toBe(sourceCommit)
      expect(manifest.files).toHaveLength(427)
      const materials: Material[] = []
      for (const [index, file] of manifest.files.entries()) {
        expect(file.path.split('/').some((part) => part === '..' || part.startsWith('.env'))).toBe(
          false
        )
        const info = await lstat(join(sourceRoot, file.path))
        expect(info.isFile() && !info.isSymbolicLink()).toBe(true)
        const body = await readFile(join(sourceRoot, file.path))
        expect(body.length, file.path).toBe(file.sizeBytes)
        expect(sha(body), file.path).toBe(file.sha256)
        materials.push({ path: `project/${file.path}`, body, versionId: `tuanzi-${index}` })
      }
      expect(
        JSON.parse(materials.find((file) => file.path === 'project/package.json')!.body.toString())
          .version
      ).toBe('0.5.6')
      materials.push({
        path: 'ui-acceptance.mjs',
        body: Buffer.from(startup),
        versionId: 'ui-startup'
      })
      receipt.sourceFilesVerified = manifest.files.length
      receipt.sourceManifestSha256 = manifestHash
      receipt.startupWrapperSha256 = sha(startup)
      receipt.productionViewerEntrySha256 = sha(await readFile('out/replay-viewer/index.html'))
      stage = 'prepare native managed environment'
      h = await setup(materials, sha(manifestBytes + startup))
      stage = 'start interface service only'
      const operation = { ...scope, requestId: 'tuanzi-stage3-ui' }
      const admitted = await h.service.execute({
        ...h.environment,
        requestId: operation.requestId,
        command: 'node "$OPEN_SCIENCE_INPUT_DIR/ui-acceptance.mjs"',
        localServicePort: 4173,
        timeoutMs: 120000,
        projectView: {
          title: 'Tuanzi v0.5.6',
          entryPath: '/lab',
          allowedRequestHeaders: ['x-gs-token'],
          adaptFrameAncestors: true
        },
        outputs: [
          { path: 'ui-service.json', filename: 'ui-service.json', contentType: 'application/json' }
        ],
        description: 'UI acceptance only. No start/step, providers or scientific trial.'
      })
      const target = { ...scope, operationId: admitted.operationId }
      await vi.waitFor(
        async () => {
          const current = await h!.service.inspectExecution(target)
          expect(current?.run?.status).toBe('running')
          expect(current?.run?.text.stdout).toContain('TUANZI_UI_READY')
        },
        { timeout: 20000 }
      )
      const startupReceipt = JSON.parse(
        await readFile(
          join(
            getNotebookDataRoot(h.root, scope.projectId, scope.sessionId),
            'managed-execution',
            h.environment.environmentId,
            'files/ui-service.json'
          ),
          'utf8'
        )
      )
      receipt.native = startupReceipt
      observation = new RunObservationOwner({
        authorize: (target, viewer) => viewers!.assertViewer(target, viewer),
        read: createManagedRunObservationReader(h.service)
      })
      viewers = new ObservationViewers({
        observer: observation,
        authorizeScope: async () => undefined,
        onRevoked: (id) => host?.closeViewer(id)
      })
      host = new ReplayViewerHttpHost({
        viewers,
        projectViews: h.views,
        readAsset: createReplayViewerAssetReader(join(process.cwd(), 'out/replay-viewer'))
      })
      const caller = createCallerContext({
        clientId: 'tuanzi-ui-acceptance',
        lifecycleClientId: 'tuanzi-ui-acceptance',
        leaseId: 'tuanzi-ui-acceptance',
        surface: 'task',
        location: 'local',
        principalKind: 'automation',
        actionOrigin: 'automation'
      })
      const access = await host.open(target, caller, {
        allowInteraction: true,
        desktopParent: 'file:'
      })
      receipt.viewerOrigin = new URL(access.url).origin
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1080 },
        locale: 'en-US'
      })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const visibleFrame = (page: Page): FrameLocator =>
        page.frameLocator('iframe[title="Tuanzi v0.5.6"]')
      stage = 'Chromium production Replay and Tuanzi create-ready'
      await page.goto(access.url)
      await page.getByTestId('open-project-interface').click()
      const project = visibleFrame(page)
      const chromiumState = await createReady(project)
      const chromiumProof = await inspectProject(project)
      expect(chromiumProof.status).toMatchObject({
        version: '0.5.6',
        providerCalls: 0,
        jevReady: false,
        llmReady: false
      })
      expect(chromiumProof.sseHasEvents).toBe(true)
      expect(chromiumProof.sseIds).toEqual([chromiumState.lastSeq])
      await page.screenshot({ path: join(evidence, 'chromium-wide.png'), fullPage: true })
      await project.locator('#world').scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidence, 'chromium-world.png'), fullPage: true })
      await page.setViewportSize({ width: 780, height: 920 })
      const narrow = await inspectProject(project)
      expect((narrow.viewport as { width: number }).width).toBeLessThan(
        (chromiumProof.viewport as { width: number }).width
      )
      await page.screenshot({ path: join(evidence, 'chromium-narrow.png'), fullPage: true })
      receipt.chromium = {
        state: chromiumState,
        proof: chromiumProof,
        narrowViewport: narrow.viewport,
        browser: browser.version()
      }
      stage = 'Electron file ancestor and Tuanzi create-ready'
      const desktop = await host.issueAccess(access.viewerId, caller)
      const html = join(h.root, 'viewer.html'),
        main = join(h.root, 'viewer.cjs')
      await writeFile(
        html,
        '<!doctype html><html><meta charset="utf-8"><body style="margin:0"><iframe id="viewer" sandbox="allow-scripts allow-same-origin allow-forms" src="' +
          desktop.url +
          '" style="width:100vw;height:100vh;border:0"></iframe></body></html>'
      )
      await writeFile(
        main,
        'const {app,BrowserWindow}=require("electron");app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1080,webPreferences:{contextIsolation:true,nodeIntegration:false,webSecurity:true}});w.loadFile(' +
          JSON.stringify(html) +
          ');});app.on("window-all-closed",()=>app.quit());'
      )
      electron = await _electron.launch({ args: [main], cwd: process.cwd() })
      const window = await electron.firstWindow()
      const viewer = window.frameLocator('#viewer')
      await viewer.getByTestId('open-project-interface').click()
      const desktopProject = viewer.frameLocator('iframe[title="Tuanzi v0.5.6"]')
      const electronState = await createReady(desktopProject)
      const electronProof = await inspectProject(desktopProject)
      expect(electronProof.status).toMatchObject({
        version: '0.5.6',
        providerCalls: 0,
        jevReady: false,
        llmReady: false
      })
      expect(electronProof.sseHasEvents).toBe(true)
      expect(electronProof.sseIds).toEqual([electronState.lastSeq])
      await window.screenshot({ path: join(evidence, 'electron-wide.png') })
      await desktopProject.locator('#world').scrollIntoViewIfNeeded()
      await window.screenshot({ path: join(evidence, 'electron-world.png') })
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(800, 900)
      )
      await expect
        .poll(
          async () => ((await inspectProject(desktopProject)).viewport as { width: number }).width
        )
        .toBeLessThan((electronProof.viewport as { width: number }).width)
      const electronNarrow = await inspectProject(desktopProject)
      await window.screenshot({ path: join(evidence, 'electron-narrow.png') })
      receipt.electron = {
        state: electronState,
        proof: electronProof,
        narrowViewport: electronNarrow.viewport,
        topProtocol: new URL(window.url()).protocol
      }
      expect(errors).toEqual([])
      receipt.pageErrors = errors
      receipt.providerCalls = 0
      receipt.readyDraftsCreated = 2
      receipt.projectSourceUnchanged = true
      expect(sha(await readFile('out/replay-viewer/index.html'))).toBe(
        receipt.productionViewerEntrySha256
      )
      expect(h.kernelExecute).not.toHaveBeenCalled()
      expect(h.globalGrants).not.toHaveBeenCalled()
      stage = 'stop only owned UI service'
      await h.service.cancelOperation(operation)
      const done = await h.operations.wait(operation)
      expect(done?.status).toBe('cancelled')
      expect(() => process.kill(startupReceipt.pid, 0)).toThrow()
      receipt.serviceStopped = true
      expect(
        await page.goto((chromiumProof.projectOrigin as string) + '/lab').then(
          () => false,
          () => true
        )
      ).toBe(true)
      receipt.oldProjectLinkUnavailable = true
      receipt.status = 'passed'
    } catch (error) {
      receipt.status = 'failed'
      receipt.stage = stage
      receipt.error = String(error).replace(/grant=[a-f0-9]+/g, 'grant=[redacted]')
      if (electron) {
        const window = await electron.firstWindow()
        await window
          .screenshot({ path: join(evidence, 'electron-failure.png') })
          .catch(() => undefined)
        receipt.electronVisibleText = await window
          .frameLocator('#viewer')
          .locator('body')
          .innerText({ timeout: 1000 })
          .catch(() => 'Frame unavailable')
      }
      if (h)
        receipt.managedRuns = (
          await h.notebooks.readSessionDocuments(scope.projectId, scope.sessionId)
        )
          .flatMap((document) => document.runs)
          .map((run) => ({ status: run.status, stdout: run.text.stdout, stderr: run.text.stderr }))
      throw error
    } finally {
      await electron?.close()
      await browser?.close()
      host?.close()
      await viewers?.close()
      observation?.close()
      if (h) {
        h.views.close()
        await h.operations.close()
        await h.environments.close()
        const shutdown = await h.notebook.shutdownAll()
        await h.notebook.dispose()
        await h.sandbox.dispose()
        if (shutdown.reaped) await h.fixture.dispose()
        receipt.cleanupReaped = shutdown.reaped
      }
      receipt.finishedAt = new Date().toISOString()
      await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
      console.log('Tuanzi stage3 UI evidence:', evidence)
    }
  },
  180000
)

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()

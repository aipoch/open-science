import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
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
import { createNotebookArtifactSourceScopeProvider } from './artifact-source-scope'
import { ResearchExecutionProfileStore } from '../research-execution-profiles/store'
import { ManagedExecutionService } from './managed-execution-service'
import { ManagedResearchEnvironmentOwner } from './managed-research-environment'
import { createManagedResearchNodeRuntimeRegistry } from './managed-research-node-runtime'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { getNotebookDataRoot, NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'
import { SessionOperationOwner, type SessionOperationDependencies } from './session-operation-owner'
import { ManagedRuntimeViews } from '../managed-runtime-views'
import type { RuntimeViewAccess } from '../../shared/runtime-view'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

const scope = { projectId: 'project-1', sessionId: 'session-1' }
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const script = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
const mode = process.argv[2];
const server = http.createServer((_request, response) => response.end('generic-node-ready'));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(process.env.OPEN_SCIENCE_SERVICE_SOCKET, resolve) });
const reply = await new Promise((resolve, reject) => {
  http.get({ socketPath: process.env.OPEN_SCIENCE_SERVICE_SOCKET, path: '/status' }, response => {
    let content = ''; response.on('data', chunk => content += chunk); response.on('end', () => resolve(content));
  }).on('error', reject);
});
const tcp = await new Promise(resolve => {
  const attempt = net.createServer(); attempt.once('error', error => resolve(error.code));
  attempt.listen({ host: '127.0.0.1', port: 0 }, () => attempt.close(() => resolve('allowed')));
});
let inputWrite;
try { fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_INPUT_DIR, 'main.mjs'), 'changed'); inputWrite = 'allowed' }
catch (error) { inputWrite = error.code }
let privateRead;
try { fs.readFileSync(process.argv[3]); privateRead = 'allowed' } catch (error) { privateRead = error.code }
const result = { reply, tcp, inputWrite, privateRead, pid: process.pid, mode, cwd: process.cwd() };
fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_OUTPUT_DIR, 'result.json'), JSON.stringify(result));
console.log(JSON.stringify(result));
if (mode === 'normal') await new Promise(resolve => server.close(resolve));
`

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

async function setup(materialScript = script, researchProfile = false): Promise<Harness> {
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
  const researchDescription = JSON.stringify({
    format: 'open-science-reproduction-description',
    descriptionVersion: 1,
    title: 'Credential fixture',
    materials: [
      {
        key: 'driver',
        role: 'script',
        availability: 'included',
        filename: 'main.mjs',
        restorePath: 'main.mjs',
        sha256: sha(materialScript),
        sizeBytes: Buffer.byteLength(materialScript)
      }
    ],
    plans: [
      {
        key: 'original',
        title: 'Original research',
        scope: 'end-to-end',
        materialKeys: ['driver'],
        claim: 'Exercise a configured runtime',
        limitations: ['Fixture does not prove a research claim'],
        entrypoints: [{ materialKey: 'driver' }],
        requirements: { node: '>=22', platforms: ['darwin'] }
      }
    ],
    secrets: [
      {
        key: 'provider',
        environmentVariable: 'PROVIDER_API_KEY',
        description: 'API credential',
        required: true,
        planKeys: ['original']
      }
    ]
  })
  const profileStore = new ResearchExecutionProfileStore(root, {
    encrypt: (value) => 'test-encrypted:' + Buffer.from(value).toString('base64'),
    decrypt: (value) => Buffer.from(value.slice(15), 'base64').toString()
  })
  const views = new ManagedRuntimeViews()
  const service = new ManagedExecutionService({
    artifacts,
    dataRoot: root,
    profiles: profileStore,
    notebooks,
    environments,
    operations,
    runtime: notebook,
    runtimes,
    registerProjectService: (registration) => views.register(registration),
    // A synthetic immutable material authority; the real import/selection bridge has separate tests.
    materials: async () => ({
      source: {
        projectId: scope.projectId,
        sessionId: 'synthetic-source',
        identity: sha(materialScript)
      },
      versions: [
        {
          versionId: 'generic-node-script',
          sourceIdentity: sha(materialScript),
          filename: 'main.mjs',
          sha256: sha(materialScript),
          sizeBytes: Buffer.byteLength(materialScript)
        },
        ...(researchProfile
          ? [
              {
                versionId: 'research-descriptor',
                sourceIdentity: sha(materialScript),
                filename: 'research-reproduction.json',
                sha256: sha(researchDescription),
                sizeBytes: Buffer.byteLength(researchDescription),
                descriptor: true
              }
            ]
          : [])
      ],
      readVersion: async (id) =>
        Buffer.from(id === 'research-descriptor' ? researchDescription : materialScript)
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
    sourceSessionId: 'synthetic-source',
    sourceIdentity: sha(materialScript),
    runtimeId: discovered.runtimes[0].runtimeId,
    materials: researchProfile
      ? { descriptorVersionId: 'research-descriptor', materialKeys: ['driver'] }
      : { files: [{ versionId: 'generic-node-script', restorePath: 'main.mjs' }] }
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

describe.skipIf(process.platform !== 'darwin')(
  'managed execution service in the native macOS sandbox',
  () => {
    it.each(['normal', 'cancel', 'timeout'] as const)(
      'restores generic Node material, publishes %s results and releases only after process proof',
      async (mode) => {
        const h = await setup()
        const operation = { ...scope, requestId: 'run-' + mode }
        const request = {
          ...h.environment,
          requestId: operation.requestId,
          command:
            'node "$OPEN_SCIENCE_INPUT_DIR/main.mjs" ' +
            mode +
            ' ' +
            quote(join(h.root, 'ordinary-workspace/unrelated.txt')),
          timeoutMs: mode === 'timeout' ? 2000 : 15_000,
          localServicePort: 4173,
          outputs: [
            { path: 'result.json', filename: 'result.json', contentType: 'application/json' }
          ],
          description: 'Run a generic Node service with no model or network provider.'
        }
        let reaped = false
        try {
          const admitted = await h.service.execute(request)
          if (mode === 'cancel') {
            await vi.waitFor(
              async () =>
                expect(
                  JSON.parse(
                    await readFile(
                      join(
                        getNotebookDataRoot(h.root, scope.projectId, scope.sessionId),
                        'managed-execution',
                        h.environment.environmentId,
                        'files/result.json'
                      ),
                      'utf8'
                    )
                  ).reply
                ).toBe('generic-node-ready'),
              { timeout: 15_000 }
            )
            await h.service.cancelOperation(operation)
          }
          const done = await h.operations.wait(operation)
          expect(done, JSON.stringify(done)).toMatchObject({
            status: mode === 'normal' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed'
          })
          expect(done!.notebookRunIds).toHaveLength(1)
          expect(done!.artifactVersionIds).toHaveLength(2)
          expect(h.kernelExecute).not.toHaveBeenCalled()
          const runs = (
            await h.notebooks.readSessionDocuments(scope.projectId, scope.sessionId)
          ).flatMap((document) => document.runs)
          expect(runs).toHaveLength(1)
          expect(runs[0]).toMatchObject({
            runId: done!.notebookRunIds[0],
            status: mode === 'normal' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'timeout',
            ...done!.provenance
          })
          expect(runs[0].workingFiles).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                path: join(
                  getNotebookDataRoot(h.notebookRoot, scope.projectId, scope.sessionId),
                  'managed-execution',
                  h.environment.environmentId,
                  'files/result.json'
                ),
                createdByRunId: runs[0].runId
              })
            ])
          )
          // OS containment and observed output bytes do not prove every file read by arbitrary Node code.
          expect(runs[0].fileEvidence?.fileReads).not.toBe('complete')
          const version = await h.fixture.client.artifactVersion.findUniqueOrThrow({
            where: { id: done!.artifactVersionIds[0] }
          })
          expect(version).toMatchObject({
            producerRunId: runs[0].runId,
            notebookSessionId: scope.sessionId
          })
          const result = JSON.parse(await readFile(join(h.root, version.contentStorageKey), 'utf8'))
          expect(result.reply).toBe('generic-node-ready')
          expect(['EPERM', 'EACCES']).toContain(result.tcp)
          expect(['EPERM', 'EACCES']).toContain(result.inputWrite)
          expect(['EPERM', 'EACCES']).toContain(result.privateRead)
          expect(h.globalGrants).not.toHaveBeenCalled()
          expect(result.cwd).toBe(
            join(h.root, 'research-environments', h.environment.environmentId, 'work')
          )
          expect(() => process.kill(result.pid, 0)).toThrow()
          const session = (await h.read(scope))!
          expect(session.activeRun).toBeUndefined()
          expect(session.cwd).toBe(join(h.root, 'ordinary-workspace'))
          expect(session.artifacts?.map((artifact) => artifact.versionId)).toEqual(
            expect.arrayContaining(done!.artifactVersionIds)
          )
          const repeated = await h.service.execute(request)
          expect(repeated.operationId).toBe(admitted.operationId)
          expect(
            (await h.notebooks.readSessionDocuments(scope.projectId, scope.sessionId)).flatMap(
              (document) => document.runs
            )
          ).toHaveLength(1)
          expect(await h.service.releaseEnvironment(h.environment)).toMatchObject({
            state: 'released'
          })
          await expect(
            stat(join(h.root, 'research-environments', h.environment.environmentId))
          ).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(
            stat(
              join(
                getNotebookDataRoot(h.root, scope.projectId, scope.sessionId),
                'managed-execution',
                h.environment.environmentId
              )
            )
          ).rejects.toMatchObject({ code: 'ENOENT' })
        } catch (error) {
          const documents = await h.notebooks.readSessionDocuments(scope.projectId, scope.sessionId)
          throw new Error(
            JSON.stringify({
              cause: String(error),
              runs: documents
                .flatMap((document) => document.runs)
                .map((run) => ({
                  status: run.status,
                  text: run.text,
                  workingFiles: run.workingFiles
                }))
            }),
            { cause: error }
          )
        } finally {
          h.views.close()
          await h.operations.close()
          await h.environments.close()
          const shutdown = await h.notebook.shutdownAll()
          reaped = shutdown.reaped
          await h.notebook.dispose()
          await h.sandbox.dispose()
          if (reaped) await h.fixture.dispose()
          expect(reaped).toBe(true)
        }
      },
      40_000
    )
  }
)

it.skipIf(process.platform !== 'darwin')(
  'observes and operates a real sandboxed project service, then revokes it on completion',
  async () => {
    const source = String.raw`
import fs from 'node:fs'; import http from 'node:http'; import net from 'node:net';
import path from 'node:path'; import {fileURLToPath} from 'node:url';
const denied = async () => await new Promise(resolve => {
  const s = net.createServer(); s.once('error', e => resolve(e.code));
  s.listen({host:'127.0.0.1',port:0}, () => s.close(() => resolve('allowed')));
});
const result = {pid:process.pid,tcp:await denied(),actions:0};
try {fs.writeFileSync(fileURLToPath(process.env.NODE_OPTIONS.slice('--import='.length)), 'changed'); result.adapterWrite='allowed'}
catch(e) {result.adapterWrite=e.code}
const server = http.createServer((req,res) => {
  if(req.url==='/act' && req.method==='POST') {
    if(req.headers.host!=='127.0.0.1:4173' || req.headers.origin!=='http://127.0.0.1:4173' || req.headers['x-fixture-token']!=='project-token') {
      res.writeHead(403); res.end('denied'); return;
    }
    result.actions++; console.log('action '+result.actions); res.end(JSON.stringify(result)); return;
  }
  if(req.url==='/stop' && req.method==='POST') {
    fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_OUTPUT_DIR,'result.json'),JSON.stringify(result));
    res.end('stopping'); setImmediate(()=>server.close()); return;
  }
  res.setHeader('content-type','text/html');
  res.setHeader('content-security-policy',"default-src 'self'; frame-ancestors 'none'");
  res.end('<main>Generic project</main>');
});
server.listen(4173,'127.0.0.1',()=>console.log('project ready'));
`
    const h = await setup(source)
    const operation = { ...scope, requestId: 'interactive-native' }
    let access: RuntimeViewAccess | undefined
    let stage = 'admission'
    const http = (
      url: string,
      method = 'GET',
      headers: Record<string, string> = {}
    ): Promise<{
      status: number
      headers: import('node:http').IncomingHttpHeaders
      body: string
    }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          url,
          {
            method,
            headers,
            family: 4,
            lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4)
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (value) => {
              body += value
            })
            res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
            res.once('error', reject)
          }
        )
        req.setTimeout(2000, () => req.destroy(new Error('Fixture HTTP timeout')))
        req.once('error', reject)
        req.end()
      })
    try {
      const admitted = await h.service.execute({
        ...h.environment,
        requestId: operation.requestId,
        command: 'node "$OPEN_SCIENCE_INPUT_DIR/main.mjs"',
        localServicePort: 4173,
        timeoutMs: 20000,
        projectView: {
          title: 'Generic project',
          adaptFrameAncestors: true,
          allowedRequestHeaders: ['x-fixture-token']
        },
        outputs: [{ path: 'result.json', filename: 'result.json', contentType: 'application/json' }]
      })
      await vi.waitFor(
        async () => {
          const active = await h.service.inspectExecution({
            ...scope,
            operationId: admitted.operationId
          })
          expect(active?.run?.status).toBe('running')
          expect(active?.run?.text.stdout).toContain('project ready')
          expect((await h.service.getOperation(operation))?.notebookRunIds).toEqual([])
          access = await h.views.open(
            { ...scope, runId: active!.identity.runId! },
            'native-viewer',
            ['http://127.0.0.1:4111']
          )
        },
        { timeout: 15000 }
      )
      stage = 'viewer bootstrap'
      const bootstrap = await http(access!.url)
      expect(bootstrap.status).toBe(303)
      const origin = new URL(access!.url).origin
      const cookie = bootstrap.headers['set-cookie']![0].split(';')[0]
      stage = 'project page'
      const page = await http(origin + '/', 'GET', { cookie })
      expect(page.status).toBe(200)
      expect(page.body).toContain('Generic project')
      stage = 'project action'
      const action = await http(origin + '/act', 'POST', {
        cookie,
        origin,
        'x-fixture-token': 'project-token'
      })
      expect(action.status).toBe(200)
      const result = JSON.parse(action.body)
      expect(result.actions).toBe(1)
      expect(['EACCES', 'EPERM']).toContain(result.tcp)
      expect(['EACCES', 'EPERM']).toContain(result.adapterWrite)
      stage = 'project stop'
      // The owning process may finish and revoke its transport before its last response is flushed.
      // Do not repeat a possibly committed action; confirm its outcome through the execution owner.
      const stopping = await http(origin + '/stop', 'POST', { cookie, origin }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ECONNRESET') throw error
          return undefined
        }
      )
      if (stopping) expect(stopping.status).toBe(200)
      const done = await h.operations.wait(operation)
      expect(done).toMatchObject({ status: 'completed' })
      expect(done!.notebookRunIds).toHaveLength(1)
      expect(h.views.describe({ ...scope, runId: done!.notebookRunIds[0] })[0]?.state).toBe(
        'closed'
      )
      expect(() => process.kill(result.pid, 0)).toThrow()
      const terminal = await h.service.inspectExecution({
        ...scope,
        operationId: admitted.operationId
      })
      expect(terminal?.run?.text.stdout).toContain('action 1')
      expect(terminal?.artifacts).toHaveLength(2)
      expect(h.kernelExecute).not.toHaveBeenCalled()
      await expect(h.service.releaseEnvironment(h.environment)).resolves.toMatchObject({
        state: 'released'
      })
    } catch (error) {
      throw new Error(`Native interactive acceptance failed during ${stage}: ${String(error)}`, {
        cause: error
      })
    } finally {
      h.views.close()
      await h.operations.close()
      await h.environments.close()
      const stopped = await h.notebook.shutdownAll()
      await h.notebook.dispose()
      await h.sandbox.dispose()
      if (stopped.reaped) await h.fixture.dispose()
      expect(stopped.reaped).toBe(true)
    }
  },
  40000
)

it.skipIf(process.platform !== 'darwin')(
  'leases a local profile to the real Node process and redacts its output without publishing credentials',
  async () => {
    const secret = 'test-key-real-native-process-47321809'
    const driver = `import fs from 'node:fs'; import path from 'node:path';
    const key = process.env.PROVIDER_API_KEY;
    if (!key) throw new Error('Credential missing');
    process.stdout.write(key.slice(0, 9));
    await new Promise(resolve => setTimeout(resolve, 25));
    process.stdout.write(key.slice(9) + '\\n');
    fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_OUTPUT_DIR, 'result.json'), JSON.stringify({ credentialProvided: !!key, model: process.env.MODEL }));`
    const h = await setup(driver, true)
    try {
      const selection = {
        ...scope,
        sourceSessionId: 'synthetic-source',
        sourceIdentity: sha(driver),
        descriptorVersionId: 'research-descriptor',
        planKey: 'original'
      }
      const missing = await h.service.preflight(selection)
      expect(missing.status).toBe('blocked')
      expect(missing.issues).toContainEqual({ code: 'credential-required', key: 'provider' })
      const profile = await h.service.saveExecutionProfile({
        ...selection,
        descriptorSha256: missing.binding!.descriptorSha256,
        displayName: 'Local test service',
        variables: { MODEL: 'test-model' },
        credentials: { provider: secret },
        allowedNetworkHosts: []
      })
      expect(
        await h.service.preflight({ ...selection, profileId: profile.profileId })
      ).toMatchObject({ status: 'ready', remoteServicesVerified: false })
      const operation = { ...scope, requestId: 'profile-run' }
      await h.service.execute({
        ...h.environment,
        requestId: operation.requestId,
        profileId: profile.profileId,
        command: 'node "$OPEN_SCIENCE_INPUT_DIR/main.mjs"',
        outputs: [{ path: 'result.json', filename: 'result.json' }],
        timeoutMs: 15000
      })
      const done = await h.operations.wait(operation)
      expect(done, JSON.stringify(done)).toMatchObject({ status: 'completed' })
      const runs = (
        await h.notebooks.readSessionDocuments(scope.projectId, scope.sessionId)
      ).flatMap((document) => document.runs)
      expect(runs).toHaveLength(1)
      expect(JSON.stringify(runs)).not.toContain(secret)
      expect(runs[0].text.stdout).toContain('[redacted]')
      for (const id of done!.artifactVersionIds) {
        const version = await h.fixture.client.artifactVersion.findUniqueOrThrow({ where: { id } })
        const contents = await readFile(join(h.root, version.contentStorageKey), 'utf8')
        expect(contents).not.toContain(secret)
      }
      const resultVersion = await h.fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: done!.artifactVersionIds[0] }
      })
      expect(
        JSON.parse(await readFile(join(h.root, resultVersion.contentStorageKey), 'utf8'))
      ).toEqual({ credentialProvided: true, model: 'test-model' })
      await expect(h.service.releaseEnvironment(h.environment)).resolves.toMatchObject({
        state: 'released'
      })
      expect(h.kernelExecute).not.toHaveBeenCalled()
    } finally {
      h.views.close()
      await h.operations.close()
      await h.environments.close()
      const stopped = await h.notebook.shutdownAll()
      await h.notebook.dispose()
      await h.sandbox.dispose()
      if (stopped.reaped) await h.fixture.dispose()
      expect(stopped.reaped).toBe(true)
    }
  },
  40000
)

it.skipIf(process.platform !== 'darwin')(
  'stops publication when a real workload writes a leased credential to its selected output',
  async () => {
    const secret = 'fixture-unpublishable-key-673629'
    const driver = `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_OUTPUT_DIR, 'result.json'), JSON.stringify({ key: process.env.PROVIDER_API_KEY }));`
    const h = await setup(driver, true)
    try {
      const selection = {
        ...scope,
        sourceSessionId: 'synthetic-source',
        sourceIdentity: sha(driver),
        descriptorVersionId: 'research-descriptor',
        planKey: 'original'
      }
      const preflight = await h.service.preflight(selection)
      const profile = await h.service.saveExecutionProfile({
        ...selection,
        descriptorSha256: preflight.binding!.descriptorSha256,
        displayName: 'Output screening test',
        credentials: { provider: secret }
      })
      const operation = { ...scope, requestId: 'profile-output-screening' }
      await h.service.execute({
        ...h.environment,
        requestId: operation.requestId,
        profileId: profile.profileId,
        command: 'node "$OPEN_SCIENCE_INPUT_DIR/main.mjs"',
        outputs: [{ path: 'result.json', filename: 'result.json' }],
        timeoutMs: 15000
      })
      const done = await h.operations.wait(operation)
      expect(done).toMatchObject({ status: 'failed', artifactVersionIds: [] })
      expect(done!.error).toContain('contains a configured credential')
      expect(JSON.stringify(done)).not.toContain(secret)
      const environment = await h.environments.get(h.environment)
      expect(environment.pendingCollection).toBeDefined()
      await h.service.discardOutputs({
        ...h.environment,
        collectionId: environment.pendingCollection!.collectionId
      })
      await expect(h.service.releaseEnvironment(h.environment)).resolves.toMatchObject({
        state: 'released'
      })
    } finally {
      h.views.close()
      await h.operations.close()
      await h.environments.close()
      const stopped = await h.notebook.shutdownAll()
      await h.notebook.dispose()
      await h.sandbox.dispose()
      if (stopped.reaped) await h.fixture.dispose()
      expect(stopped.reaped).toBe(true)
    }
  },
  40000
)

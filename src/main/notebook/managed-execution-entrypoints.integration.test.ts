import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionPackageService } from '../session-package/service'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { createManagedExecutionTurnPort } from './managed-execution-port'
import { ManagedExecutionService } from './managed-execution-service'
import {
  ManagedResearchEnvironmentOwner,
  type ManagedResearchRuntime
} from './managed-research-environment'
import {
  createSessionOperationTestHarness,
  operationTestScope as scope
} from './session-operation.test-support'
import type { ManagedExecutionProvenance } from './managed-execution-output'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

type Entry = 'external' | 'ordinary' | 'fork'
async function verifyEntry(entry: Entry): Promise<void> {
  const h = await createSessionOperationTestHarness(cleanups, {
    canonicalStorageRoot: true,
    nativeSandbox: false
  })
  if (entry === 'fork')
    await h.mutate(scope, (session) => ({
      ...session,
      forkOrigin: {
        importId: 'copy',
        sourceProjectId: 'source-project',
        sourceSessionId: 'source-session',
        importedAt: 1,
        manifestChecksum: 'a'.repeat(64)
      }
    }))
  const executable = await realpath(process.execPath)
  const runtime: ManagedResearchRuntime = {
    kind: 'node',
    executable,
    version: process.versions.node,
    sha256: sha(await readFile(executable)),
    platform: process.platform as 'darwin' | 'linux',
    arch: process.arch,
    readOnlyRoots: [dirname(executable)]
  }
  // This boundary suite exercises real Notebook and Artifact publication with the test sandbox.
  const environments = new ManagedResearchEnvironmentOwner({
    dataRoot: await realpath(h.fixture.storageRoot),
    socketRoot: await realpath(tmpdir()),
    verifyRuntime: async () => undefined,
    stopExecution: async (identity) => ({
      verified: (await h.notebook.confirmManagedShellCleanup(identity, { retry: true })).reaped
    })
  })
  cleanups.push(() => environments.close())
  const content = 'fixed research source'
  const service = new ManagedExecutionService({
    artifacts: h.artifacts,
    dataRoot: h.fixture.storageRoot,
    notebooks: h.fixture.notebookRepository,
    environments,
    operations: h.owner,
    runtime: h.notebook,
    runtimes: {
      discover: async () => ({ runtimes: [{ runtimeId: sha('runtime'), runtime }] }),
      resolve: async () => runtime
    },
    materials: async () => ({
      source: {
        projectId: scope.projectId,
        sessionId: 'source',
        identity: 'fixed-source-identity'
      },
      versions: [
        {
          versionId: 'input-version',
          sourceIdentity: 'fixed-source-identity',
          filename: 'source.txt',
          sha256: sha(content),
          sizeBytes: Buffer.byteLength(content)
        }
      ],
      readVersion: async () => Buffer.from(content)
    }),
    resolvePreparedInputs: async () => [],
    createSession: async () => {
      throw new Error('No extra Session may be created.')
    },
    withWritableSession: async (_identity, operation) => operation()
  })
  const prepared = (await service.prepare({
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    requestId: 'prepare',
    sourceSessionId: 'source',
    sourceIdentity: 'fixed-source-identity',
    runtimeId: sha('runtime'),
    materials: {
      files: [{ versionId: 'input-version', restorePath: 'source.txt' }]
    }
  })) as { environmentId: string }
  const input = {
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    environmentId: prepared.environmentId,
    requestId: scope.requestId,
    command: 'printf "value,42\\n" > "$OPEN_SCIENCE_OUTPUT_DIR/result.csv"',
    outputs: [
      { path: 'result.csv', filename: 'result.csv', contentType: 'text/csv' },
      { path: 'optional-missing.txt', filename: 'optional-missing.txt', optional: true }
    ]
  }
  if (entry === 'external') {
    await service.execute(input)
  } else {
    await h.owner.start({
      ...scope,
      requestFingerprint: sha('native turn'),
      requestText: 'Use the prepared research in this current turn.',
      execute: async (context, signal) => {
        const handle = h.artifactTurns.handleForExecution(context.operationId)
        const artifactRunId = h.artifactTurns.snapshot(handle).runId
        const port = createManagedExecutionTurnPort({
          dataRoot: h.fixture.storageRoot,
          service,
          artifacts: h.artifacts,
          notebooks: h.fixture.notebookRepository,
          trackArtifactWrite: (sessionId, executionId, write) => {
            expect(sessionId).toBe(scope.sessionId)
            expect(executionId).toBe(context.operationId)
            return h.artifactTurns.trackWrite(handle, write)
          }
        })
        const turn = Object.freeze({
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          ownerExecutionId: context.operationId,
          artifactRunId,
          artifactStorageSessionId: scope.sessionId,
          workspaceCwd: context.workspaceCwd,
          invocationId: 'native-call',
          provenanceContext: context.provenanceContext as ManagedExecutionProvenance,
          signal,
          assertActive: () => signal.throwIfAborted()
        })
        const result = await port.call('execute', input, turn)
        expect(result).toMatchObject({ status: 'completed' })
        expect(h.artifactTurns.snapshot(handle).phase).toBe('open')
        expect(await port.call('execute', input, turn)).toEqual(result)
        return { text: 'Current turn used the shared execution core.' }
      }
    })
  }
  const done = await h.owner.wait(scope)
  expect(done, JSON.stringify(done)).toMatchObject({
    status: 'completed'
  })
  const session = (await h.read(scope))!
  expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  expect(session.artifacts).toHaveLength(2)
  expect(session.activeRun).toBeUndefined()
  const output = session.artifacts!.find((artifact) => artifact.name === 'result.csv')!
  const receipt = session.artifacts!.find((artifact) => artifact.name?.startsWith('execution-'))!
  expect(await readFile(output.path, 'utf8')).toBe('value,42\n')
  const runs = await h.fixture.notebookRepository.readSessionRuns(scope.projectId, scope.sessionId)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({
    status: 'completed',
    promptMessageId: session.messages.find((message) => message.role === 'user')!.id
  })
  const report = JSON.parse(await readFile(receipt.path, 'utf8'))
  expect(report).toMatchObject({
    kind: 'managed-research-execution',
    result: {
      runId: runs[0].runId,
      status: 'completed',
      missingOptionalOutputs: ['optional-missing.txt']
    }
  })
  expect(report.runtime).not.toHaveProperty('executable')
  expect(h.kernelExecute).not.toHaveBeenCalled()
  if (entry === 'external') {
    await h.snapshots.captureFinalizedMessages(session)
    const exporter = new SessionPackageService({
      storageRoot: h.fixture.storageRoot,
      getClient: async () => h.fixture.client
    })
    cleanups.push(() => exporter.close())
    const path = join(h.fixture.storageRoot, 'managed-result.science')
    await exporter.exportTo({ projectId: scope.projectId, sessionId: scope.sessionId }, path)
    const target = await createProvenanceTestFixture()
    cleanups.push(target.dispose)
    const importer = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    cleanups.push(() => importer.close())
    const imported = await importer.importFrom(path)
    const origin = await importer.readOrigin(imported)
    const version = await target.client.artifactVersion.findUniqueOrThrow({
      where: { id: origin.identities[output.versionId!] }
    })
    expect(await readFile(join(target.storageRoot, version.contentStorageKey), 'utf8')).toBe(
      'value,42\n'
    )
    const importedRuns = await target.notebookRepository.readSessionRuns(
      imported.projectId,
      imported.sessionId
    )
    expect(importedRuns).toHaveLength(1)
    expect(importedRuns[0].runId).toBe(origin.identities[runs[0].runId])
    expect(importedRuns[0].status).toBe('completed')
    expect(version.producerRunId).toBe(importedRuns[0].runId)
  }
}

it.skipIf(process.platform === 'win32').each(['external', 'ordinary', 'fork'] as const)(
  'runs the %s entry through the real shared core, managed Notebook Run, and existing Artifact publication',
  (entry) => verifyEntry(entry)
)

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))

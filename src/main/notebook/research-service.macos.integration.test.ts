import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { x as extractTar } from 'tar'
import { expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { createManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import { initDataRoot } from '../storage-root'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

configureTestRuntimeMetadata()

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const isMac = process.platform === 'darwin'

type ServiceFixture = {
  root: string
  projectId: string
  sessionId: string
  workspace: string
  materialRoot: string
  node: string
  port: number
  output: string
  repository: NotebookRunRepository
  owner: NotebookNetworkSandboxOwner
  service: NotebookRuntimeService
  scope: { projectId: string; sessionId: string; workspaceCwd: string }
  command: (mode: string, source?: string) => string
  references: string[]
  sockets: Map<string, string>
  preload: string
  close: () => Promise<void>
}

async function setup(existingRoot?: string): Promise<ServiceFixture> {
  if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Select an independent Node >=22 for stage-one integration checks')
  }
  const root = existingRoot ?? (await realpath(await mkdtemp(join(tmpdir(), 'research-service-'))))
  initDataRoot(root)
  const projectId = 'research-project'
  const sessionId = 'reproduction-session'
  const workspaceLease = await createManagedSessionWorkspaceCapability({
    resolveRoot: () => root
  }).acquire({ projectId })
  await workspaceLease.commit(sessionId)
  const workspace = workspaceLease.cwd
  const materialRoot = join(root, 'materials')
  await mkdir(materialRoot)
  const driver = join(materialRoot, 'driver.mjs')
  await copyFile(
    join(process.cwd(), 'src/main/notebook/fixtures/research-service-driver.mjs'),
    driver
  )
  const preload = join(materialRoot, 'preload.mjs')
  await copyFile(join(process.cwd(), 'src/main/notebook/node-local-service-preload.mjs'), preload)
  const node = await realpath(process.execPath)
  const port = 4173 // Application-level Host/Origin identity only; no TCP port is opened.
  const output = join(workspace, 'output')
  const repository = new NotebookRunRepository(root)
  const owner = new NotebookNetworkSandboxOwner({
    resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
    temporaryRoot: join(root, 'commands'),
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    requestDecision: async () => 'deny'
  })
  const references: string[] = []
  const sockets = new Map<string, string>()
  // Test-only trusted composition. No descriptor, user script or public API can grant this policy.
  // The real sandbox, Notebook run allocation, persistence and process owner are not mocked.
  const sandbox: NotebookProcessSandbox = {
    async wrap(invocation) {
      if (
        invocation.projectId !== projectId ||
        invocation.sessionId !== sessionId ||
        !invocation.executionReference
      ) {
        throw new Error('Unexpected execution identity for research fixture')
      }
      references.push(invocation.executionReference)
      const directory = await mkdtemp(`/private/tmp/os-service-${invocation.executionReference}-`)
      await chmod(directory, 0o700)
      const socketPath = join(directory, 'service.sock')
      sockets.set(invocation.executionReference, socketPath)
      return owner.wrap({
        ...invocation,
        env: {
          ...invocation.env,
          HOME: workspace,
          PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          OPEN_SCIENCE_SERVICE_SOCKET: socketPath,
          OPEN_SCIENCE_SERVICE_PORT: String(port)
        },
        filesystem: {
          readOnlyRoots: [
            materialRoot,
            dirname(node),
            ...invocation.filesystem.readOnlyRoots.filter((path) => path.startsWith(`${root}/`))
          ],
          readWriteRoots: [
            workspace,
            directory,
            ...invocation.filesystem.readWriteRoots.filter((path) => path.startsWith(`${root}/`))
          ],
          deniedReadRoots: invocation.filesystem.deniedReadRoots,
          deniedWriteRoots: [...invocation.filesystem.deniedWriteRoots, materialRoot]
        },
        localService: { executionId: invocation.executionReference, socketPath }
      })
    }
  }
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId,
    repository,
    processSandbox: sandbox,
    shellExecutionMode: 'bounded',
    shellBackgroundExecutionEnabled: true
  })
  const scope = { projectId, sessionId, workspaceCwd: workspace }
  const command = (mode: string, source?: string): string =>
    [node, driver, mode, String(port), output, ...(source ? [source] : [])]
      .map(shellQuote)
      .join(' ')
  return {
    root,
    projectId,
    sessionId,
    workspace,
    materialRoot,
    node,
    port,
    output,
    repository,
    owner,
    service,
    scope,
    command,
    references,
    sockets,
    preload,
    async close() {
      const disposed = await service.dispose()
      await owner.dispose()
      expect(disposed.reaped, `Cleanup unverified; retained ${root}`).toBe(true)
      for (const socketPath of sockets.values())
        await rm(dirname(socketPath), { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function ready(
  output: string
): Promise<{ child: number; descendant?: number; [key: string]: unknown }> {
  let result: { child: number; descendant?: number; [key: string]: unknown } | undefined
  await vi.waitFor(
    async () => {
      result = JSON.parse(await readFile(join(output, 'ready.json'), 'utf8'))
      expect(result?.child).toBeGreaterThan(0)
    },
    { timeout: 20_000, interval: 25 }
  )
  return result!
}

async function assertStopped(
  result: { child: number; descendant?: number },
  sockets: Iterable<string>
): Promise<void> {
  // Query only the exact PIDs reported by the fixture we created; never scan or signal other work.
  await vi.waitFor(
    () => {
      for (const pid of [result.child, result.descendant].filter(
        (value): value is number => value !== undefined
      )) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    },
    { timeout: 10_000, interval: 25 }
  )
  for (const socketPath of sockets) {
    await expect(
      new Promise((resolve, reject) => {
        const request = httpRequest({ socketPath, path: '/health', timeout: 1000 }, resolve)
        request.on('error', reject)
        request.on('timeout', () => request.destroy(new Error('Unexpected live socket')))
        request.end()
      })
    ).rejects.toThrow()
  }
}

it.skipIf(!isMac).each(['normal', 'orphan'])(
  'records a bounded service run and reaps owned descendants (%s)',
  async (mode) => {
    const context = await setup()
    try {
      const result = await context.service.executeShell({
        ...context.scope,
        command: context.command(mode),
        timeoutMs: 20_000
      })
      expect(result.exitCode, JSON.stringify(result)).toBe(0)
      const probe = await ready(context.output)
      await assertStopped(probe, context.sockets.values())
      const document = await context.repository.findExisting(context.projectId, context.sessionId)
      expect(document?.runs).toHaveLength(1)
      const run = document!.runs[0]
      expect(run.status).toBe('completed')
      expect(context.references).toContain(run.runId)
      expect(document?.sessionId).toBe(context.sessionId)
      expect(await readFile(join(context.output, 'result.json'), 'utf8')).toContain(
        'synthetic-engineering-fixture'
      )
      const ordinary = await context.service.executeShell({
        ...context.scope,
        command: 'printf ordinary-shell'
      })
      expect(ordinary.stdout).toBe('ordinary-shell')
    } finally {
      await context.close()
    }
  },
  60_000
)

it
  .skipIf(!isMac)
  .each(['cancel', 'timeout', 'session-delete', 'project-delete', 'update', 'quit'] as const)(
  'stops a real service before lifecycle completion (%s)',
  async (action) => {
    const context = await setup()
    try {
      const receipt = await context.service.executeShellBackground({
        ...context.scope,
        command: context.command('hold'),
        background: true,
        timeoutMs: action === 'timeout' ? 4000 : 30_000
      })
      const probe = await ready(context.output)
      const active = await context.repository.findExisting(context.projectId, context.sessionId)
      expect(active?.runs.find((run) => run.runId === receipt.runId)?.status).toBe('running')
      if (action === 'cancel')
        await context.service.cancelBackgroundRun({ ...context.scope, runId: receipt.runId })
      if (action === 'session-delete') await context.service.shutdownSession(context.sessionId)
      if (action === 'project-delete') await context.service.shutdownProject(context.projectId)
      if (action === 'update') await context.service.shutdownAll()
      if (action === 'quit') await context.service.dispose()
      await assertStopped(probe, context.sockets.values())
      await vi.waitFor(
        async () => {
          const document = await context.repository.findExisting(
            context.projectId,
            context.sessionId
          )
          const run = document?.runs.find((item) => item.runId === receipt.runId)
          expect(run?.endedAt).toBeTypeOf('number')
          expect(['running', 'queued']).not.toContain(run?.status)
        },
        { timeout: 10_000 }
      )
      const ownership = join(context.root, 'shell-process-ownership')
      const receipts = await readdir(ownership).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      expect(receipts.filter((name) => name.endsWith('.json'))).toEqual([])
    } finally {
      await context.close()
    }
  },
  60_000
)

const coldOwnerHandoff = process.env.OPEN_SCIENCE_STAGE1_COLD_OWNER_HANDOFF
const coldOwnerTest = 'private bounded-service crash owner fixture'

// Only the subprocess selected by the recovery test enables this fixture. Killing this worker
// loses all in-memory supervision; the next owner must rely on the ordinary durable receipts.
it.skipIf(!isMac || !coldOwnerHandoff)(
  coldOwnerTest,
  async () => {
    const context = await setup(join(dirname(coldOwnerHandoff!), 'data'))
    const receipt = await context.service.executeShellBackground({
      ...context.scope,
      command: context.command('hold'),
      background: true,
      timeoutMs: 60_000
    })
    const probe = await ready(context.output)
    await writeFile(
      coldOwnerHandoff!,
      JSON.stringify({
        root: context.root,
        projectId: context.projectId,
        sessionId: context.sessionId,
        runId: receipt.runId,
        ownerPid: process.pid,
        probe,
        sockets: [...context.sockets.values()]
      })
    )
    process.kill(process.pid, 'SIGKILL')
    await new Promise(() => {})
  },
  60_000
)

it.skipIf(!isMac || Boolean(coldOwnerHandoff))(
  'recovers a bounded service after its real owner process crashes',
  async () => {
    const controlRoot = await realpath(await mkdtemp(join(tmpdir(), 'research-service-cold-')))
    const root = join(controlRoot, 'data')
    await mkdir(root)
    const handoff = join(controlRoot, 'handoff.json')
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/notebook/research-service.macos.integration.test.ts',
        '-t',
        `^${coldOwnerTest}$`,
        '--maxWorkers=1'
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPEN_SCIENCE_STAGE1_COLD_OWNER_HANDOFF: handoff },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const closed = once(child, 'close')
    let diagnostics = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-8192)
      })
    }
    let verified = false
    let scope:
      | {
          root: string
          projectId: string
          sessionId: string
          runId: string
          ownerPid: number
          probe: { child: number; descendant?: number }
          sockets: string[]
        }
      | undefined
    try {
      await vi.waitFor(
        async () => {
          scope = JSON.parse(await readFile(handoff, 'utf8'))
          expect(scope?.root).toBe(root)
        },
        { timeout: 30_000, interval: 50 }
      )
      const [code] = await closed
      expect(code, diagnostics).not.toBe(0)
      expect(scope!.ownerPid).not.toBe(process.pid)
      expect(() => process.kill(scope!.ownerPid, 0)).toThrow()
      initDataRoot(root)
      const repository = new NotebookRunRepository(root)
      const before = await repository.findExisting(scope!.projectId, scope!.sessionId)
      expect(before?.runs.find((run) => run.runId === scope!.runId)?.status).toBe('running')
      expect(
        (await readdir(join(root, 'shell-process-ownership'))).filter((path) =>
          path.endsWith('.json')
        )
      ).toHaveLength(1)
      const restarted = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: scope!.projectId,
        repository,
        shellExecutionMode: 'bounded',
        shellBackgroundExecutionEnabled: true
      })
      await restarted.recoverInterruptedOperations()
      await assertStopped(scope!.probe, scope!.sockets)
      expect(
        (await readdir(join(root, 'shell-process-ownership'))).filter((path) =>
          path.endsWith('.json')
        )
      ).toEqual([])
      const recovered = await repository.findExisting(scope!.projectId, scope!.sessionId)
      const run = recovered?.runs.find((item) => item.runId === scope!.runId)
      expect(run?.endedAt).toBeTypeOf('number')
      expect(['running', 'queued']).not.toContain(run?.status)
      expect((await restarted.dispose()).reaped).toBe(true)
      const secondRestart = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: scope!.projectId,
        repository,
        shellExecutionMode: 'bounded',
        shellBackgroundExecutionEnabled: true
      })
      await secondRestart.recoverInterruptedOperations()
      expect(await repository.findExisting(scope!.projectId, scope!.sessionId)).toEqual(recovered)
      expect((await secondRestart.dispose()).reaped).toBe(true)
      verified = true
    } finally {
      if (verified) {
        for (const socketPath of scope!.sockets)
          await rm(dirname(socketPath), { recursive: true, force: true })
        await rm(controlRoot, { recursive: true, force: true })
      } else {
        // No guessed cleanup: a failed cold owner proof retains all scoped evidence for inspection.
        console.error(`Cold service recovery unverified; retained ${controlRoot}. ${diagnostics}`)
      }
    }
  },
  90_000
)

// Optional local acceptance case: ordinary CI uses only synthetic portable fixtures above.
// The fixed snapshot is prepared explicitly by scripts/research/prepare-git-snapshot.mjs.
const materialsDirectory = process.env.OPEN_SCIENCE_STAGE1_TUANZI_MATERIALS
it.skipIf(!isMac || !materialsDirectory)(
  'boots the pinned tuanzi snapshot with zero model calls and a redacted receipt',
  async () => {
    const context = await setup()
    try {
      const manifest = JSON.parse(
        await readFile(join(materialsDirectory!, 'source-manifest.json'), 'utf8')
      )
      const archive = join(materialsDirectory!, 'source.tar.gz')
      const archiveBytes = await readFile(archive)
      // The separate material-preparation tool verifies every Git-object entry. Keep this probe
      // pinned too; an environment variable is not authorization to launch an arbitrary checkout.
      expect(digest(archiveBytes)).toBe(
        'd5f267593b8a184e2aaccd6dfd803d8394e27b605889cd5236dd044b86aa25c2'
      )
      expect(JSON.stringify(manifest)).toContain('b6d5810fef3baac1195c980fe728ce7a8a69408b')
      await extractTar({
        file: archive,
        cwd: context.materialRoot,
        gzip: true,
        preservePaths: false
      })
      const source = join(context.materialRoot, 'project')
      const result = await context.service.executeShell({
        ...context.scope,
        command: context.command('tuanzi', source),
        timeoutMs: 20_000
      })
      expect(result.exitCode, JSON.stringify(result)).toBe(0)
      const receipt = await ready(context.output)
      expect(receipt).toMatchObject({
        kind: 'engineering-startup-only',
        version: '0.5.6',
        providerCalls: 0,
        experimentsStarted: 0,
        jevReady: false,
        llmReady: false,
        iframeEmbeddingForbidden: true
      })
      expect(JSON.stringify(receipt)).not.toMatch(/token|api.key/i)
      await assertStopped(receipt, context.sockets.values())
      const outputReport = process.env.OPEN_SCIENCE_STAGE1_REPORT
      if (outputReport) {
        await writeFile(
          outputReport,
          JSON.stringify(
            {
              ...receipt,
              sourceCommit: 'b6d5810fef3baac1195c980fe728ce7a8a69408b',
              archiveSha256: digest(archiveBytes),
              nodeSha256: digest(await readFile(context.node)),
              transport: 'http-over-managed-unix-socket',
              adapterSha256: digest(await readFile(context.preload)),
              serviceStopped: true,
              recordedNotebookRun: (
                await context.repository.findExisting(context.projectId, context.sessionId)
              )?.runs[0]?.runId
            },
            null,
            2
          )
        )
      }
    } finally {
      await context.close()
    }
  },
  60_000
)

import * as fsPromises from 'node:fs/promises'
import { PackageCleanupPendingError } from './cleanup'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createProvenanceTestFixture,
  createArtifactVersionRequest
} from '../artifacts/provenance-test-fixtures'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from './service'
import { createPackageInspector, type InspectionWorkerInput } from './inspection-worker'
import { inspectSessionPackage } from './inspection'
import { PackageCapacityError } from './capacity'
import { withPackageTransfer } from './transfer'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
let bundleRoot: string
let workerFile: string
const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
const roots: string[] = []
const workers: Worker[] = []
const validationRoots: string[] = []
beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'package-worker-bundle-'))
  await symlink(resolve('node_modules'), join(bundleRoot, 'node_modules'), 'junction')
  workerFile = join(bundleRoot, 'inspection.mjs')
  const result = await build({
    entryPoints: [resolve('src/main/session-package/inspection-worker-entry.ts')],
    outfile: workerFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true
  })
  // A normal Node worker must not load desktop app/keychain bindings, even transitively.
  expect(
    Object.values(result.metafile!.outputs)
      .flatMap((output) => output.imports)
      .some((entry) => entry.path === 'electron')
  ).toBe(false)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  validationRoots.length = 0
})
afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true })
})
const createWorker = (options: WorkerOptions): Worker => {
  validationRoots.push((options.workerData as InspectionWorkerInput).temporaryRoot)
  const worker = new Worker(workerFile, options)
  workers.push(worker)
  return worker
}
const fixture = async (
  artifact = false
): Promise<{ source: (typeof fixtures)[number]; archive: string }> => {
  const source = await createProvenanceTestFixture()
  fixtures.push(source)
  await source.client.project.create({ data: { id: 'project-1', name: 'Research' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Inspection',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'message',
        role: 'user',
        content: 'research evidence '.repeat(4096),
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 2
      }
    ]
  })
  if (artifact) {
    await source.stagePng('plot')
    await source.repository.createVersion(createArtifactVersionRequest())
  }
  const service = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  const archive = join(source.storageRoot, 'research.science')
  try {
    await service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  } finally {
    await service.close()
  }
  return { source, archive }
}

it.each(['inspect', 'import'] as const)(
  'keeps package Session parsing off main before %s preview',
  async (action) => {
    const { archive } = await fixture()
    const target = await createProvenanceTestFixture()
    fixtures.push(target)
    const options = {
      storageRoot: target.storageRoot,
      getClient: async () => target.client,
      inspectPackage: createPackageInspector(createWorker)
    }
    const service = new SessionPackageService(options)
    let sessionParses = 0
    const parse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      const value = parse(text, reviver)
      if (value?.version === 2 && value.session?.id === 'session-1') sessionParses++
      return value
    })
    try {
      if (action === 'inspect') {
        await expect(service.inspect(archive)).resolves.toMatchObject({
          title: 'Inspection',
          messageCount: 1
        })
        expect(sessionParses).toBe(0)
      } else {
        const imported = await service.importFrom(
          archive,
          undefined,
          undefined,
          async (preview) => {
            expect(preview.messageCount).toBe(1)
            expect(sessionParses).toBe(0)
            expect(await target.client.project.count()).toBe(0)
          }
        )
        expect(
          (
            await new SessionRepository(target.storageRoot).loadSession(
              imported.projectId,
              imported.sessionId
            )
          )?.messages
        ).toHaveLength(1)
      }
      expect(workers).toHaveLength(1)
      for (const root of validationRoots)
        await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await service.close()
    }
  }
)

it('matches inline native validation and uses the parent pacing owner', async () => {
  const { source, archive } = await fixture(true)
  const inline = await inspectSessionPackage(
    archive,
    join(source.storageRoot, 'inline'),
    new AbortController().signal
  )
  let rateReads = 0
  const speeds: number[] = []
  const preview = await withPackageTransfer(
    () =>
      createPackageInspector(createWorker)(
        archive,
        join(source.storageRoot, 'worker'),
        new AbortController().signal
      ),
    () => {
      rateReads++
      return (rateReads > 1 ? 32 : 16) * 1024 ** 2
    },
    (speed) => speeds.push(speed)
  )
  expect(preview).toEqual(inline)
  expect(rateReads).toBeGreaterThan(1)
  expect(speeds.length).toBeGreaterThan(0)
  for (const root of validationRoots)
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects malformed archives without retaining validation files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'package-worker-malformed-'))
  roots.push(root)
  const archive = join(root, 'broken.science')
  await writeFile(archive, 'not an archive')
  await expect(
    createPackageInspector(createWorker)(
      archive,
      join(root, 'source'),
      new AbortController().signal
    )
  ).rejects.toThrow()
  for (const path of validationRoots)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['cancel', 'timeout'] as const)(
  'joins a worker stuck in synchronous work before %s cleans its files',
  async (mode) => {
    if (mode === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let worker!: Worker
    let root = ''
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const inspect = createPackageInspector((options) => {
      root = (options.workerData as InspectionWorkerInput).temporaryRoot
      worker = new Worker(
        "const {parentPort,workerData}=require('node:worker_threads'); require('node:fs').writeFileSync(require('node:path').join(workerData.temporaryRoot,'owned'), 'evidence'); parentPort.postMessage('started'); while(true) {}",
        { ...options, eval: true }
      )
      workers.push(worker)
      worker.once('message', started)
      return worker
    })
    const controller = new AbortController()
    const reason = new Error('User cancelled inspection')
    const directory = await mkdtemp(join(tmpdir(), 'package-worker-cancel-'))
    roots.push(directory)
    const result = inspect('unused', directory, controller.signal)
    const rejected =
      mode === 'cancel'
        ? expect(result).rejects.toBe(reason)
        : expect(result).rejects.toThrow('made no progress for ten minutes')
    await ready
    const exited = once(worker, 'exit')
    if (mode === 'cancel') controller.abort(reason)
    else await vi.advanceTimersByTimeAsync(10 * 60_000)
    await rejected
    await exited
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it.each(['crash', 'exit', 'capacity'] as const)(
  'cleans an unsuccessful worker: %s',
  async (kind) => {
    let root = ''
    const scripts = {
      crash: "throw new Error('worker failed')",
      exit: 'process.exit(0)',
      capacity:
        "require('node:worker_threads').parentPort.postMessage({kind:'error',message:'capacity',capacity:{directory:'target',requiredBytes:100,freeBytes:20}})"
    }
    const inspect = createPackageInspector((options) => {
      root = (options.workerData as InspectionWorkerInput).temporaryRoot
      const worker = new Worker(scripts[kind], { ...options, eval: true })
      workers.push(worker)
      return worker
    })
    const directory = await mkdtemp(join(tmpdir(), 'package-worker-failure-'))
    roots.push(directory)
    const result = inspect('unused', directory, new AbortController().signal)
    if (kind === 'capacity')
      await expect(result).rejects.toMatchObject({
        constructor: PackageCapacityError,
        directory: 'target',
        requiredBytes: 100,
        freeBytes: 20
      })
    else
      await expect(result).rejects.toThrow(
        kind === 'crash' ? 'worker failed' : 'inspection stopped'
      )
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it('does not publish an import when worker validation cleanup remains pending', async () => {
  const { archive } = await fixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(target)
  const service = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client,
    inspectPackage: createPackageInspector(createWorker)
  })
  const remove = fsPromises.rm
  let failed = false
  vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (!failed && String(path).includes('.inspection-')) {
      failed = true
      throw Object.assign(new Error('inspection cleanup denied'), { code: 'EACCES' })
    }
    return remove(path, options)
  })
  const confirm = vi.fn(async () => undefined)
  try {
    const error = await service
      .importFrom(archive, undefined, undefined, confirm)
      .catch((error) => error)
    expect(error).toBeInstanceOf(PackageCleanupPendingError)
    expect(error.outcome).toEqual({ error: expect.any(Error) })
    expect(confirm).not.toHaveBeenCalled()
    expect(await target.client.project.count()).toBe(0)
    expect((await new SessionRepository(target.storageRoot).loadAll()).sessions).toHaveLength(0)
    await error.retryCleanup()
    expect(workers).toHaveLength(1)
    expect(await readdir(join(target.storageRoot, 'session-package-imports'))).toEqual([])
  } finally {
    await service.close()
  }
})

it('contains a worker heap limit failure and removes its validation directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'package-worker-memory-'))
  roots.push(directory)
  let root = ''
  const inspect = createPackageInspector((options) => {
    root = (options.workerData as InspectionWorkerInput).temporaryRoot
    const worker = new Worker(
      'const retained = []; while (true) retained.push(new Array(100000).fill(1))',
      {
        ...options,
        eval: true,
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 }
      }
    )
    workers.push(worker)
    return worker
  })
  await expect(inspect('unused', directory, new AbortController().signal)).rejects.toMatchObject({
    code: 'ERR_WORKER_OUT_OF_MEMORY'
  })
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFile,
  utimes,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = appBuilderRequire('@electron/asar')
const workerPath = resolve('resources/notebook/file_evidence_worker.js')

// Each child has a 10 s handshake plus startup/exit time. Allow the initial worker,
// reader cleanup and optional recovery worker to settle before Vitest tears down the fixture.
const childTimeoutMs = 15_000
const publicationTimeoutMs = 3 * childTimeoutMs

// Pause immediately before the real rename so a real Windows reader can acquire its handle.
// Neither the filesystem call nor its Windows error is mocked.
const preload = `
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PUBLICATION_FIXTURE;
fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify({
  electron: process.versions.electron, node: process.versions.node, execPath: process.execPath
}));
const original = fs.renameSync;
let announced = false;
let changed = false;
fs.renameSync = (source, target) => {
  if (!announced) {
    announced = true;
    fs.writeFileSync(path.join(root, 'target.txt'), path.resolve(target));
    fs.writeFileSync(path.join(root, 'target-ready'), 'ready');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(root, 'locked'))) {
      if (Date.now() > deadline) throw new Error('Windows reader failed to acquire its handle');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return original(source, target); }
  catch (error) {
    fs.appendFileSync(path.join(root, 'attempts.jsonl'), JSON.stringify({
      code: error.code, previous: fs.readFileSync(target, 'utf8'),
      source: path.basename(source), next: fs.readFileSync(source, 'utf8')
    }) + '\\n');
    fs.writeFileSync(path.join(root, 'denied'), 'ready');
    const change = '__CHANGE_MODE__';
    if (change && !changed) {
      changed = true;
      fs.writeFileSync(change === 'source' ? source : target, JSON.stringify({ phase: 'foreign' }));
    }
    throw error;
  }
};
`

const readerScript = `
param([string]$Fixture, [int]$HoldMilliseconds)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$targetFile = Join-Path $Fixture 'target.txt'
while (!(Test-Path -LiteralPath (Join-Path $Fixture 'target-ready'))) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Worker did not reach publication' }
  Start-Sleep -Milliseconds 10
}
$target = [IO.File]::ReadAllText($targetFile)
$reader = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [IO.File]::WriteAllText((Join-Path $Fixture 'locked'), 'ready')
  $denialDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath (Join-Path $Fixture 'denied'))) {
    if ([DateTime]::UtcNow -gt $denialDeadline) { throw 'Worker did not attempt the locked rename' }
    Start-Sleep -Milliseconds 10
  }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath (Join-Path $Fixture 'release'))) {
    if ($HoldMilliseconds -gt 0 -and $watch.ElapsedMilliseconds -ge $HoldMilliseconds) { break }
    if ($watch.ElapsedMilliseconds -gt 10000) { throw 'Reader release was not requested' }
    Start-Sleep -Milliseconds 10
  }
} finally { $reader.Dispose() }
`

type ChildResult = { code: number | null; stdout: string; stderr: string }
type WorkerRuntime = { executable: string; worker: string; electron: boolean }
type PublicationResult = {
  result: ChildResult
  attempts: { code: string; previous: string; source: string; next: string }[]
  receipt: { phase: string }
  files: string[]
  recovery?: { result: ChildResult; receipt: { phase: string } }
}

const runChild = (
  command: string,
  args: string[],
  cwd: string,
  input?: string,
  withoutSystemPath = false
): Promise<ChildResult> => {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...(withoutSystemPath ? { PATH: '', Path: '', NODE_OPTIONS: '' } : {}),
      PUBLICATION_FIXTURE: cwd,
      ELECTRON_RUN_AS_NODE: '1'
    },
    windowsHide: true,
    timeout: childTimeoutMs,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.stdin.end(input)
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

it('publishes an import-owned project receipt when the worker cannot create hard links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'import-no-links-'))
  try {
    const preloadPath = join(root, 'deny-links.cjs')
    await writeFile(
      preloadPath,
      "require('node:fs').linkSync = () => { throw Error('hard links disabled') }"
    )
    const metadata = await stat(root)
    const result = await runChild(
      process.execPath,
      ['--require', preloadPath, workerPath],
      root,
      JSON.stringify({
        operation: 'ensure-project',
        importOperationId: 'a5722944-8803-47e3-a8c3-a1fe725a8708',
        projectName: 'imported',
        expectedRootIdentity: { dev: metadata.dev, ino: metadata.ino }
      })
    )
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(
      JSON.parse(await readFile(join(root, '.project-ownership-imported.json'), 'utf8'))
    ).toMatchObject({
      phase: 'owned',
      ownershipToken: 'a5722944-8803-47e3-a8c3-a1fe725a8708'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const exercisePublication = async (
  runtime: WorkerRuntime,
  holdMilliseconds: number,
  change = ''
): Promise<PublicationResult> => {
  const root = await mkdtemp(join(tmpdir(), 'evidence 用户 data '))
  let reader: ReturnType<typeof runChild> | undefined
  try {
    await writeFile(join(root, 'pause.cjs'), preload.replace('__CHANGE_MODE__', change))
    await writeFile(join(root, 'reader.ps1'), readerScript)
    const metadata = await stat(root)
    reader = runChild(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(root, 'reader.ps1'),
        root,
        String(holdMilliseconds)
      ],
      root
    )
    const result = await runChild(
      runtime.executable,
      ['--require', join(root, 'pause.cjs'), runtime.worker],
      root,
      JSON.stringify({
        operation: 'ensure-project',
        projectName: 'project-1',
        expectedRootIdentity: { dev: metadata.dev, ino: metadata.ino }
      }),
      runtime.electron
    )
    const runtimeInfo = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
    expect(Boolean(runtimeInfo.electron)).toBe(runtime.electron)
    await writeFile(join(root, 'release'), '')
    expect(await reader).toMatchObject({ code: 0, stderr: '' })
    const attempts = (await readFile(join(root, 'attempts.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const receipt = JSON.parse(
      await readFile(join(root, '.project-ownership-project-1.json'), 'utf8')
    )
    const files = await readdir(root)
    let recovery: PublicationResult['recovery']
    if (holdMilliseconds === 0 && !change) {
      // The previous receipt remains the recovery authority after the retry budget expires.
      const retried = await runChild(
        runtime.executable,
        [runtime.worker],
        root,
        JSON.stringify({
          operation: 'ensure-project',
          projectName: 'project-1',
          expectedRootIdentity: { dev: metadata.dev, ino: metadata.ino }
        }),
        runtime.electron
      )
      recovery = {
        result: retried,
        receipt: JSON.parse(await readFile(join(root, '.project-ownership-project-1.json'), 'utf8'))
      }
    }
    return { result, attempts, receipt, files, recovery }
  } finally {
    await writeFile(join(root, 'release'), '')
    await reader
    await rm(root, { recursive: true, force: true })
  }
}

it(
  'retains captured inputs across a failed directory rename and recovers a crash before the published receipt',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'evidence-rename-retry-'))
    try {
      const pool = join(root, 'blobs')
      await mkdir(pool)
      const snapshot = async (
        path: string
      ): Promise<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }> => {
        const { dev, ino, size, mtimeMs, ctimeMs } = await stat(path)
        return { dev, ino, size, mtimeMs, ctimeMs }
      }
      const request = {
        expectedRootIdentity: await snapshot(root),
        blobRoot: pool,
        expectedBlobRootIdentity: await snapshot(pool),
        blobStorageKeyPrefix: 'project/blobs',
        activityId: 'run',
        activityKind: 'notebook-run',
        evidenceId: 'evidence-run',
        receiptName: 'receipt-run.json',
        stagingName: 'staging-run',
        finalName: 'activity-run',
        storageKeyPrefix: 'project/session',
        maxEvidenceBytes: 65536,
        maxActivityBytes: 65536,
        maxGenerationBytes: 1024,
        availableBytes: 1048576,
        diskReserveBytes: 0,
        rootKinds: ['data'],
        rootsAvailable: true,
        reasonCodes: [],
        readPaths: [],
        changes: [],
        scientificOutputs: []
      }
      const run = (extra: Record<string, unknown>, hook?: string): Promise<ChildResult> =>
        runChild(
          process.execPath,
          [...(hook ? ['--require', hook] : []), workerPath],
          root,
          JSON.stringify({ ...request, ...extra })
        )
      const input = join(root, 'input.csv')
      await writeFile(input, 'capture these bytes')
      expect(
        (
          await run({
            operation: 'begin',
            initialViewState: 'complete',
            initialFiles: [
              {
                file: {
                  physicalPath: input,
                  path: input,
                  relativePath: 'data/input.csv',
                  kind: 'other',
                  ...(await snapshot(input))
                },
                generation: {
                  generationId: 'input-generation',
                  capturedAt: '2026-10-20T00:00:00.000Z'
                }
              }
            ]
          })
        ).code
      ).toBe(0)

      // Create a real non-empty destination immediately before the OS rename. On retry terminate the
      // worker just after the OS rename, before it can touch the capture or its durable receipt.
      const hook = join(root, 'interrupt.cjs')
      await writeFile(
        hook,
        `
const fs = require('node:fs')
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  if (from !== 'staging-run' || to !== 'activity-run') return rename(from, to)
  if (!fs.existsSync('stop-after-rename')) {
    fs.mkdirSync(to)
    fs.writeFileSync(to + '/foreign', 'keep')
  }
  rename(from, to)
  process.exit(42)
}
`
      )
      const digestName = (bytes: string): string =>
        'sha256-' + createHash('sha256').update(bytes).digest('hex')
      const persistOutput = async (bytes: string): Promise<ChildResult> => {
        const output = join(root, 'output.csv')
        await writeFile(output, bytes)
        const after = {
          physicalPath: output,
          path: output,
          relativePath: 'data/output.csv',
          kind: 'other',
          ...(await snapshot(output))
        }
        return run(
          {
            operation: 'persist',
            changes: [
              {
                change: { relation: 'created', relativePath: after.relativePath, after },
                generation: {
                  generationId: 'output-generation',
                  capturedAt: '2026-10-20T00:00:01.000Z'
                }
              }
            ]
          },
          hook
        )
      }
      const capture = join(root, request.stagingName, 'capture.json')
      const original = await readFile(capture)
      expect((await persistOutput('first output')).code).toBe(1)
      expect(await readFile(capture)).toEqual(original)
      const links = await readdir(join(root, request.stagingName, 'blobs'))
      expect(links.sort()).toEqual(
        [digestName('capture these bytes'), digestName('first output')].sort()
      )
      expect(
        await readFile(
          join(root, request.stagingName, 'blobs', digestName('capture these bytes')),
          'utf8'
        )
      ).toBe('capture these bytes')
      expect(await readFile(join(root, request.finalName, 'foreign'), 'utf8')).toBe('keep')
      await rm(join(root, request.finalName), { recursive: true })
      // Historical workers could leave a staged sidecar with no capture. Do not adopt it.
      await rm(capture)
      expect((await run({ operation: 'persist' })).code).toBe(1)
      expect(await readdir(root)).not.toContain(request.finalName)
      await writeFile(capture, original)
      await writeFile(join(root, 'stop-after-rename'), '')
      expect((await persistOutput('retried output')).code).toBe(42)
      const recovered = await run({ operation: 'recover-published' })
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        ok: true,
        recoveredFileEvidence: { activityId: 'run', generationCount: 1 }
      })
      expect(await readdir(join(root, request.finalName, 'blobs'))).toEqual([
        digestName('retried output')
      ])
      expect(await readdir(join(root, request.finalName))).not.toContain('capture.json')
      expect(JSON.parse(await readFile(join(root, request.receiptName), 'utf8'))).toMatchObject({
        phase: 'published'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  publicationTimeoutMs
)

it(
  'publishes isolated lane logs, protects active and single-link evidence, and isolates corrupt tails',
  async () => {
    const project = await mkdtemp(join(tmpdir(), 'shadow-lanes-'))
    const pool = join(project, 'blobs')
    const a = join(project, 's')
    const b = join(a, 'frames', 'b')
    const other = join(project, 't')
    const file = join(project, 'input')
    const shadowLog = (lane: string): string => join(lane, '.shadow-evidence', 'log.jsonl')
    const identity = async (
      path: string
    ): Promise<{ dev: number; ino: number; size: number; ctimeMs: number; mtimeMs: number }> => {
      const { dev, ino, size, ctimeMs, mtimeMs } = await stat(path)
      return { dev, ino, size, ctimeMs, mtimeMs }
    }
    const call = async (
      lane: string,
      id: string,
      op: string,
      extra = {},
      crashAfterRename?: string
    ): Promise<{
      shadowError?: string
      fileEvidence: { activityId: string; checksum: string; storageKey: string }
    }> => {
      const laneKey = lane === b ? 's/frames/b' : lane === other ? 't' : 's'
      const request = {
        operation: op,
        activityId: id,
        activityKind: 'notebook-run',
        evidenceId: 'execution-file-evidence-' + id,
        receiptName: 'receipt-' + id + '.json',
        stagingName: 'staging-' + id,
        finalName: 'activity-' + id,
        blobRoot: pool,
        expectedBlobRootIdentity: await identity(pool),
        expectedRootIdentity: await identity(lane),
        blobStorageKeyPrefix: 'execution-file-evidence/p/blobs',
        storageKeyPrefix: 'execution-file-evidence/p/' + laneKey,
        availableBytes: 1e8,
        maxActivityBytes: 1e6,
        maxEvidenceBytes: 1e7,
        maxGenerationBytes: 1e6,
        diskReserveBytes: 0,
        initialViewState: 'complete',
        initialFiles: [],
        reasonCodes: [],
        changes: [],
        readPaths: [],
        scientificOutputs: [],
        rootsAvailable: true,
        rootKinds: ['handoff'],
        ...extra
      }
      const args = crashAfterRename ? ['--require', crashAfterRename, workerPath] : [workerPath]
      const result = await runChild(process.execPath, args, lane, JSON.stringify(request))
      if (result.code !== 0) throw new Error(result.stdout || 'worker exited ' + result.code)
      return JSON.parse(result.stdout)
    }
    const begin = async (lane: string, id: string, content: string): Promise<string> => {
      await writeFile(file, content)
      await call(lane, id, 'begin', {
        initialFiles: [
          {
            file: { physicalPath: file, relativePath: 'handoff/input', ...(await identity(file)) },
            generation: { generationId: id + '-gen', capturedAt: '2026-11-10T00:00:00Z' }
          }
        ]
      })
      return join(pool, 'sha256-' + createHash('sha256').update(content).digest('hex'))
    }
    const sweep = (): ReturnType<typeof call> =>
      call(other, 'gc', 'reconcile', {
        retained: [],
        deferredActivityIds: [],
        deferredActivityKinds: ['notebook-run']
      })
    try {
      for (const dir of [pool, b, other]) await mkdir(dir, { recursive: true })
      const first = await begin(a, 'a', 'exclusive')
      const active = await begin(other, 'active', 'in flight')
      await utimes(active, new Date(0), new Date(0))
      // A copied/restored pending capture can lose its activity link. Its durable
      // receipt still roots the initial checksum even after the grace period.
      const activeName = 'sha256-' + createHash('sha256').update('in flight').digest('hex')
      const activeLink = join(other, 'staging-active', 'blobs', activeName)
      await rm(activeLink)
      await writeFile(activeLink, 'in flight')
      expect((await stat(active)).nlink).toBe(1)
      await sweep()
      await expect(readFile(active, 'utf8')).resolves.toBe('in flight')
      await call(a, 'a', 'persist')
      await utimes(first, new Date(0), new Date(0))
      expect((await stat(first)).nlink).toBe(1)
      await sweep()
      await expect(readFile(first, 'utf8')).resolves.toBe('exclusive')
      await expect(readFile(active, 'utf8')).resolves.toBe('in flight')
      // A new-format run has no activity alias even while executing. Another lane's
      // collector must keep the old pooled input through a real process restart.
      await writeFile(file, 'long-running input')
      const pinned = 'sha256-' + createHash('sha256').update('long-running input').digest('hex')
      const activeId = 'pinned'
      await call(other, activeId, 'begin', {
        poolAddressed: true,
        initialFiles: [
          {
            file: { physicalPath: file, relativePath: 'handoff/input', ...(await identity(file)) },
            generation: { generationId: 'long-gen', capturedAt: '2026-11-10T00:00:00Z' }
          }
        ]
      })
      expect((await stat(join(pool, pinned))).nlink).toBe(1)
      await utimes(join(pool, pinned), new Date(0), new Date(0))
      await writeFile(file, 'overwritten')
      await sweep()
      expect(await readFile(join(pool, pinned), 'utf8')).toBe('long-running input')
      await call(other, activeId, 'cleanup')
      await expect(stat(join(pool, pinned))).rejects.toMatchObject({ code: 'ENOENT' })
      await call(a, 'settling', 'begin', { poolAddressed: true })
      const { fileEvidence: published } = await call(a, 'settling', 'persist')
      const interrupt = join(project, 'interrupt-settlement.cjs')
      await writeFile(
        interrupt,
        `const fs=require('node:fs'); const rename=fs.renameSync;
fs.renameSync=(from,to)=>{rename(from,to);if(from==='activity-settling' && to.startsWith('deleting-'))process.exit(83)}`
      )
      await expect(call(a, 'settling', 'complete', published, interrupt)).rejects.toThrow(
        'worker exited 83'
      )
      const committed = await readFile(shadowLog(a))
      await call(a, 'settling', 'complete', published)
      expect(await readFile(shadowLog(a))).toEqual(committed)
      expect(
        (await readdir(a)).some((name) => name.includes('settling') || name.startsWith('deleting-'))
      ).toBe(false)
      await begin(b, 'b', 'shared')
      expect((await call(b, 'b', 'persist')).shadowError).toBeUndefined()
      const original = await readFile(shadowLog(b))
      if (process.platform === 'win32') {
        const volume = await runChild(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            '[IO.DriveInfo]::new([IO.Path]::GetPathRoot((Get-Location).Path)).DriveFormat'
          ],
          b,
          ''
        )
        expect(volume.stdout.trim()).toBe('NTFS')
      }
      await appendFile(shadowLog(b), Buffer.from([123, 0, 0, 0]))
      await begin(b, 'b2', 'shared')
      expect((await call(b, 'b2', 'persist')).shadowError).toBeUndefined()
      const clean = await readFile(shadowLog(b), 'utf8')
      expect(clean.split('\n').filter(Boolean)).toHaveLength(2)
      expect(clean.startsWith(original.toString())).toBe(true)
      const bad = clean.replace('"activityId":"b2"', '"activityId":"bx"')
      await writeFile(shadowLog(b), bad)
      await begin(b, 'b3', 'shared')
      await call(b, 'new-corrupt', 'begin', { poolAddressed: true })
      await expect(call(b, 'new-corrupt', 'persist')).rejects.toThrow(/checksum/)
      await call(b, 'new-corrupt', 'cleanup')
      const damaged = await call(b, 'b3', 'persist')
      expect(damaged.shadowError).toMatch(/checksum/)
      expect(damaged.fileEvidence.activityId).toBe('b3')
      expect(await readFile(shadowLog(b), 'utf8')).toBe(bad)
      await begin(other, 'healthy', 'shared')
      expect((await call(other, 'healthy', 'persist')).shadowError).toBeUndefined()
      // Both activities begin in the same lane and finish in reverse order. Each log
      // record must still describe its own captured input, even when paths coincide.
      await begin(other, 'older', 'first input')
      await begin(other, 'newer', 'second input')
      for (const id of ['newer', 'older'])
        expect((await call(other, id, 'persist')).shadowError).toBeUndefined()
      const lines = (await readFile(shadowLog(other), 'utf8')).trimEnd().split('\n')
      for (const [i, content] of ['second input', 'first input'].entries()) {
        const record = JSON.parse(lines[lines.length - 2 + i].split('\t')[0])
        const rows = [
          [
            'handoff/input',
            createHash('sha256').update(content).digest('hex'),
            Buffer.byteLength(content)
          ]
        ]
        expect(record.pre).toBe(createHash('sha256').update(JSON.stringify(rows)).digest('hex'))
      }
      const views = join(other, '.shadow-evidence', 'views')
      const beforeViews = (await readdir(views)).sort()
      const beforeLog = await readFile(shadowLog(other))
      const orphan = createHash('sha256').update('[]').digest('hex')
      await writeFile(join(views, orphan), JSON.stringify({ rows: [] }), { flag: 'wx' })
      await begin(other, 'bounded', 'new bytes')
      // The lane log alone already uses this budget, before counting the other
      // lanes, their views and the shared pool. No new view may be published.
      const bounded = await call(other, 'bounded', 'persist', {
        maxEvidenceBytes: beforeLog.length
      })
      expect(bounded.shadowError).toMatch(/project budget/)
      expect(bounded.fileEvidence.activityId).toBe('bounded')
      expect(await readFile(shadowLog(other))).toEqual(beforeLog)
      expect((await readdir(views)).sort()).toEqual(beforeViews)
      await rm(a, { recursive: true })
      await sweep()
      await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(active, 'utf8')).resolves.toBe('in flight')
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  },
  publicationTimeoutMs
)

describe.skipIf(process.platform !== 'win32')('file-evidence Windows atomic publication', () => {
  describe.each(['source Node', 'packaged Electron'] as const)('%s', (mode) => {
    let packageRoot: string | undefined
    let runtime: WorkerRuntime
    beforeAll(async () => {
      runtime = { executable: process.execPath, worker: workerPath, electron: false }
      if (mode !== 'packaged Electron') return
      packageRoot = await mkdtemp(join(tmpdir(), 'evidence 安装 layout '))
      const source = join(packageRoot, 'source')
      const notebook = join(source, 'resources', 'notebook')
      const resources = join(packageRoot, 'installed app 程序', 'resources')
      await mkdir(notebook, { recursive: true })
      await mkdir(resources, { recursive: true })
      // A user-selected installation ancestor may belong to an unrelated ESM project.
      await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}')
      await writeFile(join(source, 'package.json'), '{"type":"commonjs"}')
      await copyFile(
        join(workerPath, '..', 'file_evidence_codec.mjs'),
        join(notebook, 'file_evidence_codec.mjs')
      )
      await copyFile(workerPath, join(notebook, 'file_evidence_worker.js'))
      await copyFile(
        join(workerPath, '..', 'file_evidence_shadow.js'),
        join(notebook, 'file_evidence_shadow.js')
      )
      await copyFile(resolve('resources/notebook/package.json'), join(notebook, 'package.json'))
      await createPackageWithOptions(source, join(resources, 'app.asar'), {
        unpackDir: 'resources'
      })
      runtime = {
        executable: require('electron') as string,
        worker: join(
          resources,
          'app.asar.unpacked',
          'resources',
          'notebook',
          'file_evidence_worker.js'
        ),
        electron: true
      }
    })
    afterAll(async () => {
      if (packageRoot) await rm(packageRoot, { recursive: true, force: true })
    })
    it(
      'publishes the complete receipt after a reader releases its delete-sharing restriction',
      async () => {
        const { result, attempts, receipt } = await exercisePublication(runtime, 350)
        expect(attempts.length).toBeGreaterThan(0)
        expect(attempts.every((attempt) => attempt.code === 'EPERM')).toBe(true)
        expect(attempts.every((attempt) => JSON.parse(attempt.previous).phase === 'prepared')).toBe(
          true
        )
        expect(new Set(attempts.map((attempt) => attempt.source)).size).toBe(1)
        expect(new Set(attempts.map((attempt) => attempt.next)).size).toBe(1)
        expect(result).toMatchObject({ code: 0, stderr: '' })
        expect(JSON.parse(result.stdout)).toEqual({ ok: true, projectOwned: true })
        expect(receipt.phase).toBe('owned')
      },
      publicationTimeoutMs
    )

    it(
      'fails within its retry budget and preserves the old receipt when the reader stays open',
      async () => {
        const { result, attempts, receipt, files, recovery } = await exercisePublication(runtime, 0)
        expect(result.code).toBe(1)
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: expect.stringContaining('EPERM')
        })
        expect(attempts).toHaveLength(7)
        expect(receipt.phase).toBe('prepared')
        expect(
          files.filter((name) => name.startsWith('.receipt-') && name.endsWith('.tmp'))
        ).toHaveLength(1)
        expect(recovery?.result).toMatchObject({ code: 0, stderr: '' })
        expect(JSON.parse(recovery!.result.stdout)).toEqual({ ok: true, projectOwned: true })
        expect(recovery?.receipt.phase).toBe('owned')
      },
      publicationTimeoutMs
    )

    it.each(['source', 'destination'])(
      'rejects a changed %s before attempting another replacement',
      async (change) => {
        const { result, attempts, receipt } = await exercisePublication(runtime, 0, change)
        expect(result.code).toBe(1)
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: 'File-evidence receipt changed during atomic replacement.'
        })
        expect(attempts).toHaveLength(1)
        expect(receipt.phase).toBe(change === 'destination' ? 'foreign' : 'prepared')
      },
      publicationTimeoutMs
    )
  })
})

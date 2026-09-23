import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const workerPath = resolve('resources/notebook/file_evidence_worker.js')

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
      await copyFile(workerPath, join(notebook, 'file_evidence_worker.js'))
      await copyFile(resolve('resources/notebook/package.json'), join(notebook, 'package.json'))
      await createPackageWithOptions(source, join(resources, 'app.asar'), {
        unpackDir: 'resources'
      })
      runtime = {
        executable: createRequire(import.meta.url)('electron') as string,
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
    it('publishes the complete receipt after a reader releases its delete-sharing restriction', async () => {
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
    })

    it('fails within its retry budget and preserves the old receipt when the reader stays open', async () => {
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
    })

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
      }
    )
  })
})

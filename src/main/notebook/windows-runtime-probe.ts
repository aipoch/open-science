import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { NotebookProcessSandbox, NotebookSandboxedSpawn } from './process-sandbox'
import { buildNotebookKernelEnvironment } from './process-environment'
import {
  WindowsRuntimeIncompatibleError,
  type WindowsRuntimeComponentSelection
} from './windows-runtime-components'

// The native host publishes termination proof after Job reaping and ACL rollback, which can lag
// process exit on cold disks. Poll within a bounded window instead of sampling a single instant.
const confirmTerminationWithRetry = async (
  confirm: (() => Promise<boolean>) | undefined,
  signal?: AbortSignal
): Promise<boolean> => {
  if (!confirm) return false
  const deadline = Date.now() + 30_000
  for (;;) {
    if ((await confirm().catch(() => false)) === true) return true
    if (Date.now() >= deadline || signal?.aborted) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// Uses the real native launcher and its termination receipt, including on failed or timed-out probes.
// A cleanup error is never converted into a compatibility failure that permits another candidate.
export const probeWindowsRuntimeComponent = async (
  selection: WindowsRuntimeComponentSelection,
  wrap: NotebookProcessSandbox['wrap'],
  signal?: AbortSignal,
  onDiagnostic?: (message: string) => void
): Promise<void> => {
  const parent = await mkdtemp(join(tmpdir(), 'notebook-runtime-probe-'))
  const cwd = join(parent, 'workspace')
  await mkdir(cwd)
  const privateFile = join(parent, 'private.txt')
  await writeFile(privateFile, 'fixture-private')
  const node = selection.release.component === 'node'
  const code = node
    ? `const assert = require('node:assert/strict');
       const fs = require('node:fs');
       const cp = require('node:child_process');
       assert.throws(() => fs.readFileSync(process.env.OPEN_SCIENCE_PROBE_PRIVATE));
       fs.writeFileSync('probe.txt', 'ok');
       const child = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("PIPE_OK")'], {encoding:'utf8',timeout:5000});
       assert.equal(child.status, 0); assert.equal(child.stdout, 'PIPE_OK');
       import('node:path').then(() => console.log('RUNTIME_PROBE_OK'));`
    : `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
       if ($PSVersionTable.PSVersion.ToString() -ne '${selection.release.version}') { throw 'Version mismatch' }
       if (!(Get-Location).Path) { throw 'FileSystem provider unavailable' }
       if (!(Get-PSDrive -Name Temp -ErrorAction Stop).Root) { throw 'Temporary drive unavailable' }
       Set-Content -LiteralPath './probe.txt' -Value 'ok';
       if ((Get-Content -LiteralPath './probe.txt').Trim() -ne 'ok') { throw 'Workspace access failed' }
       $blocked = $false; try { [IO.File]::ReadAllText($env:OPEN_SCIENCE_PROBE_PRIVATE) | Out-Null } catch { $blocked = $true }
       if (!$blocked) { throw 'Private file was readable' }
       Write-Output 'RUNTIME_PROBE_OK'`
  const env = buildNotebookKernelEnvironment('win32')
  // A clean AppContainer (including over-the-shoulder setup under another administrator) may
  // have no profile Temp folder. Match normal execution by supplying an already granted folder.
  env.TEMP = cwd
  env.TMP = cwd
  env.TMPDIR = cwd
  env.OPEN_SCIENCE_PROBE_PRIVATE = privateFile
  env.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
  env.PSModulePath = join(dirname(selection.executable), 'Modules')
  env.OPEN_SCIENCE_PSMODULEPATH = env.PSModulePath
  let prepared: NotebookSandboxedSpawn | undefined
  let started = false
  let failure: unknown
  let endExecution: (() => void) | undefined
  let admission: ReturnType<NonNullable<NotebookSandboxedSpawn['beginSpawn']>> | undefined
  try {
    prepared = await wrap({
      executable: selection.executable,
      args: node
        ? ['-e', code]
        : [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(code, 'utf16le').toString('base64')
          ],
      env,
      cwd,
      commandText: 'Verify Windows runtime compatibility',
      runtime: node ? 'repl' : 'bash',
      sessionId: 'runtime-preparation',
      projectId: 'runtime-preparation',
      windowsProtectionRequired: true,
      filesystem: {
        readOnlyRoots: [selection.root],
        readWriteRoots: [cwd],
        deniedReadRoots: [privateFile],
        deniedWriteRoots: [privateFile]
      },
      signal
    })
    endExecution = prepared.beginExecution?.()
    admission = prepared.beginSpawn?.()
    const execution = promisify(execFile)(prepared.executable, [...prepared.args], {
      env: prepared.env,
      cwd,
      windowsHide: true,
      // Bound the complete native operation, including recursive ACL grants and rollback over
      // the runtime tree. The child can finish quickly while Windows is still restoring ACLs.
      // Killing the owner after only 30 seconds can destroy its cleanup evidence on slower disks.
      timeout: 90_000,
      signal,
      maxBuffer: 1024 * 1024
    })
    started = execution.child.pid !== undefined
    if (started) admission?.started()
    else admission?.notStarted()
    admission = undefined
    const { stdout, stderr } = await execution
    if (!stdout.includes('RUNTIME_PROBE_OK') || stderr.trim()) {
      // The fixed probe contains no user script or credentials. Keep bounded output so startup
      // provider errors can be distinguished from runtime/launcher diagnostics on clean hosts.
      throw new Error(
        `Windows runtime isolation probe did not complete cleanly: ${JSON.stringify({
          stdout: stdout.slice(-4096),
          stderr: stderr.slice(-4096)
        })}`
      )
    }
  } catch (error) {
    admission?.notStarted()
    failure = error
  } finally {
    endExecution?.()
  }
  if (
    !prepared &&
    failure instanceof Error &&
    failure.name === 'NotebookSandboxPreparationCleanupError'
  )
    throw failure
  const confirmTermination = prepared?.confirmProcessTreeTermination
  const processesTerminated =
    !started || (await confirmTerminationWithRetry(confirmTermination, signal)) === true
  const cleanup = await prepared?.cleanup(
    signal?.aborted ? 'cancel' : started ? 'exit' : 'spawn-failed',
    { processesTerminated, confirmTermination }
  )
  if (
    cleanup &&
    (!cleanup.processesTerminated || !cleanup.networkClosed || !cleanup.temporaryResourcesRemoved)
  ) {
    const detail = `cleanup flags: ${JSON.stringify({
      processesTerminated: cleanup.processesTerminated,
      networkClosed: cleanup.networkClosed,
      temporaryResourcesRemoved: cleanup.temporaryResourcesRemoved
    })}`
    onDiagnostic?.(`windows runtime probe (${selection.release.component}) ${detail}`)
    throw new Error(`Windows runtime probe cleanup could not be confirmed. ${detail}`, {
      cause: failure
    })
  }
  if (started && !processesTerminated && !cleanup?.processesTerminated) {
    onDiagnostic?.(
      `windows runtime probe (${selection.release.component}) termination proof was not published within the confirmation window`
    )
    throw new Error('Windows runtime probe termination could not be confirmed.', { cause: failure })
  }
  await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  signal?.throwIfAborted()
  if (failure) {
    // The selection layer may swallow incompatibility as a candidate skip, so surface the bounded
    // probe output here before the detail is lost.
    const detail = failure instanceof Error ? failure.message : String(failure)
    onDiagnostic?.(
      `windows runtime probe (${selection.release.component}) failed: ${detail.slice(-4096)}`
    )
    throw new WindowsRuntimeIncompatibleError(
      'Windows runtime is incompatible with protected execution.',
      { cause: failure }
    )
  }
}

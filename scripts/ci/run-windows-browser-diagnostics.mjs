/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const netlogName = /^netlog-.*\.json$/

const snapshotNetlogs = (directory) => {
  const snapshot = new Map()
  try {
    for (const name of readdirSync(directory)) {
      if (!netlogName.test(name)) continue
      const path = resolve(directory, name)
      try {
        const { mtimeMs, size } = statSync(path)
        snapshot.set(path, `${mtimeMs}:${size}`)
      } catch {
        // A browser may still be replacing its NetLog while the directory is inspected.
      }
    }
  } catch {
    // The diagnostics directory does not exist before the first browser run.
  }
  return snapshot
}

const hasFreshNoBufferSpace = (directory, before) => {
  const after = snapshotNetlogs(directory)
  for (const [path, fingerprint] of after) {
    if (before.get(path) === fingerprint) continue
    try {
      const netlog = readFileSync(path, 'utf8')
      if (/"os_error"\s*:\s*10055|"net_error"\s*:\s*-176/.test(netlog)) return true
    } catch {
      // Missing diagnostic evidence must never turn a product failure into a retry.
    }
  }
  return false
}

// Query only selected fields; never capture command lines, environment, or endpoint lists.
const query = String.raw`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'chrome.exe' OR Name = 'headless_shell.exe' OR Name = 'chrome-headless-shell.exe'" |
  Select-Object Name,ProcessId,ParentProcessId,CreationDate,HandleCount,WorkingSetSize,PrivatePageCount)
$tcp = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections())
$loopback = @($tcp | Where-Object {
  ($_.LocalEndPoint.Address.ToString() -in @('127.0.0.1', '::1') -and $_.LocalEndPoint.Port -eq 4178) -or
  ($_.RemoteEndPoint.Address.ToString() -in @('127.0.0.1', '::1') -and $_.RemoteEndPoint.Port -eq 4178)
})
@{
  processes = $processes
  tcpStates = @($tcp | Group-Object State | Select-Object Name,Count)
  loopback4178States = @($loopback | Group-Object State | Select-Object Name,Count)
} | ConvertTo-Json -Depth 5 -Compress
`

/** @returns {Promise<number>} */
export async function runWindowsBrowserDiagnostics(
  scriptPath,
  outputPath = 'test-results/browser-diagnostics/windows-resources.ndjson'
) {
  let stopped = false
  let cleanupRequested = false
  let sampleChild
  let sampling
  let timer

  /** @returns {void} */
  const record = (value) => {
    try {
      mkdirSync(dirname(outputPath), { recursive: true })
      appendFileSync(outputPath, JSON.stringify({ runnerPid: process.pid, ...value }) + '\n')
    } catch {
      console.error('Windows browser diagnostics: could not write sample.')
    }
  }

  /** @returns {void} */
  const sample = () => {
    if (sampling || stopped) return
    const startedAt = new Date().toISOString()
    sampling = new Promise((done) => {
      /** @returns {void} */
      const complete = (error, stdout) => {
        const endedAt = new Date().toISOString()
        try {
          if (error) {
            record({
              startedAt,
              endedAt,
              status: 'error',
              reason:
                error.killed && error.code == null
                  ? cleanupRequested
                    ? 'cleanup'
                    : 'query-timeout'
                  : 'command-failure',
              code: error.code ?? null,
              signal: error.signal ?? null,
              killed: Boolean(error.killed)
            })
          } else {
            record({ startedAt, endedAt, status: 'ok', ...JSON.parse(stdout) })
          }
        } catch {
          record({ startedAt, endedAt, status: 'error', code: 'invalid-json' })
        }
        sampleChild = undefined
        done()
      }
      try {
        sampleChild = execFile(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query],
          { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true },
          complete
        )
      } catch {
        complete({ code: 'sample-start-failed' }, '')
      }
    }).finally(() => {
      sampling = undefined
    })
  }

  try {
    // Custom Actions shells do not receive the default pwsh error/exit-code prologue/epilogue.
    // Read the runner's script explicitly: its temporary file need not have a .ps1 extension.
    const quotedPath = resolve(scriptPath).replaceAll("'", "''")
    const runLayout = () => {
      const child = spawn(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create([IO.File]::ReadAllText('${quotedPath}'))); if (Test-Path variable:LASTEXITCODE) { exit $LASTEXITCODE }`
        ],
        { stdio: 'inherit' }
      )
      return new Promise((done) => {
        child.once('error', () => done(1))
        child.once('exit', (code) => done(code ?? 1))
      })
    }
    const diagnosticsDirectory = dirname(outputPath)
    const netlogsBeforeRun = snapshotNetlogs(diagnosticsDirectory)
    sample()
    timer = setInterval(sample, 5000)
    let result = await runLayout()
    if (result !== 0 && hasFreshNoBufferSpace(diagnosticsDirectory, netlogsBeforeRun)) {
      record({
        endedAt: new Date().toISOString(),
        status: 'retry',
        reason: 'windows-no-buffer-space',
        attempt: 1
      })
      result = await runLayout()
    }
    return result
  } finally {
    stopped = true
    clearInterval(timer)
    const pendingChild = sampleChild
    if (pendingChild) {
      const exited = () => pendingChild.exitCode != null || pendingChild.signalCode != null
      const waitForExit = async () => {
        let deadline
        await Promise.race([
          sampling,
          new Promise((done) => {
            deadline = setTimeout(done, 1000)
          })
        ])
        clearTimeout(deadline)
      }
      try {
        // execFile may already have killed the query at its deadline, before its callback runs.
        cleanupRequested = !pendingChild.killed
        if (cleanupRequested && !pendingChild.kill()) {
          cleanupRequested = false
          record({ endedAt: new Date().toISOString(), status: 'error', code: 'sample-stop-failed' })
        }
      } catch {
        cleanupRequested = false
        record({ endedAt: new Date().toISOString(), status: 'error', code: 'sample-stop-failed' })
      }
      await waitForExit()
      if (!exited()) {
        record({ endedAt: new Date().toISOString(), status: 'error', code: 'sample-stop-timeout' })
        try {
          if (Number.isSafeInteger(pendingChild.pid) && pendingChild.pid > 0) {
            cleanupRequested ||= !pendingChild.killed
            execFileSync('taskkill.exe', ['/PID', String(pendingChild.pid), '/T', '/F'], {
              timeout: 1000,
              windowsHide: true,
              stdio: 'ignore'
            })
          } else {
            record({
              endedAt: new Date().toISOString(),
              status: 'error',
              code: 'sample-owned-pid-unavailable'
            })
          }
        } catch {
          record({
            endedAt: new Date().toISOString(),
            status: 'error',
            code: 'sample-taskkill-failed'
          })
        }
        await waitForExit()
        record({
          endedAt: new Date().toISOString(),
          status: exited() ? 'stopped' : 'error',
          code: exited() ? 'sample-exit-confirmed' : 'sample-exit-unconfirmed'
        })
      }
      pendingChild.stdout?.destroy()
      pendingChild.stderr?.destroy()
      pendingChild.unref()
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await runWindowsBrowserDiagnostics(process.argv[2])
    // Do not let an unresponsive diagnostic child extend the bounded cleanup above.
    process.exit(code)
  } catch {
    console.error('Windows browser diagnostics: could not execute layout command.')
    process.exit(1)
  }
}

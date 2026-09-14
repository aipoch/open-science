/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Query only selected fields; never capture command lines, environment, or endpoint lists.
const query = String.raw`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'chrome.exe' OR Name = 'headless_shell.exe' OR Name = 'chrome-headless-shell.exe'" |
  Select-Object Name,ProcessId,ParentProcessId,CreationDate,HandleCount,WorkingSetSize,PrivatePageCount)
$tcp = @(Get-NetTCPConnection)
$loopback = @($tcp | Where-Object {
  ($_.LocalAddress -in @('127.0.0.1', '::1') -and $_.LocalPort -eq 4178) -or
  ($_.RemoteAddress -in @('127.0.0.1', '::1') -and $_.RemotePort -eq 4178)
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
    const result = new Promise((done) => {
      child.once('error', () => done(1))
      child.once('exit', (code) => done(code ?? 1))
    })
    sample()
    timer = setInterval(sample, 5000)
    return await result
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

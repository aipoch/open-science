import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { shell } from 'electron'

import { terminateProcessTree, type ProcessTreeKillResult } from '../process-tree'

type JupyterLabLaunchRequest = {
  sessionId: string
  command: string
  commandArgs?: string[]
  notebookPath: string
  rootDir: string
  cwd: string
  ensureInstalled: () => Promise<void>
}

type JupyterLabLaunchResult = {
  url: string
  alreadyRunning: boolean
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess

type JupyterLabManagerDeps = {
  spawnProcess?: SpawnProcess
  openExternal?: (url: string) => Promise<void>
  terminate?: (child: ChildProcess) => Promise<ProcessTreeKillResult>
  startupTimeoutMs?: number
}

type RunningJupyterLab = {
  child: ChildProcess
  url?: string
}

const JUPYTER_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s]*/i

const probeJupyterLab = async (
  spawnProcess: SpawnProcess,
  command: string,
  commandArgs: string[],
  cwd: string,
  timeoutMs: number
): Promise<boolean> => {
  let child: ChildProcess
  try {
    child = spawnProcess(command, [...commandArgs, '-m', 'jupyterlab', '--version'], {
      cwd,
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {
    return false
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (available: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(available)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(false)
    }, timeoutMs)
    timeout.unref?.()
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  })
}

class JupyterLabManager {
  private readonly running = new Map<string, RunningJupyterLab>()
  private readonly spawnProcess: SpawnProcess
  private readonly openExternal: (url: string) => Promise<void>
  private readonly terminate: (child: ChildProcess) => Promise<ProcessTreeKillResult>
  private readonly startupTimeoutMs: number

  constructor(deps: JupyterLabManagerDeps = {}) {
    this.spawnProcess = deps.spawnProcess ?? spawn
    this.openExternal = deps.openExternal ?? ((url) => shell.openExternal(url))
    this.terminate = deps.terminate ?? ((child) => terminateProcessTree(child))
    this.startupTimeoutMs = deps.startupTimeoutMs ?? 30_000
  }

  async launch(request: JupyterLabLaunchRequest): Promise<JupyterLabLaunchResult> {
    const existing = this.running.get(request.sessionId)
    if (existing?.url && existing.child.exitCode === null) {
      await this.openExternal(existing.url)
      return { url: existing.url, alreadyRunning: true }
    }

    const commandArgs = request.commandArgs ?? []
    const probeTimeoutMs = Math.min(this.startupTimeoutMs, 10_000)
    if (
      !(await probeJupyterLab(
        this.spawnProcess,
        request.command,
        commandArgs,
        request.cwd,
        probeTimeoutMs
      ))
    ) {
      await request.ensureInstalled()
      if (
        !(await probeJupyterLab(
          this.spawnProcess,
          request.command,
          commandArgs,
          request.cwd,
          probeTimeoutMs
        ))
      ) {
        throw new Error('JupyterLab installation completed but the module is still unavailable.')
      }
    }

    const child = this.spawnProcess(
      request.command,
      [
        ...commandArgs,
        '-m',
        'jupyterlab',
        request.notebookPath,
        '--no-browser',
        '--ServerApp.port=0',
        `--ServerApp.root_dir=${request.rootDir}`
      ],
      {
        cwd: request.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const running: RunningJupyterLab = { child }
    this.running.set(request.sessionId, running)

    child.once('exit', () => {
      if (this.running.get(request.sessionId)?.child === child) {
        this.running.delete(request.sessionId)
      }
    })

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false
      let output = ''
      const finish = (error: Error | null, value?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve(value as string)
      }
      const inspect = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`.slice(-16_384)
        const match = output.match(JUPYTER_URL_PATTERN)
        if (match) finish(null, match[0])
      }
      const timeout = setTimeout(
        () => finish(new Error('Timed out waiting for JupyterLab to start.')),
        this.startupTimeoutMs
      )
      timeout.unref?.()
      child.stdout?.on('data', inspect)
      child.stderr?.on('data', inspect)
      child.once('error', (error) => finish(error))
      child.once('exit', (code) => {
        finish(new Error(`JupyterLab exited before startup (code ${String(code)}).`))
      })
    }).catch(async (error: unknown) => {
      this.running.delete(request.sessionId)
      await this.terminate(child)
      throw error
    })

    running.url = url
    await this.openExternal(url)
    return { url, alreadyRunning: false }
  }

  async shutdown(sessionId: string): Promise<ProcessTreeKillResult> {
    const running = this.running.get(sessionId)
    if (!running) return { reaped: true }
    this.running.delete(sessionId)
    return this.terminate(running.child)
  }

  async shutdownAll(): Promise<ProcessTreeKillResult> {
    const children = Array.from(this.running.values(), ({ child }) => child)
    this.running.clear()
    const results = await Promise.all(children.map((child) => this.terminate(child)))
    return { reaped: results.every((result) => result.reaped) }
  }
}

export { JupyterLabManager }
export type { JupyterLabLaunchRequest, JupyterLabLaunchResult, JupyterLabManagerDeps, SpawnProcess }

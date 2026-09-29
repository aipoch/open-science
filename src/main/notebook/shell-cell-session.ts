import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NotebookShellProcessRequest, NotebookShellResult } from './shell-process'
import {
  NOTEBOOK_TEXT_LIMIT_BYTES,
  NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES,
  limitUtf8
} from './content-limits'
import { NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS } from '../../shared/notebook'

type Launch = (
  request: NotebookShellProcessRequest,
  startup: string,
  signal: AbortSignal,
  onProcess: (child: ChildProcessWithoutNullStreams) => void,
  controlPipe?: string
) => Promise<{
  completion: Promise<NotebookShellResult>
  beginExecution: (command: string) => () => void
  retryCleanup?: () => Promise<boolean>
}>

type Cell = {
  marker: string
  stdout: string
  stderr: string
  buffers: { stdout: string; stderr: string }
  ended: { stdout: boolean; stderr: boolean }
  exitCode?: number
  cwd?: string
  truncated: boolean
  resolve: (result: NotebookShellResult) => void
}

const cancelledResult = (): NotebookShellResult => ({
  stdout: '',
  stderr: 'Shell command was cancelled.',
  exitCode: null,
  cancelled: true
})

// One real interpreter per Notebook lane. Transport state lives only in memory; requests are
// serialized and never replayed. The existing process adapter still owns native tree cleanup.
export class ShellCellSession {
  private tail: Promise<unknown> = Promise.resolve()
  private child?: ChildProcessWithoutNullStreams
  private controlServer?: Server
  private controlSocket?: Socket
  private completion?: Promise<NotebookShellResult>
  private processResult?: NotebookShellResult
  private launchedProcess = false
  private cleanupVerified = false
  private retryCleanup?: () => Promise<boolean>
  private lifetime = new AbortController()
  private beginExecution?: (command: string) => () => void
  private cell?: Cell
  private closed = false
  private cwd?: string
  private launchContext?: string
  private readonly protocolName = `__os_cell_${randomUUID().replaceAll('-', '')}`

  constructor(
    readonly identity: NotebookShellProcessRequest,
    private readonly launch: Launch,
    private readonly validate: (request: NotebookShellProcessRequest) => Promise<void>,
    private readonly nativeControl = false
  ) {}

  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    let started = false
    const next = this.tail.then(() => {
      started = true
      return this.run(request)
    })
    this.tail = next.catch(() => undefined)
    if (!request.signal) return next
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (!started) resolve(cancelledResult())
      }
      request.signal!.addEventListener('abort', abort, { once: true })
      if (request.signal!.aborted) abort()
      void next
        .then(resolve, reject)
        .finally(() => request.signal!.removeEventListener('abort', abort))
    })
  }

  async shutdown(): Promise<{ reaped: boolean }> {
    this.closed = true
    this.lifetime.abort()
    await this.tail
    await this.completion
    return { reaped: await this.verifyCleanup() }
  }

  private async verifyCleanup(): Promise<boolean> {
    if (
      this.cleanupVerified ||
      (this.processResult?.ownedTreeReaped !== false &&
        this.processResult?.errorCode !== 'shell-cleanup-incomplete')
    )
      return true
    this.cleanupVerified = (await this.retryCleanup?.().catch(() => false)) === true
    return this.cleanupVerified
  }

  private closeControl(): void {
    this.controlSocket?.destroy()
    this.controlSocket = undefined
    this.controlServer?.close()
    this.controlServer = undefined
  }

  private async openControl(): Promise<{ name: string; connected: Promise<void> }> {
    const name = `OpenScience.Shell.${randomUUID().replaceAll('-', '')}`
    if (this.nativeControl) return { name, connected: Promise.resolve() }
    const lifetime = this.lifetime
    const connected = Promise.withResolvers<void>()
    const server = createServer((socket) => {
      if (lifetime.signal.aborted || this.controlSocket) {
        socket.destroy()
        return
      }
      this.controlSocket = socket
      socket.on('error', () => lifetime.abort())
      // Only the interpreter connects. Stop accepting once its private stream is established.
      server.close()
      connected.resolve()
    })
    this.controlServer = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(`\\\\.\\pipe\\${name}`, () => {
        server.removeListener('error', reject)
        server.on('error', () => lifetime.abort())
        resolve()
      })
    })
    return { name, connected: connected.promise }
  }

  private startup(powershell: boolean, pipeName?: string): string {
    const name = this.protocolName
    return powershell
      ? `$${name}_pipe = [IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [IO.Pipes.PipeDirection]::In); $${name}_pipe.Connect(10000); $${name}_reader = [IO.StreamReader]::new($${name}_pipe); try { while ($null -ne ($${name} = $${name}_reader.ReadLine())) { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($${name})))) } } finally { $${name}_reader.Dispose(); $${name}_pipe.Dispose() }`
      : `while IFS= read -r ${name}; do eval "$${name}"; done`
  }

  private frame(command: string, marker: string, powershell: boolean): string {
    const name = this.protocolName
    if (powershell) {
      const encoded = Buffer.from(command, 'utf8').toString('base64')
      const code = `$global:LASTEXITCODE = 0; $${name}_status = 0; try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) | Out-Default; if (-not $?) { $${name}_status = 1 }; if ($global:LASTEXITCODE -ne 0) { $${name}_status = $global:LASTEXITCODE } } catch { [Console]::Error.WriteLine($_.ToString()); $${name}_status = 1 }; [Console]::Out.Write(([string][char]0) + '${marker}:' + $${name}_status + ':' + (Get-Location).ProviderPath + [char]0); [Console]::Error.Write(([string][char]0) + '${marker}' + [char]0)`
      return Buffer.from(code, 'utf8').toString('base64') + '\n'
    }
    // Octal bytes keep a multiline request on one protocol line without eval escaping or an
    // external decoder. Redirect user stdin so read/cat cannot consume the next cell's frame.
    const encoded = Array.from(Buffer.from(command))
      .map((byte) => '\\' + byte.toString(8).padStart(3, '0'))
      .join('')
    return `eval "$(printf '%b' '${encoded}')" </dev/null; ${name}_status=$?; printf '\\000${marker}:%s:%s\\000' "$${name}_status" "$PWD"; printf '\\000${marker}\\000' >&2\n`
  }

  private accept(stream: 'stdout' | 'stderr', chunk: string): void {
    const cell = this.cell
    if (!cell || cell.ended[stream]) return
    const prefix = `\0${cell.marker}${stream === 'stdout' ? ':' : '\0'}`
    let buffer = cell.buffers[stream] + chunk
    const index = buffer.indexOf(prefix)
    const append = (value: string): void => {
      const budget =
        stream === 'stdout'
          ? NOTEBOOK_TEXT_LIMIT_BYTES - NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES
          : NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES - 512
      const limited = limitUtf8(value, Math.max(0, budget - Buffer.byteLength(cell[stream])))
      cell[stream] += limited.text
      cell.truncated ||= limited.truncated
    }
    if (index < 0) {
      let safe = Math.max(0, buffer.length - prefix.length)
      if (safe > 0 && /[\uD800-\uDBFF]/u.test(buffer[safe - 1])) safe--
      append(buffer.slice(0, safe))
      cell.buffers[stream] = buffer.slice(safe)
      return
    }
    append(buffer.slice(0, index))
    buffer = buffer.slice(index)
    if (stream === 'stdout') {
      const end = buffer.indexOf('\0', prefix.length)
      if (end < 0) {
        cell.buffers[stream] = buffer
        return
      }
      const body = buffer.slice(prefix.length, end)
      const separator = body.indexOf(':')
      const code = Number(body.slice(0, separator))
      if (separator < 0 || !Number.isInteger(code)) return
      cell.exitCode = code
      cell.cwd = body.slice(separator + 1)
    }
    cell.buffers[stream] = ''
    cell.ended[stream] = true
    if (cell.ended.stdout && cell.ended.stderr)
      cell.resolve({
        stdout: cell.stdout,
        stderr: cell.stderr,
        exitCode: cell.exitCode ?? null,
        ...(cell.exitCode !== undefined && cell.exitCode !== 0
          ? { errorCode: 'shell-nonzero-exit' as const }
          : {}),
        cwd: cell.cwd,
        ...(cell.truncated ? { truncated: true } : {})
      })
  }

  private async run(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    if (!(await this.verifyCleanup())) return this.processResult!
    if (this.closed || request.signal?.aborted) return cancelledResult()
    const context = JSON.stringify([
      request.cwd,
      request.handoffDir,
      request.runtimeRoot,
      request.notebookSessionRoot,
      request.inputRoot,
      request.protectedDirs,
      request.environment,
      request.grantedRoots
    ])
    const reset = this.child && this.launchContext !== context
    if (reset) {
      this.lifetime.abort()
      await this.completion
      if (!(await this.verifyCleanup())) return this.processResult!
    }
    request = { ...request, cwd: this.cwd ?? request.cwd }
    try {
      await this.validate(request)
    } catch (error) {
      if (request.signal?.aborted) return cancelledResult()
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      }
    }
    if (this.closed || request.signal?.aborted) return cancelledResult()
    const powershell = request.runtimeBinding?.kind === 'powershell'
    let endExecution: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let connectionTimer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    if (!this.child) this.lifetime = new AbortController()
    const abort = (): void => {
      this.lifetime.abort()
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    const result = new Promise<NotebookShellResult>((resolve) => {
      this.cell = {
        marker: randomUUID(),
        stdout: '',
        stderr: '',
        buffers: { stdout: '', stderr: '' },
        ended: { stdout: false, stderr: false },
        truncated: false,
        resolve
      }
    })
    try {
      if (!this.child) {
        this.processResult = undefined
        this.launchedProcess = false
        this.cleanupVerified = false
        this.launchContext = context
        const control = powershell ? await this.openControl() : undefined
        const ready = Promise.withResolvers<void>()
        const launched = await this.launch(
          request,
          this.startup(powershell, control?.name),
          this.lifetime.signal,
          (child) => {
            this.launchedProcess = true
            this.child = child
            child.stdout.on('data', (chunk: string) => this.accept('stdout', chunk))
            child.stderr.on('data', (chunk: string) => this.accept('stderr', chunk))
            child.stdin.on('error', () => this.lifetime.abort())
            // Both Console.ReadLine and native descendants see EOF, never protocol frames.
            if (powershell && !this.nativeControl) child.stdin.end()
            ready.resolve()
          },
          this.nativeControl ? control?.name : undefined
        )
        this.beginExecution = launched.beginExecution
        this.retryCleanup = launched.retryCleanup
        this.completion = launched.completion.then((exit) => {
          this.closeControl()
          this.child = undefined
          this.cwd = undefined
          this.processResult = exit
          const cell = this.cell
          if (cell)
            cell.resolve({
              ...exit,
              ...(exit.ownedTreeReaped === false ? { ownedTreeReaped: false } : {}),
              stdout: cell.stdout + cell.buffers.stdout,
              stderr:
                cell.stderr +
                cell.buffers.stderr +
                (exit.cancelled && !exit.errorCode ? '' : exit.stderr),
              ...(this.launchedProcess &&
              !timedOut &&
              !exit.cancelled &&
              exit.errorCode !== 'shell-start-failed'
                ? { executionNotice: 'Shell interpreter exited.' }
                : {}),
              ...(cell.truncated ? { truncated: true } : {})
            })
          ready.resolve()
          return exit
        })
        await ready.promise
        if (control && this.child) {
          connectionTimer = setTimeout(() => this.lifetime.abort(), 10_000)
          await Promise.race([control.connected, this.completion])
          clearTimeout(connectionTimer)
        }
      }
      if (!this.child) return await result
      endExecution = this.beginExecution?.(request.command)
      if (this.closed || request.signal?.aborted) abort()
      if (!this.lifetime.signal.aborted) {
        const timeoutMs = request.timeoutMs ?? NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS
        timer = setTimeout(() => {
          timedOut = true
          abort()
        }, timeoutMs)
        const input = powershell && !this.nativeControl ? this.controlSocket! : this.child.stdin
        input.write(this.frame(request.command, this.cell!.marker, powershell))
      }
      const completed = await result
      if (completed.cwd) this.cwd = completed.cwd
      if (reset)
        completed.executionNotice = [
          'Shell launch context changed before this command.',
          completed.executionNotice
        ]
          .filter(Boolean)
          .join(' ')
      return timedOut
        ? {
            ...completed,
            cancelled: undefined,
            exitCode: null,
            status: 'timeout'
          }
        : { ...completed, cwdBefore: request.cwd }
    } catch (error) {
      this.lifetime.abort()
      await this.completion
      this.closeControl()
      if (
        this.processResult?.ownedTreeReaped === false ||
        this.processResult?.errorCode === 'shell-cleanup-incomplete'
      )
        return this.processResult
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null
      }
    } finally {
      clearTimeout(timer)
      clearTimeout(connectionTimer)
      request.signal?.removeEventListener('abort', abort)
      endExecution?.()
      this.cell = undefined
    }
  }
}

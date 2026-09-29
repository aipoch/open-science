import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NotebookShellProcessRequest, NotebookShellResult } from './shell-process'
import { NOTEBOOK_TEXT_LIMIT_BYTES, limitUtf8 } from './content-limits'
import { NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS } from '../../shared/notebook'

type Launch = (
  request: NotebookShellProcessRequest,
  startup: string,
  signal: AbortSignal,
  onProcess: (child: ChildProcessWithoutNullStreams) => void
) => Promise<{
  completion: Promise<NotebookShellResult>
  beginExecution: (command: string) => () => void
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
  private completion?: Promise<NotebookShellResult>
  private processResult?: NotebookShellResult
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
    private readonly validate: (request: NotebookShellProcessRequest) => Promise<void>
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
    const result = await this.completion
    return {
      reaped: result?.ownedTreeReaped !== false && result?.errorCode !== 'shell-cleanup-incomplete'
    }
  }

  private startup(powershell: boolean): string {
    const name = this.protocolName
    return powershell
      ? `while ($null -ne ($${name} = [Console]::ReadLine())) { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($${name})))) }`
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
      const limited = limitUtf8(
        value,
        Math.max(0, NOTEBOOK_TEXT_LIMIT_BYTES - Buffer.byteLength(cell.stdout + cell.stderr))
      )
      cell[stream] += limited.text
      cell.truncated ||= limited.truncated
    }
    if (index < 0) {
      const safe = Math.max(0, buffer.length - prefix.length)
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
        cwd: cell.cwd,
        ...(cell.truncated ? { truncated: true } : {})
      })
  }

  private async run(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    if (
      this.processResult?.errorCode === 'shell-cleanup-incomplete' ||
      this.processResult?.ownedTreeReaped === false
    )
      return this.processResult
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
      const stopped = await this.completion
      if (stopped?.ownedTreeReaped === false || stopped?.errorCode === 'shell-cleanup-incomplete')
        return stopped
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
        this.launchContext = context
        const ready = Promise.withResolvers<void>()
        const launched = await this.launch(
          request,
          this.startup(powershell),
          this.lifetime.signal,
          (child) => {
            this.child = child
            child.stdout.on('data', (chunk: string) => this.accept('stdout', chunk))
            child.stderr.on('data', (chunk: string) => this.accept('stderr', chunk))
            child.stdin.on('error', () => this.lifetime.abort())
            ready.resolve()
          }
        )
        this.beginExecution = launched.beginExecution
        this.completion = launched.completion.then((exit) => {
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
                exit.stderr +
                '\nShell interpreter exited; interpreter state was reset.',
              ...(cell.truncated ? { truncated: true } : {})
            })
          ready.resolve()
          return exit
        })
        await ready.promise
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
        this.child.stdin.write(this.frame(request.command, this.cell!.marker, powershell))
      }
      const completed = await result
      if (completed.cwd) this.cwd = completed.cwd
      if (reset)
        completed.stderr =
          'Shell launch context changed; interpreter state was reset.\n' + completed.stderr
      return timedOut
        ? {
            ...completed,
            cancelled: undefined,
            exitCode: null,
            stderr: completed.stderr + '\nShell command timed out; interpreter state was reset.'
          }
        : { ...completed, cwdBefore: request.cwd }
    } catch (error) {
      this.lifetime.abort()
      await this.completion
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
      request.signal?.removeEventListener('abort', abort)
      endExecution?.()
      this.cell = undefined
    }
  }
}

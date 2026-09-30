import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ShellCellSession } from './shell-cell-session'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookShellProcessRequest, NotebookShellResult } from './shell-process'
import { NOTEBOOK_TEXT_LIMIT_BYTES, NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES } from './content-limits'

// Exercise the native platform interpreter through the actual adapter and cleanup owner.
describe('persistent platform shell cells', () => {
  let root: string
  let adapter: NotebookShellProcessAdapter
  const windows = process.platform === 'win32'
  const command = (posix: string, powershell: string): string => (windows ? powershell : posix)
  const request = (code: string, sessionId = 'one'): NotebookShellProcessRequest => ({
    projectId: 'project',
    sessionId,
    command: code,
    cwd: join(root, 'workspace'),
    runtimeRoot: join(root, 'runtime'),
    handoffDir: join(root, 'workspace')
  })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shell-cells-'))
    await mkdir(join(root, 'workspace'))
    await mkdir(join(root, 'runtime'))
    adapter = new NotebookShellProcessAdapter()
  })
  afterEach(async () => {
    expect(await adapter.shutdown()).toEqual({ reaped: true })
    await rm(root, { recursive: true, force: true })
  })

  it('retains variables, exports, functions and cwd through ordered cells', async () => {
    const first = await adapter.execute(
      request(
        command(
          'value=41; export CELL_EXPORT=kept; greet() { printf hello; }; mkdir child; cd child',
          '$value = 41; $env:CELL_EXPORT = "kept"; function greet { "hello" }; [IO.Directory]::CreateDirectory((Join-Path (Get-Location) child)) | Out-Null; Set-Location child'
        )
      )
    )
    expect(first, JSON.stringify(first)).toMatchObject({ exitCode: 0 })
    const second = await adapter.execute(
      request(
        command(
          'printf "%s:%s:" "$value" "$CELL_EXPORT"; greet; printf ":%s" "${PWD##*/}"',
          '[Console]::Write("${value}:$($env:CELL_EXPORT):$(greet):$((Get-Item .).Name)")'
        )
      )
    )
    expect(second).toMatchObject({ exitCode: 0, stdout: '41:kept:hello:child' })
  })

  it.skipIf(!windows)('gives PowerShell cells EOF instead of the cell protocol input', async () => {
    expect(await adapter.execute(request('[Console]::Write("ready")'))).toMatchObject({
      stdout: 'ready',
      exitCode: 0
    })
    const result = await adapter.execute({
      ...request('[Console]::Write($null -eq [Console]::ReadLine())'),
      timeoutMs: 1000
    })
    expect(result).toMatchObject({ stdout: 'True', exitCode: 0 })
  })

  it.skipIf(!windows)(
    'gives native children EOF and still supports explicit pipeline input',
    async () => {
      const executable = process.execPath.replaceAll("'", "''")
      const script = `process.stdout.write(require('node:fs').readFileSync(0,'utf8') || 'eof')`
      const child = `& '${executable}' -e '${script.replaceAll("'", "''")}'`
      expect(await adapter.execute(request(`$value = 'kept'; ${child}`))).toMatchObject({
        stdout: 'eof',
        exitCode: 0
      })
      const piped = await adapter.execute(request(`'payload' | ${child}`))
      expect(piped.exitCode).toBe(0)
      expect(piped.stdout.trim()).toBe('payload')
      expect(await adapter.execute(request('[Console]::Write($value)'))).toMatchObject({
        stdout: 'kept',
        exitCode: 0
      })
    }
  )

  it('serializes concurrent submissions without sharing state between sessions', async () => {
    const first = adapter.execute(request(command('value=41', '$value=41')))
    const second = adapter.execute(
      request(command('printf "%s" "$value"', '[Console]::Write($value)'))
    )
    expect(await first).toMatchObject({ exitCode: 0 })
    expect(await second).toMatchObject({ exitCode: 0, stdout: '41' })
    expect(
      await adapter.execute(
        request(
          command(
            'printf "%s" "${value-unset}"',
            'if ($null -eq $value) { [Console]::Write("unset") }'
          ),
          'two'
        )
      )
    ).toMatchObject({ exitCode: 0, stdout: 'unset' })
  })

  it('captures multiline output and continues after a failed cell', async () => {
    const failed = await adapter.execute(
      request(
        command(
          'value=kept\nprintf "out"\nprintf "err" >&2\nfalse',
          '$value="kept"\n[Console]::Write("out")\n[Console]::Error.Write("err")\nthrow "failure"'
        )
      )
    )
    expect(failed).toMatchObject({ exitCode: 1, stdout: 'out' })
    expect(failed.stderr).toContain('err')
    expect(
      await adapter.execute(request(command('printf "%s" "$value"', '[Console]::Write($value)')))
    ).toMatchObject({ exitCode: 0, stdout: 'kept' })
  })

  it('reserves diagnostics when stdout exceeds the cell budget', async () => {
    const size = NOTEBOOK_TEXT_LIMIT_BYTES + 1024
    const result = await adapter.execute(
      request(
        command(
          `printf '%*s' ${size} '' | tr ' ' x; printf important >&2; false`,
          `[Console]::Write(('x' * ${size})); [Console]::Error.Write('important'); throw 'failure'`
        )
      )
    )
    expect(result.exitCode).toBe(1)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      NOTEBOOK_TEXT_LIMIT_BYTES - NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES
    )
    expect(result.stderr).toContain('important')
    expect(
      await adapter.execute(request(command('printf next', '[Console]::Write("next")')))
    ).toMatchObject({ stdout: 'next', stderr: '', exitCode: 0 })
  })

  it('cancels a running cell, reaps the interpreter and starts with empty state', async () => {
    expect(await adapter.execute(request(command('value=old', '$value="old"')))).toMatchObject({
      exitCode: 0
    })
    const controller = new AbortController()
    const running = adapter.execute({
      ...request(
        command(
          'printf ready > running; sleep 30',
          '[IO.File]::WriteAllText((Join-Path (Get-Location) running), "ready"); Start-Sleep -Seconds 30'
        )
      ),
      signal: controller.signal
    })
    try {
      await expect
        .poll(async () =>
          access(join(root, 'workspace', 'running')).then(
            () => true,
            () => false
          )
        )
        .toBe(true)
      controller.abort()
      expect(await running).toMatchObject({ exitCode: null, cancelled: true })
      expect(
        await adapter.execute(
          request(
            command(
              'printf "%s" "${value-unset}"',
              'if ($null -eq $value) { [Console]::Write("unset") }'
            )
          )
        )
      ).toMatchObject({ exitCode: 0, stdout: 'unset' })
    } finally {
      controller.abort()
      await running
    }
  })

  it('cancels a queued cell without resetting the active interpreter', async () => {
    const active = adapter.execute(
      request(command('value=41; sleep 1', '$value=41; Start-Sleep -Milliseconds 1000'))
    )
    const controller = new AbortController()
    const queued = adapter.execute({
      ...request(command('value=99', '$value=99')),
      signal: controller.signal
    })
    controller.abort()
    expect(await queued).toMatchObject({ cancelled: true })
    expect(await active).toMatchObject({ exitCode: 0 })
    expect(
      await adapter.execute(request(command('printf "%s" "$value"', '[Console]::Write($value)')))
    ).toMatchObject({ exitCode: 0, stdout: '41' })
  })

  it('resets state after a timeout and an explicit interpreter exit', async () => {
    expect(await adapter.execute(request(command('value=old', '$value="old"')))).toMatchObject({
      exitCode: 0
    })
    const result = await adapter.execute({
      ...request(command('sleep 30', 'Start-Sleep -Seconds 30')),
      timeoutMs: 100
    })
    expect(result.exitCode).toBeNull()
    expect(result.status).toBe('timeout')
    expect(result.stderr).toBe('')
    expect(result.executionNotice).toBeUndefined()
    expect(
      await adapter.execute(
        request(
          command(
            'printf "%s" "${value-unset}"',
            'if ($null -eq $value) { [Console]::Write("unset") }'
          )
        )
      )
    ).toMatchObject({ exitCode: 0, stdout: 'unset' })
    expect(await adapter.execute(request('exit 7'))).toMatchObject({ exitCode: 7 })
    expect(
      await adapter.execute(request(command('printf alive', '[Console]::Write("alive")')))
    ).toMatchObject({ exitCode: 0, stdout: 'alive' })
  })

  it('restarts when launch grants change and closes only the requested session', async () => {
    expect(await adapter.execute(request(command('value=old', '$value="old"')))).toMatchObject({
      exitCode: 0
    })
    const result = await adapter.execute({
      ...request(
        command(
          'printf "%s" "${value-unset}"',
          'if ($null -eq $value) { [Console]::Write("unset") }'
        )
      ),
      protectedDirs: [join(root, 'private')]
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'unset' })
    expect(result.executionNotice).toBe('Shell launch context changed before this command.')
    expect(
      await adapter.execute(request(command('value=other', '$value="other"'), 'two'))
    ).toMatchObject({ exitCode: 0 })
    expect(await adapter.shutdown({ sessionId: 'one' })).toEqual({ reaped: true })
    expect(
      await adapter.execute(
        request(command('printf "%s" "$value"', '[Console]::Write($value)'), 'two')
      )
    ).toMatchObject({ exitCode: 0, stdout: 'other' })
  })
})

// Inject control failures at the persistent adapter boundary without requiring a broken OS.
describe('persistent Shell control failures', () => {
  const request: NotebookShellProcessRequest = {
    projectId: 'project',
    sessionId: 'control-failure',
    command: 'command',
    cwd: '/workspace',
    runtimeRoot: '/runtime',
    handoffDir: '/workspace'
  }

  it('does not classify an admission infrastructure exception as a command-policy denial', async () => {
    const failure = Object.assign(new Error('scope lookup unavailable'), { code: 'EACCES' })
    const session = new ShellCellSession(
      request,
      async () => {
        throw new Error('must not launch')
      },
      async () => {
        throw failure
      }
    )
    expect(await session.execute(request)).toMatchObject({
      exitCode: null,
      errorCode: 'shell-start-failed',
      systemErrorCode: 'EACCES',
      stderr: '',
      failureDiagnostic: { error: failure.message }
    })
    expect(await session.shutdown()).toEqual({ reaped: true })
  })

  it('classifies a launch exception as not started and keeps its diagnostic private', async () => {
    const failure = Object.assign(new Error('private launch path unavailable'), { code: 'EMFILE' })
    const session = new ShellCellSession(
      request,
      async () => {
        throw failure
      },
      async () => {}
    )
    expect(await session.execute(request)).toMatchObject({
      stdout: '',
      stderr: '',
      exitCode: null,
      errorCode: 'shell-start-failed',
      systemErrorCode: 'EMFILE',
      failureDiagnostic: { error: failure.message }
    })
    expect(await session.shutdown()).toEqual({ reaped: true })
  })

  it.each(['begin', 'write'] as const)(
    'retains command output and classifies a %s control failure',
    async (stage) => {
      const failure = Object.assign(new Error('private control failure'), { code: 'EIO' })
      const session = new ShellCellSession(
        request,
        async (_request, _startup, signal, onProcess) => {
          const child = {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough()
          }
          const completion = new Promise<NotebookShellResult>((resolve) => {
            signal.addEventListener(
              'abort',
              () => resolve({ stdout: '', stderr: '', exitCode: null, cancelled: true }),
              { once: true }
            )
          })
          onProcess(child as unknown as ChildProcessWithoutNullStreams)
          child.stdin.write = ((frame: string) => {
            child.stdout.emit('data', 'partial-output')
            child.stderr.emit('data', 'command-diagnostic')
            if (stage === 'write') throw failure
            const marker = frame.match(/\\000([a-f0-9-]{36}):/)![1]
            child.stdout.emit('data', `\0${marker}:0:/workspace\0`)
            child.stderr.emit('data', `\0${marker}\0`)
            return true
          }) as typeof child.stdin.write
          return {
            completion,
            beginExecution: () => {
              if (stage === 'begin') throw failure
              return () => undefined
            }
          }
        },
        async () => {}
      )
      const result = await session.execute(request)
      expect(result).toMatchObject({
        exitCode: null,
        errorCode: 'shell-process-error',
        systemErrorCode: 'EIO'
      })
      expect(result.stdout).toBe(stage === 'begin' ? '' : 'partial-output')
      expect(result.stderr).toBe(stage === 'begin' ? '' : 'command-diagnostic')
      expect(result.failureDiagnostic).toMatchObject({ error: failure.message })
      expect(await session.shutdown()).toEqual({ reaped: true })
    }
  )
})

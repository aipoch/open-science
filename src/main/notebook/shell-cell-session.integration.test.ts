import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookShellProcessRequest } from './shell-process'
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
    expect(result.stderr).toContain('timed out')
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
    expect(result.stderr).toContain('interpreter state was reset')
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

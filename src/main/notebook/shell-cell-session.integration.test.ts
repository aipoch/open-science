import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookShellProcessRequest } from './shell-process'
import { NOTEBOOK_TEXT_LIMIT_BYTES, NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES } from './content-limits'
import { shellNpmPaths } from './shell-npm-environment'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'

// Exercise the native platform interpreter through the actual adapter and cleanup owner.
describe('persistent platform shell cells', () => {
  let root: string
  let adapter: NotebookShellProcessAdapter
  let sandbox: NotebookNetworkSandboxOwner | undefined
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
    await sandbox?.dispose()
    sandbox = undefined
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it.for([false, true])(
    'shares global npm tools without globalizing local installs (sandbox=%s)',
    { timeout: 60_000 },
    async (sandboxed, context) => {
      // Portable CI does not provision bubblewrap/AppArmor. The Linux isolation job runs this
      // same case with its native prerequisites; retain ordinary Shell coverage in portable CI.
      if (sandboxed && process.platform === 'linux' && process.env.VITEST_PORTABLE_CI === '1') {
        context.skip('Real sandbox execution runs in the Linux Notebook isolation job.')
      }
      if (sandboxed) {
        vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
        sandbox = new NotebookNetworkSandboxOwner({
          resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
          temporaryRoot: join(root, 'command-temp'),
          getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
          persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
          requestDecision: async () => 'deny',
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
        })
        adapter = new NotebookShellProcessAdapter(process.platform, sandbox)
      }
      const npmCli = process.env.npm_execpath
      expect(npmCli, 'Run this test through the repository npm test command').toBeTruthy()
      const quote = (value: string): string =>
        windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`
      const npm = `${windows ? '& ' : ''}${quote(process.execPath)} ${quote(npmCli!)}`
      const workspace = join(root, 'workspace')
      const secondWorkspace = join(root, 'second-workspace')
      await mkdir(secondWorkspace)
      const second = (code: string): NotebookShellProcessRequest => ({
        ...request(code, 'two'),
        cwd: secondWorkspace,
        handoffDir: secondWorkspace
      })
      // A session that was already running must see tools installed later by a different session.
      const started = await adapter.execute(second(command('true', '$null = 1')))
      expect(started, JSON.stringify(started)).toMatchObject({
        exitCode: 0
      })
      const fixture = join(workspace, 'fixture')
      const version = await adapter.execute(request(`${windows ? 'npm.cmd' : 'npm'} --version`))
      expect(version, JSON.stringify(version)).toMatchObject({ exitCode: 0 })
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
      await mkdir(fixture)
      await writeFile(
        join(fixture, 'package.json'),
        JSON.stringify({
          name: 'open-science-npm-fixture',
          version: '1.0.0',
          bin: { 'os-npm-fixture': 'cli.js' }
        })
      )
      await writeFile(
        join(fixture, 'cli.js'),
        '#!/usr/bin/env node\nprocess.stdout.write("shared-tool")\n'
      )
      const packed = await adapter.execute(
        request(`${npm} pack ./fixture --ignore-scripts --offline`)
      )
      expect(packed, JSON.stringify(packed)).toMatchObject({ exitCode: 0 })
      const installed = await adapter.execute(
        request(
          `${npm} install -g ./open-science-npm-fixture-1.0.0.tgz --offline --ignore-scripts --no-audit --no-fund`
        )
      )
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0 })
      const invoke = windows ? 'os-npm-fixture.cmd' : 'os-npm-fixture'
      expect(await adapter.execute(request(invoke))).toMatchObject({
        exitCode: 0,
        stdout: 'shared-tool'
      })
      expect(await adapter.execute(second(invoke))).toMatchObject({
        exitCode: 0,
        stdout: 'shared-tool'
      })
      // Each sandbox can read its own workspace, not another session's temporary workspace.
      // Stage the fixture as a local input without changing either session's read grants.
      await copyFile(
        join(workspace, 'open-science-npm-fixture-1.0.0.tgz'),
        join(secondWorkspace, 'open-science-npm-fixture-1.0.0.tgz')
      )
      const local = await adapter.execute(
        second(
          `${npm} install ./open-science-npm-fixture-1.0.0.tgz --offline --ignore-scripts --no-audit --no-fund`
        )
      )
      expect(local, JSON.stringify(local)).toMatchObject({ exitCode: 0 })
      const localPackage = JSON.parse(
        await readFile(
          join(secondWorkspace, 'node_modules', 'open-science-npm-fixture', 'package.json'),
          'utf8'
        )
      )
      expect(localPackage.name).toBe('open-science-npm-fixture')
      const { prefix } = shellNpmPaths(join(root, 'runtime'), process.platform)
      await expect(
        access(
          join(
            prefix,
            ...(windows ? [] : ['lib']),
            'node_modules',
            'open-science-npm-fixture',
            'package.json'
          )
        )
      ).resolves.toBeUndefined()
      expect(await adapter.shutdown()).toEqual({ reaped: true })
      adapter = new NotebookShellProcessAdapter(process.platform, sandbox)
      expect(await adapter.execute(second(invoke))).toMatchObject({
        exitCode: 0,
        stdout: 'shared-tool'
      })

      if (sandboxed && !windows) {
        // A private Node layout must expose npm's package without exposing sibling data or
        // turning the read grant into write access. Exercise real filesystem syscalls.
        const hostBin = join(root, 'host-node', 'bin')
        const hostNpm = join(root, 'host-node', 'lib', 'node_modules', 'npm')
        const sibling = join(root, 'host-node', 'lib', 'private.txt')
        const protectedRoot = join(root, 'runtime', 'envs', 'protected')
        await mkdir(hostBin, { recursive: true })
        await mkdir(join(hostNpm, 'bin'), { recursive: true })
        await mkdir(protectedRoot, { recursive: true })
        await writeFile(sibling, 'private')
        await writeFile(join(hostNpm, 'package.json'), '{"name":"npm"}')
        await writeFile(
          join(hostNpm, 'bin', 'npm-cli.js'),
          `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const result = { package: JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).name }
for (const [name, target, write] of ${JSON.stringify([
            ['sibling', sibling, false],
            ['npmWrite', join(hostNpm, 'pwn.txt'), true],
            ['runtimeWrite', join(protectedRoot, 'pwn.txt'), true]
          ])}) {
  try { write ? fs.writeFileSync(target, 'bad') : fs.readFileSync(target); result[name] = 'allowed' }
  catch (error) { result[name] = error.code }
}
console.log(JSON.stringify(result))
`,
          { mode: 0o755 }
        )
        await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(hostBin, 'npm'))
        // Runtime packages are readable and inherit the runtime root's read-only mount.
        // A denied-read directory would instead receive Linux's anonymous filesystem mask.
        const isolated = await adapter.execute({
          ...request('npm', 'private-node'),
          environment: { ...process.env, PATH: `${hostBin}:${process.env.PATH}` }
        })
        const deniedRead =
          process.platform === 'linux' ? /^(EPERM|EACCES|ENOENT)$/ : /^(EPERM|EACCES)$/
        const deniedWrite =
          process.platform === 'linux' ? /^(EPERM|EACCES|EROFS)$/ : /^(EPERM|EACCES)$/
        expect(isolated, JSON.stringify(isolated)).toMatchObject({ exitCode: 0 })
        expect(JSON.parse(isolated.stdout)).toEqual({
          package: 'npm',
          sibling: expect.stringMatching(deniedRead),
          npmWrite: expect.stringMatching(deniedWrite),
          runtimeWrite: expect.stringMatching(deniedWrite)
        })
        await expect(access(join(hostNpm, 'pwn.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(access(join(protectedRoot, 'pwn.txt'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
        // A workload-created launcher must not turn its private symlink target into a host grant.
        await symlink(join(hostNpm, 'bin', 'npm-cli.js'), join(prefix, 'bin', 'npm'))
        const redirected = await adapter.execute(request('npm', 'redirected-global-npm'))
        expect(redirected.exitCode).toBeGreaterThan(0)
        const probe = await adapter.execute(
          request(
            `${quote(process.execPath)} -e ${quote(
              `try { require('node:fs').readFileSync(${JSON.stringify(join(hostNpm, 'package.json'))}); console.log('allowed') } catch (error) { console.log(error.code) }`
            )}`,
            'redirected-global-npm'
          )
        )
        expect(probe, JSON.stringify(probe)).toMatchObject({ exitCode: 0 })
        expect(probe.stdout.trim()).toMatch(deniedRead)
        expect(redirected.stdout).not.toContain('"package":"npm"')
      }
    }
  )

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

configureTestRuntimeMetadata()

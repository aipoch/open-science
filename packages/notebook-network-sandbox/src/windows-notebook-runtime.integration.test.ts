import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'

import {
  readAppContainerStatus,
  windowsLaunch
} from '../runtime/src/platform/windows-appcontainer.js'
import { createRuntimeConfig } from './config.js'

// Opt in on a Windows host with protection already installed. These probes use the public native
// launch boundary, without changing drive mappings, protection settings, or the application's data.
const enabled = process.platform === 'win32' && process.env.RUN_WINDOWS_NOTEBOOK_RUNTIME === '1'

it.skipIf(!enabled).each(['powershell', 'node-pipes', 'repl-loop'] as const)(
  'executes %s at the requested workspace under the real AppContainer',
  async (kind) => {
    const workspace = await mkdtemp(join(tmpdir(), 'windows-notebook-runtime-'))
    await mkdir(join(workspace, 'fixture'))
    await writeFile(
      join(workspace, 'fixture/package.json'),
      JSON.stringify({
        name: 'fixture-local-cli',
        version: '1.0.0',
        bin: { 'fixture-cli': 'cli.js' }
      })
    )
    await writeFile(
      join(workspace, 'fixture/cli.js'),
      '#!/usr/bin/env node\nconsole.log("CLI_READY")\n'
    )
    const blocked = await mkdtemp(join(tmpdir(), 'windows-notebook-denied-'))
    await writeFile(join(blocked, 'secret.txt'), 'PRIVATE_FIXTURE')
    const runtime = resolve('packages/notebook-network-sandbox/vendor/windows-runtime/x64')
    const replLoop = resolve('resources/notebook/repl_loop.js')
    const config = createRuntimeConfig({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') }
    })
    const env: NodeJS.ProcessEnv = { TEMP: workspace, TMP: workspace }
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'LOCALAPPDATA']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    env.NPM_CONFIG_PREFIX = join(workspace, '.notebook-tools', 'npm')
    env.PATH = `${join(runtime, 'node')};${env.NPM_CONFIG_PREFIX};${env.PATH}`
    env.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
    env.NPM_CONFIG_CACHE = join(workspace, 'npm-cache')
    const powershell = join(runtime, 'powershell/pwsh.exe')
    const launch = (executable: string, args: string[]): ReturnType<typeof windowsLaunch> =>
      windowsLaunch({
        command: '',
        executable,
        args,
        cwd: workspace,
        env,
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused-offline-probe', password: 'unused-offline-probe' },
        hostPath: config.windowsHostPath,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot,
        filesystem: {
          readOnlyRoots:
            executable === env.ComSpec
              ? []
              : [
                  dirname(executable),
                  join(runtime, 'node'),
                  ...(kind === 'repl-loop'
                    ? [replLoop, resolve('resources/notebook/package.json')]
                    : [])
                ],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
    let timedOut = false
    try {
      expect(
        await readAppContainerStatus(
          config.windowsHostPath,
          config.installationId,
          config.windowsOwnershipRoot
        )
      ).toMatchObject({ owned: true, ownershipState: 'owned' })
      const script =
        kind === 'powershell'
          ? `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
             $ErrorActionPreference = 'Stop'
             if ($Error.Count -gt 0) { throw $Error[0] }
             (Get-Location).ProviderPath
             Set-Content -LiteralPath './relative.txt' -Value 'WORKSPACE_READY'
             Get-Content -LiteralPath './relative.txt'
             node --version
             npm.cmd --version
             if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
             $denied = $false
             try { [IO.File]::ReadAllText('${join(blocked, 'secret.txt').replaceAll("'", "''")}') } catch [UnauthorizedAccessException] { $denied = $true }
             if (-not $denied) { throw 'Unapproved file read succeeded' }
             'ISOLATION_PRESERVED'`
          : `const cp = require('node:child_process');
           const fs = require('node:fs');
           const assert = require('node:assert/strict');
           const result = cp.spawnSync(process.env.ComSpec, ['/d', '/c', 'echo CHILD_READY'],
             { encoding: 'utf8', timeout: 1000 });
           if (result.error) throw result.error;
           if (result.status !== 0) process.exit(1);
           console.log(process.cwd()); console.log(result.stdout);
           console.log('NPM=' + cp.execSync('npm --version', { encoding: 'utf8', timeout: 10000 }).trim());
           console.log(cp.execSync('npm install -g ./fixture --offline --install-links --ignore-scripts --no-audit --no-fund', { encoding: 'utf8', timeout: 20000 }));
           assert.equal(fs.existsSync(require('node:path').join(process.env.NPM_CONFIG_PREFIX, 'node_modules', 'fixture-local-cli', 'cli.js')), true);
           console.log(cp.execSync('fixture-cli.cmd', { encoding: 'utf8', timeout: 10000 }));
           assert.throws(() => fs.readFileSync(${JSON.stringify(join(blocked, 'secret.txt'))}), (error) => ['EACCES', 'EPERM'].includes(error.code));
           assert.throws(() => fs.writeFileSync(${JSON.stringify(join(runtime, 'node/unapproved-write.txt'))}, 'bad'), (error) => ['EACCES', 'EPERM'].includes(error.code));
           const slow = cp.spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 500 });
           assert.equal(slow.error?.code, 'ETIMEDOUT');
           cp.execFile(process.execPath, ['-e', 'console.log("ASYNC_READY")'], { timeout: 5000 }, (error, stdout) => {
             if (error) throw error;
             console.log(stdout); console.log('ISOLATION_PRESERVED');
           });`
      const wrapped =
        kind === 'powershell'
          ? launch(powershell, [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64')
            ])
          : launch(
              join(runtime, 'node/node.exe'),
              kind === 'repl-loop' ? ['--preserve-symlinks-main', replLoop] : ['-e', script]
            )
      const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: workspace,
        env: wrapped.env,
        encoding: 'utf8',
        windowsHide: true,
        ...(kind === 'repl-loop'
          ? {
              input:
                JSON.stringify({
                  req_id: 'original-repro',
                  code: `const os = require('node:os'); console.log('host', os.hostname());
           console.log('cwd', process.cwd()); console.log('node', process.version);
           const { execSync } = require('node:child_process');
           console.log('npm', execSync('npm --version', { encoding: 'utf8', timeout: 10000 }).trim());
           return 'REPL_READY';`
                }) + '\n'
            }
          : {}),
        timeout: 90_000
      })
      timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
      await wrapped.confirmProcessTreeTermination()
      expect(result.stderr).not.toContain('InitializeDefaultDrives')
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      if (kind === 'repl-loop') {
        const response = JSON.parse(result.stdout.trim())
        expect(response).toMatchObject({
          req_id: 'original-repro',
          error: null,
          result: 'REPL_READY',
          cwd: workspace
        })
        expect(response.stdout).toMatch(/npm \d+\.\d+\.\d+/)
      } else {
        expect(result.stdout.toLowerCase()).toContain(workspace.toLowerCase())
        expect(result.stdout).toContain('ISOLATION_PRESERVED')
      }
      if (kind === 'node-pipes') {
        expect(result.stdout).toContain('CHILD_READY')
        expect(result.stdout).toContain('ASYNC_READY')
        expect(result.stdout).toContain('CLI_READY')
        expect(result.stdout).toMatch(/NPM=\d+\.\d+\.\d+/)
      } else if (kind === 'powershell') expect(result.stdout).toContain('WORKSPACE_READY')
    } finally {
      if (timedOut) {
        // Closing the native host kills its Job; the next launch reconciles that dead ACL lease.
        const cleanup = launch(env.ComSpec!, ['/d', '/c', 'exit 0'])
        const result = spawnSync(cleanup.argv[0], cleanup.argv.slice(1), {
          cwd: workspace,
          env: cleanup.env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 90_000
        })
        await cleanup.confirmProcessTreeTermination()
        expect(result.error, `Native probe cleanup failed: ${result.stderr}`).toBeUndefined()
        expect(result.status, `Native probe cleanup failed: ${result.stderr}`).toBe(0)
      }
      await rm(workspace, { recursive: true, force: true })
      await rm(blocked, { recursive: true, force: true })
    }
  },
  120_000
)

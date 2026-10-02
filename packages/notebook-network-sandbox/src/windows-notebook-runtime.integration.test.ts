import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
const runtimeRoot = resolve(
  process.env.OPEN_SCIENCE_TEST_WINDOWS_RUNTIME_ROOT ??
    'packages/notebook-network-sandbox/vendor/windows-runtime/x64'
)
const testRuntimeConfig = (): ReturnType<typeof createRuntimeConfig> => {
  const config = createRuntimeConfig({
    policy: { allowedDomains: [], deniedDomains: [] },
    resources: { root: resolve('packages/notebook-network-sandbox/vendor') }
  })
  const installationId = process.env.OPEN_SCIENCE_TEST_SANDBOX_INSTALLATION_ID
  const ownershipRoot = process.env.OPEN_SCIENCE_TEST_SANDBOX_OWNERSHIP_ROOT
  if (Boolean(installationId) !== Boolean(ownershipRoot)) {
    throw new Error('A test sandbox identity requires its matching ownership root.')
  }
  return installationId && ownershipRoot
    ? { ...config, installationId, windowsOwnershipRoot: ownershipRoot }
    : config
}

it.skipIf(!enabled).each(
  (['commonjs', 'module'] as const).flatMap((parentType) =>
    (['eval', 'module-eval', 'print', 'stdin'] as const).map((invocation) => ({
      parentType,
      invocation
    }))
  )
)(
  'imports from Node $invocation without reading the inaccessible $parentType parent package',
  async ({ parentType, invocation }) => {
    await mkdir(resolve('tmp'), { recursive: true })
    const parent = await mkdtemp(resolve('tmp/notebook-eval-'))
    const workspace = join(parent, 'workspace')
    const runtime = runtimeRoot
    const config = testRuntimeConfig()
    try {
      await mkdir(workspace)
      await writeFile(join(parent, 'package.json'), JSON.stringify({ type: parentType }))
      await writeFile(join(workspace, 'value.cjs'), 'module.exports = 42')
      await writeFile(join(workspace, 'value.mjs'), 'export default 43')
      await mkdir(join(workspace, 'node_modules/fixture-eval'), { recursive: true })
      await writeFile(
        join(workspace, 'node_modules/fixture-eval/package.json'),
        JSON.stringify({
          name: 'fixture-eval',
          type: 'module',
          exports: { import: './value.mjs', require: './value.cjs' }
        })
      )
      await writeFile(join(workspace, 'node_modules/fixture-eval/value.mjs'), 'export default 44')
      await writeFile(join(workspace, 'node_modules/fixture-eval/value.cjs'), 'module.exports = 45')
      const environment: NodeJS.ProcessEnv = { TEMP: workspace, TMP: workspace }
      for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT']) {
        if (process.env[key] !== undefined) environment[key] = process.env[key]
      }
      environment.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
      const script = `
        ${invocation === 'module-eval' ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" : ''}
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        assert.throws(() => fs.readFileSync(${JSON.stringify(join(parent, 'package.json'))}), error => ['EACCES', 'EPERM'].includes(error.code));
        assert.equal(fs.existsSync('package.json'), false);
        assert.equal(require('./value.cjs'), 42);
        assert.equal(require('fixture-eval'), 45);
        Promise.all([import('./value.mjs'), import('fixture-eval')]).then(([value, bare]) => {
          assert.equal(value.default, 43);
          assert.equal(bare.default, 44);
          console.log('EVAL_IMPORT_READY');
        }).catch(error => { console.error(error); process.exitCode = 1; });
      `
      const args =
        invocation === 'stdin'
          ? []
          : invocation === 'print'
            ? ['-p', script]
            : [...(invocation === 'module-eval' ? ['--input-type=module'] : []), '-e', script]
      const wrapped = windowsLaunch({
        command: '',
        executable: join(runtime, 'node/node.exe'),
        args,
        cwd: workspace,
        env: environment,
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused-offline-probe', password: 'unused-offline-probe' },
        hostPath: config.windowsHostPath,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot,
        filesystem: {
          readOnlyRoots: [join(runtime, 'node')],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: workspace,
        env: wrapped.env,
        encoding: 'utf8',
        windowsHide: true,
        ...(invocation === 'stdin' ? { input: script } : {}),
        timeout: 30_000
      })
      await wrapped.confirmProcessTreeTermination()
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('EVAL_IMPORT_READY')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  },
  60_000
)

it.skipIf(!enabled).each(['malformed', 'unreadable'] as const)(
  'rejects a %s package config inside a readable workspace',
  async (kind) => {
    await mkdir(resolve('tmp'), { recursive: true })
    const workspace = await mkdtemp(resolve('tmp/notebook-package-config-'))
    const packagePath = join(workspace, 'package.json')
    const config = testRuntimeConfig()
    const environment = {
      ...process.env,
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main'
    }
    try {
      await writeFile(packagePath, kind === 'malformed' ? '{invalid' : '{"type":"commonjs"}')
      await mkdir(join(workspace, 'node_modules/fixture-eval'), { recursive: true })
      await writeFile(
        join(workspace, 'node_modules/fixture-eval/package.json'),
        '{"name":"fixture-eval","exports":"./value.cjs"}'
      )
      await writeFile(join(workspace, 'node_modules/fixture-eval/value.cjs'), 'module.exports = 42')
      if (kind === 'unreadable') {
        // Only this test-owned file receives a deny; the directory remains listable.
        const acl = spawnSync('icacls.exe', [packagePath, '/deny', '*S-1-1-0:(R)'], {
          encoding: 'utf8',
          windowsHide: true
        })
        expect(acl.status, acl.stderr).toBe(0)
      }
      for (const script of ["require('fixture-eval')", "import('fixture-eval')"]) {
        const wrapped = windowsLaunch({
          command: '',
          executable: join(runtimeRoot, 'node/node.exe'),
          args: ['-e', script],
          cwd: workspace,
          env: environment,
          gatewayPort: 61200,
          gatewayCredentials: {
            username: 'unused-offline-probe',
            password: 'unused-offline-probe'
          },
          hostPath: config.windowsHostPath,
          installationId: config.installationId,
          ownershipRoot: config.windowsOwnershipRoot,
          filesystem: {
            readOnlyRoots: [join(runtimeRoot, 'node')],
            readWriteRoots: [workspace],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
        const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
          cwd: workspace,
          env: wrapped.env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000
        })
        await wrapped.confirmProcessTreeTermination()
        expect(result.error, result.stderr).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('ERR_INVALID_PACKAGE_CONFIG')
      }
    } finally {
      if (kind === 'unreadable') {
        const acl = spawnSync('icacls.exe', [packagePath, '/remove:d', '*S-1-1-0'], {
          encoding: 'utf8',
          windowsHide: true
        })
        expect(acl.status, acl.stderr).toBe(0)
      }
      await rm(workspace, { recursive: true, force: true })
    }
  },
  60_000
)

it.skipIf(!enabled).each(['commonjs', 'module'] as const)(
  'retains readable %s workspace package imports, exports and file type',
  async (type) => {
    await mkdir(resolve('tmp'), { recursive: true })
    const workspace = await mkdtemp(resolve('tmp/notebook-package-scope-'))
    const config = testRuntimeConfig()
    try {
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({
          type,
          name: 'fixture-workspace',
          imports: { '#value': './value.js' },
          exports: './value.js'
        })
      )
      await writeFile(
        join(workspace, 'value.js'),
        type === 'commonjs' ? 'module.exports = 42' : 'export default 42'
      )
      const wrapped = windowsLaunch({
        command: '',
        executable: join(runtimeRoot, 'node/node.exe'),
        args: [
          '-e',
          `const assert = require('node:assert/strict');
           const value = require('fixture-workspace');
           assert.equal(${type === 'commonjs' ? 'value' : 'value.default'}, 42);
           Promise.all([import('#value'), import('fixture-workspace'), import('./value.js')]).then(values => {
             for (const value of values) assert.equal(value.default, 42);
             console.log('PACKAGE_SCOPE_READY');
           }).catch(error => { console.error(error); process.exitCode = 1; });`
        ],
        cwd: workspace,
        env: { ...process.env, NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main' },
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused-offline-probe', password: 'unused-offline-probe' },
        hostPath: config.windowsHostPath,
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot,
        filesystem: {
          readOnlyRoots: [join(runtimeRoot, 'node')],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: workspace,
        env: wrapped.env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000
      })
      await wrapped.confirmProcessTreeTermination()
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('PACKAGE_SCOPE_READY')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  },
  60_000
)

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
    const runtime = runtimeRoot
    const replLoop = resolve('resources/notebook/repl_loop.js')
    const config = testRuntimeConfig()
    const env: NodeJS.ProcessEnv = { TEMP: workspace, TMP: workspace }
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'LOCALAPPDATA']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    const sharedTools = await mkdtemp(join(tmpdir(), 'windows-notebook-tools-'))
    env.NPM_CONFIG_PREFIX = join(sharedTools, 'npm', `win32-${process.arch}`)
    env.OPEN_SCIENCE_CANONICAL_NPM_PREFIX = env.NPM_CONFIG_PREFIX
    await mkdir(env.NPM_CONFIG_PREFIX, { recursive: true })
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
          readWriteRoots: [workspace, env.NPM_CONFIG_PREFIX!],
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
      await rm(sharedTools, { recursive: true, force: true })
    }
  },
  120_000
)

it.skipIf(!enabled).each(['temporary', 'checkout'] as const)(
  'shares persistent npm tools across %s workspaces with Unicode and spaces',
  async (location) => {
    const base = location === 'temporary' ? tmpdir() : resolve('tmp')
    await mkdir(base, { recursive: true })
    const workspaces: string[] = []
    const sharedRoot = await mkdtemp(join(base, 'shared-runtime-目录 with spaces-'))
    const prefix = join(sharedRoot, 'npm', `win32-${process.arch}`)
    await mkdir(prefix, { recursive: true })
    const runtime = runtimeRoot
    const config = testRuntimeConfig()
    try {
      for (const version of ['1.0.0', '2.0.0']) {
        const workspace = await mkdtemp(join(base, 'notebook-tools-目录 with spaces-'))
        workspaces.push(workspace)
        const fixture = join(workspace, 'fixture')
        await mkdir(fixture)
        const esm = version === '2.0.0'
        await writeFile(
          join(fixture, 'package.json'),
          JSON.stringify({
            name: 'fixture-local-cli',
            version,
            type: esm ? 'module' : 'commonjs',
            bin: { 'fixture-cli': 'cli.js' },
            scripts: { postinstall: 'node install.cjs' }
          })
        )
        await writeFile(
          join(fixture, 'install.cjs'),
          "require('node:fs').writeFileSync('installed.json', JSON.stringify({ node: process.version, cwd: process.cwd() }))"
        )
        await writeFile(
          join(fixture, esm ? 'version.js' : 'version.cjs'),
          esm ? `export const version = '${version}';` : `exports.version = '${version}';`
        )
        await writeFile(
          join(fixture, 'cli.js'),
          `#!/usr/bin/env node\n${esm ? "import { version } from './version.js';" : "const { version } = require('./version.cjs');"}\nconsole.log('CLI_VERSION=' + version);`
        )
      }
      for (const [index, workspace] of workspaces.entries()) {
        await symlink(workspace, join(prefix, `escape-${index}`), 'junction')
      }
      for (const install of [true, false]) {
        for (const [index, workspace] of workspaces.entries()) {
          const cache = join(workspace, 'npm-cache')
          const environment: NodeJS.ProcessEnv = { TEMP: workspace, TMP: workspace }
          for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT']) {
            if (process.env[key] !== undefined) environment[key] = process.env[key]
          }
          environment.PATH = `${join(runtime, 'node')};${prefix};${environment.PATH}`
          environment.NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
          environment.NPM_CONFIG_PREFIX = prefix
          environment.OPEN_SCIENCE_CANONICAL_NPM_PREFIX = prefix
          environment.NPM_CONFIG_CACHE = cache
          const script = `
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const path = require('node:path');
            const cp = require('node:child_process');
            const options = { encoding: 'utf8', timeout: 30000 };
            ${install ? "cp.execSync('npm.cmd install -g ./fixture --offline --install-links --no-audit --no-fund', options);" : ''}
            const installed = path.join(process.env.NPM_CONFIG_PREFIX, 'node_modules', 'fixture-local-cli');
            const marker = JSON.parse(fs.readFileSync(path.join(installed, 'installed.json'), 'utf8'));
            assert.equal(marker.node, process.version);
            assert.equal(marker.cwd.toLowerCase(), installed.toLowerCase());
            assert.equal(cp.execSync('fixture-cli.cmd', options).trim(), ${JSON.stringify(`CLI_VERSION=${install ? index + 1 : 2}.0.0`)});
            assert.equal(fs.existsSync(path.join(process.cwd(), '.notebook-tools')), false);
            assert.throws(() => fs.readFileSync(${JSON.stringify(join(workspaces[1 - index], 'fixture/package.json'))}), error => ['EACCES', 'EPERM'].includes(error.code));
            const realpath = require(${JSON.stringify(join(runtime, 'node/node_modules/npm/node_modules/@npmcli/arborist/lib/realpath.js'))});
            const escape = ${JSON.stringify(join(prefix, `escape-${1 - index}`, 'fixture/package.json'))};
            assert.throws(() => fs.readFileSync(escape), error => ['EACCES', 'EPERM'].includes(error.code));
            realpath(escape, new Map(), new Map()).then(
              () => { throw new Error('npm resolved an unapproved junction target'); },
              error => assert.ok(['EACCES', 'EPERM'].includes(error.code))
            );
            console.log('WORKSPACE_TOOLS_READY');
          `
          const wrapped = windowsLaunch({
            command: '',
            executable: join(runtime, 'node/node.exe'),
            args: ['-e', script],
            cwd: workspace,
            env: environment,
            gatewayPort: 61200,
            gatewayCredentials: {
              username: 'unused-offline-probe',
              password: 'unused-offline-probe'
            },
            hostPath: config.windowsHostPath,
            installationId: config.installationId,
            ownershipRoot: config.windowsOwnershipRoot,
            filesystem: {
              readOnlyRoots: [join(runtime, 'node')],
              readWriteRoots: [workspace, prefix],
              deniedReadRoots: [],
              deniedWriteRoots: []
            }
          })
          const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
            cwd: workspace,
            env: wrapped.env,
            encoding: 'utf8',
            windowsHide: true,
            timeout: 90_000
          })
          await wrapped.confirmProcessTreeTermination()
          expect(result.error, result.stderr).toBeUndefined()
          expect(result.status, result.stderr).toBe(0)
          expect(result.stdout).toContain('WORKSPACE_TOOLS_READY')
          // A second AppContainer launch must find the same tools without their install cache.
          await rm(cache, { recursive: true, force: true })
        }
      }
      // Session deletion must not remove the runtime owner's shared package tree.
      for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
      expect(
        JSON.parse(
          await readFile(join(prefix, 'node_modules/fixture-local-cli/package.json'), 'utf8')
        ).version
      ).toBe('2.0.0')
    } finally {
      for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true })
      await rm(sharedRoot, { recursive: true, force: true })
    }
  },
  240_000
)

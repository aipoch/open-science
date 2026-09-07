import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import filesystem from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { defaultSpawn, installPackages, type InstallSpawn } from './package-manager'
import { micromambaSpawnEnv, resolveMicromamba } from './micromamba'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import { createProductionProvisioner } from './provisioner'
import { envPrefix, rLibraryDir, rScriptBin, runtimeRoot } from './runtime-paths'

// Use an already staged binary; this check never downloads tools or packages.
const micromamba = resolveMicromamba() ?? ''

it.skipIf(process.platform !== 'darwin')(
  'supports a configured storage root reached through a symlink',
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'os-cache-storage-link-')))
    const physicalStorage = join(directory, 'physical-storage')
    const storageRoot = join(directory, 'storage-link')
    mkdirSync(physicalStorage)
    symlinkSync(physicalStorage, storageRoot)
    const managedRoot = runtimeRoot(storageRoot)
    const spawn = sandboxedPackageSpawn({
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: managedRoot,
      storageRoot,
      processSandbox: {
        wrap: async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr) => stderr,
          cleanup: () => {}
        })
      }
    })
    try {
      const result = await spawn('/usr/bin/true', [], {
        CONDA_PKGS_DIRS: join(managedRoot, 'pkgs')
      })
      expect(result.code).toBe(0)
      expect(statSync(join(runtimeRoot(physicalStorage), 'pkgs', 'cache')).mode & 0o2000).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'darwin').each(['opened', 'validated'])(
  'fails closed if the repodata cache is replaced after its descriptor is %s',
  async (replacementPoint) => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-cache-replaced-')))
    const managedRoot = runtimeRoot(storageRoot)
    const packageRoot = join(managedRoot, 'pkgs')
    const cache = join(packageRoot, 'cache')
    const outside = join(storageRoot, 'outside')
    mkdirSync(cache, { recursive: true })
    mkdirSync(outside)
    chmodSync(cache, 0o2775)
    chmodSync(outside, 0o2775)
    const originalFstat = filesystem.fstatSync
    const originalFchmod = filesystem.fchmodSync
    const replaceCache = (): void => {
      renameSync(cache, join(packageRoot, 'previous-cache'))
      symlinkSync(outside, cache)
    }
    const observed =
      replacementPoint === 'opened'
        ? vi.spyOn(filesystem, 'fstatSync').mockImplementationOnce((fd) => {
            const state = originalFstat(fd)
            replaceCache()
            return state
          })
        : vi.spyOn(filesystem, 'fchmodSync').mockImplementationOnce((fd, mode) => {
            replaceCache()
            originalFchmod(fd, mode)
          })
    syncBuiltinESMExports()
    const spawn = sandboxedPackageSpawn({
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: managedRoot,
      storageRoot,
      processSandbox: {
        wrap: async () => {
          throw new Error('must reject before sandbox launch')
        }
      }
    })
    try {
      await expect(spawn('/usr/bin/true', [], { CONDA_PKGS_DIRS: packageRoot })).rejects.toThrow(
        /not a trusted directory|changed during preparation/
      )
      expect(statSync(outside).mode & 0o2000).toBe(0o2000)
    } finally {
      observed.mockRestore()
      syncBuiltinESMExports()
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'darwin').each(['parent', 'cache'])(
  'rejects a %s symlink before changing any external Micromamba cache',
  async (linkLocation) => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-cache-symlink-')))
    const managedRoot = runtimeRoot(storageRoot)
    const packageRoot = join(managedRoot, 'pkgs')
    const outside = join(storageRoot, 'outside')
    mkdirSync(managedRoot, { recursive: true })
    mkdirSync(outside)
    chmodSync(outside, 0o2775)
    if (linkLocation === 'parent') symlinkSync(outside, packageRoot)
    else {
      mkdirSync(packageRoot)
      symlinkSync(outside, join(packageRoot, 'cache'))
    }
    const spawn = sandboxedPackageSpawn({
      request: { language: 'python', packages: ['example'] },
      runtimeRoot: managedRoot,
      storageRoot,
      processSandbox: {
        wrap: async () => {
          throw new Error('must reject before sandbox launch')
        }
      }
    })
    try {
      await expect(spawn('/usr/bin/true', [], { CONDA_PKGS_DIRS: packageRoot })).rejects.toThrow()
      expect(statSync(outside).mode & 0o2000).toBe(0o2000)
      expect(existsSync(join(outside, 'cache'))).toBe(false)
    } finally {
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'darwin' || !existsSync(micromamba)).each(['fresh', 'setgid'])(
  'lets real Micromamba write its %s managed repodata cache through the production sandbox owner',
  async (cacheState) => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-real-package-sandbox-')))
    const managedRoot = runtimeRoot(storageRoot)
    const prefix = envPrefix(managedRoot, 'analysis')
    const channel = join(storageRoot, 'channel')
    const repodataCache = join(managedRoot, 'pkgs', 'cache')
    if (cacheState === 'setgid') {
      mkdirSync(repodataCache, { recursive: true })
      chmodSync(repodataCache, 0o2775)
    }
    writeOfflineChannel(channel, ['python', 'pip'])
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const spawn = sandboxedPackageSpawn({
      request: {
        language: 'python',
        packages: ['python'],
        projectId: 'project',
        sessionId: 'session',
        workspaceCwd: storageRoot
      },
      runtimeRoot: managedRoot,
      storageRoot,
      processSandbox: {
        wrap: (invocation) => {
          expect(existsSync(repodataCache)).toBe(true)
          expect(statSync(repodataCache).mode & 0o2000).toBe(0)
          return owner.wrap(invocation)
        }
      }
    })

    try {
      const result = await spawn(
        micromamba,
        [
          '--no-rc',
          'create',
          '--root-prefix',
          managedRoot,
          '--prefix',
          prefix,
          '-y',
          '-c',
          pathToFileURL(channel).href,
          'python',
          '--offline',
          '--dry-run'
        ],
        micromambaSpawnEnv(managedRoot)
      )

      expect(result.code, result.stderr).toBe(0)
      expect(statSync(repodataCache).mode & 0o2000).toBe(0)
    } finally {
      await owner.dispose()
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

const writeOfflineChannel = (root: string, packageNames: readonly string[]): void => {
  for (const subdir of ['noarch', process.arch === 'arm64' ? 'osx-arm64' : 'osx-64']) {
    const channel = join(root, subdir)
    mkdirSync(channel, { recursive: true })
    writeFileSync(
      join(channel, 'repodata.json'),
      JSON.stringify({
        info: { subdir },
        packages:
          subdir === 'noarch'
            ? Object.fromEntries(
                packageNames.map((name) => [
                  `${name}-1.0-0.tar.bz2`,
                  {
                    name,
                    version: name === 'python' ? '3.12' : '1.0',
                    build: '0',
                    build_number: 0,
                    depends: [],
                    subdir,
                    noarch: 'generic',
                    size: 1,
                    sha256: '0'.repeat(64)
                  }
                ])
              )
            : {},
        'packages.conda': {},
        repodata_version: 1
      })
    )
  }
}

it.skipIf(process.platform !== 'darwin' || !existsSync(micromamba))(
  'installs a real package into a managed environment through the production sandbox owner',
  async () => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-real-conda-install-')))
    const managedRoot = runtimeRoot(storageRoot)
    const prefix = envPrefix(managedRoot, 'default-python')
    const channel = join(storageRoot, 'channel')
    const source = join(storageRoot, 'package-source')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    try {
      mkdirSync(join(prefix, 'conda-meta'), { recursive: true })
      writeFileSync(join(prefix, 'conda-meta', 'history'), '')
      mkdirSync(join(source, 'info'), { recursive: true })
      mkdirSync(join(source, 'share'))
      writeFileSync(join(source, 'share', 'sandbox-proof.txt'), 'installed by real Micromamba\n')
      const metadata = {
        name: 'sandbox-proof',
        version: '1.0',
        build: '0',
        build_number: 0,
        depends: [],
        subdir: 'noarch',
        noarch: 'generic'
      }
      writeFileSync(join(source, 'info', 'index.json'), JSON.stringify(metadata))
      writeFileSync(join(source, 'info', 'files'), 'share/sandbox-proof.txt\n')
      writeOfflineChannel(channel, [])
      const filename = 'sandbox-proof-1.0-0.tar.bz2'
      const archive = join(channel, 'noarch', filename)
      const packed = spawnSync('/usr/bin/tar', ['-cjf', archive, '-C', source, 'info', 'share'], {
        encoding: 'utf8'
      })
      expect(packed.status, packed.stderr).toBe(0)
      const bytes = readFileSync(archive)
      writeFileSync(
        join(channel, 'noarch', 'repodata.json'),
        JSON.stringify({
          info: { subdir: 'noarch' },
          packages: {
            [filename]: {
              ...metadata,
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex')
            }
          },
          'packages.conda': {},
          repodata_version: 1
        })
      )
      const request = {
        language: 'python' as const,
        packages: ['sandbox-proof'],
        workspaceCwd: storageRoot
      }
      const result = await installPackages(request, {
        storageRoot,
        micromamba,
        condaChannel: pathToFileURL(channel).href,
        spawn: sandboxedPackageSpawn({
          request,
          runtimeRoot: managedRoot,
          storageRoot,
          processSandbox: owner
        })
      })
      expect(result.ok, result.log).toBe(true)
      expect(result.method).toBe('conda')
      expect(readFileSync(join(prefix, 'share', 'sandbox-proof.txt'), 'utf8')).toBe(
        'installed by real Micromamba\n'
      )
    } finally {
      await owner.dispose()
      rmSync(storageRoot, { recursive: true, force: true })
    }
  },
  60_000
)

it.skipIf(process.platform === 'win32')(
  'keeps a managed pip process isolated from packages in the real user site directory',
  async () => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-pip-user-site-')))
    const home = join(storageRoot, 'user-home')
    const prefix = envPrefix(runtimeRoot(storageRoot), 'default-python')
    const pip = join(prefix, 'bin', 'pip')
    try {
      mkdirSync(home, { recursive: true })
      const discovered = spawnSync(
        '/usr/bin/python3',
        ['-c', 'import site; print(site.getusersitepackages())'],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home } }
      )
      expect(discovered.status, discovered.stderr).toBe(0)
      const userSite = discovered.stdout.trim()
      mkdirSync(userSite, { recursive: true })
      writeFileSync(join(userSite, 'open_science_user_site_sentinel.py'), 'VALUE = "private"\n')
      mkdirSync(join(prefix, 'bin'), { recursive: true })
      writeFileSync(
        pip,
        [
          '#!/bin/sh',
          `/usr/bin/python3 -c 'import open_science_user_site_sentinel' >/dev/null 2>&1`,
          'test $? -ne 0'
        ].join('\n') + '\n'
      )
      chmodSync(pip, 0o755)

      const spawn = sandboxedPackageSpawn({
        request: { language: 'python', packages: ['example'], usePip: true },
        runtimeRoot: runtimeRoot(storageRoot),
        storageRoot,
        processSandbox: {
          wrap: async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup: () => {}
          })
        }
      })
      const result = await installPackages(
        { language: 'python', packages: ['example'], usePip: true },
        {
          storageRoot,
          spawn: (command, args, env, ...rest) =>
            spawn(command, args, { ...env, HOME: home }, ...rest)
        }
      )

      expect(result.ok, result.log).toBe(true)
    } finally {
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'isolates every managed R installer from user startup files and libraries',
  async () => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-r-user-config-')))
    const managedRoot = runtimeRoot(storageRoot)
    const environment = 'analysis'
    const prefix = envPrefix(managedRoot, environment)
    const managedHome = join(managedRoot, 'home')
    const managedLibrary = rLibraryDir(prefix)
    const hostHome = join(storageRoot, 'host-home')
    const hostLibrary = join(hostHome, 'R', 'library')
    const executable = rScriptBin(prefix)
    const fakeMicromamba = '/managed/micromamba'
    const inheritedKeys = ['HOME', 'R_USER', 'R_LIBS_USER'] as const
    const inherited = Object.fromEntries(inheritedKeys.map((key) => [key, process.env[key]]))
    try {
      mkdirSync(join(prefix, 'bin'), { recursive: true })
      mkdirSync(hostLibrary, { recursive: true })
      writeFileSync(join(hostHome, '.Rprofile'), 'stop("host .Rprofile loaded")\n')
      writeFileSync(join(hostHome, '.Renviron'), 'OPEN_SCIENCE_HOST_RENVIRON=loaded\n')
      writeFileSync(join(hostLibrary, 'host-package'), 'private\n')
      writeFileSync(
        executable,
        [
          `#!${process.execPath}`,
          "const fs = require('node:fs')",
          `const hostHome = ${JSON.stringify(hostHome)}`,
          `const expectedHome = ${JSON.stringify(managedHome)}`,
          `const expectedLibrary = ${JSON.stringify(managedLibrary)}`,
          "const vanilla = process.argv.includes('--vanilla')",
          "if (!vanilla && (fs.existsSync(hostHome + '/.Rprofile') || fs.existsSync(hostHome + '/.Renviron'))) process.exit(41)",
          'if (process.env.HOME !== expectedHome || process.env.R_USER !== expectedHome) process.exit(42)',
          'if (process.env.R_LIBS_USER !== expectedLibrary) process.exit(43)',
          "process.stdout.write('isolated managed R')"
        ].join('\n') + '\n'
      )
      chmodSync(executable, 0o755)
      process.env.HOME = hostHome
      process.env.R_USER = hostHome
      process.env.R_LIBS_USER = hostLibrary

      const condaPackageUnavailable = {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          solver_problems: ['r-example does not exist'],
          actions: { LINK: [], UNLINK: [], FETCH: [] }
        }),
        stderr: 'package not found'
      }
      const condaPackageNotManaged = {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          error: 'packages to remove not found in the environment: r-example',
          actions: {}
        }),
        stderr: 'package not installed'
      }
      const spawn: InstallSpawn = (command, args, env) => {
        if (command === fakeMicromamba) {
          if (args[1] === 'clean') {
            return Promise.resolve({ code: 0, stdout: '', stderr: '' })
          }
          return Promise.resolve(
            args.includes('remove') ? condaPackageNotManaged : condaPackageUnavailable
          )
        }
        return defaultSpawn(command, args, env)
      }
      const deps = {
        storageRoot,
        micromamba: fakeMicromamba,
        spawn,
        pathExists: () => true,
        readCondaPackageIdentity: () => ({
          name: 'r-base',
          version: '4.4.3',
          build: 'h123_0',
          buildNumber: 0
        })
      }
      const results = []
      results.push(
        await installPackages({ language: 'r', packages: ['example'], environment }, deps)
      )
      results.push(
        await installPackages(
          { language: 'r', packages: ['example'], environment, operation: 'uninstall' },
          deps
        )
      )
      results.push(
        await installPackages(
          { language: 'r', packages: ['Example'], environment, installer: 'biocmanager' },
          deps
        )
      )
      results.push(
        await installPackages(
          { language: 'r', packages: ['owner/repository'], environment, installer: 'github' },
          deps
        )
      )

      expect(results.map(({ ok }) => ok)).toEqual([true, true, true, true])
      expect(results.every(({ log }) => log.includes('isolated managed R'))).toBe(true)
    } finally {
      for (const key of inheritedKeys) {
        const value = inherited[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'darwin' || !existsSync(micromamba))(
  'plans a pandas install while the user package cache remains denied by Seatbelt',
  async () => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-package-cache-sandbox-')))
    const runtimeRoot = join(storageRoot, 'runtime')
    const home = join(storageRoot, 'home')
    const userCache = join(home, '.mamba', 'pkgs')
    const shard = join(userCache, 'cache', 'shards', 'private.msgpack.zst')
    const profile = join(storageRoot, 'sandbox.sb')
    const request = { language: 'python' as const, packages: ['pandas'] }
    try {
      mkdirSync(join(userCache, 'cache', 'shards'), { recursive: true })
      writeFileSync(shard, 'private cache')
      mkdirSync(join(runtimeRoot, 'envs', 'default-python', 'conda-meta'), { recursive: true })
      writeFileSync(join(runtimeRoot, 'envs', 'default-python', 'conda-meta', 'history'), '')
      // An offline solver-only package: no archive is downloaded or installed.
      writeOfflineChannel(join(storageRoot, 'channel'), ['pandas'])
      writeFileSync(
        profile,
        `(version 1)\n(allow default)\n(deny file-read* file-write* (subpath ${JSON.stringify(userCache)}))\n`
      )
      const checkDenied = (): void => {
        const denied = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', shard], {
          encoding: 'utf8'
        })
        expect(denied.stderr).toContain('Operation not permitted')
        expect(denied.status).toBe(1)
      }
      checkDenied()
      const spawn = sandboxedPackageSpawn({
        request,
        runtimeRoot,
        storageRoot,
        processSandbox: {
          wrap: async (invocation) => ({
            executable: '/usr/bin/sandbox-exec',
            args: ['-f', profile, invocation.executable, ...invocation.args],
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup: () => {}
          })
        }
      })
      const result = await installPackages(request, {
        storageRoot,
        micromamba,
        condaChannel: pathToFileURL(join(storageRoot, 'channel')).href,
        micromambaEnv: { env: { PATH: '/usr/bin:/bin', HOME: home } },
        spawn: (command, args, ...rest) =>
          spawn(
            command,
            args.includes('install') ? [...args, '--offline', '--dry-run'] : args,
            ...rest
          )
      })
      expect(result.ok, result.log).toBe(true)
      expect(result.method).toBe('conda')
      expect(result.fallbackUsed).toBe(false)
      checkDenied()
    } finally {
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'darwin' || !existsSync(micromamba))(
  'plans managed Python and R environment creates while host Micromamba and Conda state remain denied',
  async () => {
    const storageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'os-env-state-sandbox-')))
    const managedRoot = runtimeRoot(storageRoot)
    const hostHome = join(storageRoot, 'host-home')
    const hostMambaState = join(hostHome, '.mamba')
    const hostCondaState = join(hostHome, '.conda')
    const profile = join(storageRoot, 'sandbox.sb')
    const previousHome = process.env.HOME
    try {
      mkdirSync(hostMambaState, { recursive: true })
      mkdirSync(hostCondaState, { recursive: true })
      writeFileSync(join(hostMambaState, 'private-state'), 'private')
      writeFileSync(join(hostCondaState, 'environments.txt'), '/private/environment\n')
      writeOfflineChannel(join(storageRoot, 'channel'), [
        'python',
        'pip',
        'matplotlib-base',
        'nomkl',
        'r-base',
        'r-jsonlite'
      ])
      writeFileSync(
        profile,
        [
          '(version 1)',
          '(allow default)',
          `(deny file-read* file-write* (subpath ${JSON.stringify(hostMambaState)}))`,
          `(deny file-read* file-write* (subpath ${JSON.stringify(hostCondaState)}))`
        ].join('\n') + '\n'
      )
      process.env.HOME = hostHome
      const processSandbox = {
        wrap: async (invocation: {
          executable: string
          args: readonly string[]
          env: NodeJS.ProcessEnv
        }) => ({
          executable: '/usr/bin/sandbox-exec',
          args: [
            '-f',
            profile,
            invocation.executable,
            ...invocation.args,
            '--offline',
            '--dry-run'
          ],
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup: () => {}
        })
      }
      const provisioner = createProductionProvisioner(
        {
          root: managedRoot,
          channel: pathToFileURL(join(storageRoot, 'channel')).href,
          processSandbox
        },
        {
          runner: { initialPath: micromamba, resolve: async () => micromamba },
          maintainCache: async () => undefined,
          verify: async () => undefined,
          captureExplicitLock: async () => '@EXPLICIT\n'
        }
      )

      await expect(
        provisioner.createNamedEnvironment('analysis', 'python', [], {
          projectId: 'project',
          sessionId: 'session',
          workspaceCwd: storageRoot
        })
      ).resolves.toMatchObject({ name: 'analysis', language: 'python', ready: false })
      await expect(
        provisioner.createNamedEnvironment('r-stats', 'r', [], {
          projectId: 'project',
          sessionId: 'session',
          workspaceCwd: storageRoot
        })
      ).resolves.toMatchObject({ name: 'r-stats', language: 'r', ready: false })
      for (const deniedPath of [
        join(hostMambaState, 'private-state'),
        join(hostCondaState, 'environments.txt')
      ]) {
        const denied = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', deniedPath], {
          encoding: 'utf8'
        })
        expect(denied.stderr).toContain('Operation not permitted')
        expect(denied.status).toBe(1)
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(storageRoot, { recursive: true, force: true })
    }
  }
)

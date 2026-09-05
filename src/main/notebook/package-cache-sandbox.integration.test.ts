import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { expect, it } from 'vitest'

import { installPackages } from './package-manager'
import { sandboxedPackageSpawn } from './package-process-sandbox'

// Use an already staged binary; this check never downloads tools or packages.
const micromamba = resolve(
  process.env.OPEN_SCIENCE_TEST_MICROMAMBA ?? `resources/bin/mac/${process.arch}/micromamba`
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
      for (const subdir of ['noarch', process.arch === 'arm64' ? 'osx-arm64' : 'osx-64']) {
        const channel = join(storageRoot, 'channel', subdir)
        mkdirSync(channel, { recursive: true })
        writeFileSync(
          join(channel, 'repodata.json'),
          JSON.stringify({
            info: { subdir },
            packages:
              subdir === 'noarch'
                ? {
                    'pandas-1.0-0.tar.bz2': {
                      name: 'pandas',
                      version: '1.0',
                      build: '0',
                      build_number: 0,
                      depends: [],
                      subdir,
                      noarch: 'generic',
                      size: 1,
                      sha256: '0'.repeat(64)
                    }
                  }
                : {},
            'packages.conda': {},
            repodata_version: 1
          })
        )
      }
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

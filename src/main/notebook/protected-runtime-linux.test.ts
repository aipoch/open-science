import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { prepareProtectedRuntime } from './prepare-protected-runtime'
import { linuxLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/linux-isolation'

it.skipIf(process.platform === 'win32')(
  'compiles first-run Linux protection without nonexistent bind sources and protects absent configuration',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'linux-plan-roots-'))
    let launch: Awaited<ReturnType<typeof linuxLaunch>> | undefined
    try {
      const runtime = join(root, 'runtime')
      const config = join(root, 'config')
      const bin = join(root, 'bin')
      await mkdir(runtime)
      await mkdir(config)
      await writeFile(join(config, 'secret.json'), 'secret')
      await mkdir(bin)
      for (const name of ['bwrap', 'sh']) {
        await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n')
        await chmod(join(bin, name), 0o755)
      }
      expect(existsSync(join(runtime, 'approval-plans'))).toBe(false)
      await prepareProtectedRuntime(runtime)
      launch = await linuxLaunch({
        command: 'true',
        shell: 'sh',
        cwd: root,
        gatewayPort: 9,
        gatewayCredentials: { username: 'u', password: 'p' },
        env: { PATH: bin },
        filesystem: {
          privateRoot: root,
          readOnlyRoots: [runtime],
          readWriteRoots: [root],
          deniedWriteRoots: [join(runtime, 'approval-plans'), join(runtime, 'envs')],
          deniedReadRoots: [
            join(config, 'secret.json'),
            join(config, 'skills'),
            join(config, 'specialists.json')
          ]
        }
      })
      const sources = launch.argv.flatMap((arg, i) =>
        arg === '--ro-bind' ? [launch!.argv[i + 1]] : []
      )
      expect(sources.every((source) => existsSync(source))).toBe(true)
      expect(sources.some((source) => source.endsWith('/runtime/approval-plans'))).toBe(true)
      // The missing file/directory stay missing; their existing parent is read-only in the guest.
      expect(sources.some((source) => source.endsWith('/config'))).toBe(true)
      const lastParentMount = launch.argv.findLastIndex(
        (arg, i) => arg === '--ro-bind' && launch!.argv[i + 1].endsWith('/config')
      )
      const secretMask = launch.argv.findIndex(
        (arg, i) =>
          arg === '--ro-bind' &&
          launch!.argv[i + 1] === '/dev/null' &&
          launch!.argv[i + 2].endsWith('/secret.json')
      )
      expect(secretMask).toBeGreaterThan(lastParentMount)
      expect(existsSync(join(config, 'skills'))).toBe(false)
      expect(existsSync(join(config, 'specialists.json'))).toBe(false)
    } finally {
      await launch?.release()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'linux')(
  'starts a real Linux first-run workload while denying later protected writes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'linux-plan-native-'))
    let launch: Awaited<ReturnType<typeof linuxLaunch>> | undefined
    try {
      const runtime = join(root, 'runtime')
      const config = join(root, 'config')
      await mkdir(config)
      await writeFile(join(config, 'secret.json'), 'secret')
      await prepareProtectedRuntime(runtime)
      launch = await linuxLaunch({
        command:
          'test ! -s config/secret.json || exit 13; echo analysis > result.txt; if echo bad > runtime/approval-plans/forged; then exit 11; fi; if echo bad > config/specialists.json; then exit 12; fi',
        shell: '/bin/sh',
        cwd: root,
        gatewayPort: 9,
        gatewayCredentials: { username: 'u', password: 'p' },
        env: { ...process.env },
        filesystem: {
          privateRoot: root,
          readOnlyRoots: [runtime],
          readWriteRoots: [root],
          deniedWriteRoots: [join(runtime, 'envs'), join(runtime, 'approval-plans')],
          deniedReadRoots: [
            join(config, 'secret.json'),
            join(config, 'skills'),
            join(config, 'specialists.json')
          ]
        }
      })
      const child = spawnSync(launch.argv[0], launch.argv.slice(1), {
        env: launch.env,
        encoding: 'utf8',
        timeout: 20000
      })
      expect(child.status, child.stderr).toBe(0)
      expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('analysis\n')
      await expect(stat(join(runtime, 'approval-plans', 'forged'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(stat(join(config, 'specialists.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await launch?.release()
      await rm(root, { recursive: true, force: true })
    }
  }
)

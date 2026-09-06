import { afterEach, describe, expect, it, vi } from 'vitest'

import { wsl2Launch, type Wsl2Launch } from '../runtime/src/platform/wsl2-isolation.js'
import { notebookWorkloadCacheEnv } from '../../../src/main/notebook/notebook-workload-cache-paths.js'

const mapped = new Map([
  ['C:\\Open Science\\Workspace 路径', '/mnt/c/Open Science/Workspace 路径'],
  ['C:\\Open Science\\handoff', '/mnt/c/Open Science/handoff'],
  ['C:\\Open Science\\cache', '/mnt/c/Open Science/cache'],
  ['C:\\private', '/mnt/c/private']
])
const reconciled = async (): Promise<boolean> => true

afterEach(() => vi.unstubAllEnvs())

describe('WSL2 sandbox adapter', () => {
  it('compiles Windows policy into a gateway-only bwrap Bash launch', async () => {
    const runtimeRoot = 'C:\\Open Science\\runtime 路径'
    const cacheEnvironment = notebookWorkloadCacheEnv(runtimeRoot)
    const cacheRoot = cacheEnvironment.OPEN_SCIENCE_NOTEBOOK_CACHE_DIR!
    const mapPath = vi.fn(async (path: string) => {
      const known = mapped.get(path)
      if (known) return known
      if (/^C:\\/u.test(path)) return `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
      return path
    })
    const closeBridge = vi.fn().mockResolvedValue({
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const openBridge = vi.fn().mockResolvedValue({
      socketPath: '/tmp/open-science-network-command/gateway.sock',
      close: closeBridge
    })
    const cleanupGuest = vi.fn(async () => true)

    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: `printf '你好 world'`,
      cwd: 'C:\\Open Science\\Workspace 路径',
      env: {
        PATH: 'C:\\Windows\\System32',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak'
      },
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      pathEnvironment: {
        OPEN_SCIENCE_HANDOFF_DIR: 'C:\\Open Science\\handoff',
        ...cacheEnvironment
      },
      filesystem: {
        privateRoot: 'C:\\private',
        readOnlyRoots: ['/usr', '/bin'],
        readWriteRoots: [
          'C:\\Open Science\\Workspace 路径',
          'C:\\Open Science\\handoff',
          cacheRoot
        ],
        deniedReadRoots: ['C:\\private'],
        deniedWriteRoots: []
      },
      reconcileGuest: reconciled,
      mapPath,
      cleanupGuest,
      openBridge
    })

    expect(launch.argv[0]).toMatch(/wsl\.exe$/i)
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        '--distribution',
        'Ubuntu-22.04',
        '--user',
        'open-science-spike',
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        expect.stringContaining('export OPEN_SCIENCE_WSL_EXECUTION_TOKEN="$token"'),
        'open-science-wsl-execution',
        expect.stringMatching(/^\/tmp\/\.open-science-execution-[0-9a-f-]{36}\.receipt$/u),
        expect.stringMatching(/^open-science-execution-[0-9a-f-]{36}$/u),
        '/usr/bin/bwrap',
        '--unshare-all',
        '--tmpfs',
        '/mnt',
        '--bind',
        '/tmp/open-science-network-command/gateway.sock',
        '/run/open-science-notebook/gateway.sock',
        '--bind',
        '/mnt/c/Open Science/Workspace 路径',
        '/mnt/c/Open Science/Workspace 路径',
        '--chdir',
        '/mnt/c/Open Science/Workspace 路径',
        '/usr/bin/python3',
        '-c',
        expect.stringMatching(/^import base64,zlib;exec\(zlib\.decompress/u),
        '/run/open-science-notebook/gateway.sock',
        '3128',
        'command-user',
        'command-secret',
        `printf '你好 world'`
      ])
    )
    expect(launch.argv.slice(1).join('\n')).not.toContain('C:\\')
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        '--setenv',
        'PATH',
        '/usr/bin:/bin',
        '--setenv',
        'OPEN_SCIENCE_HANDOFF_DIR',
        '/mnt/c/Open Science/handoff',
        '--setenv',
        'OPEN_SCIENCE_NOTEBOOK_CACHE_DIR',
        '/mnt/c/Open Science/runtime 路径/cache/notebook'
      ])
    )
    expect(openBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ profileId: 'profile-1' }),
        gatewayPort: 4312
      })
    )
    for (const [key, value] of Object.entries(cacheEnvironment)) {
      const keyIndex = launch.argv.indexOf(key)
      expect(keyIndex).toBeGreaterThan(0)
      expect(launch.argv[keyIndex + 1]).toBe(`/mnt/c/${value!.slice(3).replaceAll('\\', '/')}`)
    }
    expect(launch.argv.join('\n')).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(launch.env.PATH).toBeUndefined()
    expect(launch.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(mapPath).toHaveBeenCalledWith('C:\\Open Science\\Workspace 路径', undefined)
    launch.beginSpawn().started()
    await expect(launch.release()).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(cleanupGuest).toHaveBeenCalledOnce()
    expect(closeBridge).toHaveBeenCalledOnce()
  })

  it('mounts writable parents before read-only children so nested input roots stay read-only', async () => {
    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'nested-policy-profile',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: 'echo sandboxed',
      cwd: 'C:\\workspace',
      env: {},
      filesystem: {
        readOnlyRoots: ['C:\\workspace\\input'],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      reconcileGuest: reconciled,
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      mapPath: async (path) => `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`,
      cleanupGuest: async () => true,
      openBridge: async () => ({
        socketPath: '/tmp/open-science-network-command/gateway.sock',
        close: async () => ({ networkClosed: true, temporaryResourcesRemoved: true })
      })
    })

    const writableParentMount = launch.argv.findIndex(
      (value, index) =>
        value === '--bind' &&
        launch.argv[index + 1] === '/mnt/c/workspace' &&
        launch.argv[index + 2] === '/mnt/c/workspace'
    )
    const readOnlyChildMount = launch.argv.findIndex(
      (value, index) =>
        value === '--ro-bind' &&
        launch.argv[index + 1] === '/mnt/c/workspace/input' &&
        launch.argv[index + 2] === '/mnt/c/workspace/input'
    )

    expect(writableParentMount).toBeGreaterThan(0)
    expect(readOnlyChildMount).toBeGreaterThan(writableParentMount)
    await launch.release()
  })

  it('applies denied ancestors after narrower writable grants', async () => {
    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'nested-deny-profile',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: 'echo sandboxed',
      cwd: 'C:\\workspace',
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\protected-write\\child', 'C:\\protected-read\\child'],
        deniedReadRoots: ['C:\\protected-read'],
        deniedWriteRoots: ['C:\\protected-write']
      },
      reconcileGuest: reconciled,
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      mapPath: async (path) => `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`,
      cleanupGuest: async () => true,
      openBridge: async () => ({
        socketPath: '/tmp/open-science-network-command/gateway.sock',
        close: async () => ({ networkClosed: true, temporaryResourcesRemoved: true })
      })
    })

    const writableChildMount = (path: string): number =>
      launch.argv.findIndex(
        (value, index) =>
          value === '--bind' && launch.argv[index + 1] === path && launch.argv[index + 2] === path
      )
    const deniedAncestorMount = (operation: '--ro-bind' | '--tmpfs', path: string): number =>
      launch.argv.findIndex(
        (value, index) => value === operation && launch.argv[index + 1] === path
      )

    expect(deniedAncestorMount('--ro-bind', '/mnt/c/protected-write')).toBeGreaterThan(
      writableChildMount('/mnt/c/protected-write/child')
    )
    expect(deniedAncestorMount('--tmpfs', '/mnt/c/protected-read')).toBeGreaterThan(
      writableChildMount('/mnt/c/protected-read/child')
    )
    await launch.release()
  })

  it('retains the exact receipt and retries an incomplete guest cleanup', async () => {
    const cleanupGuest = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const closeBridge = vi.fn().mockResolvedValue({
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: 'sleep 30',
      cwd: 'C:\\workspace',
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      reconcileGuest: reconciled,
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      mapPath: async () => '/mnt/c/workspace',
      cleanupGuest,
      openBridge: async () => ({
        socketPath: '/tmp/open-science-network-command/gateway.sock',
        close: closeBridge
      })
    })

    launch.beginSpawn().started()

    const first = launch.release('cancel')
    const concurrent = launch.release('timeout')

    await expect(first).resolves.toEqual({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: false
    })
    expect(concurrent).toBe(first)
    expect(cleanupGuest).toHaveBeenCalledOnce()
    expect(cleanupGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike',
        reason: 'cancel',
        receipt: expect.stringMatching(/^\/tmp\/\.open-science-execution-/u),
        token: expect.stringMatching(/^open-science-execution-/u)
      })
    )
    expect(closeBridge).toHaveBeenCalledOnce()

    await expect(launch.release('cancel')).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(cleanupGuest).toHaveBeenCalledTimes(2)
    expect(cleanupGuest.mock.calls[1]?.[0]).toEqual(cleanupGuest.mock.calls[0]?.[0])
  })

  it('skips guest receipt cleanup only when spawn admission proves no process began', async () => {
    const cleanupGuest = vi.fn(async () => true)
    const close = vi.fn(async () => ({
      networkClosed: true,
      temporaryResourcesRemoved: true
    }))
    const launch = await wsl2Launch({
      target: {
        kind: 'wsl2',
        profileId: 'never-spawned-profile',
        distro: 'Ubuntu-22.04',
        user: 'open-science-spike'
      },
      command: 'echo never-spawned',
      cwd: 'C:\\workspace',
      env: {},
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      reconcileGuest: reconciled,
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      mapPath: async () => '/mnt/c/workspace',
      cleanupGuest,
      openBridge: async () => ({
        socketPath: '/tmp/open-science-network-command/gateway.sock',
        close
      })
    })

    const admission = launch.beginSpawn()
    admission.notStarted()
    await expect(launch.release('spawn-failed')).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(cleanupGuest).not.toHaveBeenCalled()
  })

  it('stops preparation when cancellation arrives during path mapping', async () => {
    const controller = new AbortController()
    const openBridge = vi.fn()
    let mapped = 0

    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        signal: controller.signal,
        filesystem: {
          readOnlyRoots: ['C:\\runtime'],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        reconcileGuest: reconciled,
        mapPath: async (path) => {
          mapped += 1
          if (mapped === 1) controller.abort()
          return `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
        },
        openBridge
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(openBridge).not.toHaveBeenCalled()
  })

  it('publishes retryable cleanup ownership before an abort can strand a prepared bridge', async () => {
    const controller = new AbortController()
    const close = vi
      .fn()
      .mockResolvedValueOnce({ networkClosed: false, temporaryResourcesRemoved: false })
      .mockResolvedValueOnce({ networkClosed: true, temporaryResourcesRemoved: true })
    let release: Wsl2Launch['release'] | undefined

    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'bridge-abort-profile',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        signal: controller.signal,
        gatewayPort: 4312,
        gatewayCredentials: { username: 'command-user', password: 'command-secret' },
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        reconcileGuest: reconciled,
        mapPath: async () => '/mnt/c/workspace',
        cleanupGuest: async () => true,
        openBridge: async () => {
          controller.abort()
          return { socketPath: '/tmp/open-science-network-command/gateway.sock', close }
        },
        onCleanupReady: (ownedRelease) => {
          release = ownedRelease
        }
      })
    ).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    expect(release).toBeDefined()
    await expect(release?.('cancel')).resolves.toEqual({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('serializes first-launch receipt reconciliation and remembers success per guest profile', async () => {
    let finishReconciliation!: (value: boolean) => void
    const reconcileGuest = vi.fn(
      () => new Promise<boolean>((resolve) => (finishReconciliation = resolve))
    )
    const openBridge = vi.fn(async () => ({
      socketPath: '/tmp/open-science-network-command/gateway.sock',
      close: async () => ({ networkClosed: true, temporaryResourcesRemoved: true })
    }))
    const request = {
      target: {
        kind: 'wsl2' as const,
        profileId: 'concurrent-profile',
        distro: 'Concurrent-Ubuntu',
        user: 'concurrent-user'
      },
      command: 'echo sandboxed',
      cwd: 'C:\\workspace',
      env: {},
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      filesystem: {
        readOnlyRoots: [] as string[],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [] as string[],
        deniedWriteRoots: [] as string[]
      },
      reconcileGuest,
      mapPath: async () => '/mnt/c/workspace',
      cleanupGuest: async () => true,
      openBridge
    }

    const first = wsl2Launch(request)
    const second = wsl2Launch(request)
    await Promise.resolve()
    expect(reconcileGuest).toHaveBeenCalledOnce()
    expect(openBridge).not.toHaveBeenCalled()
    finishReconciliation(true)
    const launches = await Promise.all([first, second])
    expect(openBridge).toHaveBeenCalledTimes(2)
    await Promise.all(launches.map((launch) => launch.release()))

    const third = await wsl2Launch(request)
    expect(reconcileGuest).toHaveBeenCalledOnce()
    await third.release()
  })

  it('fails closed and retries when receipt reconciliation is incomplete', async () => {
    const reconcileGuest = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const request = {
      target: {
        kind: 'wsl2' as const,
        profileId: 'retry-profile',
        distro: 'Retry-Ubuntu',
        user: 'retry-user'
      },
      command: 'echo sandboxed',
      cwd: 'C:\\workspace',
      env: {},
      gatewayPort: 4312,
      gatewayCredentials: { username: 'command-user', password: 'command-secret' },
      filesystem: {
        readOnlyRoots: [] as string[],
        readWriteRoots: ['C:\\workspace'],
        deniedReadRoots: [] as string[],
        deniedWriteRoots: [] as string[]
      },
      reconcileGuest,
      mapPath: async () => '/mnt/c/workspace',
      cleanupGuest: async () => true,
      openBridge: async () => ({
        socketPath: '/tmp/open-science-network-command/gateway.sock',
        close: async () => ({ networkClosed: true, temporaryResourcesRemoved: true })
      })
    }

    await expect(wsl2Launch(request)).rejects.toThrow('SHELL_CLEANUP_INCOMPLETE')
    const launch = await wsl2Launch(request)
    expect(reconcileGuest).toHaveBeenCalledTimes(2)
    await launch.release()
  })

  it('fails closed when an authorized Windows path cannot be mapped', async () => {
    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        reconcileGuest: reconciled,
        mapPath: async () => {
          throw new Error('mapping failed')
        }
      })
    ).rejects.toThrow('WSL2 sandbox path mapping failed')
  })

  it('fails closed when a declared cache path is outside every writable root', async () => {
    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: { AWS_SECRET_FILE: 'C:\\private\\secret' },
        pathEnvironment: { UV_CACHE_DIR: 'C:\\unauthorized\\uv' },
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        reconcileGuest: reconciled,
        mapPath: async (path) => `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
      })
    ).rejects.toThrow('WSL2 sandbox path environment is not writable')
  })

  it('fails closed rather than overriding the fixed guest PATH', async () => {
    await expect(
      wsl2Launch({
        target: {
          kind: 'wsl2',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'open-science-spike'
        },
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        env: {},
        pathEnvironment: { PATH: 'C:\\workspace\\bin' },
        filesystem: {
          readOnlyRoots: [],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        reconcileGuest: reconciled,
        mapPath: async (path) => `/mnt/c/${path.slice(3).replaceAll('\\', '/')}`
      })
    ).rejects.toThrow('WSL2 sandbox path environment key is reserved')
  })
})

import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedResearchRuntime } from './managed-research-environment'
import { createManagedResearchNodeRuntimeRegistry } from './managed-research-node-runtime'

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>()
  return { ...module, execFile: vi.fn(module.execFile) }
})
const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
const directories: string[] = []
beforeEach(() => {
  vi.mocked(execFile).mockImplementation(actual.execFile)
})
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
const fakeBinary = async (name = 'node'): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'research-node-')))
  directories.push(root)
  const file = join(root, name)
  await writeFile(file, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]))
  await chmod(file, 0o755)
  return file
}
const response = (file: string, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    protocol: 'open-science-node-runtime-v1',
    node: '24.18.1',
    electron: null,
    executable: file,
    platform: process.platform,
    arch: process.arch,
    sharedObjects: [],
    ...overrides
  })
const mockProbe = (result: (file: string) => string | Error): void => {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    const value = result(file)
    if (value instanceof Error) callback(value, '', '')
    else callback(null, value, '')
    return {} as ChildProcess
  }) as typeof execFile)
}
const select = async (
  candidate: string
): Promise<{
  registry: ReturnType<typeof createManagedResearchNodeRuntimeRegistry>
  runtime: ManagedResearchRuntime
  runtimeId: string
}> => {
  const registry = createManagedResearchNodeRuntimeRegistry({ trustedCandidates: [candidate] })
  const discovery = await registry.discover()
  expect(discovery.unavailable).toEqual([])
  expect(discovery.runtimes).toHaveLength(1)
  return { registry, ...discovery.runtimes[0] }
}

describe('independent research Node discovery', () => {
  it('really probes the current independent Node and returns only narrow canonical roots', async () => {
    expect(process.versions.electron).toBeUndefined()
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(22)
    const { registry, runtime, runtimeId } = await select(process.execPath)
    expect(runtime).toMatchObject({
      kind: 'node',
      executable: await realpath(process.execPath),
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch
    })
    expect(runtimeId).toMatch(/^[a-f0-9]{64}$/)
    expect(runtime.readOnlyRoots).toContain(runtime.executable)
    expect(runtime.readOnlyRoots).not.toContain(dirname(runtime.executable))
    expect(await registry.resolve(runtimeId)).toEqual(runtime)
    // A persisted receipt can be verified by a fresh registry after an app restart.
    await createManagedResearchNodeRuntimeRegistry({
      trustedCandidates: [process.execPath]
    }).verify(runtime)
  })

  it('deduplicates symlink candidates and exposes stable IDs without mutable shared objects', async () => {
    const node = await fakeBinary()
    const link = join(dirname(node), 'node-alias')
    await symlink(node, link)
    mockProbe((file) => response(file))
    const registry = createManagedResearchNodeRuntimeRegistry({ trustedCandidates: [link, node] })
    const first = await registry.discover()
    expect(first.runtimes).toHaveLength(1)
    expect(execFile).toHaveBeenCalledOnce()
    const { runtime, runtimeId } = first.runtimes[0]
    const checksum = runtime.sha256
    expect(runtimeId).toBe(
      createHash('sha256')
        .update(JSON.stringify([node, checksum]))
        .digest('hex')
    )
    runtime.readOnlyRoots.push(dirname(node))
    expect((await registry.resolve(runtimeId)).readOnlyRoots).toEqual([node])
  })

  it('uses fixed arguments, a minimal environment and explicit probe bounds', async () => {
    const node = await fakeBinary()
    mockProbe((file) => response(file))
    await select(node)
    const call = vi.mocked(execFile).mock.calls[0]
    expect(call[0]).toBe(node)
    expect(call[1]).toEqual([
      '--no-warnings',
      '-e',
      expect.stringContaining('process.versions.electron')
    ])
    expect(call[2]).toMatchObject({
      timeout: 3000,
      maxBuffer: 65536,
      encoding: 'utf8',
      windowsHide: true,
      cwd: dirname(node)
    })
    const options = call[2] as { env: NodeJS.ProcessEnv }
    expect(options.env.PATH).toBe(dirname(node))
    for (const key of [
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'HOME',
      'OPENAI_API_KEY'
    ])
      expect(options.env).not.toHaveProperty(key)
    expect(Object.keys(options.env).sort()).toEqual(
      process.platform === 'win32' && process.env.SystemRoot
        ? ['LANG', 'LC_ALL', 'PATH', 'SystemRoot']
        : ['LANG', 'LC_ALL', 'PATH']
    )
  })

  it.each([
    ['electron', { electron: '40.0.0' }],
    ['old-node', { node: '20.19.0' }],
    ['wrong-platform', { platform: 'not-this-host' }],
    ['wrong-architecture', { arch: 'not-this-arch' }],
    ['wrong-executable', { executable: '/nonexistent/other-node' }],
    ['extra-fields', { arbitrary: 'not accepted' }],
    ['missing-protocol', { protocol: undefined }]
  ])('rejects spoofed or unsuitable probe metadata: %s', async (_name, overrides) => {
    const node = await fakeBinary()
    mockProbe((file) => response(file, overrides))
    const result = await createManagedResearchNodeRuntimeRegistry({
      trustedCandidates: [node]
    }).discover()
    expect(result.runtimes).toEqual([])
    expect(result.unavailable).toHaveLength(1)
  })

  it.each(['malformed', 'timeout', 'overflow'])(
    'does not accept a failed probe: %s',
    async (mode) => {
      const node = await fakeBinary()
      mockProbe(() => (mode === 'malformed' ? 'not JSON' : new Error(mode)))
      const result = await createManagedResearchNodeRuntimeRegistry({
        trustedCandidates: [node]
      }).discover()
      expect(result.runtimes).toEqual([])
      expect(result.unavailable).toHaveLength(1)
      expect(result.unavailable[0].code).toBe('node_unusable')
    }
  )

  it('never launches missing executables, Electron or script wrappers', async () => {
    const electron = await fakeBinary('Electron')
    const wrapper = await fakeBinary('wrapper')
    await writeFile(wrapper, '#!/bin/sh\necho fake-node\n')
    const result = await createManagedResearchNodeRuntimeRegistry({
      trustedCandidates: [join(dirname(wrapper), 'missing'), electron, wrapper]
    }).discover()
    expect(result.runtimes).toEqual([])
    expect(result.unavailable).toHaveLength(3)
    expect(result.unavailable.map(({ code }) => code)).toEqual([
      'node_not_found',
      'node_not_independent',
      'node_unusable'
    ])
    expect(execFile).not.toHaveBeenCalled()
  })

  it.each([
    [{ node: '20.19.0' }, 'node_version_unsupported'],
    [{ arch: 'different-architecture' }, 'node_host_mismatch'],
    [{ platform: process.platform === 'darwin' ? 'linux' : 'darwin' }, 'node_host_mismatch']
  ])(
    'classifies incompatible runtimes without interpreting probe error text: %j',
    async (overrides, code) => {
      const node = await fakeBinary()
      mockProbe((file) => response(file, overrides as Record<string, unknown>))
      const result = await createManagedResearchNodeRuntimeRegistry({
        trustedCandidates: [node]
      }).discover()
      expect(result.runtimes).toEqual([])
      expect(result.unavailable).toEqual([expect.objectContaining({ code })])
    }
  )

  it('bounds executable bytes and candidate count before launching any probe', async () => {
    const node = await fakeBinary()
    expect(
      (
        await createManagedResearchNodeRuntimeRegistry({
          trustedCandidates: [node],
          maxExecutableBytes: 4
        }).discover()
      ).runtimes
    ).toEqual([])
    expect(() =>
      createManagedResearchNodeRuntimeRegistry({
        trustedCandidates: Array.from({ length: 65 }, (_, i) => join(dirname(node), String(i)))
      })
    ).toThrow('candidates')
    expect(() =>
      createManagedResearchNodeRuntimeRegistry({ trustedCandidates: ['relative/node'] })
    ).toThrow('candidates')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('ignores empty and relative PATH entries rather than searching a project directory', async () => {
    mockProbe(() => new Error('unavailable'))
    const result = await createManagedResearchNodeRuntimeRegistry({
      path: ['', '.', 'relative', ''].join(delimiter)
    }).discover()
    expect(result.runtimes).toEqual([])
    expect(result.unavailable.every(({ candidate }) => !candidate.includes('relative'))).toBe(true)
    expect(
      vi
        .mocked(execFile)
        .mock.calls.every(([file]) => file.startsWith('/') || /^[A-Z]:\\/i.test(file))
    ).toBe(true)
  })

  it('discovers an independent Node from the Main-supplied PATH without a candidate override', async () => {
    const node = await fakeBinary(process.platform === 'win32' ? 'node.exe' : 'node')
    const linkDirectory = await realpath(await mkdtemp(join(tmpdir(), 'research-node-path-')))
    directories.push(linkDirectory)
    await symlink(node, join(linkDirectory, process.platform === 'win32' ? 'node.exe' : 'node'))
    mockProbe((file) => (file === node ? response(file) : new Error('not this test runtime')))
    const registry = createManagedResearchNodeRuntimeRegistry({
      path: [linkDirectory, dirname(node), linkDirectory].join(delimiter)
    })
    const discovery = await registry.discover()
    expect(discovery.runtimes).toHaveLength(1)
    expect(discovery.runtimes[0].runtime.executable).toBe(node)
    expect(vi.mocked(execFile).mock.calls.filter(([file]) => file === node)).toHaveLength(1)
    await expect(registry.resolve(discovery.runtimes[0].runtimeId)).resolves.toMatchObject({
      executable: node,
      readOnlyRoots: [node]
    })
  })

  it('grants only individual verified shared-library files, never their directories', async () => {
    const node = await fakeBinary()
    const library = join(dirname(node), 'libnode.so')
    await writeFile(library, 'library')
    mockProbe((file) => response(file, { sharedObjects: [library] }))
    const { runtime } = await select(node)
    expect(runtime.readOnlyRoots).toEqual([library, node].sort())
    mockProbe((file) => response(file, { sharedObjects: [dirname(node)] }))
    expect(
      (await createManagedResearchNodeRuntimeRegistry({ trustedCandidates: [node] }).discover())
        .runtimes
    ).toEqual([])
  })
})

describe('selected Node runtime verification', () => {
  it('fails binary changes before probing the changed executable', async () => {
    const node = await fakeBinary()
    mockProbe((file) => response(file))
    const { registry, runtime, runtimeId } = await select(node)
    vi.mocked(execFile).mockClear()
    await writeFile(
      node,
      Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 1)])
    )
    await expect(registry.verify(runtime)).rejects.toThrow('binary changed')
    await expect(registry.resolve(runtimeId)).rejects.toThrow('binary changed')
    expect(execFile).not.toHaveBeenCalled()
    expect((await registry.discover()).runtimes[0].runtimeId).not.toBe(runtimeId)
  })

  it('rejects a widened runtime grant or an executable not selected by host discovery', async () => {
    const node = await fakeBinary()
    mockProbe((file) => response(file))
    const { registry, runtime } = await select(node)
    await expect(registry.verify({ ...runtime, readOnlyRoots: [dirname(node)] })).rejects.toThrow(
      'identity changed'
    )
    const unknown = await fakeBinary('other')
    await expect(registry.verify({ ...runtime, executable: unknown })).rejects.toThrow(
      'trusted host candidate'
    )
    await expect(registry.resolve('/arbitrary/executable')).rejects.toThrow(
      'invalid runtime identity'
    )
    await expect(registry.resolve('a'.repeat(64))).rejects.toThrow('unavailable')
  })

  it('rejects a selected executable that disappeared or a candidate symlink changed', async () => {
    const node = await fakeBinary()
    const link = join(dirname(node), 'node-link')
    await symlink(node, link)
    mockProbe((file) => response(file))
    const { registry, runtime } = await select(link)
    await rename(node, `${node}-old`)
    await expect(registry.verify(runtime)).rejects.toThrow('trusted host candidate')
    await rm(link)
    await symlink(`${node}-old`, link)
    await expect(registry.verify(runtime)).rejects.toThrow('trusted host candidate')
  })
})

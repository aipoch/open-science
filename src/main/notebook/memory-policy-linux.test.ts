import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryPolicyService } from './memory-policy'

import {
  LinuxMemoryPolicyAdapter,
  parseLinuxCgroupMounts,
  parseLinuxCgroupMembership,
  parseLinuxMemoryInfo,
  parseLinuxOvercommitMode
} from './memory-policy-linux'

describe('Linux memory fact parsers', () => {
  it('uses MemAvailable and rejects a missing or malformed required field', () => {
    expect(
      parseLinuxMemoryInfo(
        'MemTotal:       1000 kB\nMemAvailable:    800 kB\nCommitLimit: 900 kB\nCommitted_AS: 100 kB\n'
      )
    ).toEqual({
      totalBytes: 1_024_000,
      availableBytes: 819_200,
      commitLimitBytes: 921_600,
      committedBytes: 102_400
    })
    expect(() => parseLinuxMemoryInfo('MemTotal: 1000 kB\nMemFree: 900 kB\n')).toThrow()
    expect(() => parseLinuxMemoryInfo('MemTotal: -1 kB\nMemAvailable: 10 kB')).toThrow()
  })

  it('recognizes strict overcommit mode only when the kernel value is exactly 2', () => {
    expect(parseLinuxOvercommitMode('2\n')).toBe(2)
    expect(parseLinuxOvercommitMode('0\n')).toBe(0)
    expect(parseLinuxOvercommitMode('1\n')).toBe(1)
    expect(() => parseLinuxOvercommitMode('unknown\n')).toThrow()
  })

  it('parses cgroup membership and mount roots without assuming /sys/fs/cgroup', () => {
    expect(parseLinuxCgroupMembership('0::/tenant/notebook\n')).toEqual([
      { hierarchy: 'v2', controllers: [], path: '/tenant/notebook' }
    ])
    expect(
      parseLinuxCgroupMembership('5:cpu,memory:/tenant/notebook\n7:name=systemd:/user.slice\n')
    ).toEqual([
      { hierarchy: 'v1', controllers: ['cpu', 'memory'], path: '/tenant/notebook' },
      { hierarchy: 'v1', controllers: ['name=systemd'], path: '/user.slice' }
    ])

    expect(
      parseLinuxCgroupMounts(
        '42 24 0:38 /tenant /run/cgroup rw,nosuid,nodev - cgroup2 cgroup rw\n' +
          '43 24 0:39 / /run/memory rw,nosuid,nodev - cgroup cgroup rw,memory\n'
      )
    ).toEqual([
      { hierarchy: 'v2', root: '/tenant', mountPoint: '/run/cgroup', controllers: [] },
      { hierarchy: 'v1', root: '/', mountPoint: '/run/memory', controllers: ['memory'] }
    ])
  })

  it('decodes kernel path escapes and rejects namespace-relative traversal', () => {
    expect(parseLinuxCgroupMembership('0::/tenant\\040one/notebook\n')[0].path).toBe(
      '/tenant one/notebook'
    )
    expect(() => parseLinuxCgroupMembership('0::/../hidden/notebook\n')).toThrow()
  })
})

describe('LinuxMemoryPolicyAdapter', () => {
  const files: Record<string, string> = {
    '/proc/self/cgroup': '0::/tenant/notebook\n',
    '/proc/self/mountinfo': '42 24 0:38 / /run/cgroup rw - cgroup2 cgroup rw\n',
    '/proc/meminfo':
      'MemTotal: 1000 kB\nMemAvailable: 800 kB\nCommitLimit: 900 kB\nCommitted_AS: 100 kB\n',
    '/proc/sys/vm/overcommit_memory': '2\n',
    '/run/cgroup/tenant/notebook/memory.current': '700\n',
    '/run/cgroup/tenant/notebook/memory.max': '1000\n',
    '/run/cgroup/tenant/notebook/memory.high': '900\n',
    '/run/cgroup/tenant/notebook/cgroup.controllers': 'cpu memory pids\n',
    '/run/cgroup/tenant/notebook/cgroup.subtree_control': '\n',
    '/run/cgroup/tenant/memory.current': '800\n',
    '/run/cgroup/tenant/memory.max': '2000\n',
    '/run/cgroup/tenant/memory.high': '1800\n',
    '/run/cgroup/tenant/cgroup.controllers': 'cpu memory pids\n',
    '/run/cgroup/tenant/cgroup.subtree_control': 'memory\n',
    '/run/cgroup/memory.current': '900\n',
    '/run/cgroup/memory.max': 'max\n',
    '/run/cgroup/memory.high': 'max\n',
    '/run/cgroup/cgroup.controllers': 'cpu memory pids\n',
    '/run/cgroup/cgroup.subtree_control': 'memory\n'
  }

  it('binds samples to the target cgroup and applies host, strict commit and cgroup signals', async () => {
    const adapter = new LinuxMemoryPolicyAdapter({
      readFile: async (path) => {
        const value = files[path]
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return value
      },
      procRoot: '/proc',
      pid: 'self',
      ancestorVisibility: 'complete'
    })

    const result = await adapter.sample(new AbortController().signal)
    expect(result.executionScope).toBe('linux:cgroup-v2:/run/cgroup/tenant/notebook')
    expect(result.facts).toMatchObject({
      availableBytes: 819_200,
      totalBytes: 1_024_000,
      overcommitMode: 2,
      commitLimitBytes: 921_600,
      committedBytes: 102_400
    })
    expect(result.facts.cgroup?.constraints).toHaveLength(2)
  })

  it('fails closed when the visible cgroup mount hides ancestors or a required fact is unreadable', async () => {
    const adapter = new LinuxMemoryPolicyAdapter({
      readFile: async (path) => {
        if (path === '/proc/self/cgroup') return '0::/tenant/notebook\n'
        if (path === '/proc/self/mountinfo') {
          return '42 24 0:38 /hidden/ancestor /run/cgroup rw - cgroup2 cgroup rw\n'
        }
        if (path === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 800 kB\n'
        if (path === '/proc/sys/vm/overcommit_memory') return '0\n'
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      procRoot: '/proc',
      pid: 'self',
      ancestorVisibility: 'complete'
    })

    await expect(adapter.sample(new AbortController().signal)).rejects.toMatchObject({
      code: 'linux-memory-unavailable',
      diagnostic: 'linux-cgroup-visibility'
    })
  })

  it('does not reject ordinary overcommit modes because Committed_AS exceeds CommitLimit', async () => {
    const local: Record<string, string> = {
      ...files,
      '/proc/sys/vm/overcommit_memory': '0\n',
      '/proc/meminfo':
        'MemTotal: 1000 kB\nMemAvailable: 800 kB\nCommitLimit: 100 kB\nCommitted_AS: 1000 kB\n'
    }
    const adapter = new LinuxMemoryPolicyAdapter({
      readFile: async (path) => {
        const value = local[path]
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return value
      },
      procRoot: '/proc',
      pid: 'self',
      ancestorVisibility: 'complete'
    })
    const result = await adapter.sample(new AbortController().signal)
    expect(result.facts.overcommitMode).toBe(0)
    expect(result.facts.commitLimitBytes).toBeUndefined()
  })

  it('cannot authenticate an ordinary directory as the reader procfs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'memory-policy-false-proc-'))
    try {
      const adapter = new LinuxMemoryPolicyAdapter({ procRoot: directory })
      await expect(adapter.sample(new AbortController().signal)).rejects.toMatchObject({
        code: 'linux-memory-unavailable',
        diagnostic: 'linux-procfs'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses the authenticated execution-domain reader for every kernel and namespace fact', async () => {
    const readPaths: string[] = []
    let pinned = 0
    let closed = 0
    const adapter = new LinuxMemoryPolicyAdapter({
      pid: 42,
      expectedBirth: '123',
      reader: {
        read: async (path, _signal, expectedFs) => {
          readPaths.push(path)
          expect(expectedFs).toBe(0x9fa0n)
          if (path === '/proc/42/stat') return `42 (owned shell) S ${'0 '.repeat(18)}123\n`
          if (path === '/proc/42/cgroup' || path === '/proc/42/mountinfo') return ''
          if (!(path in files)) throw new Error('missing')
          return files[path]
        },
        pinInitialNamespace: async () => {
          pinned++
          return {
            identity: '4:4026531835',
            close: async () => {
              closed++
            }
          }
        },
        pageSize: async () => {
          throw new Error('v2 does not need a page size')
        }
      }
    })

    await expect(adapter.sample(new AbortController().signal)).resolves.toMatchObject({
      platform: 'linux',
      facts: { availableBytes: 819_200 }
    })
    expect(readPaths).toContain('/proc/42/stat')
    expect(pinned).toBe(2)
    expect(closed).toBe(2)
  })

  it('rejects a stable reused numeric PID whose birth differs from the original owner', async () => {
    const reads: string[] = []
    const adapter = new LinuxMemoryPolicyAdapter({
      pid: 42,
      expectedBirth: '123',
      ancestorVisibility: 'complete',
      readFile: async (path) => {
        reads.push(path)
        if (path === '/proc/42/stat') return `42 (reused shell) S ${'0 '.repeat(18)}124\n`
        if (path === '/proc/42/cgroup' || path === '/proc/42/mountinfo') return ''
        if (!(path in files)) throw new Error('missing')
        return files[path]
      }
    })

    await expect(adapter.sample(new AbortController().signal)).rejects.toMatchObject({
      code: 'linux-memory-unavailable'
    })
    expect(reads).toEqual(['/proc/42/stat'])
  })

  it('rejects a remote namespace replacement while facts are sampled', async () => {
    let pins = 0
    let closed = 0
    const adapter = new LinuxMemoryPolicyAdapter({
      reader: {
        read: async (path) => {
          if (!(path in files)) throw new Error('missing')
          return files[path]
        },
        pinInitialNamespace: async () => ({
          identity: `${++pins}:4026531835`,
          close: async () => {
            closed++
          }
        }),
        pageSize: async () => 4096
      }
    })
    await expect(adapter.sample(new AbortController().signal)).rejects.toMatchObject({
      code: 'linux-memory-unavailable'
    })
    expect(closed).toBe(2)
  })

  it('uses the guest auxiliary-vector page size for cgroup v1 unlimited limits', async () => {
    let pageReads = 0
    const local: Record<string, string> = {
      '/proc/self/cgroup': '5:memory:/notebook\n',
      '/proc/self/mountinfo': '42 24 0:38 / /run/memory rw - cgroup cgroup rw,memory\n',
      '/proc/meminfo': files['/proc/meminfo'],
      '/proc/sys/vm/overcommit_memory': '0\n',
      '/run/memory/notebook/memory.usage_in_bytes': '200\n',
      '/run/memory/notebook/memory.limit_in_bytes': '1000\n',
      '/run/memory/notebook/memory.use_hierarchy': '1\n',
      '/run/memory/memory.usage_in_bytes': '500\n',
      '/run/memory/memory.limit_in_bytes': String(((1n << 63n) - 1n) & ~(65_536n - 1n)),
      '/run/memory/memory.use_hierarchy': '1\n'
    }
    const adapter = new LinuxMemoryPolicyAdapter({
      reader: {
        read: async (path, _signal, expectedFs) => {
          expect(expectedFs).toBe(path.startsWith('/proc/') ? 0x9fa0n : 0x27e0ebn)
          if (!(path in local)) throw new Error('missing')
          return local[path]
        },
        pinInitialNamespace: async () => ({ identity: '4:4026531835', close: async () => {} }),
        pageSize: async () => {
          pageReads++
          return 65_536
        }
      }
    })
    const sample = await adapter.sample(new AbortController().signal)
    expect(pageReads).toBe(1)
    expect(sample.facts.cgroup?.constraints[1].maxBytes).toBeUndefined()
  })

  it('continues to limiting ancestors when a leaf has no applicable memory controller', async () => {
    const local: Record<string, string> = {
      ...files,
      '/run/cgroup/tenant/notebook/cgroup.controllers': 'cpu pids\n',
      '/run/cgroup/tenant/cgroup.subtree_control': '\n',
      '/run/cgroup/tenant/memory.current': '1950\n'
    }
    delete local['/run/cgroup/tenant/notebook/memory.current']
    delete local['/run/cgroup/tenant/notebook/memory.max']
    delete local['/run/cgroup/tenant/notebook/memory.high']
    const service = new MemoryPolicyService({
      adapter: new LinuxMemoryPolicyAdapter({
        readFile: async (path) => {
          if (!(path in local)) throw new Error('missing')
          return local[path]
        },
        ancestorVisibility: 'complete'
      })
    })
    await expect(service.getState()).resolves.toMatchObject({
      status: 'pressured',
      reason: {
        code: 'linux-cgroup-low',
        pressureScope: 'execution-domain',
        constraintPath: '/run/cgroup/tenant'
      }
    })
  })

  it.each([4096, 16_384, 65_536])(
    'recognizes only the exact v1 unlimited sentinel for %i-byte kernel pages',
    async (pageSize) => {
      const local: Record<string, string> = {
        '/proc/self/cgroup': '5:memory:/notebook\n',
        '/proc/self/mountinfo': '42 24 0:38 / /run/memory rw - cgroup cgroup rw,memory\n',
        '/proc/meminfo': files['/proc/meminfo'],
        '/proc/sys/vm/overcommit_memory': '0\n',
        '/run/memory/notebook/memory.usage_in_bytes': '200\n',
        '/run/memory/notebook/memory.limit_in_bytes': '1000\n',
        '/run/memory/notebook/memory.use_hierarchy': '1\n',
        '/run/memory/memory.usage_in_bytes': '500\n',
        '/run/memory/memory.limit_in_bytes': String(((1n << 63n) - 1n) & ~(BigInt(pageSize) - 1n)),
        '/run/memory/memory.use_hierarchy': '1\n'
      }
      const adapter = new LinuxMemoryPolicyAdapter({
        readFile: async (path) => {
          if (!(path in local)) throw new Error('missing')
          return local[path]
        },
        ancestorVisibility: 'complete',
        pageSize
      })
      const sampled = await adapter.sample(new AbortController().signal)
      expect(sampled.facts.cgroup?.constraints[0]).toMatchObject({
        currentBytes: 200,
        maxBytes: 1000
      })
      expect(sampled.facts.cgroup?.constraints[1].maxBytes).toBeUndefined()
    }
  )

  it('retries one known limit change, then refuses an unstable execution domain', async () => {
    let reads = 0
    const adapter = new LinuxMemoryPolicyAdapter({
      readFile: async (path) => {
        if (path.endsWith('/notebook/memory.max')) return String(++reads * 1000)
        if (!(path in files)) throw new Error('missing')
        return files[path]
      },
      ancestorVisibility: 'complete'
    })
    await expect(adapter.sample(new AbortController().signal)).rejects.toMatchObject({
      code: 'linux-memory-unavailable'
    })
    expect(reads).toBe(4)
  })
})

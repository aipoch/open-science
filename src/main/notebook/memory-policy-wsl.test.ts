import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createNotebookExecutionAdmission } from './execution-admission'
import { MemoryPolicyService } from './memory-policy'
import { WindowsMemoryPolicyAdapter } from './memory-policy-platform'
import { createWslExecutionMemoryPolicy } from './memory-policy-wsl'
import type { NotebookSandboxedSpawn } from './process-sandbox'

const scope = 'wsl:profile:owner-generation'
const token = 'open-science-execution-00000000-0000-4000-8000-000000000001'
const proofPath = '/tmp/.open-science-execution-00000000-0000-4000-8000-000000000001.receipt.memory'
const stat = (birth: string): string => `42 (bash) S ${Array(18).fill('0').join(' ')} ${birth}\n`
const kernelFacts = (): Record<string, string> => ({
  [proofPath]: `v1 ${token} 42 123\n`,
  '/proc/42/stat': stat('123'),
  '/proc/42/cgroup': '0::/tenant/notebook\n',
  '/proc/42/mountinfo': '42 24 0:38 / /run/cgroup rw - cgroup2 cgroup rw\n',
  '/proc/meminfo':
    'MemTotal: 1000 kB\nMemAvailable: 800 kB\nCommitLimit: 900 kB\nCommitted_AS: 100 kB\n',
  '/proc/sys/vm/overcommit_memory': '2\n',
  '/proc/42/root/run/cgroup/tenant/notebook/memory.current': '700\n',
  '/proc/42/root/run/cgroup/tenant/notebook/memory.max': '1000\n',
  '/proc/42/root/run/cgroup/tenant/notebook/memory.high': '900\n',
  '/proc/42/root/run/cgroup/tenant/notebook/cgroup.controllers': 'memory\n',
  '/proc/42/root/run/cgroup/tenant/notebook/cgroup.subtree_control': '\n',
  '/proc/42/root/run/cgroup/tenant/memory.current': '800\n',
  '/proc/42/root/run/cgroup/tenant/memory.max': '2000\n',
  '/proc/42/root/run/cgroup/tenant/memory.high': '1800\n',
  '/proc/42/root/run/cgroup/tenant/cgroup.controllers': 'memory\n',
  '/proc/42/root/run/cgroup/tenant/cgroup.subtree_control': 'memory\n',
  '/proc/42/root/run/cgroup/cgroup.controllers': 'memory\n',
  '/proc/42/root/run/cgroup/cgroup.subtree_control': 'memory\n'
})

// Controlled kernel replies over real subprocess stdio exercise the production
// reader/parser/policy composition. They are not real WSL memory observations.
const controlledProbe = (
  options: {
    files?: Record<string, string>
    namespaceAvailable?: boolean
    expectedPid?: number
  } = {}
): {
  probe: NonNullable<NotebookSandboxedSpawn['memoryProbe']>
  replaceFiles(next: Record<string, string>): void
  expectClosed(): void
} => {
  let files = options.files ?? kernelFacts()
  const children: ChildProcessWithoutNullStreams[] = []
  const openReader = vi.fn((_program: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const files = ${JSON.stringify(files)};
      const readline = require('node:readline');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const r = JSON.parse(line);
        let ok = true, value = null;
        if (r.op === 'read') { value = files[r.path]; ok = typeof value === 'string'; }
        else if (r.op === 'pinNamespace') { ok = ${options.namespaceAvailable !== false}; value = {pin:1,identity:'4:4026531835'}; }
        else if (r.op === 'pageSize') value = 4096;
        else if (r.op === 'validateExecutionTree') ok = r.pid === ${options.expectedPid ?? 42} && r.birth === '123' && r.token === ${JSON.stringify(token)};
        else if (r.op !== 'closeNamespace') ok = false;
        process.stdout.write(JSON.stringify({id:r.id,ok,value})+'\\n');
      });
    `
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    children.push(child)
    return child
  })
  return {
    probe: { executionScope: scope, proofPath, token, openReader },
    replaceFiles: (next: Record<string, string>): void => {
      files = next
    },
    expectClosed: (): void => {
      expect(children.length).toBeGreaterThan(0)
      expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(
        true
      )
    }
  }
}

describe('WSL original-owner memory policy', () => {
  it('uses guest facts by default and preserves the owner scope and complete ancestors', async () => {
    const fixture = controlledProbe()
    const policy = await createWslExecutionMemoryPolicy(fixture.probe)
    try {
      await expect(policy.getState()).resolves.toMatchObject({
        status: 'healthy',
        executionScope: scope,
        source: 'linux-proc-cgroup-v2',
        facts: {
          totalBytes: 1_024_000,
          availableBytes: 819_200,
          overcommitMode: 2,
          cgroup: {
            version: 2,
            ancestors: 'complete',
            constraints: [
              {
                path: '/run/cgroup/tenant/notebook',
                currentBytes: 700,
                maxBytes: 1000,
                highBytes: 900
              },
              { path: '/run/cgroup/tenant', currentBytes: 800, maxBytes: 2000, highBytes: 1800 }
            ]
          }
        }
      })
      expect(policy.currentState({ executionScope: scope }).status).toBe('healthy')
      expect(fixture.probe.openReader).toHaveBeenCalledOnce()
    } finally {
      policy.dispose?.()
    }
    fixture.expectClosed()
  })

  it.each([
    [
      'guest available memory',
      '/proc/meminfo',
      'MemTotal: 1000 kB\nMemAvailable: 50 kB\nCommitLimit: 900 kB\nCommitted_AS: 100 kB\n',
      'linux-memory-low'
    ],
    [
      'strict guest Commit',
      '/proc/meminfo',
      'MemTotal: 1000 kB\nMemAvailable: 800 kB\nCommitLimit: 900 kB\nCommitted_AS: 880 kB\n',
      'linux-commit-low'
    ],
    [
      'limiting ancestor',
      '/proc/42/root/run/cgroup/tenant/memory.max',
      '850\n',
      'linux-cgroup-low'
    ],
    [
      'guest high limit',
      '/proc/42/root/run/cgroup/tenant/notebook/memory.high',
      '700\n',
      'linux-cgroup-high'
    ]
  ])(
    'refuses %s even while the real Windows policy composition is healthy',
    async (_label, path, value, reason) => {
      const fixture = controlledProbe({ files: { ...kernelFacts(), [path]: value } })
      const guest = await createWslExecutionMemoryPolicy(fixture.probe)
      const host = new MemoryPolicyService({
        adapter: new WindowsMemoryPolicyAdapter({
          sampleWindowsResources: async () => ({
            supported: true,
            complete: true,
            startedAt: 1,
            endedAt: 2,
            processes: [],
            system: {
              totalPhysicalBytes: 1000,
              availableBytes: 800,
              commitLimitBytes: 1000,
              committedBytes: 100
            }
          })
        })
      })
      const rejected = vi.fn()
      const admission = createNotebookExecutionAdmission({
        policy: async () => host,
        onRejected: rejected
      }).withExecutionDomain!(guest, scope)
      try {
        await expect(host.getState()).resolves.toMatchObject({ status: 'healthy' })
        await expect(admission.prepare('dispatch')).rejects.toMatchObject({
          code: 'NOTEBOOK_MEMORY_PRESSURE',
          memory: {
            executionScope: scope,
            reason: { code: reason, pressureScope: 'execution-domain' }
          }
        })
        expect(rejected).toHaveBeenCalledOnce()
        expect(host.currentState().status).toBe('healthy')
      } finally {
        guest.dispose?.()
        host.dispose()
      }
      fixture.expectClosed()
    }
  )

  it.each(['namespace', 'birth', 'required fact'])(
    'fails closed for an unverifiable %s',
    async (failure) => {
      const files = kernelFacts()
      if (failure === 'birth') files['/proc/42/stat'] = stat('124')
      if (failure === 'required fact') delete files['/proc/meminfo']
      const fixture = controlledProbe({ files, namespaceAvailable: failure !== 'namespace' })
      const policy = await createWslExecutionMemoryPolicy(fixture.probe)
      try {
        await expect(policy.getState({ executionScope: scope })).resolves.toMatchObject({
          status: 'unavailable',
          reason: { code: 'linux-memory-unavailable' }
        })
      } finally {
        policy.dispose?.()
      }
      fixture.expectClosed()
    }
  )

  it('keeps the original PID after failure and will not adopt a replaced identity proof', async () => {
    const files = kernelFacts()
    delete files['/proc/meminfo']
    const fixture = controlledProbe({ files })
    const policy = await createWslExecutionMemoryPolicy(fixture.probe)
    try {
      await expect(policy.getState({ executionScope: scope })).resolves.toMatchObject({
        status: 'unavailable'
      })
      const replacement = kernelFacts()
      replacement[proofPath] = `v1 ${token} 84 123\n`
      // A replacement proof cannot replace the captured authority. Restoring the
      // original process facts must still inspect PID 42 and recover explicitly.
      fixture.replaceFiles(replacement)
      await expect(policy.getState({ executionScope: scope })).resolves.toMatchObject({
        status: 'unavailable'
      })
      expect(fixture.probe.openReader).toHaveBeenCalledTimes(1)
      await expect(policy.getState({ executionScope: scope, force: true })).resolves.toMatchObject({
        status: 'healthy'
      })
      expect(fixture.probe.openReader).toHaveBeenCalledTimes(2)
    } finally {
      policy.dispose?.()
    }
    fixture.expectClosed()
  })
})

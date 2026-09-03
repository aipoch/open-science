import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookPackageAdmittedTarget } from './package-admission'
import { createFrameNotebookLane, createRootNotebookLane, notebookLaneKey } from './lane-identity'
import {
  addRepairRequired,
  managedRepairRegistryKey,
  readRepairRequiredReason,
  repairRegistryPath
} from './runtime-paths'
import { NotebookRuntimeRepairOwner } from './runtime-repair'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import { NotebookSessionAggregate, type NotebookSessionRuntimeBinding } from './session-aggregate'

type RepairOptions = ConstructorParameters<typeof NotebookRuntimeRepairOwner>[0]

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const binding = (
  language: NotebookLanguage,
  runtimeId: string,
  source: 'managed' | 'external',
  envName?: string,
  repairRequired = false
): NotebookSessionRuntimeBinding => ({
  language,
  runtimeId,
  source,
  provenance: source === 'managed' ? 'app-managed' : 'user-own',
  interpreterPath: runtimeId,
  label: runtimeId,
  status: repairRequired ? 'unavailable' : 'active',
  ...(envName ? { envName } : {}),
  ...(repairRequired ? { reason: 'repair-required' as const } : {})
})

const session = (
  sessionId: string,
  bindings: readonly NotebookSessionRuntimeBinding[] = [],
  lane = createRootNotebookLane('project', sessionId, 'root-frame-' + sessionId)
): { value: NotebookSessionAggregate; terminate: ReturnType<typeof vi.fn> } => {
  const terminate = vi.fn().mockResolvedValue(undefined)
  const value = new NotebookSessionAggregate({
    sessionId,
    projectId: 'project',
    lane,
    cwd: '/workspace',
    notebookSessionRoot: '/workspace',
    dataRoot: '/data',
    runtimeRoot: '/runtime',
    runJsonPath: `/workspace/${sessionId}.json`,
    executionCount: 0,
    executorGeneration: Symbol(sessionId),
    executor: {
      execute: async () => ({
        status: 'completed' as const,
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: '/workspace',
        outputs: []
      }),
      shutdown: async () => ({ reaped: true }),
      terminate
    }
  })
  for (const candidate of bindings) value.setRuntimeBinding(candidate.language, candidate)
  return { value, terminate }
}

const admittedTarget = (
  runtimeRoot: string,
  candidate: NotebookSessionRuntimeBinding,
  environmentName: string
): NotebookPackageAdmittedTarget => {
  const policy = new NotebookRuntimeRepairPolicy(runtimeRoot)
  return {
    request: { language: candidate.language, packages: ['numpy'], environment: environmentName },
    environmentName,
    binding: candidate,
    environmentCaptureTarget: {
      language: candidate.language,
      environmentName,
      runtimeSource: candidate.source,
      command: candidate.interpreterPath
    },
    repairRuntimeId: policy.runtimeId(environmentName, candidate),
    repairMarkerKey: policy.markerKey(candidate.language, environmentName, candidate),
    receipt: {
      language: candidate.language,
      selection: 'explicit-binding',
      runtimeSource: candidate.source,
      ...(candidate.source === 'managed' ? { environmentName } : {}),
      runtimeId: candidate.runtimeId,
      label: candidate.label,
      ...(candidate.source === 'managed'
        ? { prefix: join(runtimeRoot, 'envs', environmentName) }
        : {})
    },
    ...(candidate.source === 'managed'
      ? { journalTarget: join(runtimeRoot, 'envs', environmentName) }
      : {})
  }
}

const harness = (
  sessions: readonly NotebookSessionAggregate[]
): {
  owner: NotebookRuntimeRepairOwner
  options: RepairOptions
  runtimeRoot: string
} => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'notebook-runtime-repair-'))
  roots.push(runtimeRoot)
  const byLane = new Map(sessions.map((candidate) => [notebookLaneKey(candidate.lane), candidate]))
  const options: RepairOptions = {
    runtimeRoot,
    policy: new NotebookRuntimeRepairPolicy(runtimeRoot),
    bindings: {
      runWrites: vi.fn(async (_sessionIds, operation) => operation()),
      markUnavailable: vi.fn((candidate, language, reason) => {
        const current = candidate.runtimeBinding(language)
        if (!current) return false
        candidate.setRuntimeBinding(language, { ...current, status: 'unavailable', reason })
        return true
      }),
      markAvailable: vi.fn((candidate, language) => {
        const current = candidate.runtimeBinding(language)
        if (!current || current.status === 'active') return false
        candidate.setRuntimeBinding(language, {
          ...current,
          status: 'active',
          reason: undefined
        })
        return true
      }),
      persist: vi.fn().mockResolvedValue(undefined),
      persistStrict: vi.fn().mockResolvedValue(undefined)
    },
    environmentOperations: {
      blockRepair: vi.fn(),
      clearRepair: vi.fn()
    },
    sessions: () => sessions,
    isCurrentSession: (session) => byLane.get(notebookLaneKey(session.lane)) === session,
    clearKernelTermination: vi.fn().mockResolvedValue(undefined),
    notifyChanged: vi.fn()
  }
  return { owner: new NotebookRuntimeRepairOwner(options), options, runtimeRoot }
}

describe('NotebookRuntimeRepairOwner', () => {
  it('quarantines and stops running and idle default-runtime kernels before repair', async () => {
    const managed = binding(
      'python',
      '/runtime/envs/default-python/bin/python',
      'managed',
      'default-python'
    )
    const explicit = session('explicit', [managed])
    const implicit = session('implicit')
    explicit.value.setKernelStatus('python:default-python', 'running')
    implicit.value.setKernelStatus('python:default-python', 'idle')
    const { owner, options, runtimeRoot } = harness([explicit.value, implicit.value])

    await owner.prepareExplicitRepair('python', managed)

    expect(readRepairRequiredReason(runtimeRoot, 'default-python')).toBe(
      'protected-identity-change'
    )
    expect(explicit.value.runtimeBinding('python')).toMatchObject({
      status: 'unavailable',
      reason: 'repair-required'
    })
    expect(options.bindings.persistStrict).toHaveBeenCalledOnce()
    expect(explicit.terminate).toHaveBeenCalledWith('python', 'default-python')
    expect(implicit.terminate).toHaveBeenCalledWith('python', 'default-python')
    expect(options.clearKernelTermination).toHaveBeenCalledTimes(2)
    expect(explicit.value.consumeForceStopped('python:default-python')).toBe(true)
    expect(implicit.value.consumeForceStopped('python:default-python')).toBe(false)
    expect(explicit.value.kernelStatus('python:default-python')).toBeUndefined()
    expect(implicit.value.kernelStatus('python:default-python')).toBeUndefined()
  })

  it('quarantines every live frame lane that shares an application Session', async () => {
    const managed = binding(
      'python',
      '/runtime/envs/default-python/bin/python',
      'managed',
      'default-python'
    )
    const root = session('shared', [managed])
    const delegated = session(
      'shared',
      [managed],
      createFrameNotebookLane('project', 'shared', 'delegated-frame', 'attempt-1')
    )
    root.value.setKernelStatus('python:default-python', 'idle')
    delegated.value.setKernelStatus('python:default-python', 'running')
    const { owner } = harness([root.value, delegated.value])

    await owner.prepareExplicitRepair('python', managed)

    expect(root.terminate).toHaveBeenCalledWith('python', 'default-python')
    expect(delegated.terminate).toHaveBeenCalledWith('python', 'default-python')
  })

  it('fails closed when pre-repair binding persistence cannot be confirmed', async () => {
    const managed = binding(
      'python',
      '/runtime/envs/default-python/bin/python',
      'managed',
      'default-python'
    )
    const affected = session('affected', [managed])
    const { owner, options, runtimeRoot } = harness([affected.value])
    vi.mocked(options.bindings.persistStrict).mockRejectedValueOnce(new Error('persist denied'))

    await expect(owner.prepareExplicitRepair('python', managed)).rejects.toThrow('persist denied')

    expect(readRepairRequiredReason(runtimeRoot, 'default-python')).toBe(
      'protected-identity-change'
    )
    expect(options.environmentOperations.blockRepair).toHaveBeenCalledWith('python:default-python')
    expect(affected.value.runtimeBinding('python')).toMatchObject({
      status: 'unavailable',
      reason: 'repair-required'
    })
    expect(affected.terminate).not.toHaveBeenCalled()
    expect(options.environmentOperations.clearRepair).not.toHaveBeenCalled()
  })

  it('refreshes repaired bindings before clearing the repair gate', async () => {
    const previous = binding('r', '/runtime/envs/default-r/bin/R', 'managed', 'default-r', true)
    const replacement = binding('r', '/runtime/envs/default-r/bin/R-new', 'managed', 'default-r')
    const affected = session('affected', [previous])
    const { owner, options, runtimeRoot } = harness([affected.value])
    addRepairRequired(runtimeRoot, 'default-r', 'protected-identity-change')

    await owner.completeExplicitRepair('r', replacement)

    expect(affected.value.runtimeBinding('r')).toMatchObject({
      runtimeId: replacement.runtimeId,
      interpreterPath: replacement.interpreterPath,
      status: 'active'
    })
    expect(options.bindings.persistStrict).toHaveBeenCalledOnce()
    expect(readRepairRequiredReason(runtimeRoot, 'default-r')).toBeUndefined()
    expect(options.environmentOperations.clearRepair).toHaveBeenCalledWith('r:default-r')
  })

  it('keeps another language sharing the repaired prefix quarantined', async () => {
    const previousPython = binding(
      'python',
      '/runtime/envs/default-python/bin/python',
      'managed',
      'default-python'
    )
    const previousR = binding(
      'r',
      '/runtime/envs/default-python/bin/R',
      'managed',
      'default-python'
    )
    const replacementPython = binding(
      'python',
      '/runtime/envs/default-python/bin/python-new',
      'managed',
      'default-python'
    )
    const affected = session('affected', [previousPython, previousR])
    affected.value.setKernelStatus('python:default-python', 'idle')
    affected.value.setKernelStatus('r:default-python', 'running')
    const { owner, options, runtimeRoot } = harness([affected.value])

    await owner.prepareExplicitRepair('python', previousPython)

    expect(affected.terminate).toHaveBeenCalledWith('python', 'default-python')
    expect(affected.terminate).toHaveBeenCalledWith('r', 'default-python')
    expect(affected.value.runtimeBinding('python')).toMatchObject({ reason: 'repair-required' })
    expect(affected.value.runtimeBinding('r')).toMatchObject({ reason: 'repair-required' })
    expect(readRepairRequiredReason(runtimeRoot, previousR.runtimeId)).toBe(
      'protected-identity-change'
    )

    await owner.completeExplicitRepair('python', replacementPython)

    expect(affected.value.runtimeBinding('python')).toMatchObject({
      runtimeId: replacementPython.runtimeId,
      status: 'active'
    })
    expect(affected.value.runtimeBinding('r')).toMatchObject({
      runtimeId: previousR.runtimeId,
      status: 'unavailable',
      reason: 'repair-required'
    })
    expect(readRepairRequiredReason(runtimeRoot, previousR.runtimeId)).toBe(
      'protected-identity-change'
    )
    expect(options.environmentOperations.clearRepair).toHaveBeenCalledWith('python:default-python')
    expect(options.environmentOperations.clearRepair).not.toHaveBeenCalledWith('r:default-python')
  })

  it('keeps a repaired binding unavailable when refreshed binding persistence fails', async () => {
    const previous = binding(
      'python',
      '/runtime/envs/default-python/bin/python',
      'managed',
      'default-python',
      true
    )
    const replacement = binding(
      'python',
      '/runtime/envs/default-python/bin/python-new',
      'managed',
      'default-python'
    )
    const affected = session('affected', [previous])
    const { owner, options, runtimeRoot } = harness([affected.value])
    addRepairRequired(runtimeRoot, 'default-python', 'protected-identity-change')
    vi.mocked(options.bindings.persistStrict).mockRejectedValueOnce(new Error('persist denied'))

    await expect(owner.completeExplicitRepair('python', replacement)).rejects.toThrow(
      'persist denied'
    )

    expect(affected.value.runtimeBinding('python')).toEqual(previous)
    expect(readRepairRequiredReason(runtimeRoot, 'default-python')).toBe(
      'protected-identity-change'
    )
    expect(options.environmentOperations.clearRepair).not.toHaveBeenCalled()
  })

  it('refreshes an already-persisted binding again when repair completion is retried', async () => {
    const previous = binding(
      'python',
      '/runtime/envs/default-python/bin/python-old',
      'managed',
      'default-python',
      true
    )
    const first = session('first', [previous])
    const second = session('second', [previous])
    const { owner, options, runtimeRoot } = harness([first.value, second.value])
    addRepairRequired(runtimeRoot, 'default-python', 'protected-identity-change')
    vi.mocked(options.bindings.persistStrict)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second persist denied'))

    await expect(
      owner.completeExplicitRepair(
        'python',
        binding('python', '/runtime/envs/default-python/bin/python-a', 'managed', 'default-python')
      )
    ).rejects.toThrow('second persist denied')

    vi.mocked(options.bindings.persistStrict).mockResolvedValue(undefined)
    const replacement = binding(
      'python',
      '/runtime/envs/default-python/bin/python-b',
      'managed',
      'default-python'
    )
    await owner.completeExplicitRepair('python', replacement)

    expect(first.value.runtimeBinding('python')?.runtimeId).toBe(replacement.runtimeId)
    expect(second.value.runtimeBinding('python')?.runtimeId).toBe(replacement.runtimeId)
    expect(readRepairRequiredReason(runtimeRoot, 'default-python')).toBeUndefined()
  })

  it('quarantines both languages sharing a managed prefix and persists every changed Session', async () => {
    const managedPython = binding('python', '/runtime/analysis/python', 'managed', 'analysis')
    const managedR = binding('r', '/runtime/analysis/R', 'managed', 'analysis')
    const first = session('first', [managedPython, managedR])
    const second = session('second', [managedPython])
    const { owner, options, runtimeRoot } = harness([first.value, second.value])

    await owner.quarantineProtectedIdentity(admittedTarget(runtimeRoot, managedPython, 'analysis'))

    expect(options.environmentOperations.blockRepair).toHaveBeenCalledWith('python:analysis')
    expect(options.environmentOperations.blockRepair).toHaveBeenCalledWith('r:analysis')
    expect(readRepairRequiredReason(runtimeRoot, 'analysis')).toBe('protected-identity-change')
    expect(first.value.runtimeBinding('python')).toMatchObject({ reason: 'repair-required' })
    expect(first.value.runtimeBinding('r')).toMatchObject({ reason: 'repair-required' })
    expect(second.value.runtimeBinding('python')).toMatchObject({ reason: 'repair-required' })
    expect(first.terminate).toHaveBeenCalledTimes(2)
    expect(second.terminate).toHaveBeenCalledTimes(1)
    expect(options.bindings.persist).toHaveBeenCalledTimes(2)
  })

  it('isolates an external quarantine by language and runtime identity', async () => {
    const targetBinding = binding('python', '/usr/bin/python3', 'external')
    const otherBinding = binding('python', '/opt/python', 'external')
    const targetSession = session('target', [targetBinding])
    const otherSession = session('other', [otherBinding])
    const { owner, options, runtimeRoot } = harness([targetSession.value, otherSession.value])

    await owner.quarantineProtectedIdentity(
      admittedTarget(runtimeRoot, targetBinding, 'default-python')
    )

    expect(options.environmentOperations.blockRepair).toHaveBeenCalledOnce()
    expect(options.environmentOperations.blockRepair).toHaveBeenCalledWith(
      'external:python:/usr/bin/python3'
    )
    expect(targetSession.value.runtimeBinding('python')).toMatchObject({
      reason: 'repair-required'
    })
    expect(otherSession.value.runtimeBinding('python')).not.toMatchObject({
      reason: 'repair-required'
    })
    expect(targetSession.terminate).toHaveBeenCalledOnce()
    expect(otherSession.terminate).not.toHaveBeenCalled()
  })

  it('keeps the durable gate armed and tags a binding persistence failure', async () => {
    const managedR = binding('r', '/runtime/analysis/R', 'managed', 'analysis')
    const affected = session('affected', [managedR])
    const { owner, options, runtimeRoot } = harness([affected.value])
    vi.mocked(options.bindings.persist).mockRejectedValueOnce(new Error('persist denied'))

    await expect(
      owner.quarantineProtectedIdentity(admittedTarget(runtimeRoot, managedR, 'analysis'))
    ).rejects.toThrow(/REPAIR_QUARANTINE_FAILED.*persist denied/)

    expect(readRepairRequiredReason(runtimeRoot, 'analysis')).toBe('protected-identity-change')
    expect(affected.value.runtimeBinding('r')).toMatchObject({ reason: 'repair-required' })
    expect(options.environmentOperations.blockRepair).toHaveBeenCalledWith('python:analysis')
    expect(options.environmentOperations.blockRepair).toHaveBeenCalledWith('r:analysis')
  })

  it('adopts a successful external legacy repair and restores every matching binding', async () => {
    const external = binding('python', '/usr/bin/python3', 'external', undefined, true)
    const first = session('first', [external])
    const second = session('second', [external])
    const { owner, options, runtimeRoot } = harness([first.value, second.value])
    mkdirSync(dirname(repairRegistryPath(runtimeRoot)), { recursive: true })
    writeFileSync(
      repairRegistryPath(runtimeRoot),
      `${JSON.stringify({ runtimeIds: [external.runtimeId] })}\n`,
      'utf8'
    )

    await owner.completeInterruptedInstall(admittedTarget(runtimeRoot, external, 'default-python'))

    expect(readRepairRequiredReason(runtimeRoot, external.runtimeId)).toBeUndefined()
    expect(options.environmentOperations.clearRepair).toHaveBeenCalledWith(
      'external:python:/usr/bin/python3'
    )
    expect(first.value.runtimeBinding('python')).toMatchObject({ status: 'active' })
    expect(second.value.runtimeBinding('python')).toMatchObject({ status: 'active' })
    expect(options.bindings.persist).toHaveBeenCalledTimes(2)
  })

  it('marks every matching binding active before the first restore persistence attempt', async () => {
    const external = binding('python', '/usr/bin/python3', 'external', undefined, true)
    const first = session('first', [external])
    const second = session('second', [external])
    const { owner, options, runtimeRoot } = harness([first.value, second.value])
    const order: string[] = []
    vi.mocked(options.bindings.markAvailable).mockImplementation((candidate, language) => {
      order.push(`mark:${candidate.sessionId}`)
      const current = candidate.runtimeBinding(language)
      if (!current || current.status === 'active') return false
      candidate.setRuntimeBinding(language, { ...current, status: 'active', reason: undefined })
      return true
    })
    vi.mocked(options.bindings.persist).mockImplementation(async (candidate) => {
      order.push(`persist:${candidate.sessionId}`)
      throw new Error('persist denied')
    })

    await expect(
      owner.completeInterruptedInstall(admittedTarget(runtimeRoot, external, 'default-python'))
    ).rejects.toThrow('persist denied')

    expect(order).toEqual(['mark:first', 'mark:second', 'persist:first'])
    expect(first.value.runtimeBinding('python')).toMatchObject({ status: 'active' })
    expect(second.value.runtimeBinding('python')).toMatchObject({ status: 'active' })
    expect(options.notifyChanged).not.toHaveBeenCalled()
  })

  it('keeps managed legacy protection while clearing interrupted aliases after repair', async () => {
    const managed = binding('python', '/runtime/analysis/python', 'managed', 'analysis', true)
    const active = session('active', [managed])
    const { owner, runtimeRoot } = harness([active.value])
    addRepairRequired(runtimeRoot, 'analysis', 'protected-identity-change')
    addRepairRequired(runtimeRoot, managedRepairRegistryKey('analysis', 'python'))
    addRepairRequired(runtimeRoot, managed.runtimeId)

    await owner.completeInterruptedInstall(admittedTarget(runtimeRoot, managed, 'analysis'))

    expect(readRepairRequiredReason(runtimeRoot, 'analysis')).toBe('protected-identity-change')
    expect(
      readRepairRequiredReason(runtimeRoot, managedRepairRegistryKey('analysis', 'python'))
    ).toBeUndefined()
    expect(readRepairRequiredReason(runtimeRoot, managed.runtimeId)).toBeUndefined()
    expect(active.value.runtimeBinding('python')).toMatchObject({ status: 'active' })
  })

  it('clears a removed managed environment without restoring its unavailable binding', () => {
    const managed = binding('r', '/runtime/analysis/R', 'managed', 'analysis', true)
    const active = session('active', [managed])
    const { owner, options, runtimeRoot } = harness([active.value])
    addRepairRequired(runtimeRoot, 'analysis', 'protected-identity-change')
    addRepairRequired(runtimeRoot, managed.runtimeId)

    owner.completeRemovedManagedEnvironment('analysis')

    expect(readRepairRequiredReason(runtimeRoot, 'analysis')).toBeUndefined()
    expect(readRepairRequiredReason(runtimeRoot, managed.runtimeId)).toBeUndefined()
    expect(options.environmentOperations.clearRepair).toHaveBeenCalledWith('python:analysis')
    expect(options.environmentOperations.clearRepair).toHaveBeenCalledWith('r:analysis')
    expect(active.value.runtimeBinding('r')).toMatchObject({ reason: 'repair-required' })
    expect(options.bindings.markAvailable).not.toHaveBeenCalled()
  })
})

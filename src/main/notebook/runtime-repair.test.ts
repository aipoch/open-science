import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookPackageAdmittedTarget } from './package-admission'
import { createRootNotebookLane } from './lane-identity'
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
  ...(envName ? { envName } : {}),
  ...(repairRequired ? { status: 'unavailable' as const, reason: 'repair-required' as const } : {})
})

const session = (
  sessionId: string,
  bindings: readonly NotebookSessionRuntimeBinding[] = []
): { value: NotebookSessionAggregate; terminate: ReturnType<typeof vi.fn> } => {
  const terminate = vi.fn().mockResolvedValue(undefined)
  const value = new NotebookSessionAggregate({
    sessionId,
    projectId: 'project',
    lane: createRootNotebookLane('project', sessionId, 'root-frame-' + sessionId),
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
  const byId = new Map(sessions.map((candidate) => [candidate.sessionId, candidate]))
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
      persist: vi.fn().mockResolvedValue(undefined)
    },
    environmentOperations: {
      blockRepair: vi.fn(),
      clearRepair: vi.fn()
    },
    sessions: () => sessions,
    findSession: (sessionId) => byId.get(sessionId),
    notifyChanged: vi.fn()
  }
  return { owner: new NotebookRuntimeRepairOwner(options), options, runtimeRoot }
}

describe('NotebookRuntimeRepairOwner', () => {
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

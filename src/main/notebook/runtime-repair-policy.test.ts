import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  addRepairRequired,
  envPrefix,
  managedRepairRegistryKey,
  pythonBin,
  repairRegistryPath,
  rBin
} from './runtime-paths'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-repair-policy-'))
  roots.push(root)
  return root
}

const binding = (
  source: 'managed' | 'external',
  runtimeId: string
): Pick<NotebookSessionRuntimeBinding, 'runtimeId' | 'source'> => ({ source, runtimeId })

describe('NotebookRuntimeRepairPolicy', () => {
  it('keeps managed compatibility aliases scoped by language and external identities isolated', () => {
    const runtimeRoot = createRoot()
    const policy = new NotebookRuntimeRepairPolicy(runtimeRoot)
    const managed = binding('managed', 'analysis-python-runtime')

    expect(policy.registryKeys('python', 'analysis', managed)).toEqual([
      'analysis',
      managedRepairRegistryKey('analysis', 'python'),
      managed.runtimeId,
      pythonBin(envPrefix(runtimeRoot, 'analysis'))
    ])
    expect(policy.registryKeys('r', 'analysis')).toEqual([
      'analysis',
      managedRepairRegistryKey('analysis', 'r'),
      rBin(envPrefix(runtimeRoot, 'analysis'))
    ])
    expect(
      policy.registryKeys('python', 'default-python', binding('external', '/usr/bin/python'))
    ).toEqual(['/usr/bin/python'])
  })

  it('protects managed legacy markers while leaving external legacy markers adoptable', () => {
    const runtimeRoot = createRoot()
    const managed = binding('managed', 'managed-runtime')
    const external = binding('external', 'external-runtime')
    mkdirSync(dirname(repairRegistryPath(runtimeRoot)), { recursive: true })
    writeFileSync(
      repairRegistryPath(runtimeRoot),
      `${JSON.stringify({ runtimeIds: [managed.runtimeId, external.runtimeId] })}\n`,
      'utf8'
    )
    const policy = new NotebookRuntimeRepairPolicy(runtimeRoot)

    expect(policy.requirement('python', 'analysis', managed)).toMatchObject({
      required: true,
      protectedIdentity: true
    })
    expect(policy.requirement('python', 'default-python', external)).toMatchObject({
      required: true,
      protectedIdentity: false
    })
  })

  it('keeps raw interpreter aliases out of the public binding projection', () => {
    const runtimeRoot = createRoot()
    const policy = new NotebookRuntimeRepairPolicy(runtimeRoot)
    const managed = binding('managed', 'canonical-managed-runtime')
    addRepairRequired(runtimeRoot, pythonBin(envPrefix(runtimeRoot, 'analysis')))

    expect(policy.requirement('python', 'analysis', managed).required).toBe(true)
    expect(policy.bindingRequirement('python', 'analysis', managed).required).toBe(false)
  })

  it('treats explicit protected markers as protected for external runtimes', () => {
    const runtimeRoot = createRoot()
    const external = binding('external', 'external-runtime')
    addRepairRequired(runtimeRoot, external.runtimeId, 'protected-identity-change')

    expect(
      new NotebookRuntimeRepairPolicy(runtimeRoot).requirement('python', 'default-python', external)
    ).toMatchObject({ required: true, protectedIdentity: true })
  })

  it('projects recovery markers without widening managed language scope', () => {
    const policy = new NotebookRuntimeRepairPolicy(createRoot())
    const record = {
      operationId: 'operation',
      kind: 'install' as const,
      runtimeId: 'analysis',
      phase: 'install-r',
      startedAt: 1,
      targetPath: '/runtime/envs/analysis'
    }

    expect(policy.recoveryMarker(record)).toEqual({
      key: managedRepairRegistryKey('analysis', 'r'),
      reason: 'interrupted-install'
    })
    expect(
      policy.recoveryMarker({
        ...record,
        repairReason: 'protected-identity-change'
      })
    ).toEqual({ key: 'analysis', reason: 'protected-identity-change' })
    expect(
      policy.recoveryMarker({ ...record, runtimeId: '/usr/bin/R', targetPath: undefined })
    ).toEqual({ key: '/usr/bin/R', reason: 'interrupted-install' })
  })
})

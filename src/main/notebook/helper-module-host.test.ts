import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  NOTEBOOK_HELPER_EVIDENCE_MAX_SOURCE_BYTES,
  NotebookHelperModuleHost,
  type RegisteredNotebookHelperModule
} from './helper-module-host'
import type { NotebookKernelEpochOwnership } from './session-aggregate'

const digest = (source: string): string => createHash('sha256').update(source).digest('hex')

const helper = (
  id: string,
  source = `def ${id.replaceAll('-', '_')}():\n    return ${JSON.stringify(id)}`,
  dependencies: readonly string[] = [],
  registeredGeneration = 'generation-1'
): RegisteredNotebookHelperModule => ({
  id,
  language: 'python',
  source,
  sourceDigest: digest(source),
  exports: [id.replaceAll('-', '_')],
  dependencies,
  skillIdentity: `skill:${id}`,
  packageOrigin: 'built-in',
  interfaceRevision: '1',
  registeredGeneration,
  generationRoot: `/registered/${registeredGeneration}`
})

const epoch = (id: string): NotebookKernelEpochOwnership => ({
  id,
  processKey: 'python:default-python'
})

describe('NotebookHelperModuleHost', () => {
  it('omits the helper evidence envelope when an epoch has loaded no helpers', () => {
    const host = new NotebookHelperModuleHost()

    expect(host.loadedEvidence(epoch('helper-free-epoch'))).toEqual({})
  })

  it('pins roots before deterministic dependency expansion and initializes each helper once', async () => {
    const descriptors = new Map([
      ['root-b', helper('root-b', undefined, ['shared'])],
      ['root-a', helper('root-a', undefined, ['shared'])],
      ['shared', helper('shared')]
    ])
    const resolve = vi.fn(async (id: string) => descriptors.get(id))
    const host = new NotebookHelperModuleHost({ resolve })
    const ownership = epoch('epoch-1')

    const request = await host.preflight('python', ['root-b', 'root-a', 'root-b'])
    const first = await host.plan(ownership, request)
    host.commitInitialized(
      ownership,
      first.injections.map(({ id }) => id)
    )
    const second = await host.plan(ownership, await host.preflight('python', ['root-a', 'root-b']))
    const helperFree = await host.plan(ownership, await host.preflight('python', undefined))

    expect(first.injections.map(({ id }) => id)).toEqual(['shared', 'root-a', 'root-b'])
    expect(second.injections).toEqual([])
    expect(first.protectedGenerationRoots).toEqual(['/registered/generation-1'])
    expect(helperFree.protectedGenerationRoots).toEqual(['/registered/generation-1'])
    expect(host.loadedEvidence(ownership)).toEqual({
      helperEvidenceStatus: { state: 'complete' },
      helperModules: [
        expect.objectContaining({
          helperId: 'root-a',
          skillIdentity: 'skill:root-a',
          packageOrigin: 'built-in',
          interfaceRevision: '1',
          registeredGeneration: 'generation-1',
          exports: ['root_a'],
          source: expect.stringContaining('def root_a'),
          sourceDigest: digest('def root_a():\n    return "root-a"')
        }),
        expect.objectContaining({ helperId: 'root-b' }),
        expect.objectContaining({ helperId: 'shared' })
      ]
    })
  })

  it('fails missing dependencies and cycles before returning an injection plan', async () => {
    const missingHost = new NotebookHelperModuleHost({
      resolve: async (id) => (id === 'root' ? helper('root', undefined, ['missing']) : undefined)
    })
    await expect(
      missingHost.plan(epoch('missing-epoch'), await missingHost.preflight('python', ['root']))
    ).rejects.toThrow(/MISSING_HELPER_DEPENDENCY.*root.*missing/)

    const cycleHost = new NotebookHelperModuleHost({
      resolve: async (id) =>
        id === 'a'
          ? helper('a', undefined, ['b'])
          : id === 'b'
            ? helper('b', undefined, ['a'])
            : undefined
    })
    await expect(
      cycleHost.plan(epoch('cycle-epoch'), await cycleHost.preflight('python', ['a']))
    ).rejects.toThrow(/HELPER_DEPENDENCY_CYCLE.*a -> b -> a/)
  })

  it('marks helper evidence incomplete when its registered provenance identity is unavailable', async () => {
    const source = 'def unbound():\n    return 1'
    const host = new NotebookHelperModuleHost({
      resolve: async () => ({
        id: 'unbound',
        language: 'python',
        source,
        sourceDigest: digest(source),
        exports: ['unbound']
      })
    })

    const ownership = epoch('unbound-epoch')
    const plan = await host.plan(ownership, await host.preflight('python', ['unbound'], ownership))
    host.commitInitialized(
      ownership,
      plan.injections.map(({ id }) => id)
    )

    expect(host.loadedEvidence(ownership)).toEqual({
      helperModules: [],
      helperEvidenceStatus: { state: 'incomplete', reasons: ['source-missing'] }
    })
  })

  it('keeps earlier generation roots protected when a later request adds another helper', async () => {
    const descriptors = new Map([
      ['helper-a', { ...helper('helper-a'), generationRoot: '/registered/generation-a' }],
      ['helper-b', { ...helper('helper-b'), generationRoot: '/registered/generation-b' }]
    ])
    const host = new NotebookHelperModuleHost({
      resolve: async (id) => descriptors.get(id)
    })
    const ownership = epoch('multi-root-epoch')
    const first = await host.plan(
      ownership,
      await host.preflight('python', ['helper-a'], ownership)
    )
    host.commitInitialized(
      ownership,
      first.injections.map(({ id }) => id)
    )
    const second = await host.plan(
      ownership,
      await host.preflight('python', ['helper-b'], ownership)
    )

    expect(second.injections.map(({ id }) => id)).toEqual(['helper-b'])
    expect(second.protectedGenerationRoots).toEqual([
      '/registered/generation-a',
      '/registered/generation-b'
    ])
  })

  it('keeps the first registered generation pinned until the aggregate rotates the epoch', async () => {
    let current = helper('stable', 'def stable():\n    return 1', [], 'generation-1')
    const host = new NotebookHelperModuleHost({ resolve: async () => current })
    const firstEpoch = epoch('epoch-1')

    const first = await host.plan(firstEpoch, await host.preflight('python', ['stable']))
    host.commitInitialized(firstEpoch, ['stable'])
    current = helper('stable', 'def stable():\n    return 2', [], 'generation-2')
    const pinned = await host.plan(
      firstEpoch,
      await host.preflight('python', ['stable'], firstEpoch)
    )
    const replacement = await host.plan(
      epoch('epoch-2'),
      await host.preflight('python', ['stable'])
    )

    expect(first.injections[0]).toMatchObject({ registeredGeneration: 'generation-1' })
    expect(pinned.injections).toEqual([])
    expect(replacement.injections[0]).toMatchObject({ registeredGeneration: 'generation-2' })
  })

  it('reuses the complete pinned closure before consulting a removed or invalid catalog entry', async () => {
    let descriptors = new Map([
      ['root', helper('root', undefined, ['dependency'])],
      ['dependency', helper('dependency')]
    ])
    const resolve = vi.fn(async (id: string) => descriptors.get(id))
    const host = new NotebookHelperModuleHost({ resolve })
    const ownership = epoch('pinned-epoch')
    const first = await host.plan(ownership, await host.preflight('python', ['root']))
    host.commitInitialized(
      ownership,
      first.injections.map(({ id }) => id)
    )
    const callsAfterPin = resolve.mock.calls.length

    descriptors = new Map()
    const removed = await host.plan(ownership, await host.preflight('python', ['root'], ownership))
    descriptors.set('root', {
      ...helper('root', 'def root():\n    return "invalid replacement"'),
      sourceDigest: '0'.repeat(64)
    })
    const invalidReplacement = await host.plan(
      ownership,
      await host.preflight('python', ['root'], ownership)
    )

    expect(removed.injections).toEqual([])
    expect(invalidReplacement.injections).toEqual([])
    expect(removed.protectedGenerationRoots).toEqual(['/registered/generation-1'])
    expect(resolve).toHaveBeenCalledTimes(callsAfterPin)
  })

  it('rejects a catalog digest mismatch without exposing source text', async () => {
    const source = 'def secret_export():\n    return "protected source marker"'
    const host = new NotebookHelperModuleHost({
      resolve: async () => ({ ...helper('secret', source), sourceDigest: '0'.repeat(64) })
    })

    const failure = await host.preflight('python', ['secret']).catch((error: unknown) => error)
    expect(String(failure)).toMatch(/HELPER_GENERATION_MISMATCH.*secret/)
    expect(String(failure)).not.toContain('protected source marker')
  })

  it('marks epoch evidence incomplete instead of repeating unbounded helper source', async () => {
    const firstSource = `def first():\n    return ${JSON.stringify('a'.repeat(300 * 1024))}`
    const secondSource = `def second():\n    return ${JSON.stringify('b'.repeat(300 * 1024))}`
    const descriptors = new Map([
      ['first', helper('first', firstSource)],
      ['second', helper('second', secondSource)]
    ])
    const host = new NotebookHelperModuleHost({ resolve: async (id) => descriptors.get(id) })
    const ownership = epoch('bounded-epoch')
    const plan = await host.plan(
      ownership,
      await host.preflight('python', ['first', 'second'], ownership)
    )
    host.commitInitialized(
      ownership,
      plan.injections.map(({ id }) => id)
    )

    const evidence = host.loadedEvidence(ownership)
    const helperModules = evidence.helperModules ?? []

    expect(
      helperModules.reduce((bytes, item) => bytes + Buffer.byteLength(item.source), 0)
    ).toBeLessThanOrEqual(NOTEBOOK_HELPER_EVIDENCE_MAX_SOURCE_BYTES)
    expect(helperModules.map(({ helperId }) => helperId)).toEqual(['first'])
    expect(evidence.helperEvidenceStatus).toEqual({
      state: 'incomplete',
      reasons: ['payload-limit']
    })
  })
})

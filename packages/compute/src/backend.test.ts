import { describe, expect, it } from 'vitest'
import {
  assertComputeBackendCanSubmit,
  assertComputeBackendCapabilities,
  requiredComputeBackendCapabilities,
  classifyComputeBackendObservation,
  ComputeBackendAdapterRegistry,
  ComputeBackendCatalog,
  LEGACY_COMPUTE_BACKENDS
} from './backend'

describe('compute backend catalog', () => {
  it('exposes both existing execution modes with compatible capabilities', () => {
    const catalog = new ComputeBackendCatalog()

    expect(catalog.list()).toEqual(LEGACY_COMPUTE_BACKENDS)
    expect(catalog.get('direct_ssh')).toMatchObject({
      id: 'direct_ssh',
      capabilities: {
        commandExecution: true,
        sourcePackaging: true,
        streamingLogs: true,
        metrics: false,
        cancellation: true,
        outputCollection: true,
        environmentSelection: true
      }
    })
    expect(catalog.get('slurm')?.id).toBe('slurm')
  })

  it('rejects duplicate backend ids before publishing a catalog', () => {
    expect(
      () => new ComputeBackendCatalog([LEGACY_COMPUTE_BACKENDS[0], LEGACY_COMPUTE_BACKENDS[0]])
    ).toThrow('Compute backend ids must be unique.')
  })

  it('returns a snapshot when callers enumerate descriptors', () => {
    const catalog = new ComputeBackendCatalog()
    const listed = catalog.list()

    expect(listed).not.toBe(catalog.list())
    expect(listed).toEqual(LEGACY_COMPUTE_BACKENDS)
  })
})

const testAdapter = (id: string) =>
  ({
    id,
    capabilities: {
      commandExecution: true,
      sourcePackaging: true,
      streamingLogs: true,
      metrics: false,
      cancellation: true,
      outputCollection: true,
      environmentSelection: true
    },
    validateTarget: async () => ({ valid: true, contact: 'live' as const }),
    probe: async () => ({ phase: 'running' as const, contact: 'live' as const }),
    submit: async () => ({ backendId: id, providerId: 'test:provider', value: 'opaque' }),
    recover: async () => null,
    observe: async () => ({ phase: 'running' as const, contact: 'live' as const }),
    cancel: async () => ({ outcome: 'confirmed' as const }),
    collectLogs: async () => ({ stdout: '', stderr: '', complete: true }),
    harvest: async () => ({ outcome: 'complete' as const }),
    cleanup: async () => ({ outcome: 'cleaned' as const })
  }) as const

describe('compute backend adapter registry', () => {
  it('looks up adapters without exposing provider-specific parsing', async () => {
    const adapter = testAdapter('kubernetes')
    const registry = new ComputeBackendAdapterRegistry([adapter])

    expect(registry.get('kubernetes')).toBe(adapter)
    expect(registry.list()).toEqual([adapter])
    await expect(
      registry
        .requireAdapter('kubernetes')
        .probe({ providerId: 'k8s:cluster', backendId: 'kubernetes' })
    ).resolves.toEqual({
      phase: 'running',
      contact: 'live'
    })
  })

  it('rejects duplicate adapters and missing lookups', () => {
    const adapter = testAdapter('kubernetes')

    expect(() => new ComputeBackendAdapterRegistry([adapter, adapter])).toThrow(
      'Compute backend adapter ids must be unique.'
    )
    expect(() => new ComputeBackendAdapterRegistry().requireAdapter('kubernetes')).toThrow(
      'No compute backend adapter registered for "kubernetes".'
    )
  })
})

describe('compute backend capability and observation guards', () => {
  it('rejects unsupported submission requirements before provider calls', () => {
    expect(() =>
      assertComputeBackendCapabilities(
        {
          commandExecution: true,
          sourcePackaging: false,
          streamingLogs: true,
          metrics: false,
          cancellation: true,
          outputCollection: false,
          environmentSelection: false
        },
        ['commandExecution', 'sourcePackaging']
      )
    ).toThrow('sourcePackaging')
  })

  it.each([
    [
      { phase: 'running', contact: 'live' },
      { kind: 'active', terminal: false }
    ],
    [
      { phase: 'succeeded', contact: 'live' },
      { kind: 'terminal', terminal: true }
    ],
    [
      { phase: 'failed', contact: 'unreachable' },
      { kind: 'contact_lost', terminal: false }
    ],
    [
      { phase: 'lost', contact: 'live' },
      { kind: 'needs_attention', terminal: false }
    ]
  ] as const)(
    'keeps observation %j non-terminal when contact is uncertain',
    (observation, expected) => {
      expect(classifyComputeBackendObservation(observation)).toEqual(expected)
    }
  )
})

describe('compute backend submission requirements', () => {
  it('derives capability requirements from input and output declarations', () => {
    expect(
      requiredComputeBackendCapabilities({
        jobId: 'job-1',
        target: { providerId: 'k8s:cluster', backendId: 'kubernetes' },
        command: 'echo ready',
        inputManifest: '[]',
        outputManifest: ' outputs.json ',
        harvestConfig: '',
        environment: 'python-3.12'
      })
    ).toEqual(['commandExecution', 'environmentSelection', 'sourcePackaging', 'outputCollection'])
  })

  it('blocks unsupported output collection before submission', () => {
    const adapter = {
      capabilities: {
        commandExecution: true,
        sourcePackaging: false,
        streamingLogs: true,
        metrics: false,
        cancellation: true,
        outputCollection: false,
        environmentSelection: false
      }
    }
    expect(() =>
      assertComputeBackendCanSubmit(adapter, {
        jobId: 'job-1',
        target: { providerId: 'k8s:cluster', backendId: 'kubernetes' },
        command: 'echo ready',
        outputManifest: 'outputs.json'
      })
    ).toThrow('outputCollection')
  })
})

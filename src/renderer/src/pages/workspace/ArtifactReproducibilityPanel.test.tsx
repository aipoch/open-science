// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactReproducibilityProjection } from '../../../../shared/artifact-provenance'
import type {
  ArtifactReproducibilityReceipt,
  ArtifactReproducibilityCheckState
} from '../../../../shared/artifact-reproducibility'
import { ArtifactReproducibilityPanel } from './ArtifactReproducibilityPanel'
import { ReproducibilityOutput } from './ReproducibilityOutput'
import { ReproducibilityOutputStorage } from './ReproducibilityOutputStorage'
import * as dependencyGraph from './artifact-reproducibility-graph'
import { DEFAULT_OUTPUT_COMPARISON_POLICY } from '../../../../shared/output-comparison'

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const projection = (): ArtifactReproducibilityProjection => ({
  completeness: 'complete',
  reasonCodes: [],
  targetEntityId: 'artifact-version:version-1',
  activities: [
    {
      activityId: 'run-1',
      kind: 'notebook-run',
      sequence: 0,
      runIndex: 0,
      inclusion: 'target-closure',
      evidenceState: 'available'
    },
    {
      activityId: 'publish-1',
      kind: 'artifact-publication',
      sequence: 1,
      inclusion: 'target-closure',
      evidenceState: 'available'
    }
  ],
  entities: [
    {
      entityId: 'input-1',
      kind: 'registered-input-generation',
      label: 'source.csv',
      checksum: 'a'.repeat(64),
      sizeBytes: 10,
      sourceKind: 'upload-version'
    },
    {
      entityId: 'file-1',
      kind: 'file-generation',
      label: 'private-result.csv',
      checksum: 'b'.repeat(64),
      sizeBytes: 20,
      pathPortability: 'absolute'
    },
    {
      entityId: 'artifact-version:version-1',
      kind: 'artifact-version',
      label: 'result.csv',
      checksum: 'b'.repeat(64),
      sizeBytes: 20
    }
  ],
  outputGroups: [],
  edges: [
    {
      kind: 'used',
      activityId: 'run-1',
      entityId: 'input-1',
      authority: 'authoritative',
      evidenceSource: 'registered-contract'
    },
    {
      kind: 'generated',
      activityId: 'run-1',
      entityId: 'file-1',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'used',
      activityId: 'publish-1',
      entityId: 'file-1',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    },
    {
      kind: 'generated',
      activityId: 'publish-1',
      entityId: 'artifact-version:version-1',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    }
  ],
  startFrontiers: [
    {
      frontierId: 'original-inputs',
      kind: 'original-inputs',
      claimScope: 'end-to-end',
      eligibility: 'available',
      crossingEntityIds: ['input-1'],
      downstreamActivityIds: ['run-1', 'publish-1'],
      reasonCodes: []
    },
    {
      frontierId: 'checkpoint:run-1',
      kind: 'checkpoint',
      claimScope: 'downstream-only',
      eligibility: 'blocked',
      afterActivityId: 'run-1',
      crossingEntityIds: ['file-1'],
      downstreamActivityIds: ['publish-1'],
      reasonCodes: ['absolute-path-boundary']
    }
  ],
  executionRunCount: 2,
  includedNotebookRunCount: 1,
  skippedRunCount: 1
})

const receipt = (outcome: 'matched' | 'different' = 'matched'): ArtifactReproducibilityReceipt => ({
  schemaVersion: 1,
  receiptId: 'attempt-1',
  startedAt: '2026-09-02T00:00:00.000Z',
  completedAt: '2026-09-02T00:01:00.000Z',
  outcome,
  artifactVersion: {
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    targetChecksum: 'a'.repeat(64)
  },
  frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
  recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
  environmentLocks: [],
  completedStepIds: ['notebook:run-1'],
  comparisons: [
    {
      stepId: 'notebook:run-1',
      entityId: 'file-1',
      relativePath: 'result.csv',
      expectedChecksum: 'd'.repeat(64),
      expectedSizeBytes: 10,
      actualChecksum: outcome === 'matched' ? 'd'.repeat(64) : 'e'.repeat(64),
      actualSizeBytes: 10,
      status: outcome,
      ...(outcome === 'different' ? { reason: 'checksum-mismatch' as const } : {})
    }
  ],
  receiptChecksum: 'f'.repeat(64)
})

const branchedProjection = (): ArtifactReproducibilityProjection => {
  const value = projection()
  value.activities.splice(1, 0, {
    activityId: 'run-2',
    kind: 'notebook-run',
    sequence: 0,
    runIndex: 1,
    inclusion: 'target-closure',
    evidenceState: 'available'
  })
  value.entities.splice(2, 0, {
    entityId: 'file-2',
    kind: 'file-generation',
    label: 'summary.csv',
    checksum: 'c'.repeat(64),
    sizeBytes: 12,
    pathPortability: 'relative'
  })
  value.edges.splice(
    2,
    0,
    {
      kind: 'used',
      activityId: 'run-2',
      entityId: 'input-1',
      authority: 'authoritative',
      evidenceSource: 'registered-contract'
    },
    {
      kind: 'generated',
      activityId: 'run-2',
      entityId: 'file-2',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'used',
      activityId: 'publish-1',
      entityId: 'file-2',
      authority: 'authoritative',
      evidenceSource: 'artifact-publication'
    }
  )
  value.executionRunCount = 3
  value.includedNotebookRunCount = 2
  return value
}

const kernelDependencyProjection = (): ArtifactReproducibilityProjection => {
  const value = projection()
  value.activities.splice(1, 0, {
    activityId: 'run-2',
    kind: 'notebook-run',
    sequence: 1,
    runIndex: 1,
    inclusion: 'target-closure',
    evidenceState: 'available'
  })
  value.activities[2]!.sequence = 2
  const generated = value.edges.find(
    (edge) => edge.kind === 'generated' && edge.entityId === 'file-1'
  )
  if (generated) generated.activityId = 'run-2'
  value.edges.push({
    kind: 'depends-on',
    activityId: 'run-2',
    dependencyActivityId: 'run-1',
    authority: 'authoritative',
    evidenceSource: 'dependency-analysis'
  })
  value.executionRunCount = 2
  value.includedNotebookRunCount = 2
  value.skippedRunCount = 0
  return value
}

const conservativeBranchProjection = (): ArtifactReproducibilityProjection => {
  const value = projection()
  value.activities.splice(1, 0, {
    activityId: 'run-2',
    kind: 'notebook-run',
    sequence: 1,
    runIndex: 1,
    inclusion: 'kernel-epoch-conservative',
    evidenceState: 'partial'
  })
  value.activities[2]!.sequence = 2
  value.edges.splice(2, 0, {
    kind: 'used',
    activityId: 'run-2',
    entityId: 'input-1',
    authority: 'advisory',
    evidenceSource: 'conservative-fallback'
  })
  value.executionRunCount = 2
  value.includedNotebookRunCount = 2
  value.skippedRunCount = 0
  return value
}

describe('ArtifactReproducibilityPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as { api?: unknown }).api = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows retained size, confirms cleanup, and removes previews and actions after cleanup', async () => {
    const value = receipt('different')
    const comparison = {
      ...value.comparisons[0]!,
      outputCaptured: true as const,
      actualSizeBytes: 2048
    }
    let storage = { sizeBytes: 2048, fileCount: 1, clearedReceiptChecksums: [] as string[] }
    const clearReproducibilityOutputs = vi.fn(async () => {
      storage = { sizeBytes: 0, fileCount: 0, clearedReceiptChecksums: [value.receiptChecksum] }
      return storage
    })
    const getReproducibilityOutputStorage = vi.fn(async () => storage)
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        getReproducibilityOutputStorage,
        clearReproducibilityOutputs,
        readReproducibilityOutput: async () => ({
          filename: 'result.csv',
          reproduced: { kind: 'text', text: 'changed' }
        }),
        exportReproducibilityReceipt: vi.fn()
      }
    }
    const render = async (running: boolean): Promise<void> => {
      await act(async () =>
        root.render(
          <ReproducibilityOutputStorage
            scope={value.artifactVersion}
            receiptKey={value.receiptChecksum}
            running={running}
          >
            <ReproducibilityOutput receipt={value} comparison={comparison} />
          </ReproducibilityOutputStorage>
        )
      )
    }
    const button = (label: string): HTMLButtonElement =>
      Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label)!
    await render(true)
    expect(container.textContent).toContain('2.0 KB')
    expect(button('Clear reproduced outputs').disabled).toBe(true)
    await render(false)
    await act(async () => fireEvent.click(button('View output')))
    expect(container.querySelectorAll('figure')).toHaveLength(2)
    await act(async () => fireEvent.click(button('Clear reproduced outputs')))
    expect(clearReproducibilityOutputs).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Verification history and logs are kept.')
    await act(async () => fireEvent.click(button('Cancel')))
    expect(clearReproducibilityOutputs).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(button('Clear reproduced outputs')))
    await act(async () => fireEvent.click(button('Clear')))
    expect(clearReproducibilityOutputs).toHaveBeenCalledTimes(1)
    expect(clearReproducibilityOutputs).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: value.artifactVersion.versionId })
    )
    expect(container.textContent).toContain('Output cleared')
    expect(container.textContent).toContain('0 B')
    expect(container.querySelectorAll('figure')).toHaveLength(0)
    expect(button('Download output')).toBeUndefined()
  })

  it.each([
    ['budget-exceeded', 'Content exceeds the comparison limit.'],
    ['unsupported-format', 'This content format is not supported for comparison.'],
    ['comparison-failed', 'Content could not be parsed or compared.']
  ] as const)(
    'explains unavailable content comparison %s without reading output',
    async (reason, message) => {
      const value = receipt('different')
      const readReproducibilityOutput = vi.fn()
      ;(window as unknown as { api: unknown }).api = { artifacts: { readReproducibilityOutput } }
      await act(async () =>
        root.render(
          <ReproducibilityOutput
            receipt={value}
            comparison={{
              ...value.comparisons[0]!,
              contentComparisonUnavailableReason: reason
            }}
          />
        )
      )
      expect(container.textContent).toContain('Content comparison unavailable')
      expect(container.textContent).toContain(message)
      expect(readReproducibilityOutput).not.toHaveBeenCalled()
    }
  )

  it('loads image differences on demand and adjusts overlay opacity without another read', async () => {
    const value = receipt('different')
    const comparison = {
      ...value.comparisons[0]!,
      outputCaptured: true as const,
      contentComparison: {
        schemaVersion: 1 as const,
        comparator: 'open-science-content-v1' as const,
        policy: DEFAULT_OUTPUT_COMPARISON_POLICY,
        policyChecksum: 'a'.repeat(64),
        expectedChecksum: 'b'.repeat(64),
        actualChecksum: 'c'.repeat(64),
        kind: 'image' as const,
        outcome: 'different' as const,
        image: {
          width: 8,
          height: 8,
          changedPixels: 64,
          changedPixelRatio: 1,
          rmse: 100,
          maxDifference: 255
        }
      }
    }
    const readReproducibilityOutput = vi.fn(async () => ({
      filename: 'plot.png',
      original: { kind: 'image', dataUrl: 'data:image/png;base64,b3JpZ2luYWw=' },
      reproduced: { kind: 'image', dataUrl: 'data:image/png;base64,YWN0dWFs' },
      differenceImage: 'data:image/png;base64,ZGlmZg=='
    }))
    ;(window as unknown as { api: unknown }).api = { artifacts: { readReproducibilityOutput } }
    await act(async () =>
      root.render(<ReproducibilityOutput receipt={value} comparison={comparison} />)
    )
    expect(readReproducibilityOutput).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'View output'
    )!
    await act(async () => fireEvent.click(button))
    expect(container.textContent).toContain('Difference image')
    const slider = container.querySelector('input[type="range"]')!
    await act(async () => fireEvent.change(slider, { target: { value: '75' } }))
    expect(container.querySelector<HTMLImageElement>('img[style]')?.style.opacity).toBe('0.75')
    expect(readReproducibilityOutput).toHaveBeenCalledTimes(1)
  })

  it('loads reproduced output on demand, caches previews, and downloads the selected generation', async () => {
    const value = receipt('different')
    const comparison = { ...value.comparisons[0]!, outputCaptured: true as const }
    const readReproducibilityOutput = vi.fn(async () => ({
      filename: 'result.csv',
      original: { kind: 'text', text: 'original' },
      reproduced: { kind: 'text', text: '<script>reproduced</script>' }
    }))
    const exportReproducibilityReceipt = vi.fn(async () => ({ saved: true }))
    ;(window as unknown as { api: unknown }).api = {
      artifacts: { readReproducibilityOutput, exportReproducibilityReceipt }
    }
    await act(async () =>
      root.render(<ReproducibilityOutput receipt={value} comparison={comparison} />)
    )
    expect(readReproducibilityOutput).not.toHaveBeenCalled()
    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (item) => item.textContent === label
      )!
      await act(async () => fireEvent.click(button))
    }
    await click('View output')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>reproduced</script>')
    expect(container.querySelectorAll('figure')).toHaveLength(2)
    expect(readReproducibilityOutput).toHaveBeenCalledWith({
      projectId: value.artifactVersion.projectId,
      appSessionId: value.artifactVersion.appSessionId,
      artifactId: value.artifactVersion.artifactId,
      versionId: value.artifactVersion.versionId,
      receiptChecksum: value.receiptChecksum,
      entityId: comparison.entityId
    })
    await click('Hide output')
    await click('View output')
    expect(readReproducibilityOutput).toHaveBeenCalledTimes(1)
    await click('Download output')
    expect(exportReproducibilityReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptChecksum: value.receiptChecksum,
        outputEntityId: comparison.entityId
      })
    )
  })

  it('keeps legacy output limitations explicit and retries a failed preview after reopening', async () => {
    const value = receipt('different')
    const readReproducibilityOutput = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ filename: 'result.csv', reproduced: { kind: 'text', text: 'result' } })
    ;(window as unknown as { api: unknown }).api = { artifacts: { readReproducibilityOutput } }
    await act(async () =>
      root.render(<ReproducibilityOutput receipt={value} comparison={value.comparisons[0]!} />)
    )
    expect(container.textContent).toContain('Reproduced output was not retained.')
    expect(container.querySelector('button')).toBeNull()
    await act(async () =>
      root.render(
        <ReproducibilityOutput
          receipt={value}
          comparison={{ ...value.comparisons[0]!, outputCaptured: true }}
        />
      )
    )
    await act(async () => fireEvent.click(container.querySelector('button')!))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded')
    await act(async () => fireEvent.click(container.querySelector('button')!))
    await act(async () => fireEvent.click(container.querySelector('button')!))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('result')
  })

  it('preserves log reading position and keeps the graph unchanged during streaming and timer ticks', async () => {
    vi.useFakeTimers()
    const edgePath = vi.spyOn(dependencyGraph, 'graphEdgePath')
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    let listener: ((state: ArtifactReproducibilityCheckState) => void) | undefined
    const state: ArtifactReproducibilityCheckState = {
      request: { ...artifactVersion, frontierId: 'original-inputs' },
      attemptId: 'streaming',
      startedAt: new Date().toISOString(),
      revision: 1,
      status: 'running',
      phase: 'executing',
      completedSteps: 0,
      totalSteps: 1,
      completedEnvironments: 1,
      totalEnvironments: 1,
      totalComparisons: 1,
      comparisons: [],
      logs: [
        {
          source: 'notebook',
          kernelKind: 'python',
          stream: 'stdout',
          text: 'first output',
          stepId: 'step:run-1',
          runIndex: 0
        }
      ]
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        artifacts: {
          getReproducibilityCheck: vi.fn(async () => state),
          onReproducibilityCheckChanged: (next: typeof listener) => {
            listener = next
            return () => {
              listener = undefined
            }
          },
          listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
        }
      }
    })
    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactVersion={artifactVersion}
        />
      )
    )
    expect(edgePath).toHaveBeenCalled()
    edgePath.mockClear()
    const log = container.querySelector<HTMLDivElement>('[role="log"]')!
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 }
    })
    log.scrollTop = 100
    await act(async () => fireEvent.scroll(log))
    expect(container.querySelector('button[aria-label="Latest output"]')).toBeNull()
    // Phase updates can carry a new logs array without any new output.
    await act(async () => listener?.({ ...state, revision: 2, logs: [...state.logs!] }))
    expect(container.querySelector('button[aria-label="Latest output"]')).toBeNull()
    await act(async () =>
      listener?.({
        ...state,
        revision: 3,
        logs: [...state.logs!, { ...state.logs![0]!, text: 'second output' }]
      })
    )
    expect(log.scrollTop).toBe(100)
    expect(log.textContent).toContain('second output')
    const latest = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Latest output'
    )!
    expect(latest).toBeDefined()
    await act(async () => latest.click())
    expect(log.scrollTop).toBe(1000)
    expect(document.activeElement).toBe(log)
    expect(container.querySelector('button[aria-label="Latest output"]')).toBeNull()
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1200 })
    await act(async () =>
      listener?.({
        ...state,
        revision: 4,
        logs: [...state.logs!, { ...state.logs![0]!, text: 'third output' }]
      })
    )
    expect(log.scrollTop).toBe(1200)
    expect(container.querySelector('button[aria-label="Latest output"]')).toBeNull()
    log.scrollTop = 100
    await act(async () => fireEvent.scroll(log))
    expect(container.querySelector('button[aria-label="Latest output"]')).toBeNull()
    await act(async () =>
      listener?.({
        ...state,
        revision: 5,
        logs: [...state.logs!, { ...state.logs![0]!, text: 'third output continued' }]
      })
    )
    expect(container.querySelector('button[aria-label="Latest output"]')).not.toBeNull()
    log.scrollTop = 1000
    await act(async () => fireEvent.scroll(log))
    expect(container.querySelector('button[aria-label="Latest output"]')).toBeNull()
    await act(async () => vi.advanceTimersByTime(2000))
    expect(container.textContent).toContain('Elapsed 00:02')
    expect(edgePath).not.toHaveBeenCalled()
    // Selection still updates the graph after the memo boundary is introduced.
    await act(async () =>
      fireEvent.click(container.querySelector('[data-graph-node="activity:run-1"]')!)
    )
    expect(edgePath).toHaveBeenCalled()
  })

  it('explains missing graph evidence for historical Artifact Versions', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel executionAvailable={true} />))

    expect(container.textContent).toContain(
      'Dependency graph was not captured for this Artifact Version.'
    )
    expect(container.querySelector('input')).toBeNull()
  })

  it('does not claim an Execution Log exists when execution evidence is unavailable', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel />))

    expect(container.textContent).toContain(
      'Execution evidence is unavailable, so safe starting points cannot be determined.'
    )
    expect(container.textContent).not.toContain('The Execution Log remains available')
  })

  it('renders only a meaningful safe start, lineage, and unavailable future action', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

    expect(container.textContent).toContain('Captured evidence')
    expect(container.textContent).toContain('Complete capture')
    expect(container.textContent).not.toContain('This result has not been checked again yet.')
    expect(container.querySelector('#reproducibility-check-title')?.textContent).toBe(
      'Not verified yet'
    )
    expect(container.textContent).toContain('Runs to execute1Frozen files1')
    expect(container.textContent).not.toContain('Runs to execute0Frozen files1')
    expect(container.textContent).toContain('1 unrelated runs can be skipped.')
    expect(container.textContent).not.toContain('Checks the complete captured path')
    expect(container.textContent).toContain('Comparison target')
    expect(container.textContent).toContain('Published as')
    expect(container.querySelector('#dependency-title')?.textContent).toBe('Dependency')
    expect(container.textContent).not.toContain('Dependency path')
    expect(container.querySelector('[data-graph-node="activity:publish-1"]')).toBeNull()
    expect(container.querySelector('[data-graph-publication-boundary]')).not.toBeNull()
    expect(container.querySelector('svg[role="group"]')).not.toBeNull()
    expect(container.querySelector('[data-start-frontier-selector]')).toBeNull()
    expect(
      container.querySelector('[data-start-frontier-summary="original-inputs"]')
    ).not.toBeNull()
    expect(container.textContent).not.toContain('After Notebook run 1')
    expect(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Check reproducibility'
      )
    ).toBeUndefined()
    expect(container.querySelector('[data-reproducibility-check-unavailable]')?.textContent).toBe(
      'Unavailable'
    )
    expect(container.querySelector('[data-reproducibility-check-state="idle"]')).not.toBeNull()
    expect(container.querySelector('[data-reproducibility-check-progress-track]')).toBeNull()
    expect(container.querySelector('section')?.getAttribute('aria-labelledby')).toBe(
      'reproducibility-check-title'
    )
    expect(container.querySelector('[data-reproducibility-check-state] fieldset')).not.toBeNull()
    expect(container.textContent).not.toContain('C:\\Users')
  })

  it.each([false, true])(
    'explains why a reproducibility check is unavailable (failed dependency: %s)',
    async (failedDependency) => {
      const value = projection()
      value.completeness = 'incomplete'
      value.reasonCodes = ['activity-evidence-partial', 'file-reads-unavailable']
      value.startFrontiers[0]!.eligibility = 'blocked'
      value.startFrontiers[0]!.reasonCodes = ['activity-evidence-partial', 'file-reads-unavailable']
      if (failedDependency) {
        value.startFrontiers[0]!.checkReasonCodes = [
          'required-run-not-completed',
          'environment-lock-missing'
        ]
      }
      const artifactVersion = {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      }
      ;(window as unknown as { api: unknown }).api = {
        artifacts: {
          startReproducibilityCheck: vi.fn(),
          cancelReproducibilityCheck: vi.fn(),
          onReproducibilityCheckChanged: vi.fn(() => () => undefined),
          listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
        }
      }

      await act(async () =>
        root.render(
          <ArtifactReproducibilityPanel
            projection={value}
            executionAvailable
            artifactVersion={artifactVersion}
          />
        )
      )

      const unavailable = container.querySelector<HTMLElement>(
        '[data-reproducibility-check-unavailable]'
      )
      expect(unavailable?.textContent).toBe('Unavailable')
      expect(unavailable?.querySelector('button')).toBeNull()
      const blocker = container.querySelector<HTMLElement>('[data-reproducibility-check-blocker]')
      expect(blocker?.textContent).toContain(
        failedDependency
          ? 'A required run did not complete. Rerun it successfully, then regenerate this result.'
          : 'Execution evidence is missing. Rerun the required code to create a new version.'
      )
      expect(blocker?.textContent).not.toContain('Activity file evidence is incomplete.')
      expect(blocker?.textContent).not.toContain('File access evidence is incomplete.')
      expect(unavailable?.getAttribute('aria-describedby')).toBe(blocker?.id)

      const details = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'View details'
      )
      await act(async () => {
        if (!details) return
        fireEvent.pointerDown(details, { pointerType: 'mouse', button: 0 })
        fireEvent.pointerUp(details, { pointerType: 'mouse', button: 0 })
        fireEvent.click(details)
        await Promise.resolve()
      })
      const detailsContent = document.body.querySelector('[data-capture-issue-details]')
      expect(detailsContent?.textContent).toContain('Areas needing attention')
      expect(detailsContent?.textContent).toContain(
        'Execution recordSome execution details were not fully captured.'
      )
      expect(detailsContent?.textContent).toContain(
        'File lineageSome file inputs or outputs could not be confirmed.'
      )
      expect(detailsContent?.textContent).not.toContain('Activity file evidence')
      expect(detailsContent?.textContent).not.toContain('File access evidence')
    }
  )

  it.each(['environment-lock-missing', 'environment-lock-partial'] as const)(
    'shows a frontier-only %s blocker even when capture is complete',
    async (reason) => {
      const value = projection()
      value.startFrontiers[0]!.eligibility = 'blocked'
      value.startFrontiers[0]!.checkReasonCodes = [reason]
      ;(window as unknown as { api: unknown }).api = {
        artifacts: {
          startReproducibilityCheck: vi.fn(),
          cancelReproducibilityCheck: vi.fn(),
          onReproducibilityCheckChanged: vi.fn(() => () => undefined),
          listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
        }
      }
      await act(async () =>
        root.render(
          <ArtifactReproducibilityPanel
            projection={value}
            executionAvailable
            environmentRuns={
              reason === 'environment-lock-partial'
                ? [
                    {
                      runId: 'run-1',
                      runIndex: 0,
                      environmentName: 'analysis',
                      environmentLock: {
                        state: 'partial',
                        format: 'environment-lock-bundle',
                        lockChecksum: 'a'.repeat(64),
                        partialReasons: ['non-conda-package-detected'],
                        diagnostics: [
                          {
                            reason: 'package-version-mismatch',
                            packageName: 'pandas',
                            observedVersion: '3.0.5',
                            lockedVersion: '2.0'
                          }
                        ]
                      }
                    },
                    {
                      runId: 'unrelated',
                      runIndex: 1,
                      environmentLock: {
                        state: 'partial',
                        format: 'environment-lock-bundle',
                        lockChecksum: 'b'.repeat(64),
                        partialReasons: ['non-conda-package-detected'],
                        diagnostics: [
                          { reason: 'package-lock-missing', packageName: 'unrelated-package' }
                        ]
                      }
                    }
                  ]
                : undefined
            }
            artifactVersion={{
              projectId: 'project-1',
              appSessionId: 'session-1',
              artifactId: 'artifact-1',
              versionId: 'version-1'
            }}
          />
        )
      )
      expect(container.textContent).toContain('Incomplete capture')
      expect(container.textContent).not.toContain('pandas: installed')
      expect(container.textContent).not.toContain('unrelated-package')
      expect(container.textContent).toContain(
        'A valid environment lock is required. Rerun with locked dependencies to create a new version.'
      )
      expect(container.querySelectorAll('[data-reproducibility-check-blocker] p')).toHaveLength(1)
      const unavailable = container.querySelector<HTMLElement>(
        '[data-reproducibility-check-unavailable]'
      )
      expect(unavailable?.tabIndex).toBe(0)
      await act(async () => unavailable?.focus())
      expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
        'A valid environment lock is required. Rerun with locked dependencies to create a new version.'
      )
      await act(async () => unavailable?.blur())
      const capture = [...container.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Incomplete capture: Code and environment'
      )
      await act(async () => capture?.focus())
      expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
        'The original code or environment is not available for replay.'
      )
      await act(async () => capture?.blur())
      const details = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'View details'
      )
      expect(details).toBeDefined()
      await act(async () => {
        if (details) fireEvent.click(details)
      })
      expect(document.body.querySelector('[data-capture-issue-details]')?.textContent).toContain(
        'Code and environment'
      )
      if (reason === 'environment-lock-partial') {
        const content = document.body.querySelector('[data-capture-issue-details]')?.textContent
        expect(content).toContain('pandas: installed 3.0.5, locked 2.0.')
        expect(content).not.toContain('unrelated-package')
      }
    }
  )

  it.each([
    ['environment-lock-missing', 'Code and environment'],
    ['advisory-dependency', 'File lineage']
  ] as const)('summarizes frontier-only %s blockers as a capture area', async (reason, area) => {
    const value = projection()
    value.checkReasonCodes = []
    value.startFrontiers[0]!.eligibility = 'blocked'
    value.startFrontiers[0]!.checkReasonCodes = [reason]
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: vi.fn(),
        cancelReproducibilityCheck: vi.fn(),
        onReproducibilityCheckChanged: vi.fn(() => () => undefined),
        listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
      }
    }

    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={value}
          executionAvailable
          artifactVersion={artifactVersion}
        />
      )
    )

    const status = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Incomplete capture:')
    )
    await act(async () => status?.focus())
    expect(status?.getAttribute('aria-label')).toBe(`Incomplete capture: ${area}`)
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      area === 'File lineage'
        ? 'Some file inputs or outputs could not be confirmed.'
        : 'The original code or environment is not available for replay.'
    )
  })

  it.each(['close', 'change-version', 'reopen'] as const)(
    'keeps a pending start running after leaving its panel: %s',
    async (navigation) => {
      const artifactVersion = {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      }
      const initial = {
        attemptId: 'attempt-pending',
        startedAt: new Date().toISOString(),
        request: { ...artifactVersion, frontierId: 'original-inputs' },
        revision: 0,
        status: 'running' as const,
        phase: 'loading-evidence' as const,
        completedSteps: 0,
        totalSteps: 1,
        completedEnvironments: 0,
        totalEnvironments: 1,
        totalComparisons: 1,
        comparisons: []
      }
      let resolveStart!: (state: typeof initial) => void
      const startReproducibilityCheck = vi.fn(
        () =>
          new Promise<typeof initial>((resolve) => {
            resolveStart = resolve
          })
      )
      const cancelReproducibilityCheck = vi.fn(async () => undefined)
      ;(window as unknown as { api: unknown }).api = {
        artifacts: {
          startReproducibilityCheck,
          cancelReproducibilityCheck,
          getReproducibilityCheck: vi.fn(async (scope) =>
            scope.versionId === artifactVersion.versionId &&
            startReproducibilityCheck.mock.calls.length > 0
              ? initial
              : undefined
          ),
          onReproducibilityCheckChanged: vi.fn(() => () => undefined),
          listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
        }
      }
      const panel = (versionId = artifactVersion.versionId): React.JSX.Element => (
        <ArtifactReproducibilityPanel
          key={versionId}
          projection={projection()}
          executionAvailable
          artifactVersion={{ ...artifactVersion, versionId }}
        />
      )
      await act(async () => root.render(panel()))
      const start = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Check reproducibility'
      )
      await act(async () => start?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      expect(startReproducibilityCheck).toHaveBeenCalledOnce()
      await act(async () =>
        root.render(navigation === 'change-version' ? panel('version-2') : null)
      )
      if (navigation === 'reopen') await act(async () => root.render(panel()))
      await act(async () => resolveStart(initial))

      expect(cancelReproducibilityCheck).not.toHaveBeenCalled()
      if (navigation === 'reopen') {
        expect(
          container.querySelector('[data-reproducibility-check-state="running"]')
        ).not.toBeNull()
      } else {
        expect(container.querySelector('[data-reproducibility-check-state="running"]')).toBeNull()
      }
      if (navigation === 'change-version') {
        expect(container.querySelector('[data-reproducibility-check-state="idle"]')).not.toBeNull()
      }
    }
  )

  it.each(['close-tab', 'switch-file', 'switch-version'] as const)(
    'restores a running check and its logs after %s without cancelling or restarting it',
    async (navigation) => {
      const artifactVersion = {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      }
      const initial: ArtifactReproducibilityCheckState = {
        attemptId: 'background-attempt',
        startedAt: new Date().toISOString(),
        request: { ...artifactVersion, frontierId: 'original-inputs' },
        revision: 0,
        status: 'running',
        phase: 'loading-evidence',
        completedSteps: 0,
        totalSteps: 1,
        completedEnvironments: 0,
        totalEnvironments: 1,
        totalComparisons: 1,
        comparisons: []
      }
      let state: ArtifactReproducibilityCheckState | undefined
      let history: ArtifactReproducibilityReceipt[] = []
      let listener: ((state: ArtifactReproducibilityCheckState) => void) | undefined
      const cancel = vi.fn(async () => undefined)
      const start = vi.fn(async () => {
        state = initial
        return initial
      })
      const get = vi.fn(async (scope: typeof artifactVersion) =>
        scope.artifactId === artifactVersion.artifactId &&
        scope.versionId === artifactVersion.versionId
          ? state
          : undefined
      )
      ;(window as unknown as { api: unknown }).api = {
        artifacts: {
          startReproducibilityCheck: start,
          cancelReproducibilityCheck: cancel,
          getReproducibilityCheck: get,
          onReproducibilityCheckChanged: (next: typeof listener) => {
            listener = next
            return () => {
              listener = undefined
            }
          },
          listReproducibilityReceipts: vi.fn(async () => ({ receipts: history }))
        }
      }
      const panel = (scope = artifactVersion): React.JSX.Element => (
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactVersion={scope}
        />
      )
      await act(async () => root.render(panel()))
      await act(async () =>
        fireEvent.click(
          [...container.querySelectorAll('button')].find(
            (button) => button.textContent === 'Check reproducibility'
          )!
        )
      )
      expect(container.querySelector('[data-reproducibility-check-state="running"]')).not.toBeNull()
      await act(async () =>
        root.render(
          navigation === 'close-tab'
            ? null
            : panel({
                ...artifactVersion,
                ...(navigation === 'switch-file'
                  ? { artifactId: 'artifact-2' }
                  : { versionId: 'version-2' })
              })
        )
      )
      expect(cancel).not.toHaveBeenCalled()
      expect(container.querySelector('[data-reproducibility-check-state="running"]')).toBeNull()
      state = {
        ...initial,
        revision: 3,
        phase: 'executing',
        completedEnvironments: 1,
        logs: [
          {
            source: 'notebook',
            kernelKind: 'python',
            stream: 'stdout',
            text: 'Progress while panel was hidden\n',
            stepId: 'step:run-1',
            runIndex: 0
          }
        ]
      }
      // No progress event is sent: reopening must recover from the main-process snapshot.
      await act(async () => root.render(panel()))
      expect(get).toHaveBeenLastCalledWith(artifactVersion)
      expect(container.querySelector('[data-reproducibility-check-state="running"]')).not.toBeNull()
      expect(container.textContent).toContain('Progress while panel was hidden')
      expect(start).toHaveBeenCalledOnce()
      expect(cancel).not.toHaveBeenCalled()
      await act(async () => listener?.({ ...state!, revision: 4, phase: 'comparing' }))
      await act(async () => root.render(null))
      // Completion while hidden leaves no active attempt; persisted history supplies the result.
      state = undefined
      history = [
        { ...receipt(), artifactVersion: { ...receipt().artifactVersion, ...artifactVersion } }
      ]
      await act(async () => root.render(panel()))
      expect(container.textContent).toContain('Result reproduced')
      expect(start).toHaveBeenCalledOnce()
      expect(cancel).not.toHaveBeenCalled()
    }
  )

  it('does not replace newer live progress with a delayed snapshot or a previous file response', async () => {
    const scope = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    const initial: ArtifactReproducibilityCheckState = {
      attemptId: 'attempt-1',
      startedAt: new Date().toISOString(),
      request: { ...scope, frontierId: 'original-inputs' },
      revision: 1,
      status: 'running',
      phase: 'loading-evidence',
      completedSteps: 0,
      totalSteps: 1,
      completedEnvironments: 0,
      totalEnvironments: 1,
      totalComparisons: 1,
      comparisons: []
    }
    const pending: Array<(state?: ArtifactReproducibilityCheckState) => void> = []
    let listener: ((state: ArtifactReproducibilityCheckState) => void) | undefined
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: vi.fn(),
        cancelReproducibilityCheck: vi.fn(),
        getReproducibilityCheck: () =>
          new Promise<ArtifactReproducibilityCheckState | undefined>((resolve) =>
            pending.push(resolve)
          ),
        onReproducibilityCheckChanged: (next: typeof listener) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
      }
    }
    const panel = (artifactId = scope.artifactId): React.JSX.Element => (
      <ArtifactReproducibilityPanel
        projection={projection()}
        executionAvailable
        artifactVersion={{ ...scope, artifactId }}
      />
    )
    await act(async () => root.render(panel()))
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Loading…')
        ?.disabled
    ).toBe(true)
    await act(async () =>
      listener?.({
        ...initial,
        revision: 5,
        phase: 'executing',
        logs: [
          {
            source: 'notebook',
            stream: 'stdout',
            text: 'Newest progress',
            kernelKind: 'python',
            stepId: 'step:run-1',
            runIndex: 0
          }
        ]
      })
    )
    await act(async () => pending[0](initial))
    expect(container.textContent).toContain('Newest progress')
    await act(async () => root.render(panel('artifact-2')))
    await act(async () => root.render(panel('artifact-3')))
    await act(async () =>
      pending[1]({ ...initial, request: { ...initial.request, artifactId: 'artifact-2' } })
    )
    expect(container.querySelector('[data-reproducibility-check-state="running"]')).toBeNull()
    await act(async () => pending[2](undefined))
    expect(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Check reproducibility'
      )?.disabled
    ).toBe(false)
  })

  it('starts, reports, and cancels an isolated reproducibility check', async () => {
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    let listener:
      | ((
          state: import('../../../../shared/artifact-reproducibility').ArtifactReproducibilityCheckState
        ) => void)
      | undefined
    const initial = {
      attemptId: 'attempt-1',
      startedAt: new Date().toISOString(),
      request: { ...artifactVersion, frontierId: 'original-inputs' },
      revision: 0,
      status: 'running' as const,
      phase: 'loading-evidence' as const,
      completedSteps: 0,
      totalSteps: 1,
      completedEnvironments: 0,
      totalEnvironments: 1,
      totalComparisons: 1,
      comparisons: []
    }
    const startReproducibilityCheck = vi.fn(async () => initial)
    const cancelReproducibilityCheck = vi.fn(async () => undefined)
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck,
        cancelReproducibilityCheck,
        onReproducibilityCheckChanged: (next: typeof listener): (() => void) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        listReproducibilityReceipts: vi.fn(async () => ({ receipts: [] }))
      }
    }

    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactVersion={artifactVersion}
        />
      )
    )
    const start = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check reproducibility'
    )
    expect(start?.disabled).toBe(false)
    const checkSurface = container.querySelector('[data-reproducibility-check-state="idle"]')
    expect(checkSurface).not.toBeNull()
    expect(container.querySelector('[data-reproducibility-check-progress-track]')).toBeNull()
    expect(container.querySelector('[data-reproducibility-check-log]')).toBeNull()

    await act(async () => start?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(startReproducibilityCheck).toHaveBeenCalledWith({
      ...artifactVersion,
      frontierId: 'original-inputs',
      comparisonPolicy: DEFAULT_OUTPUT_COMPARISON_POLICY
    })
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    expect(container.textContent).toContain('Loading captured evidence…')
    expect(container.textContent).toContain('Elapsed')
    expect(container.querySelector('[data-reproducibility-check-log]')?.textContent).toContain(
      'Loading captured evidence…'
    )
    expect(container.querySelector('[data-reproducibility-check-state="running"]')).toBe(
      checkSurface
    )
    expect(
      container
        .querySelector('[data-reproducibility-check-stage="loading-evidence"]')
        ?.getAttribute('data-reproducibility-check-stage-state')
    ).toBe('current')
    expect(
      container
        .querySelector('[data-reproducibility-check-stage="loading-evidence"]')
        ?.querySelector('[data-reproducibility-check-stage-marker]')?.className
    ).toContain('bg-primary')
    expect(
      container.querySelector('[data-reproducibility-check-progress-count]')?.textContent
    ).toBe('Step 1 of 5')

    await act(async () =>
      listener?.({
        ...initial,
        startedAt: new Date(Date.now() - 31_000).toISOString(),
        revision: 1,
        phase: 'restoring-environments',
        activeEnvironment: {
          kernelKind: 'python',
          index: 0,
          total: 1,
          stage: 'restoring-packages'
        },
        logs: [
          {
            source: 'environment',
            requirementId: 'environment-lock:python',
            environmentIndex: 0,
            environmentTotal: 1,
            kernelKind: 'python',
            stream: 'stdout',
            text: 'Linking numpy-2.0.0\n',
            recordedAt: '2026-09-04T12:34:56.000Z'
          }
        ]
      })
    )
    expect(container.textContent).toContain('Restoring the Python environment…')
    expect(container.textContent).toContain('Environment 1 of 1')
    expect(
      container.querySelector('[data-reproducibility-check-progress-count]')?.textContent
    ).toBe('Step 3 of 5')
    expect(
      container.querySelector<HTMLElement>('[data-reproducibility-check-rail-progress]')?.style
        .transform
    ).toBe('scaleX(0.5)')
    expect(container.textContent).toContain(
      'The first environment restore may take a few minutes. Cached packages are reused.'
    )
    expect(
      container.querySelector('[data-reproducibility-check-log-entry="environment"]')?.textContent
    ).toContain('Environment 1 of 1·Python·stdoutLinking numpy-2.0.0')
    expect(
      container
        .querySelector('[data-reproducibility-check-log-entry="environment"] time')
        ?.getAttribute('datetime')
    ).toBe('2026-09-04T12:34:56.000Z')

    await act(async () =>
      listener?.({
        ...initial,
        revision: 2,
        phase: 'executing',
        completedSteps: 0,
        logs: [
          {
            source: 'notebook',
            stepId: 'step:run-1',
            runIndex: 0,
            kernelKind: 'python',
            stream: 'stdout',
            text: 'saved result.csv\n'
          },
          {
            source: 'notebook',
            stepId: 'step:run-1',
            runIndex: 0,
            kernelKind: 'python',
            stream: 'stderr',
            text: 'runtime warning\n',
            truncated: true
          }
        ]
      })
    )
    expect(container.textContent).toContain('0 of 1 runs complete')
    const checkLog = container.querySelector('[data-reproducibility-check-log]')
    expect(checkLog?.textContent).toContain('Notebook run 1·Python·stdout')
    expect(checkLog?.textContent).toContain('saved result.csv')
    expect(checkLog?.textContent).toContain('Notebook run 1·Python·stderrOutput truncated')
    expect(checkLog?.textContent).toContain('runtime warning')
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(cancelReproducibilityCheck).toHaveBeenCalledWith({ attemptId: 'attempt-1' })

    await act(async () =>
      listener?.({
        ...initial,
        revision: 3,
        status: 'matched',
        phase: undefined,
        completedSteps: 1,
        logs: [
          {
            source: 'notebook',
            stepId: 'step:run-1',
            runIndex: 0,
            kernelKind: 'python',
            stream: 'stdout',
            text: 'saved result.csv'
          }
        ],
        comparisons: [{ relativePath: 'result.csv', status: 'matched' }]
      })
    )
    const matchedCheck = container.querySelector('[data-reproducibility-check-state="matched"]')
    expect(matchedCheck?.querySelector('#reproducibility-check-title')?.textContent).toBe(
      'Result reproduced'
    )
    expect(matchedCheck?.textContent).toContain('All selected outputs match the captured result.')
    expect(matchedCheck?.querySelector('[data-reproducibility-check-comparisons]')).toBeNull()
    expect(
      matchedCheck?.querySelector<HTMLDetailsElement>('[data-reproducibility-check-log]')?.open
    ).toBe(false)
    expect(matchedCheck?.querySelector('[data-reproducibility-check-log]')?.textContent).toContain(
      'saved result.csv'
    )
    expect(container.textContent).toContain('Check again')
    expect(container.querySelector('[data-reproducibility-check-progress-track]')).toBeNull()
    expect(container.querySelector('fieldset')?.disabled).toBe(false)

    await act(async () =>
      listener?.({
        ...initial,
        revision: 4,
        status: 'different',
        phase: undefined,
        completedSteps: 1,
        comparisons: [
          { relativePath: 'result.csv', status: 'matched' },
          { relativePath: 'changed.csv', status: 'different' }
        ]
      })
    )
    const differentCheck = container.querySelector('[data-reproducibility-check-state="different"]')
    expect(differentCheck?.querySelector('#reproducibility-check-title')?.textContent).toBe(
      'Result differs'
    )
    expect(differentCheck?.textContent).toContain('changed.csv')
    expect(differentCheck?.textContent).not.toContain('result.csv')

    await act(async () =>
      listener?.({
        ...initial,
        revision: 5,
        status: 'failed',
        phase: 'executing'
      })
    )
    expect(container.textContent).toContain('Check stopped')
    expect(container.textContent).toContain(
      'The isolated Notebook run stopped before comparison. The original result was not changed.'
    )
    expect(container.textContent).toContain('Retry check')
    expect(container.textContent).not.toContain('The isolated check could not complete.')
  })

  it('previews a node without file IO and starts the displayed upstream preparation plan once', async () => {
    const value = kernelDependencyProjection()
    value.startFrontiers[0]!.downstreamActivityIds = ['run-1', 'run-2', 'publish-1']
    value.startFrontiers[1]!.downstreamActivityIds = ['run-2', 'publish-1']
    value.startFrontiers[1]!.reasonCodes = ['advisory-boundary']
    value.startFrontiers[1]!.crossingEntityIds = ['input-1']
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    let rejectStart: (reason: Error) => void = () => {}
    const start = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject
        })
    )
    const readPreview = vi.fn()
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: start,
        readPreview,
        cancelReproducibilityCheck: vi.fn(),
        onReproducibilityCheckChanged: () => () => {}
      }
    }
    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={value}
          executionAvailable
          artifactVersion={artifactVersion}
        />
      )
    )
    const node = container.querySelector('[data-graph-node="activity:run-1"]')!
    await act(async () => fireEvent.click(node))
    const button = (name: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((item) => item.textContent === name)!
    await act(async () => fireEvent.click(button('Check from here')))
    const preview = container.querySelector('[data-node-start-preview]')!
    expect(preview.textContent).toContain('Notebook run 2 requires state from Notebook run 1.')
    expect(preview.textContent).toContain('Preparation')
    expect(preview.textContent).toContain('End-to-end claim')
    expect(start).not.toHaveBeenCalled()
    expect(readPreview).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(button('Start check'))
      fireEvent.click(button('Start check'))
    })
    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith({
      ...artifactVersion,
      frontierId: 'original-inputs',
      comparisonPolicy: DEFAULT_OUTPUT_COMPARISON_POLICY
    })
    await act(async () => rejectStart(new Error('failed')))
    expect(preview.querySelector('[role="alert"]')?.textContent).toBe('Check failed')
  })

  it.each(['matched', 'different', 'failed'] as const)(
    'shows the latest %s conclusion above evidence without confusing its scope with the next check',
    async (outcome) => {
      const saved = receipt(outcome === 'different' ? 'different' : 'matched')
      saved.frontier = { frontierId: 'checkpoint:earlier-run', claimScope: 'downstream-only' }
      const failed = {
        schemaVersion: 1,
        attemptId: 'newer-failure',
        startedAt: '2026-09-04T00:00:00Z',
        completedAt: '2026-09-04T00:01:00Z',
        artifactVersion: saved.artifactVersion,
        frontierId: 'original-inputs',
        phase: 'restoring-environments',
        checkLog: { logChecksum: '1'.repeat(64), entryCount: 0, sizeBytes: 0, truncated: false }
      }
      ;(window as unknown as { api: unknown }).api = {
        artifacts: {
          startReproducibilityCheck: vi.fn(),
          cancelReproducibilityCheck: vi.fn(),
          onReproducibilityCheckChanged: vi.fn(() => () => undefined),
          listReproducibilityReceipts: vi.fn(async () => ({
            receipts: [saved],
            latestFailedAttempt: outcome === 'failed' ? failed : undefined
          }))
        }
      }
      await act(async () =>
        root.render(
          <ArtifactReproducibilityPanel
            projection={projection()}
            artifactVersion={saved.artifactVersion}
          />
        )
      )
      const surface = container.querySelector('[data-reproducibility-check-state]')
      expect(surface?.querySelector('#reproducibility-check-title')?.textContent).toBe(
        outcome === 'matched'
          ? 'Result reproduced'
          : outcome === 'different'
            ? 'Result differs'
            : 'Check stopped'
      )
      expect(surface?.querySelector('legend')?.textContent).toContain('Next check')
      expect(surface?.querySelector('[data-start-frontier-summary]')?.textContent).toContain(
        'End-to-end claim'
      )
      expect(
        surface?.querySelector('[data-reproducibility-check-conclusion]')?.textContent
      ).not.toContain('End-to-end claim')
      if (outcome !== 'failed')
        expect(
          surface?.querySelector('[data-reproducibility-check-conclusion]')?.textContent
        ).toContain('Downstream-only claim')
      else expect(surface?.textContent).toContain('Retry check')
      expect(surface?.querySelector('time')?.getAttribute('datetime')).toBe(
        outcome === 'failed' ? failed.completedAt : saved.completedAt
      )
      expect(surface?.querySelector('[data-reproducibility-check-progress-track]')).toBeNull()
      expect(
        container.querySelector<HTMLDetailsElement>('[data-reproducibility-history]')?.open
      ).toBe(false)
    }
  )

  it.each(['check', 'history'] as const)(
    'keeps the action neutral while restoring a checked version (%s resolves first)',
    async (first) => {
      let resolveCheck!: (state: undefined) => void
      let resolveHistory!: (page: { receipts: ArtifactReproducibilityReceipt[] }) => void
      window.api = {
        artifacts: {
          startReproducibilityCheck: vi.fn(),
          cancelReproducibilityCheck: vi.fn(),
          getReproducibilityCheck: vi.fn(
            () =>
              new Promise<undefined>((resolve) => {
                resolveCheck = resolve
              })
          ),
          listReproducibilityReceipts: vi.fn(
            () =>
              new Promise<{ receipts: ArtifactReproducibilityReceipt[] }>((resolve) => {
                resolveHistory = resolve
              })
          ),
          onReproducibilityCheckChanged: vi.fn(() => () => {})
        }
      } as unknown as Window['api']
      const render = async (): Promise<void> => {
        await act(async () =>
          root.render(
            <ArtifactReproducibilityPanel
              projection={projection()}
              artifactVersion={{
                projectId: 'project-1',
                appSessionId: 'session-1',
                artifactId: 'artifact-1',
                versionId: 'version-1'
              }}
            />
          )
        )
      }
      const action = (): HTMLButtonElement | undefined =>
        [...container.querySelectorAll('button')].find((button) =>
          ['Loading…', 'Check reproducibility', 'Check again'].includes(button.textContent ?? '')
        )
      // Repeat after unmount, as switching away from the Provenance tab does.
      for (let visit = 0; visit < 2; visit += 1) {
        await render()
        expect(action()?.dataset.variant).toBe('outline')
        expect(action()?.disabled).toBe(true)
        await act(async () => {
          if (first === 'check') resolveCheck(undefined)
          else resolveHistory({ receipts: [receipt()] })
        })
        expect(action()?.dataset.variant).toBe('outline')
        expect(action()?.disabled).toBe(true)
        await act(async () => {
          if (first === 'check') resolveHistory({ receipts: [receipt()] })
          else resolveCheck(undefined)
        })
        expect(action()?.textContent).toBe('Check again')
        expect(action()?.dataset.variant).toBe('outline')
        expect(action()?.disabled).toBe(false)
        await act(async () => root.render(null))
      }
    }
  )

  it('retries the initial verification history request in place', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValue({ receipts: [receipt()] })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { artifacts: { listReproducibilityReceipts: list } }
    })
    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactVersion={{
            projectId: 'project-1',
            appSessionId: 'session-1',
            artifactId: 'artifact-1',
            versionId: 'version-1'
          }}
        />
      )
    )
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    )
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(list).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Verification history could not be loaded.')
    expect(container.textContent).toContain('Result reproduced')
  })

  it('loads durable verification history and keeps its details collapsed by default', async () => {
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    const history = {
      ...receipt('different'),
      checkLog: {
        logChecksum: '1'.repeat(64),
        entryCount: 1,
        sizeBytes: 256,
        truncated: false
      }
    }
    const getReproducibilityCheckLog = vi.fn(async () => ({
      schemaVersion: 1 as const,
      attemptId: history.receiptId,
      entries: [
        {
          source: 'notebook' as const,
          stepId: 'notebook:run-1',
          runIndex: 0,
          kernelKind: 'python' as const,
          stream: 'stdout' as const,
          text: 'saved result.csv\nsecond line\n',
          recordedAt: '2026-09-04T12:35:56.000Z'
        }
      ],
      truncated: false,
      logChecksum: history.checkLog.logChecksum
    }))
    const exportReproducibilityReceipt = vi.fn(async () => ({ saved: true }))
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: vi.fn(),
        cancelReproducibilityCheck: vi.fn(),
        onReproducibilityCheckChanged: vi.fn(() => () => undefined),
        listReproducibilityReceipts: vi.fn(async () => ({ receipts: [history] })),
        getReproducibilityCheckLog,
        exportReproducibilityReceipt
      }
    }

    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactName="result.csv"
          artifactVersion={artifactVersion}
        />
      )
    )
    await act(async () => undefined)

    const disclosure = container.querySelector<HTMLDetailsElement>('[data-reproducibility-history]')
    expect(container.querySelector('#reproducibility-check-title')?.textContent).toBe(
      'Result differs'
    )
    expect(
      container.querySelector('[data-reproducibility-check-conclusion]')?.textContent
    ).toContain('End-to-end claim')
    expect(
      container
        .querySelector('[data-reproducibility-check-conclusion] time')
        ?.getAttribute('datetime')
    ).toBe(history.completedAt)
    expect(container.querySelector('[data-reproducibility-check-progress-track]')).toBeNull()
    expect(disclosure?.open).toBe(false)
    expect(disclosure?.querySelector('summary')?.textContent).toContain('Verification history1')
    expect(disclosure?.querySelector('summary')?.textContent).not.toContain('Result differs')
    expect(container.textContent).toContain('Check again')

    await act(async () => {
      if (disclosure) disclosure.open = true
    })
    expect(container.textContent).toContain('1 run')
    expect(container.textContent).toContain('1 output comparison')
    expect(container.textContent).toContain('result.csv')
    const logDisclosure = container.querySelector<HTMLDetailsElement>(
      '[data-reproducibility-history-entry="different"]'
    )
    expect(logDisclosure?.querySelector(':scope > summary')?.textContent).toContain('View details')
    await act(async () => {
      if (logDisclosure) {
        logDisclosure.open = true
        logDisclosure.dispatchEvent(new Event('toggle', { bubbles: true }))
      }
    })
    expect(getReproducibilityCheckLog).toHaveBeenCalledWith({
      ...artifactVersion,
      receiptChecksum: history.receiptChecksum
    })
    expect(container.textContent).toContain('saved result.csv')
    expect(logDisclosure?.querySelector('pre')?.textContent).toBe('saved result.csv\nsecond line\n')
    expect(logDisclosure?.querySelector('pre')?.classList.contains('whitespace-pre-wrap')).toBe(
      true
    )
    expect(logDisclosure?.querySelector('time[datetime="2026-09-04T12:35:56.000Z"]')).not.toBeNull()
    const exportButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export verification record"]'
    )
    await act(async () => exportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(exportReproducibilityReceipt).toHaveBeenCalledWith({
      ...artifactVersion,
      receiptChecksum: history.receiptChecksum,
      suggestedName: 'result.csv'
    })
  })

  it('loads older verification receipts on demand', async () => {
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    const latest = receipt()
    const older = {
      ...receipt('different'),
      receiptId: 'attempt-0',
      completedAt: '2026-09-01T00:01:00.000Z',
      receiptChecksum: 'e'.repeat(64)
    }
    const listReproducibilityReceipts = vi.fn(async (request: { cursor?: string }) =>
      request.cursor
        ? { receipts: [older] }
        : { receipts: [latest], nextCursor: latest.receiptChecksum }
    )
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: vi.fn(),
        cancelReproducibilityCheck: vi.fn(),
        onReproducibilityCheckChanged: vi.fn(() => () => undefined),
        listReproducibilityReceipts
      }
    }

    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactVersion={artifactVersion}
        />
      )
    )
    await act(async () => undefined)
    expect(
      container.querySelector('[data-reproducibility-history] summary')?.textContent
    ).toContain('Verification history1+')

    const loadMore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more'
    )
    await act(async () => loadMore?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(listReproducibilityReceipts).toHaveBeenLastCalledWith({
      ...artifactVersion,
      cursor: latest.receiptChecksum
    })
    expect(
      container.querySelector('[data-reproducibility-history] summary')?.textContent
    ).toContain('Verification history2')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Load more')
    ).toBe(false)
  })

  it('keeps the latest failed attempt diagnostic available without calling it reproduced', async () => {
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    const latestFailedAttempt = {
      schemaVersion: 1 as const,
      attemptId: 'attempt-failed',
      startedAt: '2026-09-02T00:02:00.000Z',
      completedAt: '2026-09-02T00:03:00.000Z',
      artifactVersion,
      frontierId: 'original-inputs',
      phase: 'restoring-environments' as const,
      checkLog: {
        logChecksum: '2'.repeat(64),
        entryCount: 1,
        sizeBytes: 128,
        truncated: false
      }
    }
    const getReproducibilityCheckLog = vi.fn(async () => ({
      schemaVersion: 1 as const,
      attemptId: latestFailedAttempt.attemptId,
      entries: [
        {
          source: 'environment' as const,
          requirementId: 'python:analysis',
          environmentIndex: 0,
          environmentTotal: 1,
          kernelKind: 'python' as const,
          stream: 'stderr' as const,
          text: 'package restore stopped\n'
        }
      ],
      truncated: false,
      logChecksum: latestFailedAttempt.checkLog.logChecksum
    }))
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: vi.fn(),
        cancelReproducibilityCheck: vi.fn(),
        onReproducibilityCheckChanged: vi.fn(() => () => undefined),
        listReproducibilityReceipts: vi.fn(async () => ({
          receipts: [],
          latestFailedAttempt
        })),
        getReproducibilityCheckLog
      }
    }

    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactVersion={artifactVersion}
        />
      )
    )
    await act(async () => undefined)

    const history = container.querySelector<HTMLDetailsElement>('[data-reproducibility-history]')
    expect(history?.querySelector('summary')?.textContent).toContain('Verification history1')
    expect(history?.querySelector('summary')?.textContent).not.toContain('Check failed')
    expect(history?.querySelector('summary')?.textContent).not.toContain('Result reproduced')

    const logDisclosure = container.querySelector<HTMLDetailsElement>(
      '[data-reproducibility-history-entry="failed"]'
    )
    expect(logDisclosure?.querySelector(':scope > summary')?.textContent).toContain('View log')
    await act(async () => {
      if (logDisclosure) {
        logDisclosure.open = true
        logDisclosure.dispatchEvent(new Event('toggle', { bubbles: true }))
      }
    })
    expect(getReproducibilityCheckLog).toHaveBeenCalledWith({
      ...artifactVersion,
      attemptId: latestFailedAttempt.attemptId
    })
    expect(container.textContent).toContain('package restore stopped')
  })

  it('keeps receipt history unchanged when verification record export fails', async () => {
    const artifactVersion = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    const history = receipt()
    ;(window as unknown as { api: unknown }).api = {
      artifacts: {
        startReproducibilityCheck: vi.fn(),
        cancelReproducibilityCheck: vi.fn(),
        onReproducibilityCheckChanged: vi.fn(() => () => undefined),
        listReproducibilityReceipts: vi.fn(async () => ({ receipts: [history] })),
        exportReproducibilityReceipt: vi.fn(async () => {
          throw new Error('private destination')
        })
      }
    }

    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel
          projection={projection()}
          executionAvailable
          artifactName="result.csv"
          artifactVersion={artifactVersion}
        />
      )
    )
    await act(async () => undefined)
    const receiptDetails = container.querySelector<HTMLDetailsElement>(
      '[data-reproducibility-history-entry="matched"]'
    )
    expect(
      receiptDetails?.querySelector('[data-verification-result-icon="matched"]')?.className
    ).toContain('bg-bg-200')
    expect(
      receiptDetails?.querySelector('[data-verification-result-icon="matched"]')?.className
    ).toContain('text-primary')
    await act(async () => {
      if (receiptDetails) receiptDetails.open = true
    })
    const exportButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Export verification record"]'
    )
    await act(async () => exportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.textContent).toContain('Verification record could not be exported.')
    expect(container.textContent).toContain('Result reproduced')
  })

  it('keeps portaled help above the preview modal', async () => {
    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel projection={projection()} tooltipClassName="z-[70]" />
      )
    )

    const help = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview a safe starting point. No files or results will be changed."]'
    )
    await act(async () => help?.focus())

    expect(
      document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]')?.className
    ).toContain('z-[70]')
  })

  it('keeps capture limitations behind the status explanation', async () => {
    const value = projection()
    value.completeness = 'incomplete'
    value.reasonCodes = [
      'activity-evidence-partial',
      'file-reads-unavailable',
      'kernel-epoch-conservative'
    ]

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))

    const status = container.querySelector<HTMLButtonElement>('[aria-label^="Incomplete capture:"]')
    expect(status?.textContent).toBe('Incomplete capture3')
    expect(status?.getAttribute('aria-label')).toBe(
      'Incomplete capture: Execution record, File lineage, Notebook state'
    )
    expect(container.textContent).not.toContain('Activity file evidence is incomplete.')
    expect(container.textContent).not.toContain('This result has not been checked again yet.')
  })

  it('lifts comparison help and scientific menus above the Preview dialog', async () => {
    await act(async () =>
      root.render(
        <ArtifactReproducibilityPanel projection={projection()} tooltipClassName="z-[70]" />
      )
    )
    const help = container.querySelector<HTMLButtonElement>('[data-slot="field-help"]')!
    await act(async () => help.focus())
    expect(document.querySelector('[data-slot="tooltip-content"]')?.className).toContain('z-[70]')
    await act(async () => {
      fireEvent.keyDown(help, { key: 'Escape' })
      help.blur()
    })
    const select = container.querySelector('[data-slot="select-trigger"]')!
    await act(async () => fireEvent.keyDown(select, { key: 'ArrowDown' }))
    expect(document.querySelector('[data-slot="select-content"]')?.className).toContain('z-[70]')
  })

  it('uses one fitted graph surface and moves activity detail into the node inspector', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

    const graph = container.querySelector('svg[role="group"]')
    expect(graph?.getAttribute('width')).toBeNull()
    expect(graph?.getAttribute('height')).toBeNull()
    const lineageSummary = container.querySelector('[data-dependency-lineage-summary]')
    expect(lineageSummary?.classList.contains('sr-only')).toBe(true)
    expect(lineageSummary?.textContent).toContain('Captured input: source.csv')
    expect(lineageSummary?.textContent).toContain('source.csv → Notebook run 1 (Confirmed)')

    const activity = container.querySelector<SVGGElement>('[data-graph-node="activity:run-1"]')
    expect(activity?.getAttribute('tabindex')).toBe('0')
    await act(async () => activity?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.textContent).toContain('Inputs')
    expect(container.textContent).toContain('source.csv')
    expect(container.textContent).toContain('Outputs')
    expect(container.textContent).toContain('private-result.csv')
    expect(activity?.getAttribute('aria-pressed')).toBe('true')
  })

  it('renders workflow-style nodes and opens details only after selection', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

    const edge = container.querySelector<SVGPathElement>('[data-graph-edge]')
    const activity = container.querySelector('[data-graph-node="activity:run-1"]')

    expect(container.querySelector('pattern[id$="-grid"]')).not.toBeNull()
    const evidenceLegend = container.querySelector('[data-dependency-evidence-legend]')
    const dependencyHeader = container.querySelector('[data-dependency-header]')
    expect(evidenceLegend?.textContent).toBe('ConfirmedInferred')
    expect(evidenceLegend?.getAttribute('aria-label')).toBe('Dependency evidence')
    expect(container.querySelector('[data-dependency-toolbar]')?.contains(evidenceLegend)).toBe(
      true
    )
    expect(evidenceLegend?.classList.contains('flex-wrap')).toBe(true)
    expect(dependencyHeader?.textContent).toContain('Select a node to view details.')
    expect(edge?.getAttribute('d')).toContain(' C ')
    expect(activity?.querySelector('.lucide-book-open')).not.toBeNull()
    expect(activity?.querySelectorAll('circle').length).toBeGreaterThan(0)
    expect(container.querySelector('[data-dependency-inspector]')).toBeNull()

    await act(async () => activity?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('[data-dependency-inspector="selected-node"]')).not.toBeNull()
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close details"]')
    await act(async () => close?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelector('[data-dependency-inspector]')).toBeNull()
  })

  it('places graph ports on the left and right for a horizontal path', async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1400
    })
    try {
      await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

      const activity = container.querySelector('[data-graph-node="activity:run-1"]')
      const incoming = activity?.querySelector('[data-graph-port="incoming"]')
      const outgoing = activity?.querySelector('[data-graph-port="outgoing"]')

      expect(incoming?.getAttribute('cx')).toBe('0')
      expect(incoming?.getAttribute('cy')).toBe(String(dependencyGraph.NODE_HEIGHT / 2))
      expect(outgoing?.getAttribute('cx')).toBe(String(dependencyGraph.NODE_WIDTH))
      expect(outgoing?.getAttribute('cy')).toBe(String(dependencyGraph.NODE_HEIGHT / 2))
    } finally {
      if (clientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      } else {
        delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      }
    }
  })

  it('uses the full canvas until a node is selected', async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1400
    })
    try {
      await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

      const graph = container.querySelector('svg[role="group"]')
      expect(Number(graph?.getAttribute('data-graph-viewport-width'))).toBeGreaterThan(
        Number(graph?.getAttribute('data-graph-content-width'))
      )
      expect(Number(graph?.getAttribute('data-graph-canvas-height'))).toBe(168)
      const canvasFrame = container.querySelector('[data-dependency-canvas-frame]')
      expect(canvasFrame?.classList.contains('grid')).toBe(false)
      expect(container.querySelector('[data-dependency-inspector]')).toBeNull()

      const target = container.querySelector(
        '[data-graph-node="entity:artifact-version:version-1"]'
      )
      await act(async () => target?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const inspector = container.querySelector('[data-dependency-inspector="selected-node"]')
      expect(inspector?.classList.contains('absolute')).toBe(false)
      expect(inspector?.classList.contains('border-t')).toBe(true)
      expect(canvasFrame?.classList.contains('grid')).toBe(false)
    } finally {
      if (clientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      } else {
        delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      }
    }
  })

  it('lays out independent activities as a branched DAG instead of a single line', async () => {
    await act(async () =>
      root.render(<ArtifactReproducibilityPanel projection={branchedProjection()} />)
    )

    const firstRun = container.querySelector('[data-graph-node="activity:run-1"]')
    const secondRun = container.querySelector('[data-graph-node="activity:run-2"]')
    expect(firstRun?.getAttribute('transform')).not.toBe(secondRun?.getAttribute('transform'))
    expect(container.querySelectorAll('[data-graph-node]').length).toBe(6)
  })

  it('hides the view switch when the capture has no additional visible nodes', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

    expect(container.querySelector('[data-graph-view]')).toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-1"]')).not.toBeNull()
  })

  it('shows only the target lineage by default and counts the extra nodes in full capture', async () => {
    await act(async () =>
      root.render(<ArtifactReproducibilityPanel projection={conservativeBranchProjection()} />)
    )

    expect(container.querySelector('[data-graph-node="activity:run-1"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-2"]')).toBeNull()

    const fullCapture = container.querySelector<HTMLButtonElement>('[data-graph-view="full"]')
    expect(fullCapture?.textContent).toBe('Full capture+1')
    expect(fullCapture?.getAttribute('aria-label')).toBe('Full capture, 1 additional node')
    await act(async () => fullCapture?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('[data-graph-node="activity:run-2"]')).not.toBeNull()
    expect(fullCapture?.getAttribute('aria-pressed')).toBe('true')
    expect(fullCapture?.textContent).toBe('Full capture+1')

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))
    expect(container.querySelector('[data-graph-view]')).toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-2"]')).toBeNull()
  })

  it('omits activities with no dependency edges from the full capture graph', async () => {
    const value = projection()
    value.activities.splice(1, 0, {
      activityId: 'run-isolated',
      kind: 'notebook-run',
      sequence: 1,
      runIndex: 1,
      inclusion: 'kernel-epoch-conservative',
      evidenceState: 'partial'
    })
    value.activities[2]!.sequence = 2
    value.executionRunCount = 3
    value.includedNotebookRunCount = 2

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))
    expect(container.querySelector('[data-graph-view]')).toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-1"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-isolated"]')).toBeNull()
  })

  it('keeps long file paths inside fixed-width node label slots', async () => {
    const value = projection()
    const generatedFile = value.entities.find((entity) => entity.entityId === 'file-1')
    if (generatedFile) {
      generatedFile.label =
        '/very/long/intermediate/results/folder/a-result-file-name-that-does-not-fit.csv'
    }

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))

    const node = container.querySelector('[data-graph-node="entity:file-1"]')
    const primary = node?.querySelector<HTMLElement>('[data-graph-node-label-primary]')

    expect(node?.querySelector('[data-graph-node-label-context]')).toBeNull()
    expect(primary?.textContent).toBe('a-result-file-name-that-does-not-fit.csv')
    expect(primary?.classList.contains('truncate')).toBe(true)
    expect(node?.getAttribute('aria-label')).toContain(generatedFile?.label)

    await act(async () => node?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('/very/long/intermediate/results/folder/')
    expect(container.textContent).toContain('Published asresult.csv')
    expect(container.textContent).not.toContain('Used byresult.csv')
  })

  it('centers the type icon independently from the node text', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

    const node = container.querySelector('[data-graph-node="entity:file-1"]')
    const icon = node?.querySelector('[data-graph-node-icon]')

    expect(icon?.getAttribute('transform')).toBe(
      `translate(${dependencyGraph.NODE_ICON_X} ${dependencyGraph.NODE_ICON_Y})`
    )
  })

  it('mutes branches outside the hovered Artifact lineage in the full capture', async () => {
    await act(async () =>
      root.render(<ArtifactReproducibilityPanel projection={conservativeBranchProjection()} />)
    )
    const fullCapture = container.querySelector<HTMLButtonElement>('[data-graph-view="full"]')
    await act(async () => fullCapture?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const target = container.querySelector('[data-graph-node="entity:artifact-version:version-1"]')
    const unrelated = container.querySelector('[data-graph-node="activity:run-2"]')
    expect(unrelated?.getAttribute('opacity')).toBe('1')

    await act(async () => target?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))

    expect(unrelated?.getAttribute('opacity')).toBe('0.16')
    expect(target?.getAttribute('opacity')).toBe('1')
  })

  it('renders an exact Cell-to-Cell kernel dependency as a directed graph edge', async () => {
    await act(async () =>
      root.render(<ArtifactReproducibilityPanel projection={kernelDependencyProjection()} />)
    )

    expect(
      container.querySelector('[data-graph-edge="activity:run-1->activity:run-2:depends-on"]')
    ).not.toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-1"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="activity:run-2"]')).not.toBeNull()
  })

  it('switches the graph to a readable vertical path in a narrow container', async () => {
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 375
    })
    try {
      await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))

      const firstRun = container.querySelector('[data-graph-node="activity:run-1"]')
      const target = container.querySelector(
        '[data-graph-node="entity:artifact-version:version-1"]'
      )
      const incoming = firstRun?.querySelector('[data-graph-port="incoming"]')
      const outgoing = firstRun?.querySelector('[data-graph-port="outgoing"]')
      expect(firstRun?.getAttribute('transform')?.split(' ')[0]).toBe(
        target?.getAttribute('transform')?.split(' ')[0]
      )
      expect(firstRun?.getAttribute('transform')).not.toBe(target?.getAttribute('transform'))
      expect(incoming?.getAttribute('cx')).toBe(String(dependencyGraph.NODE_WIDTH / 2))
      expect(incoming?.getAttribute('cy')).toBe('0')
      expect(outgoing?.getAttribute('cx')).toBe(String(dependencyGraph.NODE_WIDTH / 2))
      expect(outgoing?.getAttribute('cy')).toBe(String(dependencyGraph.NODE_HEIGHT))
    } finally {
      if (clientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      } else {
        delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      }
    }
  })

  it.each([320, 375, 414, 560, 768, 1180])(
    'fits a short path without inflating its nodes at width %i',
    async (width) => {
      const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get: () => width
      })
      try {
        const value = projection()
        value.entities = value.entities.filter((entity) => entity.entityId !== 'input-1')
        value.edges = value.edges.filter(
          (edge) => !('entityId' in edge) || edge.entityId !== 'input-1'
        )
        await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))
        const graph = container.querySelector('svg[role="group"]')!
        const [, , viewportWidth, viewportHeight] = graph
          .getAttribute('viewBox')!
          .split(' ')
          .map(Number)
        const height = Number(graph.getAttribute('data-graph-canvas-height'))
        expect(Math.min((width - 40) / viewportWidth, height / viewportHeight)).toBeLessThanOrEqual(
          1
        )
        expect(height).toBeLessThanOrEqual(300)
        expect(container.querySelectorAll('[data-graph-node]')).toHaveLength(3)
        expect(container.querySelector('[data-graph-publication-boundary]')?.textContent).toBe(
          'Published as'
        )
      } finally {
        if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
        else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      }
    }
  )

  it('opens node details with the keyboard and returns focus on Escape', async () => {
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={projection()} />))
    const activity = container.querySelector<SVGGElement>('[data-graph-node="activity:run-1"]')!
    await act(async () => {
      activity.focus()
      fireEvent.keyDown(activity, { key: 'Enter' })
    })
    const inspector = container.querySelector('[data-dependency-inspector]')!
    expect(inspector).not.toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close details')
    const close = inspector.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!
    await act(async () => {
      close.focus()
      fireEvent.keyDown(close, { key: 'Escape' })
    })
    expect(container.querySelector('[data-dependency-inspector]')).toBeNull()
    expect(document.activeElement).toBe(activity)
    expect(activity.getAttribute('aria-pressed')).toBe('false')
  })

  it('dims upstream nodes when an available downstream checkpoint is selected', async () => {
    const value = projection()
    value.activities.splice(1, 0, {
      activityId: 'run-2',
      kind: 'notebook-run',
      sequence: 1,
      runIndex: 1,
      inclusion: 'target-closure',
      evidenceState: 'available'
    })
    value.activities[2].sequence = 2
    const checkpoint = value.startFrontiers[1]
    checkpoint.eligibility = 'available'
    checkpoint.downstreamActivityIds = ['run-2', 'publish-1']
    checkpoint.reasonCodes = []
    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))

    const selector = container.querySelector<HTMLButtonElement>('[data-start-frontier-selector]')!
    expect(selector.getAttribute('data-slot')).toBe('select-trigger')
    await act(async () => fireEvent.keyDown(selector, { key: 'ArrowDown' }))
    await act(async () =>
      fireEvent.click(within(document.body).getByRole('option', { name: /After Notebook run 1/ }))
    )

    expect(
      container.querySelector('[data-graph-node="activity:run-1"]')?.getAttribute('opacity')
    ).toBe('0.34')
    expect(
      container
        .querySelector('[data-graph-node="entity:artifact-version:version-1"]')
        ?.getAttribute('opacity')
    ).toBe('1')
  })

  it('compacts a long frontier list into safe executable choices', async () => {
    const value = projection()
    value.activities.splice(1, 0, {
      activityId: 'run-2',
      kind: 'notebook-run',
      sequence: 1,
      runIndex: 1,
      inclusion: 'target-closure',
      evidenceState: 'available'
    })
    value.activities[2].sequence = 2
    value.startFrontiers = [
      {
        ...value.startFrontiers[0],
        downstreamActivityIds: ['run-1', 'run-2', 'publish-1']
      },
      {
        frontierId: 'checkpoint:run-1',
        kind: 'checkpoint',
        claimScope: 'downstream-only',
        eligibility: 'available',
        afterActivityId: 'run-1',
        crossingEntityIds: ['file-1'],
        downstreamActivityIds: ['run-2', 'publish-1'],
        reasonCodes: []
      },
      {
        frontierId: 'checkpoint:run-2',
        kind: 'checkpoint',
        claimScope: 'downstream-only',
        eligibility: 'available',
        afterActivityId: 'run-2',
        crossingEntityIds: ['file-1'],
        downstreamActivityIds: ['publish-1'],
        reasonCodes: []
      }
    ]

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))

    await act(async () =>
      fireEvent.keyDown(container.querySelector('[data-start-frontier-selector]')!, {
        key: 'ArrowDown'
      })
    )
    const options = within(document.body).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Original captured inputs · Runs to execute: 2',
      'After Notebook run 1 · Runs to execute: 1'
    ])
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('After Notebook run 2')
  })

  it('numbers Compute jobs independently from preceding Notebook runs', async () => {
    const value = projection()
    value.activities.splice(1, 0, {
      activityId: 'compute-1',
      kind: 'compute-job',
      sequence: 1,
      inclusion: 'target-closure',
      evidenceState: 'available'
    })
    value.activities[2].sequence = 2
    value.edges.push({
      kind: 'depends-on',
      activityId: 'compute-1',
      dependencyActivityId: 'run-1',
      authority: 'authoritative',
      evidenceSource: 'dependency-analysis'
    })

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))
    const fullCapture = container.querySelector<HTMLButtonElement>('[data-graph-view="full"]')
    await act(async () => fullCapture?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.textContent).toContain('Compute job 1')
    expect(container.textContent).not.toContain('Compute job 2')
  })

  it('collapses logical outputs by default and expands their authoritative member files', async () => {
    const value = projection()
    value.entities.splice(
      2,
      0,
      {
        entityId: 'zarr-metadata',
        kind: 'file-generation',
        label: 'results/model.zarr/.zgroup',
        checksum: 'd'.repeat(64),
        sizeBytes: 12,
        pathPortability: 'relative'
      },
      {
        entityId: 'zarr-chunk',
        kind: 'file-generation',
        label: 'results/model.zarr/0.0',
        checksum: 'e'.repeat(64),
        sizeBytes: 24,
        pathPortability: 'relative'
      }
    )
    value.edges.splice(
      2,
      0,
      {
        kind: 'generated',
        activityId: 'run-1',
        entityId: 'zarr-metadata',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      },
      {
        kind: 'generated',
        activityId: 'run-1',
        entityId: 'zarr-chunk',
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      }
    )
    value.outputGroups = [
      {
        outputId: 'zarr-output',
        activityId: 'run-1',
        label: 'results/model.zarr',
        storageShape: 'directory-tree',
        memberEntityIds: ['zarr-chunk', 'zarr-metadata'],
        riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
      }
    ]

    await act(async () => root.render(<ArtifactReproducibilityPanel projection={value} />))
    const fullCapture = container.querySelector<HTMLButtonElement>('[data-graph-view="full"]')
    await act(async () => fullCapture?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('[data-graph-node="output-group:zarr-output"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="entity:zarr-metadata"]')).toBeNull()
    const group = container.querySelector<SVGGElement>(
      '[data-graph-node="output-group:zarr-output"]'
    )
    await act(async () => group?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Directory tree')
    expect(container.textContent).toContain('File-level provenance remains authoritative.')
    expect(container.textContent).toContain(
      'Consistency across member files has not been verified.'
    )

    const expand = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Expand files'
    )
    await act(async () => expand?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('[data-graph-node="entity:zarr-metadata"]')).not.toBeNull()
    expect(container.querySelector('[data-graph-node="entity:zarr-chunk"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-graph-relation="contains"]')).toHaveLength(2)
    expect(container.textContent).toContain('Collapse files')
  })
})

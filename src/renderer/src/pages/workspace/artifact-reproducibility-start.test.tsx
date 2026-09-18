// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactReproducibilityProjection } from '../../../../shared/artifact-provenance'
import { previewNodeStart, type NodeStartPreview } from './artifact-reproducibility-start'
import { ReproducibilityStartPreview } from './ReproducibilityStartPreview'
import { PreviewProvenanceSplit } from './PreviewProvenanceSplit'

const fixture = (): ArtifactReproducibilityProjection => ({
  completeness: 'complete',
  reasonCodes: [],
  targetEntityId: 'result',
  outputGroups: [],
  executionRunCount: 3,
  includedNotebookRunCount: 3,
  skippedRunCount: 0,
  activities: [0, 1, 2].map((sequence) => ({
    activityId: `run-${sequence}`,
    kind: 'notebook-run',
    sequence,
    runIndex: sequence,
    inclusion: 'target-closure',
    evidenceState: 'available'
  })),
  entities: ['input', 'middle', 'result'].map((id, index) => ({
    entityId: id,
    kind: index ? 'file-generation' : 'registered-input-generation',
    label: `${id}.h5ad`,
    checksum: id,
    sizeBytes: 100 * 1024 ** 3
  })),
  edges: [
    {
      kind: 'generated',
      activityId: 'run-0',
      entityId: 'middle',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'generated',
      activityId: 'run-2',
      entityId: 'result',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    },
    {
      kind: 'depends-on',
      activityId: 'run-2',
      dependencyActivityId: 'run-1',
      authority: 'authoritative',
      evidenceSource: 'dependency-analysis'
    }
  ],
  startFrontiers: [
    {
      frontierId: 'original',
      kind: 'original-inputs',
      claimScope: 'end-to-end',
      eligibility: 'available',
      crossingEntityIds: ['input'],
      downstreamActivityIds: ['run-0', 'run-1', 'run-2'],
      reasonCodes: []
    },
    {
      frontierId: 'after-0',
      kind: 'checkpoint',
      afterActivityId: 'run-0',
      claimScope: 'downstream-only',
      eligibility: 'available',
      crossingEntityIds: ['middle'],
      downstreamActivityIds: ['run-1', 'run-2'],
      reasonCodes: []
    },
    {
      frontierId: 'after-1',
      kind: 'checkpoint',
      afterActivityId: 'run-1',
      claimScope: 'downstream-only',
      eligibility: 'blocked',
      crossingEntityIds: ['middle'],
      downstreamActivityIds: ['run-2'],
      reasonCodes: ['advisory-boundary']
    },
    {
      frontierId: 'after-2',
      kind: 'checkpoint',
      afterActivityId: 'run-2',
      claimScope: 'downstream-only',
      eligibility: 'blocked',
      crossingEntityIds: ['result'],
      downstreamActivityIds: [],
      reasonCodes: []
    }
  ]
})

const activityPreview = (
  value: ArtifactReproducibilityProjection,
  index: number
): NodeStartPreview =>
  previewNodeStart(value, {
    key: `activity:run-${index}`,
    kind: 'activity',
    value: value.activities[index]!
  })

afterEach(cleanup)

describe('metadata-only node starts', () => {
  it('restores the intermediate file and executes only downstream runs', () => {
    const value = fixture()
    const preview = previewNodeStart(value, {
      key: 'entity:middle',
      kind: 'entity',
      value: value.entities[1]!
    })
    expect(preview.effective?.frontierId).toBe('after-0')
    expect(preview.steps.map((step) => step.activityId)).toEqual(['run-1', 'run-2'])
    expect(preview.files.map((file) => file.label)).toEqual(['middle.h5ad'])
    expect(preview.needsPreparation).toBe(false)
  })

  it('selects the nearest sealed earlier plan and explicitly includes prerequisite runs', () => {
    const preview = activityPreview(fixture(), 1)
    expect(preview.requested?.frontierId).toBe('after-1')
    expect(preview.effective?.frontierId).toBe('after-0')
    expect(
      preview.dependencies.map((edge) => [edge.from?.activityId, edge.to?.activityId])
    ).toEqual([['run-1', 'run-2']])
    expect([...preview.preparationIds]).toEqual(['run-1'])
    expect(preview.steps.map((step) => step.activityId)).toEqual(['run-1', 'run-2'])
  })

  it('falls back to original inputs with an end-to-end scope only when necessary', () => {
    const value = fixture()
    value.startFrontiers[1]!.eligibility = 'blocked'
    const preview = activityPreview(value, 1)
    expect(preview.effective?.claimScope).toBe('end-to-end')
    expect([...preview.preparationIds]).toEqual(['run-0', 'run-1'])
    expect(preview.files[0]?.label).toBe('input.h5ad')
  })

  it('keeps unavailable memory boundaries blocked when no saved plan can prepare them', () => {
    const value = fixture()
    value.startFrontiers.forEach((frontier) => {
      frontier.eligibility = 'blocked'
    })
    expect(activityPreview(value, 1).effective).toBeUndefined()
    expect(activityPreview(value, 1).dependencies).toHaveLength(1)
  })

  it('does not present a frozen final output as a runnable check', () => {
    const preview = activityPreview(fixture(), 2)
    expect(preview.noDownstream).toBe(true)
    expect(preview.effective).toBeUndefined()
  })

  it('rejects ambiguous producers and files that are not part of the boundary', () => {
    const value = fixture()
    value.edges.push({
      kind: 'generated',
      activityId: 'run-1',
      entityId: 'middle',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    })
    expect(
      previewNodeStart(value, { key: 'middle', kind: 'entity', value: value.entities[1]! })
        .requested
    ).toBeUndefined()
    value.edges.pop()
    value.startFrontiers[1]!.crossingEntityIds = []
    expect(
      previewNodeStart(value, { key: 'middle', kind: 'entity', value: value.entities[1]! })
        .requested
    ).toBeUndefined()
  })

  it.each(['file', 'run'])('does not enable a plan with missing %s metadata', (kind) => {
    const value = fixture()
    value.startFrontiers[0]!.eligibility = 'blocked'
    if (kind === 'file') value.startFrontiers[1]!.crossingEntityIds.push('lost-file')
    else value.startFrontiers[1]!.downstreamActivityIds.push('lost-run')
    const preview = activityPreview(value, 0)
    expect(preview.effective).toBeUndefined()
    expect(kind === 'file' ? preview.missingFileMetadata : preview.missingRunMetadata).toBe(true)
  })

  it('identifies unavailable file names from saved plan metadata', () => {
    const value = fixture()
    value.startFrontiers[0]!.eligibility = 'blocked'
    value.startFrontiers[1]!.unavailableEntityIds = ['middle']
    const preview = activityPreview(value, 0)
    expect(preview.effective).toBeUndefined()
    expect(preview.unavailableFiles.map((file) => file.label)).toEqual(['middle.h5ad'])
  })

  it('previews a 100 GB file without starting work, then submits the displayed effective plan', () => {
    const onStart = vi.fn(async () => {})
    render(
      <ReproducibilityStartPreview
        preview={activityPreview(fixture(), 1)}
        activityLabel={(step) => step.activityId}
        frontierLabel={(frontier) => frontier.frontierId}
        issues={[]}
        busy={false}
        onStart={onStart}
      />
    )
    expect(screen.queryByText('Files to restore', { exact: false })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check from here' }))
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getByText('middle.h5ad')).toBeTruthy()
    expect(screen.getByText('run-2 requires state from run-1.')).toBeTruthy()
    expect(screen.getByText('Preparation')).toBeTruthy()
    const steps = screen.getAllByRole('list').find((list) => list.tagName === 'OL')!
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['run-1Preparation', 'run-2'])
    fireEvent.click(screen.getByRole('button', { name: 'Start check' }))
    expect(onStart).toHaveBeenCalledWith('after-0')
  })

  it('shows the unavailable file and disables execution', () => {
    const value = fixture()
    value.startFrontiers[0]!.eligibility = 'blocked'
    value.startFrontiers[1]!.unavailableEntityIds = ['middle']
    const onStart = vi.fn(async () => {})
    render(
      <ReproducibilityStartPreview
        preview={activityPreview(value, 0)}
        activityLabel={(step) => step.activityId}
        frontierLabel={(frontier) => frontier.frontierId}
        issues={[]}
        busy={false}
        onStart={onStart}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check from here' }))
    expect(
      screen.getByText('Some required files cannot be restored safely.').parentElement?.textContent
    ).toContain('middle.h5ad')
    fireEvent.click(screen.getByRole('button', { name: 'Start check' }))
    expect(onStart).not.toHaveBeenCalled()
  })
})

it('preserves the preview content-region target with the real resizable component', () => {
  render(
    <PreviewProvenanceSplit mode="content" provenance={null}>
      <span>Preview content</span>
    </PreviewProvenanceSplit>
  )
  expect(
    within(screen.getByTestId('preview-file-content-region')).getByText('Preview content')
  ).toBeTruthy()
})

it.each(['content', 'split', 'provenance'] as const)(
  'distinguishes the preview divider from the workspace divider in %s mode',
  (mode) => {
    const { container } = render(
      <>
        <div role="separator" aria-label="Resize right panel" />
        <PreviewProvenanceSplit mode={mode} provenance={<span>Provenance</span>}>
          <span>Preview content</span>
        </PreviewProvenanceSplit>
      </>
    )
    // Include hidden handles, as the workspace modal-isolation E2E does.
    expect(
      container.querySelectorAll('[role="separator"][aria-label="Resize right panel"]')
    ).toHaveLength(1)
    expect(
      within(screen.getByTestId('preview-file-content-region'))
        .getByRole('separator', { hidden: true })
        .getAttribute('aria-label')
    ).toBe('Resize provenance panel')
  }
)

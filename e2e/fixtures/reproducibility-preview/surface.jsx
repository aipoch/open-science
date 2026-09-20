import { forwardRef, useImperativeHandle } from 'react'
import { ArtifactReproducibilityPanel } from '../../../src/renderer/src/pages/workspace/ArtifactReproducibilityPanel'

// Only the file/backend boundary is replaced. The dialog, focus scope, panel, form,
// tooltips, selects and CSS are production components; no scientific files are read.
const projection = {
  completeness: 'complete',
  reasonCodes: [],
  targetEntityId: 'output',
  activities: [1, 2].map((n) => ({
    activityId: `run-${n}`,
    kind: 'notebook-run',
    sequence: n - 1,
    runIndex: n - 1,
    inclusion: 'target-closure',
    evidenceState: 'available'
  })),
  entities: [
    {
      entityId: 'output',
      kind: 'artifact-version',
      label: 'result.csv',
      checksum: 'a'.repeat(64),
      sizeBytes: 20
    }
  ],
  edges: [
    {
      kind: 'generated',
      activityId: 'run-2',
      entityId: 'output',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    }
  ],
  outputGroups: [],
  startFrontiers: [
    {
      frontierId: 'original-inputs',
      kind: 'original-inputs',
      claimScope: 'end-to-end',
      eligibility: 'available',
      crossingEntityIds: [],
      downstreamActivityIds: ['run-1', 'run-2'],
      reasonCodes: []
    },
    {
      frontierId: 'checkpoint:run-1',
      kind: 'checkpoint',
      claimScope: 'downstream-only',
      eligibility: 'available',
      afterActivityId: 'run-1',
      crossingEntityIds: [],
      downstreamActivityIds: ['run-2'],
      reasonCodes: []
    }
  ],
  executionRunCount: 2,
  includedNotebookRunCount: 2,
  skippedRunCount: 0
}

const scenario = new URLSearchParams(location.search).get('package')
const scope = {
  projectId: 'import-project',
  appSessionId: 'import-session',
  artifactId: 'local-artifact',
  versionId: 'local-version'
}
const sourceScope = {
  projectId: 'source',
  appSessionId: 'source-session',
  artifactId: 'source-artifact',
  versionId: 'source-version'
}
const sourceReceipt = {
  schemaVersion: 1,
  receiptId: 'source-check',
  receiptChecksum: 'f'.repeat(64),
  artifactVersion: { ...sourceScope, targetChecksum: 'a'.repeat(64) },
  startedAt: '2026-09-10T00:00:00.000Z',
  completedAt: '2026-09-10T00:01:00.000Z',
  outcome: 'matched',
  frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
  recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
  environmentLocks: [],
  completedStepIds: ['run-1', 'run-2'],
  comparisons: [
    {
      stepId: 'run-2',
      entityId: 'output',
      relativePath: 'result.csv',
      expectedChecksum: 'a'.repeat(64),
      actualChecksum: 'a'.repeat(64),
      expectedSizeBytes: 20,
      actualSizeBytes: 20,
      status: 'matched'
    }
  ]
}
if (scenario) {
  window.api = {
    ...window.api,
    artifacts: {
      ...window.api?.artifacts,
      startReproducibilityCheck: async () => {
        throw new Error('Fixture must not execute')
      },
      cancelReproducibilityCheck: async () => undefined,
      onReproducibilityCheckChanged: () => () => undefined,
      getReproducibilityCheck: async () => undefined,
      listReproducibilityReceipts: async () => ({
        receipts: scenario === 'import' ? [sourceReceipt] : [],
        ...(scenario === 'import' ? { sourceArtifactVersion: sourceScope } : {})
      })
    }
  }
}

export const PreviewFileSurface = forwardRef(function Surface({ tooltipClassName }, ref) {
  useImperativeHandle(ref, () => ({
    requestLeave(action) {
      action()
      return true
    }
  }))
  return (
    <div className="min-w-0 w-full overflow-auto p-4 @container">
      <ArtifactReproducibilityPanel
        projection={projection}
        tooltipClassName={tooltipClassName}
        artifactVersion={scenario ? scope : undefined}
        executionAvailable={Boolean(scenario)}
      />
    </div>
  )
})

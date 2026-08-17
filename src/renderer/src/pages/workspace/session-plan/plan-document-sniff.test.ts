import { describe, expect, it } from 'vitest'

import type { PlanDocumentV1 } from '../../../../../shared/session-plan/contract'

import { parsePlanDocumentFromPreviewContent } from './plan-document-sniff'

const planDocument: PlanDocumentV1 = {
  schema_version: 1,
  task_summary: 'Analyze one dataset',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Primary agent',
          steps: [
            { title: 'Load the counts', description: 'Read the matrix into memory.' },
            { title: 'Summarize groups', description: 'Report per-group totals.' }
          ]
        }
      ]
    }
  ],
  desired_outputs: ['Group summary table'],
  feasibility: { confidence: 'high', rationale: 'The dataset is small and local.' }
}

// Mirrors how PlanService serializes the Plan Artifact Version to disk.
const serializedPlan = JSON.stringify(planDocument, null, 2)

describe('plan document preview sniffing', () => {
  it('recognizes a serialized Session Plan document', () => {
    expect(parsePlanDocumentFromPreviewContent(serializedPlan)).toEqual(planDocument)
  })

  it('ignores ordinary JSON without a Plan shape', () => {
    expect(parsePlanDocumentFromPreviewContent('{"name": "results", "rows": 3}')).toBeUndefined()
    expect(
      parsePlanDocumentFromPreviewContent(JSON.stringify({ schema_version: 2, task_summary: 'x' }))
    ).toBeUndefined()
  })

  it('ignores JSON that claims the Plan schema but fails validation', () => {
    expect(
      parsePlanDocumentFromPreviewContent(JSON.stringify({ schema_version: 1 }))
    ).toBeUndefined()
    expect(
      parsePlanDocumentFromPreviewContent(
        JSON.stringify({ schema_version: 1, task_summary: 'No phases' })
      )
    ).toBeUndefined()
  })

  it('ignores truncated or invalid JSON', () => {
    expect(parsePlanDocumentFromPreviewContent(serializedPlan.slice(0, 40))).toBeUndefined()
    expect(parsePlanDocumentFromPreviewContent('not json')).toBeUndefined()
    expect(parsePlanDocumentFromPreviewContent('[1, 2, 3]')).toBeUndefined()
    expect(parsePlanDocumentFromPreviewContent('null')).toBeUndefined()
  })
})

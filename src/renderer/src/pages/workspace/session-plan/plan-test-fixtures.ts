import type {
  ActivePlanProjection,
  PlanDocumentV1
} from '../../../../../shared/session-plan/contract'

// Shared by the plan preview renderer, projection resolution, and workbench store tests: one
// fixture keeps the projection shape in sync as the contract evolves.
export const planTestDocument: PlanDocumentV1 = {
  schema_version: 1,
  task_summary: 'Analyze one dataset',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Primary agent',
          steps: [{ title: 'Analyze the data', description: 'Produce the result.' }]
        }
      ]
    }
  ],
  desired_outputs: [],
  feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
}

export const planTestProjection = (artifactVersionId: string): ActivePlanProjection => ({
  artifactId: `artifact-${artifactVersionId}`,
  artifactVersionId,
  artifactChecksum: 'a'.repeat(64),
  revision: 1,
  approval: 'approved',
  lifecycle: 'approved',
  document: planTestDocument,
  stepStatuses: {},
  stepStates: { 'Analyze the data': { status: 'completed' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
})

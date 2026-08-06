import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'
import { projectGeneratePlanActivity } from './generate-plan-activity-projection'

const createActivity = (overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  id: 'plan-1',
  kind: 'tool',
  title: 'generate_plan',
  providerToolName: 'mcp__open-science-plan__generate_plan',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const planArguments = {
  task_summary: 'Prepare the publication package',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Evidence',
          steps: [
            { title: 'Inspect sources', description: 'Check every primary source.' },
            { title: 'Draft findings', description: 'Write the evidence summary.' }
          ]
        },
        {
          name: 'Figures',
          steps: [{ title: 'Build chart', description: 'Create the final chart.' }]
        }
      ]
    },
    {
      name: 'Delivery',
      delegations: [
        {
          name: 'Package',
          steps: [{ title: 'Export report', description: 'Produce the PDF.' }]
        }
      ]
    }
  ],
  desired_outputs: ['PDF report'],
  feasibility: { confidence: 'medium', rationale: 'One source may need confirmation.' }
}

describe('projectGeneratePlanActivity', () => {
  it('validates direct Plan arguments and flattens steps in source order', () => {
    expect(projectGeneratePlanActivity(createActivity({ rawInput: planArguments }))).toEqual({
      kind: 'content',
      heading: 'Created execution Plan',
      taskSummary: 'Prepare the publication package',
      steps: [
        { number: 1, title: 'Inspect sources', description: 'Check every primary source.' },
        { number: 2, title: 'Draft findings', description: 'Write the evidence summary.' },
        { number: 3, title: 'Build chart', description: 'Create the final chart.' },
        { number: 4, title: 'Export report', description: 'Produce the PDF.' }
      ],
      feasibility: { confidence: 'medium', summary: 'One source may need confirmation.' }
    })
  })

  it('unwraps an MCP arguments envelope and reflects an active call', () => {
    const projection = projectGeneratePlanActivity(
      createActivity({ status: 'in_progress', rawInput: { arguments: planArguments } })
    )

    expect(projection).toMatchObject({
      kind: 'content',
      heading: 'Creating execution Plan',
      taskSummary: 'Prepare the publication package'
    })
  })

  it('projects approval and dismissal calls as compact decisions', () => {
    expect(
      projectGeneratePlanActivity(createActivity({ rawInput: { decision: 'approved' } }))
    ).toEqual({ kind: 'approved', heading: 'Approved execution Plan' })
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { arguments: { decision: 'rejected' } } })
      )
    ).toEqual({ kind: 'rejected', heading: 'Dismissed execution Plan' })
    expect(projectGeneratePlanActivity(createActivity({ rawInput: { approve: true } }))).toEqual({
      kind: 'approved',
      heading: 'Approved execution Plan'
    })
  })

  it('rejects decisions combined with Plan content or contradictory legacy approval', () => {
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { decision: 'approved', task_summary: 'Do the work' } })
      )
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { decision: 'rejected', phases: planArguments.phases } })
      )
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { approve: true, feasibility: planArguments.feasibility } })
      )
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { decision: 'approved', desired_outputs: ['Report'] } })
      )
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { decision: 'approved', approve: true } })
      )
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
    expect(
      projectGeneratePlanActivity(
        createActivity({ rawInput: { decision: 'rejected', approve: true } })
      )
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
  })

  it('keeps missing and invalid content visible as unavailable', () => {
    expect(projectGeneratePlanActivity(createActivity({ rawInput: undefined }))).toEqual({
      kind: 'unavailable',
      heading: 'Created execution Plan'
    })
    expect(
      projectGeneratePlanActivity(createActivity({ rawInput: { ...planArguments, phases: [] } }))
    ).toEqual({ kind: 'unavailable', heading: 'Created execution Plan' })
  })

  it('projects failures independently of recoverable input', () => {
    expect(
      projectGeneratePlanActivity(createActivity({ status: 'failed', rawInput: planArguments }))
    ).toEqual({ kind: 'failed', heading: 'Failed to create execution Plan' })
  })
})

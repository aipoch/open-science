import { describe, expect, it } from 'vitest'

import {
  createPlanDocumentV1,
  derivePlanLifecycle,
  generatePlanContentSchema,
  formatPlanProtectedContext,
  isPlanCommandErrorCode,
  isPlanComplete,
  isPlanTerminalOutcome,
  parsePlanDocumentV1,
  PlanCommandError,
  projectPlanStepStates
} from './contract'

describe('Plan command errors', () => {
  it('recognizes a pending Plan review conflict at the shared transport boundary', () => {
    expect(isPlanCommandErrorCode('plan-review-pending')).toBe(true)
  })

  it('recognizes a live approval waiter conflict at the shared transport boundary', () => {
    expect(isPlanCommandErrorCode('approval-already-pending')).toBe(true)
  })

  it('does not expose the removed continuation authority error', () => {
    expect(isPlanCommandErrorCode('continuation-required')).toBe(false)
  })
})

describe('protected Plan context', () => {
  it('keeps decision state and exact step titles without model-irrelevant storage identity', () => {
    const summary = formatPlanProtectedContext({
      artifactId: 'artifact-1',
      artifactVersionId: 'version-3',
      artifactChecksum: 'a'.repeat(64),
      revision: 8,
      approval: 'approved',
      lifecycle: 'blocked',
      document: createPlanDocumentV1({
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Main Agent',
                steps: [
                  { title: 'Inspect exact input title', description: 'Inspect the data.' },
                  { title: 'Analyze', description: 'Analyze the data.' }
                ]
              }
            ]
          }
        ],
        desired_outputs: ['Result'],
        feasibility: { confidence: 'high', rationale: 'Ready.' }
      }),
      stepStatuses: {
        'Inspect exact input title': {
          status: 'completed',
          updatedAt: 41,
          notes: 'A long completed-step implementation log that is no longer actionable.'
        },
        Analyze: { status: 'blocked', updatedAt: 42, notes: 'Input missing' }
      },
      stepStates: {
        'Inspect exact input title': {
          status: 'completed',
          notes: 'A long completed-step implementation log that is no longer actionable.'
        },
        Analyze: { status: 'blocked', notes: 'Input missing' }
      },
      counts: { phases: 1, delegations: 1, steps: 2, completed: 1, inProgress: 0 }
    })

    expect(summary).toBe(
      [
        '<open_science_protected_plan_context>',
        'approval=approved lifecycle=blocked',
        'task=Analyze data',
        '- Inspect exact input title: completed',
        '- Analyze: blocked — Input missing',
        'Use this approved Session Plan as durable work context. Real side effects remain subject to independent permissions.',
        'The originating Conversation Turn retains ownership of the Plan; related later ordinary or application Attempts on the same durable Message Branch receive it only as active context.',
        'The latest explicit user Message takes precedence over this Plan. Treat application Messages as contextual events and judge how they relate to the approved steps without letting them override user intent.',
        'If it changes the goal, desired outputs, risks, or material scope, generate a replacement Plan revision and wait for approval before doing the changed work.',
        'Routine execution details and progress updates within the approved scope do not require another approval.',
        '</open_science_protected_plan_context>'
      ].join('\n')
    )
  })
})

describe('Plan document V1', () => {
  it('publishes one canonical content contract for Plan producers', () => {
    expect(Object.keys(generatePlanContentSchema.shape)).toEqual([
      'task_summary',
      'phases',
      'desired_outputs',
      'feasibility'
    ])
    expect(generatePlanContentSchema.description).toContain('four content fields')
    expect(
      generatePlanContentSchema.safeParse({
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      }).success
    ).toBe(true)
  })

  it('adds the server-owned schema version to a valid single-step plan', () => {
    expect(
      createPlanDocumentV1({
        task_summary: 'Prepare a review-ready result',
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
        desired_outputs: ['Analysis result'],
        feasibility: { confidence: 'high', rationale: 'The required inputs are available.' }
      })
    ).toEqual({
      schema_version: 1,
      task_summary: 'Prepare a review-ready result',
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
      desired_outputs: ['Analysis result'],
      feasibility: { confidence: 'high', rationale: 'The required inputs are available.' }
    })
  })

  it('accepts an empty desired-output list and preserves every phase, delegation, and step', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Compare two cohorts',
      phases: [
        {
          name: 'Preparation',
          delegations: [
            {
              name: 'Data intake',
              steps: [
                { title: 'Read the dictionary', description: 'Confirm field meanings.' },
                { title: 'Validate inputs', description: 'Check both cohorts.' }
              ]
            }
          ]
        },
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Comparison',
              steps: [{ title: 'Compare cohorts', description: 'Calculate differences.' }]
            },
            {
              name: 'Evidence review',
              steps: [{ title: 'Review evidence', description: 'Check supporting evidence.' }]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'medium', rationale: 'Inputs may need confirmation.' }
    })

    expect(document.phases).toHaveLength(2)
    expect(document.phases[0].delegations).toHaveLength(1)
    expect(document.phases[1].delegations).toHaveLength(2)
    expect(document.phases[0].delegations[0].steps).toHaveLength(2)
    expect(document.desired_outputs).toEqual([])
  })

  it('rejects an explicitly unsupported schema version at the shared contract boundary', () => {
    expect(() =>
      createPlanDocumentV1({
        schema_version: 2,
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      })
    ).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({
        code: 'invalid-plan',
        message: 'schema_version must be 1.'
      })
    )
  })

  it('requires the V1 discriminator when parsing a persisted Plan document', () => {
    expect(() =>
      parsePlanDocumentV1({
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      })
    ).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({
        code: 'invalid-plan',
        message: 'schema_version must be 1.'
      })
    )
  })

  it.each([
    [undefined, 'Plan document must be an object.'],
    [{}, 'task_summary must be non-empty.'],
    [
      {
        task_summary: 'Analyze data',
        phases: [{ name: 'Analysis', delegations: 'not-an-array' }],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      'Each phase requires at least one delegation.'
    ],
    [
      {
        task_summary: 'Analyze data',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [
                  { title: 'Analyze data', description: 'First description.' },
                  { title: ' Analyze data ', description: 'Second description.' }
                ]
              }
            ]
          }
        ],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      },
      'Duplicate step title: Analyze data'
    ]
  ])('returns structured invalid-plan for malformed runtime input %#', (input, message) => {
    expect(() => createPlanDocumentV1(input)).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({ code: 'invalid-plan', message })
    )
  })

  it('checks each phase name before validating later phase fields', () => {
    expect(() =>
      createPlanDocumentV1({
        task_summary: 'Analyze data',
        phases: [{ name: '', delegations: 'not-an-array' }],
        desired_outputs: [],
        feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
      })
    ).toThrow(
      expect.objectContaining<Partial<PlanCommandError>>({
        code: 'invalid-plan',
        message: 'phase name must be non-empty.'
      })
    )
  })
})

describe('derived Plan lifecycle', () => {
  it('keeps approved work in progress after its Attempt ends', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Analyze data',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })

    const statuses = { 'Analyze data': { status: 'in_progress' as const } }
    expect(derivePlanLifecycle(document, 'approved', statuses)).toBe('in_progress')
  })

  it('derives blocked once blocked work has no remaining active execution', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Analyze data',

      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [
                { title: 'Inspect inputs', description: 'Check the data.' },
                { title: 'Analyze data', description: 'Produce the result.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })

    expect(
      derivePlanLifecycle(document, 'approved', {
        'Inspect inputs': { status: 'blocked' }
      })
    ).toBe('blocked')
  })

  it('uses one completion rule for durable status facts', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Prepare a result',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: [
                { title: 'Analyze', description: 'Analyze the inputs.' },
                { title: 'Summarize', description: 'Summarize the result.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })

    expect(
      isPlanComplete(document, {
        Analyze: { status: 'completed' },
        Summarize: { status: 'skipped' }
      })
    ).toBe(true)
    expect(isPlanComplete(document, { Analyze: { status: 'completed' } })).toBe(false)
  })

  it('treats special JavaScript property names as opaque status keys', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Exercise special names',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Primary agent',
              steps: ['toString', 'constructor', '__proto__'].map((title) => ({
                title,
                description: `Complete ${title}.`
              }))
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })

    expect(projectPlanStepStates(document, {})).toEqual(
      Object.fromEntries(
        ['toString', 'constructor', '__proto__'].map((title) => [title, { status: 'not_started' }])
      )
    )
    const statuses = Object.fromEntries([
      ['toString', { status: 'completed' as const, updatedAt: 1 }],
      ['constructor', { status: 'skipped' as const, updatedAt: 2 }],
      ['__proto__', { status: 'blocked' as const, updatedAt: 3 }]
    ])
    expect(projectPlanStepStates(document, statuses)).toEqual(
      Object.fromEntries([
        ['toString', { status: 'completed' }],
        ['constructor', { status: 'skipped' }],
        ['__proto__', { status: 'blocked' }]
      ])
    )
    expect(isPlanTerminalOutcome(document, statuses)).toBe(true)
  })
})

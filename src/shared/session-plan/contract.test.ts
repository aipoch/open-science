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
  planStepSchema,
  projectPlanStepStates,
  type ActivePlanProjection
} from './contract'

describe('Plan command errors', () => {
  it('recognizes a pending Plan review conflict at the shared transport boundary', () => {
    expect(isPlanCommandErrorCode('plan-review-pending')).toBe(true)
  })

  it('recognizes a live approval waiter conflict at the shared transport boundary', () => {
    expect(isPlanCommandErrorCode('approval-already-pending')).toBe(true)
  })

  it('recognizes unavailable capability and invalid result errors at the shared boundary', () => {
    expect(isPlanCommandErrorCode('plan-unavailable')).toBe(true)
    expect(isPlanCommandErrorCode('invalid-backend-result')).toBe(true)
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

  it.each([
    ['pending', 'awaiting_approval'],
    ['approved', 'in_progress'],
    ['rejected', 'rejected']
  ] as const)(
    'keeps the real %s decision state with a short external reference',
    (approval, lifecycle) => {
      const reference = 'Plan details: read the current Plan from the provided input directory.'
      const summary = formatPlanProtectedContext(
        {
          artifactId: 'artifact-sensitive',
          artifactVersionId: 'version-sensitive',
          artifactChecksum: 'checksum-sensitive',
          revision: 9,
          approval,
          lifecycle,
          document: createPlanDocumentV1({
            task_summary: 'sensitive task text that must stay out of reference mode',
            phases: [
              {
                name: 'Sensitive phase',
                delegations: [
                  {
                    name: 'Sensitive delegation',
                    steps: [
                      {
                        title: 'Sensitive step title',
                        description: 'sensitive step description that must not be projected'
                      }
                    ]
                  }
                ]
              }
            ],
            desired_outputs: ['Sensitive output'],
            feasibility: { confidence: 'medium', rationale: 'Sensitive rationale' }
          }),
          stepStatuses: {},
          stepStates: { 'Sensitive step title': { status: 'not_started' } },
          counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
        },
        { kind: 'file-reference', reference }
      )

      expect(summary).toContain(`approval=${approval} lifecycle=${lifecycle}`)
      expect(summary).toContain('expectedArtifactVersionId=version-sensitive expectedRevision=9')
      expect(summary).toContain(reference)
      expect(summary).toContain('The latest explicit user Message takes precedence')
      expect(summary).not.toContain('sensitive task text')
      expect(summary).not.toContain('Sensitive step title')
      expect(summary).not.toContain('sensitive step description')
      expect(summary).not.toContain('artifact-sensitive')
      expect(summary).not.toContain('checksum-sensitive')
    }
  )

  it('falls back to an authoritative request summary when the Plan file is unavailable', () => {
    const warning = 'The Plan file is unavailable; do not rely on an earlier copy.'
    const summary = formatPlanProtectedContext(
      {
        artifactId: 'artifact-sensitive',
        artifactVersionId: 'version-9',
        artifactChecksum: 'checksum-sensitive',
        revision: 12,
        approval: 'approved',
        lifecycle: 'in_progress',
        document: createPlanDocumentV1({
          task_summary: 'Recover the interrupted analysis',
          phases: [
            {
              name: 'Recovery',
              delegations: [
                {
                  name: 'Main Agent',
                  steps: [
                    {
                      title: 'Finish the verified analysis',
                      description: 'Use the approved inputs.'
                    }
                  ]
                }
              ]
            }
          ],
          desired_outputs: ['Verified result'],
          feasibility: { confidence: 'high', rationale: 'The projection remains readable.' }
        }),
        stepStatuses: {},
        stepStates: {
          'Finish the verified analysis': { status: 'in_progress', notes: 'Half complete' }
        },
        counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 1 }
      },
      { kind: 'file-unavailable', warning }
    )

    expect(summary).toContain('approval=approved lifecycle=in_progress')
    expect(summary).toContain('expectedArtifactVersionId=version-9 expectedRevision=12')
    expect(summary).toContain('task=Recover the interrupted analysis')
    expect(summary).toContain('- Finish the verified analysis: in_progress — Half complete')
    expect(summary).toContain('an authoritative summary of the Plan as read for this request')
    expect(summary).toContain('omit detailed requirements')
    expect(summary).toContain('do not guarantee that the Plan remained unchanged')
    expect(summary).toContain('report it as a blocker instead of guessing')
    expect(summary).toContain(warning)
    expect(summary).toContain('Use this approved Session Plan as durable work context')
    expect(summary).not.toContain('artifact-sensitive')
    expect(summary).not.toContain('checksum-sensitive')
  })

  it('keeps reference-mode context bounded independently of Plan document size', () => {
    const projection = (content: string): ActivePlanProjection => ({
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'a'.repeat(64),
      revision: 1,
      approval: 'approved',
      lifecycle: 'approved',
      document: createPlanDocumentV1({
        task_summary: content,
        phases: [
          {
            name: 'Phase',
            delegations: [
              {
                name: 'Agent',
                steps: [{ title: `Step ${content}`, description: content }]
              }
            ]
          }
        ],
        desired_outputs: [content],
        feasibility: { confidence: 'high', rationale: content }
      }),
      stepStatuses: {},
      stepStates: {},
      counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
    })
    const reference = 'Plan details are available from the current input directory.'
    const compact = formatPlanProtectedContext(projection('short'), {
      kind: 'file-reference',
      reference
    })
    const large = formatPlanProtectedContext(projection('private-plan-content-'.repeat(10_000)), {
      kind: 'file-reference',
      reference
    })

    expect(large).toBe(compact)
    expect(large.length).toBeLessThan(512)
    expect(large).not.toContain('private-plan-content')
  })
})

describe('Plan document V1', () => {
  it('defines steps as verifiable work units with explicit completion boundaries', () => {
    expect(planStepSchema.description).toContain('independently verifiable work unit')
    expect(planStepSchema.description).toContain('meaningful stopping point')
    expect(planStepSchema.description).toContain('promised check passes')
    expect(planStepSchema.description).toContain('result is available as agreed')
    expect(planStepSchema.description).toContain(
      'Managed Artifact publication is required only when this step promises it'
    )
    expect(planStepSchema.shape.description.description).toContain(
      'work, promised result, and completion check'
    )
    expect(planStepSchema.shape.description.description).toContain(
      'routine tightly coupled preparation, arithmetic, and local checks'
    )
  })

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

  it('keeps a Plan active while an already-started peer delegation has work left', () => {
    const document = createPlanDocumentV1({
      task_summary: 'Analyze data in parallel',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Cohorts',
              steps: [
                { title: 'Validate cohorts', description: 'Validate the cohort boundaries.' },
                { title: 'Compare cohorts', description: 'Compare the validated cohorts.' }
              ]
            },
            {
              name: 'Evidence',
              steps: [
                { title: 'Find evidence', description: 'Find the relevant evidence.' },
                { title: 'Review evidence', description: 'Review the collected evidence.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
    })
    const statuses = {
      'Validate cohorts': { status: 'blocked' as const },
      'Find evidence': { status: 'completed' as const }
    }

    expect(projectPlanStepStates(document, statuses)).toMatchObject({
      'Validate cohorts': { status: 'blocked' },
      'Compare cohorts': { status: 'not_run' },
      'Find evidence': { status: 'completed' },
      'Review evidence': { status: 'not_started' }
    })
    expect(isPlanTerminalOutcome(document, statuses)).toBe(false)
    expect(derivePlanLifecycle(document, 'approved', statuses)).toBe('in_progress')
  })

  it('preserves the terminal blocked projection used by existing persisted Plans', () => {
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
    const statuses = { 'Inspect inputs': { status: 'blocked' as const } }

    expect(projectPlanStepStates(document, statuses)).toMatchObject({
      'Inspect inputs': { status: 'blocked' },
      'Analyze data': { status: 'not_run' }
    })
    expect(isPlanTerminalOutcome(document, statuses)).toBe(true)
    expect(derivePlanLifecycle(document, 'approved', statuses)).toBe('blocked')
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

import { createServer } from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { PlanCommandError } from '../../shared/session-plan/contract'
import { listenForLocalRpc } from '../local-rpc-transport'
import {
  callPlanRpc,
  createPlanMcpServer,
  createPlanMcpServerForEnvironment
} from './plan-mcp-server'

const withPlanMcpClient = async <Result>(
  name: string,
  handler: Parameters<typeof createPlanMcpServer>[0],
  call: (client: Client) => Promise<Result>
): Promise<Result> => {
  const server = createPlanMcpServer(handler)
  const client = new Client({ name, version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    return await call(client)
  } finally {
    await client.close()
    await server.close()
  }
}

const VALID_STEP = { title: 'Analyze', description: 'Produce the result.' }
const VALID_DELEGATION = { name: 'Primary agent', steps: [VALID_STEP] }
const VALID_PHASE = { name: 'Analysis', delegations: [VALID_DELEGATION] }

function planGenerationArguments(
  phases: unknown,
  feasibility: unknown = { confidence: 'high', rationale: 'Inputs are available.' }
): Record<string, unknown> {
  return {
    task_summary: 'Analyze one dataset',
    phases,
    desired_outputs: [],
    feasibility
  }
}

describe('Session Plan MCP server', () => {
  it('advertises the complete nested Plan content schema', async () => {
    const server = createPlanMcpServer({
      generate: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      updateStepStatus: vi.fn()
    })
    const client = new Client({ name: 'plan-schema-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const generatePlan = (await client.listTools()).tools.find(
        (tool) => tool.name === 'generate_plan'
      )
      const inputSchema = generatePlan?.inputSchema as {
        properties?: Record<string, unknown>
      }

      expect(inputSchema.properties?.task_summary).toMatchObject({
        type: 'string',
        description: expect.stringContaining('generation mode')
      })
      expect(inputSchema.properties?.phases).toMatchObject({
        type: 'array',
        description: expect.stringContaining('ordered phases'),
        items: {
          type: 'object',
          required: ['name', 'delegations'],
          properties: {
            name: { type: 'string', description: expect.any(String) },
            delegations: {
              type: 'array',
              description: expect.stringContaining('at least one delegation'),
              items: {
                type: 'object',
                required: ['name', 'steps'],
                properties: {
                  name: { type: 'string', description: expect.any(String) },
                  steps: {
                    type: 'array',
                    description: expect.stringContaining('ordered verifiable work units'),
                    items: {
                      type: 'object',
                      description: expect.stringContaining('independently verifiable work unit'),
                      required: ['title', 'description'],
                      properties: {
                        title: { type: 'string', description: expect.any(String) },
                        description: {
                          type: 'string',
                          description: expect.stringContaining(
                            'work, promised result, and completion check'
                          )
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      })
      expect(inputSchema.properties?.desired_outputs).toMatchObject({
        type: 'array',
        description: expect.stringContaining('empty array'),
        items: { type: 'string', description: expect.any(String) }
      })
      expect(inputSchema.properties?.feasibility).toMatchObject({
        type: 'object',
        description: expect.any(String),
        properties: {
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: expect.any(String)
          },
          rationale: { type: 'string', description: expect.any(String) }
        }
      })
      expect(inputSchema.properties).not.toHaveProperty('session_id')
      expect(inputSchema.properties).not.toHaveProperty('plan_id')
      expect(inputSchema.properties).not.toHaveProperty('artifact_id')
      expect(inputSchema.properties).not.toHaveProperty('artifact_version_id')
      expect(inputSchema).not.toHaveProperty('required')
      expect(JSON.stringify(inputSchema)).not.toContain(
        'delegations: [{ name, steps: [{ title, description }] }]'
      )
      expect(JSON.stringify(inputSchema)).not.toContain('`{ title, description }` objects')
      expect(JSON.stringify(inputSchema)).toContain('meaningful stopping point')
      expect(JSON.stringify(inputSchema)).toContain('independent review or decisions')
      expect(JSON.stringify(inputSchema)).toContain('user-requested pauses')
      expect(JSON.stringify(inputSchema)).toContain('substantial jobs')
      expect(JSON.stringify(inputSchema)).toContain('delivered separately')
      expect(JSON.stringify(inputSchema)).toContain('Do not target a fixed step count')
      expect(JSON.stringify(inputSchema)).toContain('result is available as agreed')
      expect(JSON.stringify(inputSchema)).toContain(
        'Managed Artifact publication is required only when this step promises it'
      )

      const updateStep = (await client.listTools()).tools.find(
        (tool) => tool.name === 'update_step_status'
      )
      const updateSchema = updateStep?.inputSchema as {
        required?: string[]
        properties?: Record<string, { description?: string; enum?: string[] }>
      }
      expect(updateSchema.required).toEqual(['title', 'status'])
      expect(updateSchema.properties?.title?.description).toContain('exact, case-sensitive title')
      expect(updateSchema.properties?.status).toMatchObject({
        enum: ['in_progress', 'completed', 'blocked', 'skipped'],
        description: expect.stringContaining('blocked only for an irreversible failure')
      })
      expect(updateSchema.properties?.status?.description).toContain(
        'skipped only for unnecessary work that has not started'
      )
      expect(updateSchema.properties?.status?.description).toContain(
        'Terminal statuses cannot change later'
      )
      expect(updateSchema.properties?.notes?.description).toContain(
        'repeated terminal-status no-op does not write new notes'
      )
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rehydrates structured Plan errors returned by the local RPC adapter', async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'stale-plan', message: 'A newer Plan is active.' }
          }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    vi.stubGlobal('fetch', fetch)

    try {
      await expect(
        callPlanRpc(
          {
            endpoint: 'http://127.0.0.1:1234/plan',
            token: 'plan-token',
            projectId: 'project-1',
            sessionId: 'session-1'
          },
          'updateStepStatus',
          { title: 'Analyze the data', status: 'completed' }
        )
      ).rejects.toMatchObject({
        name: 'PlanCommandError',
        code: 'stale-plan',
        message: 'A newer Plan is active.'
      })
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/plan',
        expect.objectContaining({
          method: 'POST',
          headers: {
            authorization: 'Bearer plan-token',
            'content-type': 'application/json'
          }
        })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps Plan generation pending beyond the global fetch response-headers policy', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result: { lifecycle: 'approved' } }))
    })
    const connection = await listenForLocalRpc(server, {
      name: 'plan-long-wait-test',
      transport: 'tcp'
    })
    const globalFetch = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('Headers Timeout Error'), {
          code: 'UND_ERR_HEADERS_TIMEOUT'
        })
      })
    })
    vi.stubGlobal('fetch', globalFetch)

    try {
      await expect(
        callPlanRpc(
          {
            endpoint: `${connection.endpoint}/plan`,
            token: 'plan-token',
            projectId: 'project-1',
            sessionId: 'session-1'
          },
          'generate',
          { task_summary: 'Wait for review' }
        )
      ).resolves.toEqual({ lifecycle: 'approved' })
      expect(globalFetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns a compact step receipt without exposing the internal Plan projection', async () => {
    const planContext =
      '<open_science_protected_plan_context>\napproval=approved lifecycle=completed\nPlan details: $OPEN_SCIENCE_INPUT_DIR/plan.md\n</open_science_protected_plan_context>'
    const updateStepStatus = vi.fn().mockResolvedValue({
      changed: true,
      planContext,
      projection: {
        artifactId: 'artifact-1',
        artifactVersionId: 'version-1',
        artifactChecksum: 'private-checksum',
        revision: 12,
        approval: 'approved',
        lifecycle: 'completed',
        document: {
          schema_version: 1,
          task_summary: 'private-task-summary',
          phases: [],
          desired_outputs: [],
          feasibility: { confidence: 'high', rationale: 'private-rationale' }
        },
        stepStatuses: {},
        stepStates: { 'Analyze the data': { status: 'completed' } },
        counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
      }
    })
    await withPlanMcpClient(
      'plan-step-receipt-test',
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus
      },
      async (client) => {
        const result = await client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze the data', status: 'completed', notes: 'Dataset verified.' }
        })
        const content = (result as { content: Array<{ text: string }> }).content
        const receipt = JSON.parse(content[0].text)

        expect(receipt).toEqual({
          changed: true,
          step: { title: 'Analyze the data', status: 'completed' },
          revision: 12,
          lifecycle: 'completed',
          planContext
        })
        expect(content[0].text).not.toContain('projection')
        expect(content[0].text).not.toContain('private-task-summary')
        expect(content[0].text).not.toContain('private-checksum')
        expect(updateStepStatus).toHaveBeenCalledWith({
          title: 'Analyze the data',
          status: 'completed',
          notes: 'Dataset verified.',
          expectedArtifactVersionId: undefined
        })
      }
    )
  })

  it('returns compact approval and rejection receipts without exposing their projections', async () => {
    const approvedPlanContext =
      '<open_science_protected_plan_context>\napproval=approved lifecycle=approved\nPlan details: $OPEN_SCIENCE_INPUT_DIR/plan.md\n</open_science_protected_plan_context>'
    const projection = (
      approval: 'approved' | 'rejected',
      revision: number
    ): Record<string, unknown> => ({
      artifactId: 'artifact-1',
      artifactVersionId: 'version-1',
      artifactChecksum: 'private-decision-checksum',
      revision,
      approval,
      lifecycle: approval,
      document: { task_summary: 'private-decision-summary' },
      stepStatuses: {},
      stepStates: {},
      counts: {}
    })
    await withPlanMcpClient(
      'plan-decision-receipt-test',
      {
        generate: vi.fn(),
        approve: vi.fn().mockResolvedValue({
          changed: true,
          planContext: approvedPlanContext,
          projection: projection('approved', 7)
        }),
        reject: vi.fn().mockResolvedValue({ changed: true, projection: projection('rejected', 8) }),
        updateStepStatus: vi.fn()
      },
      async (client) => {
        const approved = await client.callTool({
          name: 'generate_plan',
          arguments: { decision: 'approved' }
        })
        const rejected = await client.callTool({
          name: 'generate_plan',
          arguments: { decision: 'rejected' }
        })
        const approvedText = (approved as { content: Array<{ text: string }> }).content[0].text
        const rejectedText = (rejected as { content: Array<{ text: string }> }).content[0].text

        expect(JSON.parse(approvedText)).toEqual({
          kind: 'decision',
          decision: 'approved',
          changed: true,
          revision: 7,
          lifecycle: 'approved',
          planContext: approvedPlanContext
        })
        expect(JSON.parse(rejectedText)).toEqual({
          kind: 'decision',
          decision: 'rejected',
          changed: true,
          revision: 8,
          lifecycle: 'rejected'
        })
        expect(JSON.parse(rejectedText)).not.toHaveProperty('planContext')
        expect(`${approvedText}${rejectedText}`).not.toContain('projection')
        expect(`${approvedText}${rejectedText}`).not.toContain('private-decision-summary')
        expect(`${approvedText}${rejectedText}`).not.toContain('private-decision-checksum')
      }
    )
  })

  it.each([undefined, 'Read session-plan/current.json through the Notebook shell.'])(
    'returns human feedback and an available Plan reference (%s)',
    async (planContext) => {
      const generate = vi.fn().mockResolvedValue({
        kind: 'feedback',
        ...(planContext ? { planContext } : {}),
        routeToInteractionId: 'private-interaction-id',
        artifactVersionId: 'private-artifact-version',
        text: 'Split the analysis by cohort.',
        message: {
          id: 'private-message-id',
          content: 'Split the analysis by cohort.',
          createdAt: 123
        },
        planRevision: 9,
        deliveryCommandId: 'private-delivery-receipt'
      })
      await withPlanMcpClient(
        'plan-feedback-receipt-test',
        { generate, approve: vi.fn(), reject: vi.fn(), updateStepStatus: vi.fn() },
        async (client) => {
          const result = await client.callTool({
            name: 'generate_plan',
            arguments: {
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
          })
          const text = (result as { content: Array<{ text: string }> }).content[0].text

          expect(JSON.parse(text)).toEqual({
            kind: 'feedback',
            ...(planContext ? { planContext } : {}),
            text: 'Split the analysis by cohort.'
          })
          expect(text).not.toContain('private-interaction-id')
          expect(text).not.toContain('private-message-id')
          expect(text).not.toContain('private-delivery-receipt')
        }
      )
    }
  )

  it('returns a compact decision receipt when generated Plan review completes', async () => {
    const planContext =
      '<open_science_protected_plan_context>\napproval=approved lifecycle=approved\nPlan details: $OPEN_SCIENCE_INPUT_DIR/plan.md\n</open_science_protected_plan_context>'
    const generate = vi.fn().mockResolvedValue({
      changed: true,
      planContext,
      projection: {
        artifactVersionId: 'version-1',
        artifactChecksum: 'private-generated-plan-checksum',
        revision: 10,
        approval: 'approved',
        lifecycle: 'approved',
        document: { task_summary: 'private-generated-plan-summary' },
        stepStates: {}
      }
    })
    await withPlanMcpClient(
      'generated-plan-decision-receipt-test',
      { generate, approve: vi.fn(), reject: vi.fn(), updateStepStatus: vi.fn() },
      async (client) => {
        const result = await client.callTool({
          name: 'generate_plan',
          arguments: {
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
        })
        const text = (result as { content: Array<{ text: string }> }).content[0].text

        expect(JSON.parse(text)).toEqual({
          kind: 'decision',
          decision: 'approved',
          changed: true,
          revision: 10,
          lifecycle: 'approved',
          planContext
        })
        expect(text).not.toContain('private-generated-plan-checksum')
        expect(text).not.toContain('private-generated-plan-summary')
      }
    )
  })

  it('makes a pending generated Plan explicit in the compact receipt', async () => {
    const result = await withPlanMcpClient(
      'generated-plan-pending-receipt-test',
      {
        generate: vi.fn().mockResolvedValue({
          changed: true,
          projection: {
            artifactVersionId: 'version-pending',
            revision: 11,
            approval: 'pending',
            lifecycle: 'awaiting_approval'
          }
        }),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      (client) =>
        client.callTool({
          name: 'generate_plan',
          arguments: planGenerationArguments([VALID_PHASE])
        })
    )
    const receipt = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

    expect(receipt).toEqual({
      kind: 'plan',
      changed: true,
      revision: 11,
      lifecycle: 'awaiting_approval',
      guidance: 'Review is pending. Do not execute Plan steps until approval is recorded.'
    })
  })

  it('keeps a committed step update successful when its projection refresh failed', async () => {
    const sensitiveRefreshError = 'database password=should-not-cross-the-MCP-boundary'
    const planContext =
      'The step status was committed. Its Plan details could not be refreshed, so do not replay this update.'
    const result = await withPlanMcpClient(
      'plan-refresh-failure-receipt-test',
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn().mockResolvedValue({
          changed: true,
          planContext,
          refreshError: sensitiveRefreshError,
          projection: {
            revision: 14,
            approval: 'approved',
            lifecycle: 'in_progress',
            stepStates: { Analyze: { status: 'in_progress' } }
          }
        })
      },
      (client) =>
        client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze', status: 'in_progress' }
        })
    )
    const text = (result as { content: Array<{ text: string }> }).content[0].text

    expect(result).not.toHaveProperty('isError')
    expect(JSON.parse(text)).toEqual({
      changed: true,
      revision: 14,
      lifecycle: 'in_progress',
      planContext,
      step: { title: 'Analyze', status: 'in_progress' }
    })
    expect(text).toContain('committed')
    expect(text).toContain('do not replay')
    expect(text).not.toContain(sensitiveRefreshError)
    expect(text).not.toContain('refreshError')
  })

  it.each(['decision-call', 'generation-waiter'])(
    'preserves a committed decision delivery identity through MCP serialization for a %s',
    async (path) => {
      const warning =
        'The Plan decision was committed, but delivery to the waiting Agent is unconfirmed. Do not repeat the decision automatically.'
      const committed = {
        changed: true,
        deliveryWarning: warning,
        deliveryCommandId: 'delivery-command-7',
        projection: {
          artifactVersionId: 'artifact-version-4',
          revision: 15,
          approval: 'approved',
          lifecycle: 'approved'
        }
      }
      const result = await withPlanMcpClient(
        `plan-delivery-warning-${path}`,
        {
          generate: vi.fn().mockResolvedValue(committed),
          approve: vi.fn().mockResolvedValue(committed),
          reject: vi.fn(),
          updateStepStatus: vi.fn()
        },
        (client) =>
          client.callTool({
            name: 'generate_plan',
            arguments:
              path === 'decision-call'
                ? { decision: 'approved' }
                : planGenerationArguments([VALID_PHASE])
          })
      )
      const receipt = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

      expect(result).not.toHaveProperty('isError')
      expect(receipt).toEqual({
        kind: 'decision',
        decision: 'approved',
        changed: true,
        revision: 15,
        lifecycle: 'approved',
        deliveryWarning: warning,
        artifactVersionId: 'artifact-version-4',
        deliveryCommandId: 'delivery-command-7'
      })
    }
  )

  it('does not expose delivery identities without a bounded delivery warning', async () => {
    const approve = vi
      .fn()
      .mockResolvedValueOnce({
        changed: true,
        deliveryCommandId: 'private-command-without-warning',
        projection: {
          artifactVersionId: 'private-version-without-warning',
          revision: 16,
          approval: 'approved',
          lifecycle: 'approved'
        }
      })
      .mockResolvedValueOnce({
        changed: false,
        deliveryWarning: 'x'.repeat(2049),
        deliveryCommandId: 'private-command-with-oversized-warning',
        projection: {
          artifactVersionId: 'private-version-with-oversized-warning',
          revision: 16,
          approval: 'approved',
          lifecycle: 'approved'
        }
      })
      .mockResolvedValueOnce({
        changed: false,
        deliveryWarning: 'The committed decision delivery is unconfirmed.',
        deliveryCommandId: 'c'.repeat(2049),
        projection: {
          artifactVersionId: 'v'.repeat(2049),
          revision: 16,
          approval: 'approved',
          lifecycle: 'approved'
        }
      })
    await withPlanMcpClient(
      'plan-delivery-warning-bound-test',
      { generate: vi.fn(), approve, reject: vi.fn(), updateStepStatus: vi.fn() },
      async (client) => {
        for (let index = 0; index < 3; index += 1) {
          const result = await client.callTool({
            name: 'generate_plan',
            arguments: { decision: 'approved' }
          })
          const text = (result as { content: Array<{ text: string }> }).content[0].text
          const receipt = JSON.parse(text)

          if (index === 2) {
            expect(receipt.deliveryWarning).toBe('The committed decision delivery is unconfirmed.')
          } else {
            expect(receipt).not.toHaveProperty('deliveryWarning')
          }
          expect(receipt).not.toHaveProperty('artifactVersionId')
          expect(receipt).not.toHaveProperty('deliveryCommandId')
          expect(text).not.toContain('private-')
        }
      }
    )
  })

  it('sanitizes unexpected failures and preserves an unconfirmed outcome at the MCP boundary', async () => {
    const result = await withPlanMcpClient(
      'plan-unexpected-error-test',
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn(async () => {
          throw new Error('database password=synthetic-secret')
        })
      },
      (client) =>
        client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze', status: 'in_progress' }
        })
    )
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const receipt = JSON.parse(text)

    expect(result).toMatchObject({ isError: true, structuredContent: receipt })
    expect(receipt).toEqual({
      error: {
        message: 'The Session Plan operation did not return a confirmed result.',
        guidance:
          'Stop automatic retries. Do not assume the operation failed or repeat it until later Session Plan context confirms whether it took effect. Do not repeat confirmed writes; report unresolved state for application recovery.'
      }
    })
    expect(text).not.toContain('synthetic-secret')
  })

  it('redacts domain error secrets before bounding the serialized message', async () => {
    const result = await withPlanMcpClient(
      'plan-domain-error-bound-test',
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn(async () => {
          throw new PlanCommandError(
            'unknown-step',
            `Unknown Plan step password=synthetic-secret\n${'detail '.repeat(500)}`
          )
        })
      },
      (client) =>
        client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze', status: 'in_progress' }
        })
    )
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const receipt = JSON.parse(text)

    expect(receipt.error.message).toContain('[redacted]')
    expect(receipt.error.message).toContain('[message truncated]')
    expect(receipt.error.message.length).toBeLessThanOrEqual(2048)
    expect(text).not.toContain('synthetic-secret')
  })

  it('does not suggest approval when the current Plan cannot accept step updates', async () => {
    const result = await withPlanMcpClient(
      'plan-not-approved-guidance-test',
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn(async () => {
          throw new PlanCommandError(
            'plan-not-approved',
            'The current Session Plan was rejected; its steps cannot be updated.'
          )
        })
      },
      (client) =>
        client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze', status: 'in_progress' }
        })
    )
    const receipt = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

    expect(receipt.error.guidance).toContain('unless later Session Plan context confirms')
    expect(receipt.error.guidance).not.toMatch(/ask|request|submit.*approv/i)
  })

  it('reports an unavailable Plan capability as not attempted without rebuilding the Plan', async () => {
    const result = await withPlanMcpClient(
      'plan-unavailable-guidance-test',
      {
        generate: vi.fn(),
        approve: vi.fn(async () => {
          throw new PlanCommandError(
            'plan-unavailable',
            'Session Plan capability is not configured. This operation was not attempted.'
          )
        }),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      (client) => client.callTool({ name: 'generate_plan', arguments: { decision: 'approved' } })
    )
    const receipt = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

    expect(result).toMatchObject({ isError: true, structuredContent: receipt })
    expect(receipt.error).toEqual({
      code: 'plan-unavailable',
      message: 'Session Plan capability is not configured. This operation was not attempted.',
      guidance:
        'The operation was not attempted. Do not rebuild or resubmit the Plan. Open-Science must provide the Session Plan capability before another Plan call.'
    })
  })

  it('drops an oversized Plan reference from an otherwise valid success receipt', async () => {
    const result = await withPlanMcpClient(
      'oversized-plan-reference-test',
      {
        generate: vi.fn(),
        approve: vi.fn().mockResolvedValue({
          changed: true,
          planContext: 'x'.repeat(2049),
          projection: { revision: 3, approval: 'approved', lifecycle: 'approved' }
        }),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      (client) => client.callTool({ name: 'generate_plan', arguments: { decision: 'approved' } })
    )
    const receipt = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0].text
    ) as Record<string, unknown>

    expect(result).not.toHaveProperty('isError')
    expect(receipt).toEqual({
      kind: 'decision',
      decision: 'approved',
      changed: true,
      revision: 3,
      lifecycle: 'approved'
    })
    expect(receipt).not.toHaveProperty('planContext')
  })

  it('fails closed when a Plan handler returns an unknown success shape', async () => {
    await withPlanMcpClient(
      'invalid-plan-receipt-test',
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn().mockResolvedValue({ lifecycle: 'completed' })
      },
      async (client) => {
        const result = await client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze the data', status: 'completed' }
        })

        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: 'invalid-backend-result',
              message:
                'The Session Plan service returned an invalid result. The operation outcome is unconfirmed.',
              guidance: expect.stringContaining('Stop automatic retries')
            }
          }
        })
      }
    )
  })

  it('fails closed when a decision result contradicts the requested decision', async () => {
    await withPlanMcpClient(
      'contradictory-plan-receipt-test',
      {
        generate: vi.fn(),
        approve: vi.fn().mockResolvedValue({
          changed: true,
          projection: { approval: 'rejected', revision: 4, lifecycle: 'rejected' }
        }),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      async (client) => {
        const result = await client.callTool({
          name: 'generate_plan',
          arguments: { decision: 'approved' }
        })

        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'invalid-backend-result' } }
        })
      }
    )
  })

  it.each([
    [
      'lifecycle',
      {
        approval: 'approved',
        revision: 4,
        lifecycle: 'unknown',
        stepStates: { 'Analyze the data': { status: 'in_progress' } }
      }
    ],
    [
      'approval',
      {
        approval: 'unknown',
        revision: 4,
        lifecycle: 'in_progress',
        stepStates: { 'Analyze the data': { status: 'in_progress' } }
      }
    ],
    [
      'revision',
      {
        approval: 'approved',
        revision: -1,
        lifecycle: 'in_progress',
        stepStates: { 'Analyze the data': { status: 'in_progress' } }
      }
    ],
    [
      'step status',
      {
        approval: 'approved',
        revision: 4,
        lifecycle: 'in_progress',
        stepStates: { 'Analyze the data': { status: 'unknown' } }
      }
    ]
  ])('fails closed when a step result contains an invalid %s', async (_field, projection) => {
    const result = await withPlanMcpClient(
      `invalid-plan-${_field}`,
      {
        generate: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn().mockResolvedValue({ changed: true, projection })
      },
      (client) =>
        client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze the data', status: 'in_progress' }
        })
    )

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'invalid-backend-result',
          message:
            'The Session Plan service returned an invalid result. The operation outcome is unconfirmed.',
          guidance: expect.stringContaining('Stop automatic retries')
        }
      }
    })
  })

  it.each([
    {
      name: 'omitted delegation steps',
      input: planGenerationArguments([
        { name: 'Analysis', delegations: [{ name: 'Primary agent' }] }
      ]),
      expected: 'Expected array; received missing value at phases[0].delegations[0].steps'
    },
    {
      name: 'omitted phase delegations',
      input: planGenerationArguments([{ name: 'Analysis' }]),
      expected: 'Expected array; received missing value at phases[0].delegations'
    },
    {
      name: 'omitted step title',
      input: planGenerationArguments([
        {
          ...VALID_PHASE,
          delegations: [{ ...VALID_DELEGATION, steps: [{ description: 'Produce the result.' }] }]
        }
      ]),
      expected: 'Expected string; received missing value at phases[0].delegations[0].steps[0].title'
    },
    {
      name: 'invalid feasibility confidence',
      input: planGenerationArguments([VALID_PHASE], {
        confidence: 'certain',
        rationale: 'Inputs are available.'
      }),
      expected:
        'Expected one of "high", "medium", "low"; received "certain" at feasibility.confidence'
    },
    {
      name: 'invalid phase object',
      input: planGenerationArguments(['Analysis']),
      expected: 'Expected object; received string at phases[0]'
    },
    {
      name: 'invalid decision',
      input: { decision: 'maybe' },
      expected: 'Expected one of "approved", "rejected"; received "maybe" at decision'
    }
  ])('formats $name with the shared schema error convention', async ({ name, input, expected }) => {
    const generate = vi.fn()

    await withPlanMcpClient(
      `plan-schema-error-${name}`,
      {
        generate,
        approve: vi.fn(),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      async (client) => {
        const result = await client.callTool({ name: 'generate_plan', arguments: input })
        const text = (result as { content: Array<{ text: string }> }).content[0].text

        expect(result).toMatchObject({ isError: true })
        expect(text).toContain(expected)
        expect(generate).not.toHaveBeenCalled()
      }
    )
  })

  it('rejects unadvertised identity fields before invoking a Plan handler', async () => {
    const approve = vi.fn()

    await withPlanMcpClient(
      'plan-forged-identities-test',
      {
        generate: vi.fn(),
        approve,
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      async (client) => {
        const result = await client.callTool({
          name: 'generate_plan',
          arguments: {
            decision: 'approved',
            session_id: 'forged-session',
            plan_id: 'forged-plan',
            artifact_id: 'forged-artifact',
            artifact_version_id: 'forged-version'
          }
        })
        const text = (result as { content: Array<{ text: string }> }).content[0].text

        expect(result).toMatchObject({ isError: true })
        expect(text).toContain(
          'Unexpected fields: "session_id", "plan_id", "artifact_id", "artifact_version_id"'
        )
        expect(approve).not.toHaveBeenCalled()
      }
    )
  })

  it('preserves approval-already-pending as a structured MCP error', async () => {
    const rpcServer = createServer((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            code: 'approval-already-pending',
            message: 'An identical execution Plan is already awaiting approval.'
          }
        })
      )
    })
    const connection = await listenForLocalRpc(rpcServer, {
      name: 'plan-pending-error-test',
      transport: 'tcp'
    })
    const planServer = createPlanMcpServerForEnvironment({
      endpoint: `${connection.endpoint}/plan`,
      token: 'plan-token',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const client = new Client({ name: 'plan-pending-error-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([planServer.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'generate_plan',
        arguments: {
          task_summary: 'Wait for review',
          phases: [
            {
              name: 'Review',
              delegations: [
                {
                  name: 'Primary agent',
                  steps: [{ title: 'Wait', description: 'Wait for the decision.' }]
                }
              ]
            }
          ],
          desired_outputs: [],
          feasibility: { confidence: 'high', rationale: 'Review is available.' }
        }
      })

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: 'approval-already-pending',
            message: 'An identical execution Plan is already awaiting approval.'
          }
        }
      })
    } finally {
      await client.close()
      await planServer.close()
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()))
    }
  })

  it('does not misstate an undelivered Plan response as awaiting review', async () => {
    const result = await withPlanMcpClient(
      'plan-response-delivery-pending-test',
      {
        generate: vi.fn(),
        approve: vi.fn(async () => {
          throw new PlanCommandError(
            'plan-review-pending',
            'The Session Plan response has not been delivered. Wait for Open-Science to resume this task before making another Plan call.'
          )
        }),
        reject: vi.fn(),
        updateStepStatus: vi.fn()
      },
      (client) => client.callTool({ name: 'generate_plan', arguments: { decision: 'approved' } })
    )
    const receipt = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

    expect(receipt.error).toMatchObject({
      code: 'plan-review-pending',
      guidance: expect.stringContaining('follow the error message or later Session Plan context')
    })
    expect(receipt.error.guidance).not.toContain('wait for the current review result')
  })

  it('reports a local RPC authentication rejection as not attempted with bounded diagnostics', async () => {
    let requests = 0
    const rpcServer = createServer((_request, response) => {
      requests += 1
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: `Invalid notebook RPC token. echo: rejected-plan-token password=synthetic-secret\n${'detail '.repeat(500)}`
        })
      )
    })
    const connection = await listenForLocalRpc(rpcServer, {
      name: 'plan-authentication-rejection-test',
      transport: 'tcp'
    })
    const planServer = createPlanMcpServerForEnvironment({
      endpoint: connection.endpoint,
      token: 'rejected-plan-token',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const client = new Client({ name: 'plan-authentication-rejection-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([planServer.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'update_step_status',
        arguments: { title: 'Analyze', status: 'in_progress' }
      })
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      const receipt = JSON.parse(text)

      expect(requests).toBe(1)
      expect(result).toMatchObject({ isError: true, structuredContent: receipt })
      expect(receipt.error.message).toContain('operation was not attempted')
      expect(receipt.error.message).toContain('Invalid notebook RPC token')
      expect(receipt.error.message).toContain('[redacted]')
      expect(receipt.error.message).toContain('[message truncated]')
      expect(receipt.error.message.length).toBeLessThanOrEqual(2048)
      expect(receipt.error.guidance).toContain("refresh this Session's Plan capability")
      expect(receipt.error.guidance).toContain('retry only after the application provides')
      expect(receipt.error.guidance).toContain('Do not retry automatically or bypass the rejection')
      expect(text).not.toContain('synthetic-secret')
      expect(text).not.toContain('rejected-plan-token')
      expect(text).not.toContain('outcome is unconfirmed')
    } finally {
      await client.close()
      await planServer.close()
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()))
    }
  })

  it('keeps an HTTP 500 result unconfirmed and hides its diagnostic', async () => {
    const rpcServer = createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'database password=synthetic-secret' }))
    })
    const connection = await listenForLocalRpc(rpcServer, {
      name: 'plan-unknown-http-failure-test',
      transport: 'tcp'
    })
    const planServer = createPlanMcpServerForEnvironment({
      endpoint: connection.endpoint,
      token: 'plan-token',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const client = new Client({ name: 'plan-unknown-http-failure-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([planServer.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'update_step_status',
        arguments: { title: 'Analyze', status: 'in_progress' }
      })
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      const receipt = JSON.parse(text)

      expect(receipt.error.message).toContain('did not return a confirmed result')
      expect(receipt.error.guidance).toContain('Stop automatic retries')
      expect(text).not.toContain('synthetic-secret')
      expect(text).not.toContain('not attempted')
    } finally {
      await client.close()
      await planServer.close()
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()))
    }
  })

  it('keeps a network failure unconfirmed at the MCP boundary', async () => {
    const rpcServer = createServer()
    const connection = await listenForLocalRpc(rpcServer, {
      name: 'plan-network-failure-test',
      transport: 'tcp'
    })
    await new Promise<void>((resolve) => rpcServer.close(() => resolve()))
    const planServer = createPlanMcpServerForEnvironment({
      endpoint: connection.endpoint,
      token: 'plan-token',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const client = new Client({ name: 'plan-network-failure-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([planServer.connect(serverTransport), client.connect(clientTransport)])

    try {
      const result = await client.callTool({
        name: 'update_step_status',
        arguments: { title: 'Analyze', status: 'in_progress' }
      })
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      const receipt = JSON.parse(text)

      expect(receipt.error.message).toContain('did not return a confirmed result')
      expect(receipt.error.guidance).toContain('Stop automatic retries')
      expect(text).not.toContain('not attempted')
    } finally {
      await client.close()
      await planServer.close()
    }
  })

  it('releases the pending Plan RPC request when its MCP connection closes', async () => {
    let backendRequestAborted = false
    let backendRequestReceived = false
    const rpcServer = createServer((request) => {
      backendRequestReceived = true
      request.once('aborted', () => {
        backendRequestAborted = true
      })
    })
    const connection = await listenForLocalRpc(rpcServer, {
      name: 'plan-abort-test',
      transport: 'tcp'
    })
    const planServer = createPlanMcpServerForEnvironment({
      endpoint: `${connection.endpoint}/plan`,
      token: 'plan-token',
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    const client = new Client({ name: 'plan-abort-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([planServer.connect(serverTransport), client.connect(clientTransport)])

    const call = client
      .callTool({
        name: 'generate_plan',
        arguments: {
          task_summary: 'Wait for review',
          phases: [
            {
              name: 'Review',
              delegations: [
                {
                  name: 'Primary agent',
                  steps: [{ title: 'Wait', description: 'Wait for the decision.' }]
                }
              ]
            }
          ],
          desired_outputs: [],
          feasibility: { confidence: 'high', rationale: 'Review is available.' }
        }
      })
      .catch(() => undefined)

    try {
      await vi.waitFor(() => expect(backendRequestReceived).toBe(true), { timeout: 500 })
      const close = client.close()
      await vi.waitFor(() => expect(backendRequestAborted).toBe(true), { timeout: 500 })
      await Promise.all([call, close])
    } finally {
      rpcServer.closeAllConnections()
      rpcServer.close()
      void client.close()
      void planServer.close()
    }
  })

  it('drops the previous execution binding when a replacement generation is interrupted', async () => {
    const updateStepStatus = vi.fn(async () => ({}))
    await withPlanMcpClient(
      'paused-replacement-binding',
      {
        generate: async () => {
          throw new Error('Provider turn paused')
        },
        approve: async () => ({
          changed: true,
          projection: {
            artifactVersionId: 'old-version',
            revision: 1,
            approval: 'approved',
            lifecycle: 'approved'
          }
        }),
        reject: vi.fn(),
        updateStepStatus
      },
      async (client) => {
        await client.callTool({ name: 'generate_plan', arguments: { decision: 'approved' } })
        await client.callTool({
          name: 'generate_plan',
          arguments: planGenerationArguments([VALID_PHASE])
        })
        await client.callTool({
          name: 'update_step_status',
          arguments: { title: 'Analyze', status: 'completed' }
        })
        expect(updateStepStatus).toHaveBeenCalledWith({
          title: 'Analyze',
          status: 'completed',
          expectedArtifactVersionId: undefined
        })
      }
    )
  })

  it('exposes server-bound generation, decisions, and exact-title status commands', async () => {
    const generate = vi.fn().mockResolvedValue({
      projection: { artifactVersionId: 'version-1', lifecycle: 'approved' }
    })
    const approve = vi.fn().mockResolvedValue({
      projection: { artifactVersionId: 'version-1', lifecycle: 'approved' }
    })
    const reject = vi.fn().mockResolvedValue({
      projection: { artifactVersionId: 'version-1', lifecycle: 'rejected' }
    })
    const updateStepStatus = vi.fn().mockResolvedValue({ lifecycle: 'completed' })
    const server = createPlanMcpServer({ generate, approve, reject, updateStepStatus })
    const client = new Client({ name: 'plan-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listedTools = await client.listTools()
    expect(listedTools.tools.map((tool) => tool.name)).toEqual([
      'generate_plan',
      'update_step_status'
    ])
    const generateTool = listedTools.tools.find((tool) => tool.name === 'generate_plan')
    expect(generateTool).toBeDefined()
    expect(generateTool?.description).toMatch(/^Create a complete Session Plan for review/)
    expect(generateTool?.description).toContain(
      'generation with task_summary, phases, desired_outputs, and feasibility'
    )
    expect(generateTool?.description).toContain(
      'decision-only with decision:"approved" or decision:"rejected"'
    )
    expect(generateTool?.description).toContain('distinct new Plan supersedes the current Plan')
    expect(generateTool?.description).toContain('current Plan needs revision')
    expect(generateTool?.description).toContain('complete revised Plan for fresh review')
    expect(generateTool?.description).toContain('Do not regenerate merely to report progress')
    expect(generateTool?.description).toContain(
      'work, concrete deliverable or finding, and completion check'
    )
    expect(generateTool?.description).toContain('kind:feedback')
    expect(generateTool?.description).toContain('decision:"approved"')
    expect(generateTool?.description).not.toContain(
      'every delegation must include its own non-empty `steps` array'
    )
    expect(generateTool?.description).toContain('Repair every reported validation path')
    const updateTool = listedTools.tools.find((tool) => tool.name === 'update_step_status')
    expect(updateTool?.description).toMatch(/^Report observed progress/)
    expect(updateTool?.description).toContain('Waiting for user input')
    expect(updateTool?.description).toContain('preserves the current status')
    expect(updateTool?.description).toContain('Earlier steps in the same delegation')
    expect(updateTool?.description).toContain('all earlier phases must be completed or skipped')
    expect(updateTool?.description).toContain('only already-started delegations may continue')
    expect(updateTool?.description).toContain('without inventing terminal statuses')
    await client.callTool({
      name: 'generate_plan',
      arguments: {
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
    })
    await client.callTool({ name: 'generate_plan', arguments: { decision: 'approved' } })
    await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'completed' }
    })

    expect(generate).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(updateStepStatus).toHaveBeenCalledWith({
      title: 'Analyze the data',
      status: 'completed',
      expectedArtifactVersionId: 'version-1'
    })
    const forged = await client.callTool({
      name: 'generate_plan',
      arguments: { approve: true, session_id: 'forged' }
    })
    expect(forged).toMatchObject({ isError: true })

    const malformed = await client.callTool({
      name: 'generate_plan',
      arguments: {
        task_summary: '',
        phases: [{ name: 'Analysis', delegations: [] }],
        desired_outputs: []
      }
    })
    expect(malformed).toMatchObject({ isError: true })
    const malformedContent = (malformed as { content: Array<{ text: string }> }).content
    expect(JSON.parse(malformedContent[0].text)).toEqual({
      error: {
        code: 'invalid-plan',
        message: 'task_summary must be non-empty.'
      }
    })
    expect(generate).toHaveBeenCalledOnce()

    await client.callTool({ name: 'generate_plan', arguments: { decision: 'rejected' } })
    expect(reject).toHaveBeenCalledOnce()

    updateStepStatus.mockRejectedValueOnce(
      new PlanCommandError('dependency-not-satisfied', 'A previous step is unfinished.')
    )
    const rejected = await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'in_progress' }
    })
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'dependency-not-satisfied',
          message: 'A previous step is unfinished.'
        }
      }
    })
    await client.close()
    await server.close()
  })

  it('returns tagged-union and domain failures as structured MCP errors', async () => {
    const server = createPlanMcpServer({
      generate: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      updateStepStatus: vi.fn(async () => {
        throw new PlanCommandError('stale-plan', 'A newer Plan is active.')
      })
    })
    const client = new Client({ name: 'plan-errors', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const mixed = await client.callTool({
      name: 'generate_plan',
      arguments: { approve: true, task_summary: 'Do both shapes' }
    })
    expect(mixed).toMatchObject({ isError: true })
    expect(JSON.parse((mixed as { content: Array<{ text: string }> }).content[0].text)).toEqual({
      error: {
        code: 'invalid-plan',
        message: 'A Plan decision cannot be combined with Plan content.'
      }
    })

    const stale = await client.callTool({
      name: 'update_step_status',
      arguments: { title: 'Analyze the data', status: 'completed' }
    })
    expect(stale).toMatchObject({ isError: true })
    expect(JSON.parse((stale as { content: Array<{ text: string }> }).content[0].text)).toEqual({
      error: {
        code: 'stale-plan',
        message: 'A newer Plan is active.',
        guidance:
          'Stop automatic retries. Follow later Session Plan context for the current version and state before making another mutation.'
      }
    })

    await client.close()
    await server.close()
  })
})

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
                    description: expect.stringContaining('at least one step'),
                    items: {
                      type: 'object',
                      required: ['title', 'description'],
                      properties: {
                        title: { type: 'string', description: expect.any(String) },
                        description: { type: 'string', description: expect.any(String) }
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
    const updateStepStatus = vi.fn().mockResolvedValue({
      changed: true,
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
          lifecycle: 'completed'
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
        approve: vi
          .fn()
          .mockResolvedValue({ changed: true, projection: projection('approved', 7) }),
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
          lifecycle: 'approved'
        })
        expect(JSON.parse(rejectedText)).toEqual({
          kind: 'decision',
          decision: 'rejected',
          changed: true,
          revision: 8,
          lifecycle: 'rejected'
        })
        expect(`${approvedText}${rejectedText}`).not.toContain('projection')
        expect(`${approvedText}${rejectedText}`).not.toContain('private-decision-summary')
        expect(`${approvedText}${rejectedText}`).not.toContain('private-decision-checksum')
      }
    )
  })

  it('returns only the human feedback needed to revise a generated Plan', async () => {
    const generate = vi.fn().mockResolvedValue({
      kind: 'feedback',
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
          text: 'Split the analysis by cohort.'
        })
        expect(text).not.toContain('private-interaction-id')
        expect(text).not.toContain('private-message-id')
        expect(text).not.toContain('private-delivery-receipt')
      }
    )
  })

  it('returns a compact decision receipt when generated Plan review completes', async () => {
    const generate = vi.fn().mockResolvedValue({
      changed: true,
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
          lifecycle: 'approved'
        })
        expect(text).not.toContain('private-generated-plan-checksum')
        expect(text).not.toContain('private-generated-plan-summary')
      }
    )
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
              code: 'invalid-plan',
              message: 'The Session Plan service returned an invalid success result.'
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
          structuredContent: { error: { code: 'invalid-plan' } }
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
          code: 'invalid-plan',
          message: 'The Session Plan service returned an invalid success result.'
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
    expect(generateTool?.description).toMatch(/^Generation and decision use separate call shapes\./)
    expect(generateTool?.description).toContain(
      'all four top-level fields: task_summary, phases, desired_outputs, and feasibility'
    )
    expect(generateTool?.description).toContain(
      'For a decision, submit only decision:"approved" or decision:"rejected"'
    )
    expect(generateTool?.description).toContain('kind:feedback')
    expect(generateTool?.description).toContain('decision:"approved"')
    expect(generateTool?.description).not.toContain(
      'every delegation must include its own non-empty `steps` array'
    )
    expect(generateTool?.description).toContain('repair each reported path')
    expect(generateTool?.description).toContain('never resend the same invalid arguments unchanged')
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
      error: { code: 'stale-plan', message: 'A newer Plan is active.' }
    })

    await client.close()
    await server.close()
  })
})

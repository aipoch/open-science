import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { PlanCommandError } from '../../shared/session-plan/contract'
import { callPlanRpc, createPlanMcpServer } from './plan-mcp-server'

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
        description: expect.stringContaining('one or more delegations'),
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: expect.any(String) },
            delegations: {
              type: 'array',
              description: expect.stringContaining('at least one delegation'),
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: expect.any(String) },
                  steps: {
                    type: 'array',
                    description: expect.stringContaining('at least one step'),
                    items: {
                      type: 'object',
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
      expect(inputSchema).not.toHaveProperty('required')
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
    expect(generateTool?.description).toContain('kind:feedback')
    expect(generateTool?.description).toContain('decision:"approved"')
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

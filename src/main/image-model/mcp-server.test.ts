import { z } from 'zod'
import { IMAGE_MODEL_PRESETS } from '../../shared/image-model-presets'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLocalRpc } from '../local-rpc-transport'

vi.mock('../local-rpc-transport', () => ({ fetchLocalRpc: vi.fn() }))
vi.mock('../artifacts/mcp-server', () => ({
  readCurrentRunContext: vi.fn(async () => ({
    artifactRunId: 'run-a',
    rpcCapabilityToken: 'turn-token'
  }))
}))

import { nodeRuntimeEnvironmentEntries } from '../node-process-host'
import {
  IMAGE_MCP_SERVER_ARG,
  IMAGE_MCP_SERVER_NAME,
  createImageMcpEnvironmentFromProcess,
  createImageMcpServer,
  imageMcpToolDefinitions,
  createImageMcpServerConfig,
  type ImageMcpEnvironment
} from './mcp-server'

const environment: ImageMcpEnvironment = {
  projectId: 'project-a',
  sessionId: 'session-a',
  presetId: 'minimax-h3/official',
  currentRunFile: '/tmp/current-run.json',
  rpcEndpoint: 'http://127.0.0.1:1234'
}

describe('image MCP server', () => {
  it('exposes only generation and edit tools', async () => {
    const server = createImageMcpServer(environment)
    const client = new Client({ name: 'image-mcp-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual(['generate_image', 'edit_image'])
    await client.close()
    await server.close()
  })

  it.each(Object.keys(IMAGE_MODEL_PRESETS))(
    'exposes only the selected preset options: %s',
    (presetId) => {
      const preset = IMAGE_MODEL_PRESETS[presetId as keyof typeof IMAGE_MODEL_PRESETS]
      const definitions = imageMcpToolDefinitions(presetId)
      for (const [name, operation] of [
        ['generate_image', 'generate'],
        ['edit_image', 'edit']
      ] as const) {
        const definition = definitions[name]
        if (!preset.operations[operation]) {
          expect(definition).toBeUndefined()
          continue
        }
        const schema = definition!.inputSchema.options
        const json = z.toJSONSchema(schema, { io: 'input' })
        expect(Object.keys(json.properties ?? {})).toEqual(
          Object.entries(preset.operations[operation]?.options ?? {})
            .filter(
              ([key, spec]) =>
                ['size', 'aspect_ratio', 'area', 'quality', 'output_format', 'background'].includes(
                  key
                ) || spec.required
            )
            .map(([key]) => key)
        )
        expect(json.additionalProperties).toBe(false)
        expect(schema.safeParse({ resolution: '2K' }).success).toBe(false)
      }
      expect(definitions.generate_image.inputSchema.options.safeParse(undefined).success).toBe(
        presetId !== 'minimax-h3/sglang'
      )
    }
  )

  it('rejects guessed options before sending a provider request', async () => {
    const server = createImageMcpServer({ ...environment, presetId: 'minimax-h3/official' })
    const client = new Client({ name: 'image-options-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'a circle', options: { resolution: '2K' } }
      })
      expect(result.isError).toBe(true)
      expect(fetchLocalRpc).not.toHaveBeenCalled()
      const schema =
        imageMcpToolDefinitions('minimax-h3/official').generate_image.inputSchema.options
      expect(z.toJSONSchema(schema, { io: 'input' }).properties).toMatchObject({
        size: { description: expect.stringContaining('WIDTHxHEIGHT') },
        aspect_ratio: { description: expect.stringContaining('W:H') },
        area: { enum: ['1K', '2K', '4K'] }
      })
      expect(schema.safeParse({ area: '2K', aspect_ratio: '3:2' }).success).toBe(true)
      expect(schema.safeParse({ area: '8K' }).success).toBe(false)
      expect(
        imageMcpToolDefinitions('minimax-h3/sglang').generate_image.inputSchema.options.safeParse(
          {}
        ).success
      ).toBe(false)
    } finally {
      await client.close()
      await server.close()
    }
  })

  beforeEach(() => {
    vi.mocked(fetchLocalRpc).mockReset()
  })

  it.each(['success', 'failure', 'cancel'] as const)(
    'keeps a long image request alive and stops heartbeats on %s',
    async (outcome) => {
      vi.useFakeTimers()
      let release!: (response: Response) => void
      let started!: () => void
      let signal: AbortSignal | undefined
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      vi.mocked(fetchLocalRpc).mockImplementation(async (_route, request) => {
        signal = request.signal as AbortSignal
        started()
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      })
      const server = createImageMcpServer(environment)
      const client = new Client({ name: 'image-progress-test', version: '1' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const controller = new AbortController()
      const onprogress = vi.fn()
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
        const pending = client
          .callTool(
            {
              name: outcome === 'success' ? 'generate_image' : 'edit_image',
              arguments: {
                prompt: 'a circle',
                source: {
                  projectId: 'project-a',
                  sourceKind: 'artifact-version',
                  sourceFileId: 'file-a',
                  inputFileVersionId: 'version-a'
                }
              }
            },
            undefined,
            {
              signal: controller.signal,
              onprogress,
              timeout: 60_000,
              resetTimeoutOnProgress: true
            }
          )
          .catch((error: unknown) => error)
        await ready
        await vi.advanceTimersByTimeAsync(125_000)
        expect(onprogress.mock.calls.map(([progress]) => progress)).toEqual(
          [1, 2, 3, 4].map((progress) => ({
            progress,
            message: outcome === 'success' ? 'Generating image.' : 'Modifying image.'
          }))
        )
        expect(signal?.aborted).toBe(false)
        if (outcome === 'cancel') {
          controller.abort()
          await pending
          await vi.advanceTimersByTimeAsync(0)
          expect(signal?.aborted).toBe(true)
          expect(vi.getTimerCount()).toBe(0)
        }
        release(
          outcome === 'failure'
            ? Response.json(
                { error: { code: 'PROVIDER_ERROR', message: 'Unavailable' } },
                { status: 503 }
              )
            : Response.json({ result: { artifactId: 'artifact-a' } })
        )
        const result = await pending
        if (outcome === 'failure') expect(result).toMatchObject({ isError: true })
        else if (outcome === 'success')
          expect(result).toMatchObject({
            content: [{ type: 'text', text: JSON.stringify({ artifactId: 'artifact-a' }, null, 2) }]
          })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(onprogress).toHaveBeenCalledTimes(4)
        expect(vi.getTimerCount()).toBe(0)
        expect(fetchLocalRpc).toHaveBeenCalledOnce()
      } finally {
        controller.abort()
        release?.(Response.json({ result: {} }))
        await client.close()
        await server.close()
        vi.useRealTimers()
      }
    }
  )

  it('binds source project and separates fresh connections while retaining HTTP replays', async () => {
    const result = { artifactId: 'artifact-a', versionId: 'version-a', width: 32, height: 24 }
    vi.mocked(fetchLocalRpc).mockImplementation(async () => Response.json({ result }))
    const source = {
      sourceKind: 'artifact-version',
      sourceFileId: 'file-a',
      inputFileVersionId: 'version-source'
    }
    const invoke = async (
      scope?: string,
      prompt = 'recolor',
      idempotencyKey?: string
    ): Promise<void> => {
      const server = createImageMcpServer(environment, scope)
      const client = new Client({ name: 'image-mcp-test', version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      try {
        const response = await client.callTool({
          name: 'edit_image',
          arguments: {
            prompt,
            source: { ...source, projectId: 'guessed-project' },
            options: { size: 'auto' },
            ...(idempotencyKey ? { idempotencyKey } : {}),
            appSessionId: 'forged-session'
          }
        })
        expect(response.isError).not.toBe(true)
        expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(result, null, 2) }])
      } finally {
        await client.close()
        await server.close()
      }
    }
    await invoke()
    await invoke()
    await invoke('http:route')
    await invoke('http:route')
    await invoke('http:route', 'replace')
    await invoke(undefined, 'recolor', 'explicit-recovery-key')
    await invoke('http:route', 'recolor', 'explicit-recovery-key')
    const requests = vi
      .mocked(fetchLocalRpc)
      .mock.calls.map(([, request]) => JSON.parse(String(request.body)))
    expect(requests[0].params.idempotencyKey).not.toBe(requests[1].params.idempotencyKey)
    expect(requests[2]).toEqual(requests[3])
    expect(requests[2].params.idempotencyKey).not.toBe(requests[4].params.idempotencyKey)
    expect(requests[0].params.idempotencyKey).toMatch(/^mcp-[a-f0-9]{64}$/u)
    expect(requests[0].params).toEqual({
      operation: 'edit',
      prompt: 'recolor',
      source: { ...source, projectId: environment.projectId },
      options: { size: 'auto' },
      idempotencyKey: requests[0].params.idempotencyKey
    })
    expect(requests[5]).toEqual(requests[6])
    expect(requests[5].params.idempotencyKey).toBe('explicit-recovery-key')
    expect(vi.mocked(fetchLocalRpc).mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer turn-token' },
      signal: expect.any(AbortSignal)
    })
  })

  it('retains a safe provider failure in the MCP text contract', async () => {
    const imageError = {
      code: 'QUOTA_EXCEEDED',
      httpStatus: 429,
      providerCode: 'SetLimitExceeded',
      requestId: '31f808fd-8eef-9004-b128-deaf00000000'
    }
    vi.mocked(fetchLocalRpc).mockResolvedValue(
      Response.json(
        { error: { code: imageError.code, message: 'Quota exhausted.', imageError } },
        { status: 500 }
      )
    )
    const server = createImageMcpServer(environment)
    const client = new Client({ name: 'image-mcp-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const response = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'a circle' }
      })
      expect(response.isError).toBe(true)
      expect(JSON.parse((response.content as { text: string }[])[0].text)).toMatchObject({
        imageError,
        message: expect.stringContaining('QUOTA_EXCEEDED')
      })
      expect(fetchLocalRpc).toHaveBeenCalledOnce()
    } finally {
      await client.close()
      await server.close()
    }
  })

  it.each(['host-error', 'disconnect', 'invalid-json', 'missing-outcome'] as const)(
    'preserves an unknown outcome after %s without retrying',
    async (failure) => {
      const rpc = vi.mocked(fetchLocalRpc)
      if (failure === 'host-error')
        rpc.mockResolvedValue(
          Response.json(
            {
              error: { code: 'OUTCOME_UNKNOWN', message: 'Response lost after submission.' }
            },
            { status: 500 }
          )
        )
      else if (failure === 'disconnect') rpc.mockRejectedValue(new Error('Connection lost'))
      else if (failure === 'missing-outcome') rpc.mockResolvedValue(Response.json(null))
      else rpc.mockResolvedValue(new Response('not-json'))
      const server = createImageMcpServer(environment)
      const client = new Client({ name: 'image-mcp-test', version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      try {
        const response = await client.callTool({
          name: 'generate_image',
          arguments: {
            prompt: 'a circle',
            idempotencyKey: 'recover-this-call'
          }
        })
        expect(response.isError).toBe(true)
        expect(response.content).toEqual([
          { type: 'text', text: expect.stringContaining('OUTCOME_UNKNOWN') }
        ])
        expect(JSON.stringify(response.content)).toContain('recover-this-call')
        expect(JSON.stringify(response.content)).toContain('Do not start another generation')
        expect(rpc).toHaveBeenCalledOnce()
      } finally {
        await client.close()
        await server.close()
      }
    }
  )

  it('builds a process config without exposing credentials', () => {
    const config = createImageMcpServerConfig({
      ...environment,
      command: '/Applications/Open-Science.app/Contents/MacOS/Open-Science',
      entryPath: '/app/out/main/index.js',
      rpcSocketPath: '\\\\.\\pipe\\open-science-notebook'
    })
    expect(config).toEqual({
      name: IMAGE_MCP_SERVER_NAME,
      command: '/Applications/Open-Science.app/Contents/MacOS/Open-Science',
      args: ['/app/out/main/index.js', IMAGE_MCP_SERVER_ARG],
      env: [
        ...nodeRuntimeEnvironmentEntries(),
        { name: 'OPEN_SCIENCE_IMAGE_PRESET_ID', value: environment.presetId },
        { name: 'OPEN_SCIENCE_IMAGE_PROJECT_ID', value: 'project-a' },
        { name: 'OPEN_SCIENCE_IMAGE_SESSION_ID', value: 'session-a' },
        { name: 'OPEN_SCIENCE_IMAGE_CURRENT_RUN_FILE', value: '/tmp/current-run.json' },
        { name: 'OPEN_SCIENCE_IMAGE_RPC_ENDPOINT', value: 'http://127.0.0.1:1234' },
        { name: 'OPEN_SCIENCE_IMAGE_RPC_SOCKET_PATH', value: '\\\\.\\pipe\\open-science-notebook' }
      ]
    })
    expect(config.env?.some(({ name }) => name.toLowerCase().includes('key'))).toBe(false)
  })

  it('requires the process routing context', () => {
    expect(() => createImageMcpEnvironmentFromProcess({})).toThrow(
      'Missing OPEN_SCIENCE_IMAGE_PROJECT_ID.'
    )
  })
})

it('does not advertise editing for a generation-only custom preset', async () => {
  const server = createImageMcpServer({ ...environment, presetId: 'openai-images/generic' })
  const client = new Client({ name: 'generate-only', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(b), client.connect(a)])
  try {
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(['generate_image'])
  } finally {
    await client.close()
    await server.close()
  }
})

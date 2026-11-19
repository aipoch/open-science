import { ImageModelError } from './contract'
import { imageModelErrorSchema, type ImageErrorDetail } from '../../shared/image-model-error'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServerStdio } from '@agentclientprotocol/sdk'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { installToolErrorRecovery } from '../../shared/tool-error-recovery'
import { z } from 'zod'
import {
  getImageModelPreset,
  type ImageOptionSpec,
  type ImageOperation
} from '../../shared/image-model-presets'
import { createHash, randomUUID } from 'node:crypto'

import {
  readCurrentRunContext,
  type ArtifactMcpEnvironment,
  type ArtifactRunContext
} from '../artifacts/mcp-server'
import { fetchLocalRpc } from '../local-rpc-transport'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'
import { nodeRuntimeEnvironmentEntries } from '../node-process-host'
import { IMAGE_MCP_SERVER_ARG } from '../mcp-server-args'

export const IMAGE_MCP_SERVER_NAME = 'open-science-images'
export { IMAGE_MCP_SERVER_ARG }
const IMAGE_GENERATION_UNAVAILABLE =
  'IMAGE_GENERATION_UNAVAILABLE: Image generation is not available in this turn.'

export type ImageMcpEnvironment = Pick<
  ArtifactMcpEnvironment,
  'projectId' | 'sessionId' | 'currentRunFile' | 'rpcEndpoint' | 'rpcSocketPath'
> & { presetId?: string }

type ImageMcpServerConfigRequest = ImageMcpEnvironment & {
  command: string
  entryPath: string
}

type ImageSource = {
  sourceKind: 'upload-version' | 'artifact-version'
  sourceFileId: string
  inputFileVersionId: string
}

type ImageRpcResult = {
  source?: ImageSource
  artifactId: string
  versionId: string
  versionNumber: number
  filename: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  model: string
  presetId: string
  parameters: unknown
  usage?: unknown
  generatedImages?: number
}

type ImageRpcResponse = {
  result?: ImageRpcResult | null
  error?: string | { code: string; message: string; imageError?: ImageErrorDetail }
}

export const IMAGE_TOOL_GUIDANCE =
  'For image generation (including scientific mechanism illustrations), call the open-science-images generate_image MCP tool directly. For visual edits, call edit_image with the exact source Version when that tool is available. These are MCP tools, not host SDK methods: host.help, host.capabilities and host.mcp do not discover or invoke them. The tool schema contains the selected model options. Normally send only prompt; omit optional options to use provider defaults. No directory check, Notebook runtime or API-schema discovery is needed for these calls. Use Notebook for data-driven plots or explicit code/vector edits. For visual review, if Notebook and model image input are available, use await host.viewImage({ versionId }) in JavaScript Notebook with the exact versionId from the image tool result. Report what the image actually shows. If image inspection is unavailable or fails, say it could not be verified and present the saved image for review.'

const optionSchema = (spec: ImageOptionSpec): z.ZodType => {
  let schema: z.ZodType
  switch (spec.kind) {
    case 'enum':
      schema = z.enum(spec.values as [string, ...string[]])
      break
    case 'integer':
      schema = z.number().int().min(spec.min).max(spec.max)
      break
    case 'boolean':
      schema = z.boolean()
      break
    case 'text':
      schema = z.string().max(spec.maxLength)
      break
    case 'aspect-ratio':
      schema = z
        .string()
        .max(32)
        .regex(/^(auto|[1-9]\d*:[1-9]\d*)$/)
        .describe(
          `Aspect ratio W:H or auto. Each component <= ${spec.maxComponent}; longest/shortest <= ${spec.maxRatio}.`
        )
      break
    case 'size':
      schema = z
        .string()
        .max(32)
        .describe(
          `Output size WIDTHxHEIGHT in pixels${spec.auto ? ', or auto' : ''}${spec.namedSizes?.length ? ', or ' + spec.namedSizes.join(', ') : ''}. Pixel area ${spec.minPixels}..${spec.maxPixels}${spec.maxRatio ? ', longest/shortest <= ' + spec.maxRatio : ''}${spec.maxEdge ? ', longest edge <= ' + spec.maxEdge : ''}${spec.edgeMultiple ? ', both edges divisible by ' + spec.edgeMultiple : ''}.`
        )
      break
  }
  return spec.required
    ? schema
    : schema.optional().describe(schema.description ?? 'Output setting; omit for model default.')
}

// Keep the conversational contract small; the editor retains the full provider preset.
const conversationalOptions = new Set([
  'size',
  'aspect_ratio',
  'area',
  'quality',
  'output_format',
  'background'
])

const imageOptionsSchema = (presetId: string | undefined, operation: ImageOperation): z.ZodType => {
  const specs = (presetId && getImageModelPreset(presetId)?.operations[operation]?.options) || {}
  const schema = z
    .object(
      Object.fromEntries(
        Object.entries(specs)
          .filter(([key, spec]) => conversationalOptions.has(key) || spec.required)
          .map(([key, spec]) => {
            const field = optionSchema(spec)
            return [
              key,
              field.describe(
                key === 'area'
                  ? 'Resolution preset (MiniMax): 1K, 2K or 4K. This field is named area, not resolution. Omit for model default.'
                  : key === 'quality'
                    ? 'Image quality. Omit for model default.'
                    : key === 'background'
                      ? 'Transparent output requires PNG or WebP. Omit for model default.'
                      : key === 'size' && 'aspect_ratio' in specs
                        ? `${field.description} Explicit pixel size cannot be combined with aspect_ratio or area.`
                        : (field.description ?? 'Output setting; omit for model default.')
              )
            ]
          })
      )
    )
    .strict()
    .describe(
      'Only the fields shown here are supported. Omit optional fields to use defaults. Never invent resolution, model, n or response_format. Express visual instructions in prompt.'
    )
  return Object.values(specs).some((spec) => spec.required) ? schema : schema.optional()
}
const imageSourceSchema = z.object({
  sourceKind: z.enum(['upload-version', 'artifact-version']),
  sourceFileId: z.string().min(1),
  inputFileVersionId: z.string().min(1)
})

const imageToolFields = {
  prompt: z.string().trim().min(1).max(32_000),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Use the same key only to recover the same request in this turn. A new key starts a new paid generation.'
    ),
  filename: z.string().trim().min(1).max(256).optional(),
  options: imageOptionsSchema(undefined, 'generate')
}

export const IMAGE_MCP_TOOL_DEFINITIONS = {
  generate_image: {
    description: `${IMAGE_TOOL_GUIDANCE} Generate one image and publish it as the current Artifact. Minimal call: {"prompt":"Describe the image"}. Reuse the returned source object directly for edit_image; the project is bound by the Host. Do not automatically retry OUTCOME_UNKNOWN; the provider may have charged.`,
    inputSchema: imageToolFields
  },
  edit_image: {
    description:
      'Modify an existing image with the configured image model and publish the result as a new Artifact Version. Use this for visual changes to a user-referenced image (for example recoloring, replacing objects or changing style); do not use generate_image to recreate it from scratch. Use the returned source object from generate_image/edit_image verbatim for follow-up edits. For other images use the exact referenced Artifact or upload Version as source. The Host binds projectId; do not supply or guess it. Resolve missing identifiers through Artifact/file metadata; never guess IDs or substitute a same-named SVG, notebook plot or other file. Use Notebook instead when the user explicitly requests source-code/vector/data edits. If image editing is unavailable or fails, report that before changing methods. Do not automatically retry OUTCOME_UNKNOWN; the provider may have charged.',
    inputSchema: { ...imageToolFields, source: imageSourceSchema }
  }
}

export const imageMcpToolDefinitions = (
  presetId?: string
): Pick<typeof IMAGE_MCP_TOOL_DEFINITIONS, 'generate_image'> &
  Partial<Pick<typeof IMAGE_MCP_TOOL_DEFINITIONS, 'edit_image'>> => ({
  generate_image: {
    ...IMAGE_MCP_TOOL_DEFINITIONS.generate_image,
    description: `${IMAGE_MCP_TOOL_DEFINITIONS.generate_image.description}${presetId ? ` Selected preset: ${presetId}.` : ''}${presetId && !getImageModelPreset(presetId)?.operations.edit ? ' This model supports generation only; image editing is unavailable.' : ''}`,
    inputSchema: { ...imageToolFields, options: imageOptionsSchema(presetId, 'generate') }
  },
  ...(!presetId || getImageModelPreset(presetId)?.operations.edit
    ? {
        edit_image: {
          ...IMAGE_MCP_TOOL_DEFINITIONS.edit_image,
          description: `${IMAGE_MCP_TOOL_DEFINITIONS.edit_image.description} Use this MCP tool directly, not host.help or host.mcp.${presetId ? ` Selected preset: ${presetId}.` : ''}`,
          inputSchema: {
            ...imageToolFields,
            source: imageSourceSchema,
            options: imageOptionsSchema(presetId, 'edit')
          }
        }
      }
    : {})
})

const readImageCapability = async (
  environment: ImageMcpEnvironment
): Promise<{ context: ArtifactRunContext; token: string }> => {
  const context = await readCurrentRunContext(environment.currentRunFile)
  if (!context.rpcCapabilityToken) throw new Error(IMAGE_GENERATION_UNAVAILABLE)
  return { context, token: context.rpcCapabilityToken }
}

const callImageRpc = async (
  environment: ImageMcpEnvironment,
  operation: 'generate' | 'edit',
  input: {
    prompt: string
    idempotencyKey?: string
    filename?: string
    options?: unknown
    source?: ImageSource
  },
  requestId: string | number,
  requestScope: string,
  signal: AbortSignal
): Promise<ImageRpcResult> => {
  if (!environment.rpcEndpoint) throw new Error(IMAGE_GENERATION_UNAVAILABLE)
  const { token } = await readImageCapability(environment)
  // Stateless HTTP uses a stable route scope so an identical POST can still be replayed safely.
  const idempotencyKey =
    input.idempotencyKey ??
    `mcp-${createHash('sha256')
      .update(JSON.stringify([requestScope, requestId, operation, input]))
      .digest('hex')}`
  const body = JSON.stringify({
    method: 'imageGenerate',
    params: {
      ...input,
      ...(input.source ? { source: { ...input.source, projectId: environment.projectId } } : {}),
      operation,
      idempotencyKey
    }
  })
  assertWithinResourceBudget(
    'request',
    Buffer.byteLength(body),
    LOCAL_RESOURCE_BUDGETS.requestBytes
  )
  signal.throwIfAborted()
  let response: Response
  let payload: ImageRpcResponse
  try {
    response = await fetchLocalRpc(
      { endpoint: environment.rpcEndpoint, socketPath: environment.rpcSocketPath },
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal
      },
      'Image Model RPC'
    )
    payload = (await response.json()) as ImageRpcResponse
    if (!payload || typeof payload !== 'object' || (!payload.result && !payload.error)) {
      throw new Error('Image Model RPC returned no outcome.')
    }
  } catch {
    throw new ImageModelError(
      'OUTCOME_UNKNOWN',
      `OUTCOME_UNKNOWN: Image generation may have been charged. Do not start another generation. Recover only in this turn with idempotencyKey ${idempotencyKey}.`
    )
  }
  if (!response.ok || payload.error || !payload.result) {
    const detail =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error
          ? `${payload.error.code}: ${payload.error.message}`
          : `Image Model RPC failed with status ${response.status}`
    const parsed = imageModelErrorSchema.safeParse(
      typeof payload.error === 'object'
        ? (payload.error.imageError ?? { code: payload.error.code })
        : undefined
    )
    const { code, httpStatus, ...diagnostics } = parsed.success ? parsed.data : {}
    throw new ImageModelError(
      detail.includes('OUTCOME_UNKNOWN') ? 'OUTCOME_UNKNOWN' : (code ?? 'PROVIDER_ERROR'),
      detail.includes('OUTCOME_UNKNOWN')
        ? `${detail} Do not start another generation. Recover only in this turn with idempotencyKey ${idempotencyKey}.`
        : detail,
      httpStatus,
      diagnostics
    )
  }
  return payload.result
}

const toolResult = (result: ImageRpcResult): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
})

const withImageProgress = async <T>(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  operation: 'generate' | 'edit',
  execute: () => Promise<T>
): Promise<T | { isError: true; content: [{ type: 'text'; text: string }] }> => {
  const progressToken = extra._meta?.progressToken
  let progress = 0
  // A heartbeat keeps long requests alive; no total means this is not a completion percentage.
  const heartbeat =
    progressToken === undefined
      ? undefined
      : setInterval(() => {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: ++progress,
                message: operation === 'edit' ? 'Modifying image.' : 'Generating image.'
              }
            })
            .catch(() => undefined)
        }, 30_000)
  heartbeat?.unref()
  const stop = (): void => clearInterval(heartbeat)
  extra.signal.addEventListener('abort', stop, { once: true })
  try {
    extra.signal.throwIfAborted()
    return await execute()
  } catch (error) {
    if (!(error instanceof ImageModelError)) throw error
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            imageError: error.detail,
            message: error.message.startsWith(`${error.code}:`)
              ? error.message
              : `${error.code}: ${error.message}`
          })
        }
      ]
    }
  } finally {
    stop()
    extra.signal.removeEventListener('abort', stop)
  }
}

export const createImageMcpServer = (
  environment: ImageMcpEnvironment,
  requestScope = `connection:${randomUUID()}`
): ModelContextProtocolServer => {
  const server = installToolErrorRecovery(
    new ModelContextProtocolServer({ name: IMAGE_MCP_SERVER_NAME, version: '1.0.0' })
  )
  const definitions = imageMcpToolDefinitions(environment.presetId)
  server.registerTool('generate_image', definitions.generate_image, async (input, extra) =>
    withImageProgress(extra, 'generate', async () =>
      toolResult(
        await callImageRpc(
          environment,
          'generate',
          input,
          extra.requestId,
          requestScope,
          extra.signal
        )
      )
    )
  )
  if (definitions.edit_image) {
    server.registerTool('edit_image', definitions.edit_image, async (input, extra) =>
      withImageProgress(extra, 'edit', async () =>
        toolResult(
          await callImageRpc(
            environment,
            'edit',
            input,
            extra.requestId,
            requestScope,
            extra.signal
          )
        )
      )
    )
  }
  return server
}

export const createImageMcpServerConfig = (
  request: ImageMcpServerConfigRequest
): McpServerStdio => ({
  name: IMAGE_MCP_SERVER_NAME,
  command: request.command,
  args: [request.entryPath, IMAGE_MCP_SERVER_ARG],
  env: [
    ...nodeRuntimeEnvironmentEntries(),
    ...(request.presetId
      ? [{ name: 'OPEN_SCIENCE_IMAGE_PRESET_ID', value: request.presetId }]
      : []),
    { name: 'OPEN_SCIENCE_IMAGE_PROJECT_ID', value: request.projectId },
    { name: 'OPEN_SCIENCE_IMAGE_SESSION_ID', value: request.sessionId },
    { name: 'OPEN_SCIENCE_IMAGE_CURRENT_RUN_FILE', value: request.currentRunFile },
    ...(request.rpcEndpoint
      ? [{ name: 'OPEN_SCIENCE_IMAGE_RPC_ENDPOINT', value: request.rpcEndpoint }]
      : []),
    ...(request.rpcSocketPath
      ? [{ name: 'OPEN_SCIENCE_IMAGE_RPC_SOCKET_PATH', value: request.rpcSocketPath }]
      : [])
  ]
})

const requiredEnv = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

export const createImageMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): ImageMcpEnvironment => ({
  ...(env.OPEN_SCIENCE_IMAGE_PRESET_ID ? { presetId: env.OPEN_SCIENCE_IMAGE_PRESET_ID } : {}),
  projectId: requiredEnv(env, 'OPEN_SCIENCE_IMAGE_PROJECT_ID'),
  sessionId: requiredEnv(env, 'OPEN_SCIENCE_IMAGE_SESSION_ID'),
  currentRunFile: requiredEnv(env, 'OPEN_SCIENCE_IMAGE_CURRENT_RUN_FILE'),
  ...(env.OPEN_SCIENCE_IMAGE_RPC_ENDPOINT
    ? { rpcEndpoint: env.OPEN_SCIENCE_IMAGE_RPC_ENDPOINT }
    : {}),
  ...(env.OPEN_SCIENCE_IMAGE_RPC_SOCKET_PATH
    ? { rpcSocketPath: env.OPEN_SCIENCE_IMAGE_RPC_SOCKET_PATH }
    : {})
})

export const runImageMcpServer = async (
  environment = createImageMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createImageMcpServer(environment)
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: LOCAL_RESOURCE_BUDGETS.requestBytes
    })
  )
}

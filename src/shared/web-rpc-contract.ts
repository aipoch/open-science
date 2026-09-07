import { z } from 'zod'

import { APPLICATION_COMMAND_ERROR_CODES } from './application-command-contract'
import { WEB_CALLER_LOCATIONS } from './web-caller-location'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'

export const WEB_RPC_PROTOCOL_VERSION = 1 as const
export const WEB_RPC_CAPABILITY_UPDATE_CLI_V1 = 'update-cli-v1' as const
export const WEB_RPC_CAPABILITIES = [WEB_RPC_CAPABILITY_UPDATE_CLI_V1] as const
// v3 requires ACP consumers to apply acp:event incrementally. The payload is an ordered event
// batch on the same protocol version; Electron and Web clients that ship with this Main consume it.
export const WEB_EVENT_STREAM_PROTOCOL_VERSION = 3 as const
export const WEB_RPC_TRANSPORT_ERROR_CODES = [
  'invalid_request',
  'method_not_found',
  'handler_error'
] as const
export const WEB_RPC_ERROR_CODES = [
  ...WEB_RPC_TRANSPORT_ERROR_CODES,
  ...APPLICATION_COMMAND_ERROR_CODES
] as const
export type WebRpcErrorCode = (typeof WEB_RPC_ERROR_CODES)[number]

// The preload interface is the positive source for browser-callable methods. These Electron-only
// methods have browser adapters or require native WebContents/filesystem capabilities and therefore
// remain outside the Web RPC seam.
export const WEB_RPC_UNAVAILABLE_CHANNELS = [
  'file:save-blob',
  'file:save-managed',
  'sessions:export-conversation',
  'sessions:open-recovery-folder',
  'file:save-session-artifacts',
  'file:save-project-artifacts',
  'uploads:stage-local-file',
  'window:close',
  'settings:list-agent-home-skills',
  'settings:import-agent-home-skills'
] as const

const unavailableChannels = new Set<string>(WEB_RPC_UNAVAILABLE_CHANNELS)

export const WEB_RPC_ALLOWED_CHANNELS: readonly string[] = Object.freeze(
  [...new Set(Object.values(WEB_INVOKE_CHANNELS))]
    .filter((channel) => !unavailableChannels.has(channel))
    .sort()
)

export const WEB_RPC_EVENT_CHANNELS: readonly string[] = Object.freeze(
  [...new Set(Object.values(WEB_EVENT_CHANNELS))].sort()
)

const allowedChannels = new Set(WEB_RPC_ALLOWED_CHANNELS)
const eventChannels = new Set(WEB_RPC_EVENT_CHANNELS)

export const isWebRpcChannel = (channel: string): boolean => allowedChannels.has(channel)
export const isWebRpcEventChannel = (channel: string): boolean => eventChannels.has(channel)

const webRpcValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.custom<ArrayBuffer | ArrayBufferView>(
      (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value),
      'Expected binary data'
    ),
    z.array(webRpcValueSchema),
    z.record(z.string(), webRpcValueSchema)
  ])
)

export const webRpcRequestSchema = z
  .object({
    protocolVersion: z.literal(WEB_RPC_PROTOCOL_VERSION),
    args: z.array(webRpcValueSchema)
  })
  .strict()

export const webRpcResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      protocolVersion: z.literal(WEB_RPC_PROTOCOL_VERSION),
      ok: z.literal(true),
      result: webRpcValueSchema
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(WEB_RPC_PROTOCOL_VERSION),
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(WEB_RPC_ERROR_CODES),
          message: z.string()
        })
        .strict()
    })
    .strict()
])

export const webRpcBootstrapSchema = z
  .object({
    platform: z.string(),
    webCallerLocation: z.enum(WEB_CALLER_LOCATIONS).optional(),
    versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string() }).strict(),
    rpcProtocolVersion: z.literal(WEB_RPC_PROTOCOL_VERSION),
    eventStream: z
      .object({
        protocolVersion: z.literal(WEB_EVENT_STREAM_PROTOCOL_VERSION),
        streamId: z.string().min(1),
        latestSequence: z.number().int().nonnegative()
      })
      .strict(),
    restrictedRpcChannels: z.array(z.string()).optional(),
    rpcCapabilities: z.array(z.string()).optional(),
    rpcChannels: z.array(z.string()).superRefine((channels, context) => {
      for (const channel of channels) {
        if (isWebRpcChannel(channel)) continue
        context.addIssue({
          code: 'custom',
          message: `Unknown Web RPC channel: ${channel}`
        })
      }
    })
  })
  .passthrough()

export const webRpcEventSchema = z
  .object({
    kind: z.literal('event'),
    protocolVersion: z.literal(WEB_EVENT_STREAM_PROTOCOL_VERSION),
    streamId: z.string().min(1),
    sequence: z.number().int().positive(),
    channel: z.string().refine(isWebRpcEventChannel, 'Unknown Web RPC event channel'),
    payload: webRpcValueSchema
  })
  .strict()

export const webRpcEventReadySchema = z
  .object({
    kind: z.literal('ready'),
    protocolVersion: z.literal(WEB_EVENT_STREAM_PROTOCOL_VERSION),
    streamId: z.string().min(1),
    latestSequence: z.number().int().nonnegative()
  })
  .strict()

export const webRpcEventHeartbeatSchema = z
  .object({
    kind: z.literal('heartbeat'),
    protocolVersion: z.literal(WEB_EVENT_STREAM_PROTOCOL_VERSION),
    streamId: z.string().min(1),
    latestSequence: z.number().int().nonnegative()
  })
  .strict()

export const webRpcEventResyncRequiredSchema = z
  .object({
    kind: z.literal('resync-required'),
    protocolVersion: z.literal(WEB_EVENT_STREAM_PROTOCOL_VERSION),
    streamId: z.string().min(1),
    latestSequence: z.number().int().nonnegative(),
    reason: z.enum(['stream-changed', 'cursor-expired'])
  })
  .strict()

export const webRpcEventMessageSchema = z.discriminatedUnion('kind', [
  webRpcEventSchema,
  webRpcEventReadySchema,
  webRpcEventHeartbeatSchema,
  webRpcEventResyncRequiredSchema
])

export type WebRpcRequest = z.infer<typeof webRpcRequestSchema>
export type WebRpcResponse = z.infer<typeof webRpcResponseSchema>
export type WebRpcEventMessage = z.infer<typeof webRpcEventMessageSchema>

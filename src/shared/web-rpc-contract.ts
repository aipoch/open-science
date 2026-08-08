import { z } from 'zod'

import { APPLICATION_COMMAND_ERROR_CODES } from './application-command-contract'
import { WEB_EVENT_CHANNELS, WEB_INVOKE_CHANNELS } from './web-api-map.generated'

export const WEB_RPC_PROTOCOL_VERSION = 1 as const
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
  'file:save-session-artifacts',
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
    versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string() }).strict(),
    rpcProtocolVersion: z.literal(WEB_RPC_PROTOCOL_VERSION),
    restrictedRpcChannels: z.array(z.string()).optional(),
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
    protocolVersion: z.literal(WEB_RPC_PROTOCOL_VERSION),
    channel: z.string().refine(isWebRpcEventChannel, 'Unknown Web RPC event channel'),
    payload: webRpcValueSchema
  })
  .strict()

export type WebRpcRequest = z.infer<typeof webRpcRequestSchema>
export type WebRpcResponse = z.infer<typeof webRpcResponseSchema>

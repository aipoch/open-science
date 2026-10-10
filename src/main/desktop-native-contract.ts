import {
  observationNativeRequestSchema,
  parseObservationNativeResult
} from './observation-desktop/contract'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const text = z.string().max(32_768)
const path = text.refine(isAbsolute, 'Expected an absolute local path.')
const filters = z
  .array(z.object({ name: text, extensions: z.array(text).max(32) }).strict())
  .max(32)
export const desktopOpenOptionsSchema = z
  .object({
    title: text.optional(),
    defaultPath: text.optional(),
    filters: filters.optional(),
    properties: z
      .array(
        z.enum([
          'openFile',
          'openDirectory',
          'multiSelections',
          'createDirectory',
          'showHiddenFiles'
        ])
      )
      .max(5)
      .optional()
  })
  .strict()
export const desktopSaveOptionsSchema = z
  .object({
    title: text.optional(),
    defaultPath: text.optional(),
    filters: filters.optional()
  })
  .strict()
export const desktopMessageOptionsSchema = z
  .object({
    type: z.enum(['none', 'info', 'error', 'question', 'warning']).optional(),
    title: text.optional(),
    message: text,
    detail: text.optional(),
    buttons: z.array(text).max(16).optional(),
    defaultId: z.number().int().nonnegative().optional(),
    cancelId: z.number().int().nonnegative().optional()
  })
  .strict()
export const reviewerDesktopRenderSchema = z
  .object({
    artifactVersionId: text.min(1),
    format: z.enum(['docx', 'pptx']),
    pages: z.array(z.number().int().positive()).min(1).max(32),
    includePreview: z.boolean(),
    maxBytes: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
    resource: z
      .object({
        id: text.min(1),
        url: text.url(),
        size: z
          .number()
          .int()
          .nonnegative()
          .max(40 * 1024 * 1024),
        mimeType: text.min(1),
        version: z.number().finite()
      })
      .strict()
      .refine((resource) => {
        const url = new URL(resource.url)
        return url.protocol === 'open-science-preview:' && url.hostname === resource.id
      })
  })
  .strict()

const reviewerDesktopResultSchema = z
  .object({
    pageCount: z.number().int().positive(),
    pageCountComplete: z.boolean().optional(),
    pages: z
      .array(
        z
          .object({
            pageNumber: z.number().int().positive(),
            text: z.string().max(8 * 1024 * 1024)
          })
          .strict()
      )
      .max(32),
    media: z
      .array(
        z
          .object({
            pageNumber: z.number().int().positive(),
            data: z.string().max(8 * 1024 * 1024),
            mimeType: z.literal('image/jpeg')
          })
          .strict()
      )
      .max(32)
      .optional(),
    limitations: z
      .array(
        z
          .object({
            kind: z.enum(['truncated', 'budget-exhausted']),
            subjectId: text.optional(),
            detail: text.optional()
          })
          .strict()
      )
      .max(64)
      .optional()
  })
  .strict()

export const desktopNativeOperationSchema = z.discriminatedUnion('operation', [
  z
    .object({ operation: z.literal('observation'), request: observationNativeRequestSchema })
    .strict(),
  z
    .object({
      operation: z.literal('renderer-flush'),
      policy: z.enum(['ordinary-shutdown', 'data-root-handoff']).optional()
    })
    .strict(),
  z.object({ operation: z.literal('renderer-flush-aborted') }).strict(),
  z.object({ operation: z.literal('runtime-relaunch') }).strict(),
  z
    .object({ operation: z.literal('reviewer-render'), input: reviewerDesktopRenderSchema })
    .strict(),
  z
    .object({
      operation: z.literal('office-frame'),
      runtimeUrl: text.url().refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'open-science-office-preview:' &&
          url.hostname === 'runtime' &&
          url.pathname === '/office-preview.html' &&
          Boolean(url.searchParams.get('sessionId'))
        )
      })
    })
    .strict(),
  z
    .object({ operation: z.literal('process-memory'), processId: z.number().int().positive() })
    .strict(),
  z.object({ operation: z.literal('open-path'), path }).strict(),
  z.object({ operation: z.literal('reveal-path'), path }).strict(),
  z
    .object({
      operation: z.literal('open-external'),
      url: text
        .url()
        .refine(
          (value) => ['https:', 'http:'].includes(new URL(value).protocol),
          'Expected an HTTP(S) authorization URL.'
        )
    })
    .strict(),
  z.object({ operation: z.literal('notification-focus') }).strict(),
  z.object({ operation: z.literal('notification-main-focus') }).strict(),
  z
    .object({ operation: z.literal('notification-visible'), sessionId: text.min(1).max(512) })
    .strict(),
  z
    .object({
      operation: z.literal('notification-badge'),
      count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z.object({ operation: z.literal('notification-availability') }).strict(),
  z.object({ operation: z.literal('notification-test'), title: text, body: text }).strict(),
  z
    .object({
      operation: z.literal('notification-show'),
      token: z.string().uuid(),
      title: text,
      body: text
    })
    .strict(),
  z
    .object({
      operation: z.literal('notification-attention'),
      action: z.enum(['request', 'clear'])
    })
    .strict(),
  z.object({ operation: z.literal('notification-activate'), sessionId: text.optional() }).strict(),
  z.object({ operation: z.literal('open-dialog'), options: desktopOpenOptionsSchema }).strict(),
  z.object({ operation: z.literal('save-dialog'), options: desktopSaveOptionsSchema }).strict(),
  z.object({ operation: z.literal('message-box'), options: desktopMessageOptionsSchema }).strict(),
  z
    .object({
      operation: z.literal('conversation-pdf'),
      htmlPath: path,
      timeoutMs: z.number().int().positive().max(120_000),
      timeoutMessage: text
    })
    .strict()
])
export const desktopNativeRequestSchema = z
  .object({
    kind: z.literal('native-request'),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    clientId: z.string().uuid().optional(),
    request: desktopNativeOperationSchema
  })
  .strict()
export const desktopNativeResponseSchema = z
  .object({
    kind: z.literal('native-response'),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    outcome: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), message: text }).strict()
    ])
  })
  .strict()
export const desktopNativeCancelSchema = z
  .object({
    kind: z.literal('native-cancel'),
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type DesktopNativeOperation = z.infer<typeof desktopNativeOperationSchema>
export type DesktopNativeRequest = z.infer<typeof desktopNativeRequestSchema>
export type DesktopNativeHandler = (
  request: DesktopNativeRequest,
  signal: AbortSignal
) => Promise<unknown>

// The runtime validates native results before they can become file destinations or PDF content.
export function parseDesktopNativeResult(
  request: DesktopNativeOperation,
  result: unknown
): unknown {
  switch (request.operation) {
    case 'observation':
      return parseObservationNativeResult(request.request, result)
    case 'runtime-relaunch':
    case 'renderer-flush':
      return z.boolean().parse(result)
    case 'renderer-flush-aborted':
      return z.null().parse(result)
    case 'reviewer-render': {
      const value = reviewerDesktopResultSchema.parse(result)
      const pages = new Set(request.input.pages)
      if (
        value.pages.some((page) => !pages.has(page.pageNumber)) ||
        value.media?.some((page) => !pages.has(page.pageNumber)) ||
        value.pages.reduce((bytes, page) => bytes + Buffer.byteLength(page.text, 'utf8'), 0) +
          (value.media?.reduce((bytes, page) => bytes + page.data.length, 0) ?? 0) >
          request.input.maxBytes
      )
        throw new Error('Reviewer native result exceeded its requested pages or byte budget.')
      return value
    }
    case 'office-frame':
      return (
        z
          .object({
            frameProcessId: z.number().int().nonnegative(),
            parentProcessId: z.number().int().nonnegative()
          })
          .strict()
          .nullable()
          .parse(result) ?? undefined
      )
    case 'process-memory':
      return z.number().finite().nonnegative().parse(result)
    case 'open-path':
      return text.parse(result)
    case 'reveal-path':
    case 'open-external':
      return z.null().parse(result)
    case 'notification-main-focus':
    case 'notification-visible':
    case 'notification-focus':
      return z.boolean().parse(result)
    case 'notification-availability':
      return z.enum(['supported', 'unavailable']).parse(result)
    case 'notification-test':
      return z.enum(['shown', 'failed', 'unconfirmed', 'unavailable']).parse(result)
    case 'notification-badge':
    case 'notification-show':
    case 'notification-attention':
    case 'notification-activate':
      return z.null().parse(result)
    case 'open-dialog':
      return z
        .object({ canceled: z.boolean(), filePaths: z.array(path).max(4096) })
        .strict()
        .parse(result)
    case 'save-dialog':
      return z.object({ canceled: z.boolean(), filePath: path.optional() }).strict().parse(result)
    case 'message-box':
      return z
        .object({
          response: z
            .number()
            .int()
            .nonnegative()
            .max(Math.max(0, (request.options.buttons?.length ?? 1) - 1))
        })
        .strict()
        .parse(result)
    case 'conversation-pdf':
      return z.literal(`${request.htmlPath}.pdf`).parse(result)
  }
}

// Preserve the invoking document through async export workflows without putting Electron objects
// or window IDs into business owners. A navigation aborts this exact caller lease.
const desktopCaller = new AsyncLocalStorage<{ clientId: string; signal: AbortSignal }>()
export const currentDesktopCaller = (): { clientId: string; signal: AbortSignal } | undefined =>
  desktopCaller.getStore()
export function withDesktopCaller<T>(
  caller: { clientId: string; signal: AbortSignal },
  work: () => T
): T {
  return desktopCaller.run(caller, work)
}

// Upload progress belongs to one invoking document, never the broadcast/replay stream. The upload
// owner retains status and cancellation; dropping a late UI projection does not change transfer state.
export const desktopUploadProgressSchema = z
  .object({
    kind: z.literal('upload-progress'),
    clientId: z.string().uuid(),
    progress: z
      .object({
        transferId: text.min(1),
        name: text,
        receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      })
      .strict()
  })
  .strict()

// As with broadcast events, feature owners validate payloads. This private envelope preserves the
// document audience; authoritative check state remains queryable through the existing commands.
export const desktopDocumentEventSchema = z
  .object({
    kind: z.literal('document-event'),
    clientId: z.string().uuid(),
    channel: z.enum([
      'artifacts:reproducibility-check-changed',
      'specialist:marketplace-download-progress',
      'office-preview:state'
    ]),
    payload: z.unknown()
  })
  .strict()

export const desktopNotificationActionSchema = z
  .object({
    kind: z.literal('notification-action'),
    token: z.string().uuid(),
    action: z.enum(['clicked', 'closed'])
  })
  .strict()

export const desktopNotificationViewSchema = z
  .object({
    kind: z.literal('notification-view'),
    reason: z.enum(['view', 'focus', 'window-created']),
    visibleSessionId: z.string().trim().min(1).max(512).optional()
  })
  .strict()

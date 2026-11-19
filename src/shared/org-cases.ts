import { z } from 'zod'
import type { LabView } from './lab'

export const ORG_CASE_DEFAULT_PAGE_SIZE = 20
export const ORG_CASE_MAX_PAGE_SIZE = 50
export const ORG_CASE_MAX_QUERY_LENGTH = 200
export const ORG_CASE_NAME_MAX_LENGTH = 200
export const ORG_CASE_DESCRIPTION_MAX_LENGTH = 4000
export const ORG_CASE_ID_REGEX = /^[A-Za-z0-9_-]{3,96}$/
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i

export function unicodeCharacterLength(value: string): number {
  return Array.from(value).length
}

export function clampOrgCaseName(value: string | undefined, fallback = 'Session'): string {
  const cleanFallback = Array.from((fallback || 'Session').replaceAll('\0', '').trim())
    .slice(0, ORG_CASE_NAME_MAX_LENGTH)
    .join('')
    .trim()
  const cleaned = (value ?? '').replaceAll('\0', '').trim()
  if (!cleaned) return cleanFallback || 'Session'
  return (
    Array.from(cleaned).slice(0, ORG_CASE_NAME_MAX_LENGTH).join('').trim() ||
    cleanFallback ||
    'Session'
  )
}

export function isValidOrgCaseId(value: string): boolean {
  return ORG_CASE_ID_REGEX.test(value)
}

export function normalizeOrgCaseSearchQuery(value?: string): string {
  return value ? value.trim() : ''
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]'
}

export function isAllowedOrgCaseDownloadUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

/**
 * Computes an identity key representing the active Lab connection/session context so both main and
 * renderer can discard stale org-case searches and cancel in-flight downloads when the user signs
 * out or switches account/organization/server.
 */
export function buildLabConnectionKey(
  lab: Pick<LabView, 'state' | 'serverUrl' | 'accountId' | 'orgId'> | undefined
): string {
  if (!lab) return 'none'
  if (lab.state !== 'authenticated') return `${lab.state}:${lab.serverUrl ?? ''}`
  return JSON.stringify([lab.state, lab.serverUrl ?? '', lab.orgId ?? '', lab.accountId])
}

export const orgCaseIdSchema = z.string().regex(ORG_CASE_ID_REGEX)

export const listOrgCasesQuerySchema = z.object({
  q: z
    .string()
    .refine((value) => !value.includes('\0'), {
      message: 'Search query must not contain NUL characters.'
    })
    .refine((value) => Array.from(value.trim()).length <= ORG_CASE_MAX_QUERY_LENGTH, {
      message: `Search query must be at most ${ORG_CASE_MAX_QUERY_LENGTH} characters.`
    })
    .optional(),
  page: z.number().int().min(1).max(2_147_483_647).optional(),
  pageSize: z.number().int().min(1).max(ORG_CASE_MAX_PAGE_SIZE).optional()
})

export const orgCaseOwnerSchema = z.object({
  id: z.string().min(1),
  display_name: z
    .string()
    .nullish()
    .transform((value) => value ?? '')
})

export const orgCaseOmissionSchema = z.object({
  kind: z.string().min(1),
  description: z
    .string()
    .nullish()
    .transform((value) => value ?? '')
})

export const orgCaseSummarySchema = z.object({
  schema_version: z.number().int().min(1),
  features: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
  file_count: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  excluded_files: z.number().int().nonnegative(),
  omission_count: z.number().int().nonnegative(),
  omissions: z
    .array(orgCaseOmissionSchema)
    .nullish()
    .transform((value) => value ?? [])
})

export const orgCaseItemSchema = z.object({
  id: orgCaseIdSchema,
  name: z.string().min(1),
  code: z.string().min(1),
  description: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  size_bytes: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(SHA256_HEX_REGEX)
    .transform((value) => value.toLowerCase()),
  created_at: z.string().min(1),
  owner: orgCaseOwnerSchema,
  can_delete: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined),
  summary: orgCaseSummarySchema
})

export const orgCasesPageSchema = z.object({
  items: z.array(orgCaseItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  page_size: z.number().int().min(1).max(ORG_CASE_MAX_PAGE_SIZE)
})

export const orgCaseDetailSchema = orgCaseItemSchema.extend({
  original_filename: z
    .string()
    .nullish()
    .transform((value) => value ?? '')
})

export const orgCaseDetailResponseSchema = z.object({
  case: orgCaseDetailSchema
})

export const orgCaseDownloadTicketSchema = z.object({
  url: z.string().refine(isAllowedOrgCaseDownloadUrl, {
    message: 'Download URL must use https (or localhost http for development).'
  }),
  expires_at: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'Download ticket expiration must be a valid ISO timestamp.'
  }),
  size_bytes: z.number().int().positive(),
  sha256: z
    .string()
    .regex(SHA256_HEX_REGEX)
    .transform((value) => value.toLowerCase()),
  name: z.string().min(1),
  code: z.string().min(1)
})

export const orgCaseUploadMetadataSchema = z
  .object({
    name: z
      .string()
      .refine((value) => !value.includes('\0'), {
        message: 'Case name must not contain NUL characters.'
      })
      .transform((value) => value.trim())
      .refine((value) => value.length >= 1, {
        message: 'Case name is required.'
      })
      .refine((value) => unicodeCharacterLength(value) <= ORG_CASE_NAME_MAX_LENGTH, {
        message: `Case name must be at most ${ORG_CASE_NAME_MAX_LENGTH} characters.`
      }),
    description: z
      .string()
      .refine((value) => !value.includes('\0'), {
        message: 'Case description must not contain NUL characters.'
      })
      .transform((value) => value.trim())
      .refine((value) => unicodeCharacterLength(value) <= ORG_CASE_DESCRIPTION_MAX_LENGTH, {
        message: `Case description must be at most ${ORG_CASE_DESCRIPTION_MAX_LENGTH} characters.`
      })
      .default('')
  })
  .strict()

export const orgCaseUploadedSummarySchema = z
  .object({
    id: orgCaseIdSchema,
    name: z.string().min(1),
    code: z.string().min(1)
  })
  .strict()

export const orgCaseErrorCodeSchema = z.enum([
  'unconfigured',
  'signed-out',
  'expired',
  'storage-not-configured',
  'storage-unavailable',
  'not-found',
  'forbidden',
  'license-inactive',
  'seat-required',
  'org-inactive',
  'account-disabled',
  'no-organization',
  'rate-limited',
  'package-too-large',
  'package-invalid',
  'unsupported-package',
  'upload-in-progress',
  'upload-timeout',
  'network',
  'timeout',
  'cancelled',
  'invalid-response',
  'verification-failed',
  'url-expired',
  'capacity',
  'import-busy',
  'unknown'
])

export type OrgCaseOwner = z.infer<typeof orgCaseOwnerSchema>
export type OrgCaseOmission = z.infer<typeof orgCaseOmissionSchema>
export type OrgCaseSummary = z.infer<typeof orgCaseSummarySchema>
export type OrgCaseItem = z.infer<typeof orgCaseItemSchema>
export type OrgCasesPage = z.infer<typeof orgCasesPageSchema>
export type OrgCaseDetail = z.infer<typeof orgCaseDetailSchema>
export type OrgCaseDownloadTicket = z.infer<typeof orgCaseDownloadTicketSchema>
export type ListOrgCasesQuery = z.infer<typeof listOrgCasesQuerySchema>
export type OrgCaseUploadMetadata = z.infer<typeof orgCaseUploadMetadataSchema>
export type OrgCaseUploadedSummary = z.infer<typeof orgCaseUploadedSummarySchema>
export type OrgCaseErrorCode = z.infer<typeof orgCaseErrorCodeSchema>

export type OrgCaseDownloadState =
  'preparing' | 'downloading' | 'verifying' | 'handed-off' | 'cancelled' | 'failed'

export type OrgCaseDownloadSnapshot = {
  caseId: string
  name: string
  code: string
  state: OrgCaseDownloadState
  completedBytes: number
  totalBytes?: number
  errorCode?: OrgCaseErrorCode
  message?: string
}

export const listOrgCasesResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), page: orgCasesPageSchema }),
  z.object({
    ok: z.literal(false),
    errorCode: orgCaseErrorCodeSchema,
    message: z.string().optional()
  })
])

export const getOrgCaseDetailResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), case: orgCaseDetailSchema }),
  z.object({
    ok: z.literal(false),
    errorCode: orgCaseErrorCodeSchema,
    message: z.string().optional()
  })
])

export const importOrgCaseResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('handed-off'), caseId: orgCaseIdSchema }),
  z.object({ status: z.literal('cancelled'), caseId: orgCaseIdSchema }),
  z.object({
    status: z.literal('failed'),
    caseId: orgCaseIdSchema,
    errorCode: orgCaseErrorCodeSchema,
    message: z.string().optional()
  })
])

export const cancelOrgCaseImportResultSchema = z.object({
  cancelled: z.boolean()
})

export type ListOrgCasesResult = z.infer<typeof listOrgCasesResultSchema>
export type GetOrgCaseDetailResult = z.infer<typeof getOrgCaseDetailResultSchema>
export type ImportOrgCaseResult = z.infer<typeof importOrgCaseResultSchema>
export type CancelOrgCaseImportResult = z.infer<typeof cancelOrgCaseImportResultSchema>

export const orgCaseCommandContracts = {
  list: {
    args: z.union([z.tuple([]), z.tuple([listOrgCasesQuerySchema.optional()])]),
    result: listOrgCasesResultSchema
  },
  detail: {
    args: z.tuple([orgCaseIdSchema]),
    result: getOrgCaseDetailResultSchema
  },
  import: {
    args: z.tuple([orgCaseIdSchema]),
    result: importOrgCaseResultSchema
  },
  cancelImport: {
    args: z.union([z.tuple([]), z.tuple([orgCaseIdSchema.optional()])]),
    result: cancelOrgCaseImportResultSchema
  }
}

export function parseOrgCasesPage(raw: unknown): OrgCasesPage | null {
  const parsed = orgCasesPageSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseOrgCaseDetailResponse(raw: unknown): OrgCaseDetail | null {
  const parsed = orgCaseDetailResponseSchema.safeParse(raw)
  return parsed.success ? parsed.data.case : null
}

export function parseOrgCaseDownloadTicket(raw: unknown): OrgCaseDownloadTicket | null {
  const parsed = orgCaseDownloadTicketSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

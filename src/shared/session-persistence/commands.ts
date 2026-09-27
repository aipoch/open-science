import {
  type PersistedChatSession,
  type SessionSummary,
  type SaveSessionOptions,
  delegationPolicySchema
} from './session'
import type { PersistedChatMessage, PersistedToolActivity, PersistedArtifact } from './message'
import type { PersistedSessionManifest } from '../session-persistence-envelope'
import { z } from 'zod'
import { MAX_SESSION_PDF_CONTEXTS, type SessionRuntimeContext } from '../session-runtime-context'
import {
  type RuntimeCodec,
  defineApplicationCommandContract,
  validationCodec
} from '../application-command-contract'
import { persistedChatSessionCodec } from './file-codec'
import { sanitizeSessionRuntimeContext } from './runtime-context'

// Internal Task admission command; not part of the persisted Session format.
export type BindTaskSessionRequest = Readonly<{
  session: Pick<
    PersistedChatSession,
    | 'id'
    | 'projectId'
    | 'cwd'
    | 'permissionProfile'
    | 'agentFrameworkId'
    | 'agentBackendId'
    | 'providerSessionId'
    | 'providerContinuityToken'
    | 'agentConfiguration'
    | 'updatedAt'
  >
  contextReset: boolean
}>

export type AdmitTaskSessionTurnRequest = Readonly<{
  session: PersistedChatSession
  contextReset: boolean
}>

export type StageTaskSessionCompletionRequest = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  message?: PersistedChatMessage
  activities: readonly PersistedToolActivity[]
  clearPendingHistoryReplay?: true
  updatedAt: number
}>

export type SettleTaskSessionCompletionRequest = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  taskRunCommitId: string
  messageId?: string
  artifacts: readonly PersistedArtifact[]
  updatedAt: number
}>

export type FailTaskSessionRunRequest = SettleTaskSessionCompletionRequest &
  Readonly<{
    error: string
    errorReportable?: false
  }>

// Renderer-safe diagnostics for durable Session files omitted during startup hydration.
export type SessionLoadWarning =
  | {
      kind: 'corrupt' | 'unreadable'
      projectId: string
      fileName: string
      recovered: boolean
    }
  | {
      kind: 'unsupported-version'
      projectId: string
      fileName: string
      recovered: false
    }
  | {
      kind: 'too-large'
      projectId: string
      fileName: string
      recovered: false
    }
  | {
      kind: 'manifest-corrupt' | 'manifest-unreadable'
      fileName: string
      recovered: boolean
    }

export type SessionLoadFailure = 'startup-reconciliation-failed'

export type SessionLoadDiagnostics = {
  isComplete: boolean
  warnings: SessionLoadWarning[]
  failure?: SessionLoadFailure
  // The outer startup boundary stamps this after replaying pending Project deletions. Session and
  // Project deletion IPC both enforce the same prerequisite, independently of scan completeness.
  isProjectDeletionRecoveryComplete?: boolean
}

// IPC payloads for the per-session persistence surface.
export type LoadAllSessionsResult = {
  sessions: PersistedChatSession[]
  manifest: PersistedSessionManifest
  diagnostics?: SessionLoadDiagnostics
}

export type ListSessionSummariesResult = {
  sessions: SessionSummary[]
  manifest: PersistedSessionManifest
  diagnostics?: SessionLoadDiagnostics
}

export type LoadSessionRequest = {
  projectId: string
  sessionId: string
}

export type OpenSessionRecoveryFolderRequest = {
  projectId: string
}

const sessionPdfContextSourceSchema = z.union([
  z
    .object({
      sourceKind: z.enum(['artifact-version', 'upload-version']),
      sourceFileId: z.string().min(1),
      sourceVersionId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      sourceKind: z.literal('literature-attachment-version'),
      sourceFileId: z.string().min(1).optional(),
      sourceVersionId: z.string().min(1)
    })
    .strict()
])

const pendingSessionPdfContextCandidateSchema = z
  .object({
    attachmentId: z.string().min(1),
    path: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1).optional()
  })
  .strict()

export const filterSessionPdfContextCandidatesRequestSchema = z
  .object({
    projectId: z.string().min(1),
    sources: z.array(sessionPdfContextSourceSchema).max(100),
    pendingAttachments: z.array(pendingSessionPdfContextCandidateSchema).max(3).optional()
  })
  .strict()

export const filterSessionPdfContextCandidatesResultSchema = z
  .object({
    sources: z.array(sessionPdfContextSourceSchema).max(100),
    pendingAttachmentIds: z.array(z.string().min(1)).max(3),
    unavailableSources: z.array(sessionPdfContextSourceSchema).max(100).optional()
  })
  .strict()

export const linkSessionPdfContextRequestSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    sources: z.array(sessionPdfContextSourceSchema).min(1).max(MAX_SESSION_PDF_CONTEXTS),
    excludeSinglePage: z.boolean().optional()
  })
  .strict()

export const unlinkSessionPdfContextRequestSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    bindingId: z.string().min(1)
  })
  .strict()

export const deleteSessionRequestSchema = z
  .object({ projectId: z.string().min(1), sessionId: z.string().min(1) })
  .strict()

// Manual details edits mutate only authority-owned display fields server-side, so they carry no
// whole-Session revision: concurrent unrelated writes advance that revision constantly and must
// not fence the edit.
const editSessionDetailsRequestFields = {
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  description: z.string()
} as const

// Web RPC v1 originally exposed this command without optimistic edit baselines. Accept that exact
// legacy shape alongside the protected shape; a partial baseline is neither valid nor useful.
export const editSessionDetailsRequestSchema = z.union([
  z
    .object({
      ...editSessionDetailsRequestFields,
      expectedTitle: z.string(),
      expectedDescription: z.string()
    })
    .strict(),
  z
    .object({
      ...editSessionDetailsRequestFields
    })
    .strict()
])

export type DeleteSessionRequest = z.infer<typeof deleteSessionRequestSchema>

// Main-process deletion failures must preserve the irreversible JSON commit boundary. Only the
// plain SessionDeletionResult is sent across IPC; this error and its cause stay in main.
export class SessionDeletionCommittedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'SessionDeletionCommittedError'
  }
}

// zod v4 requires unique discriminator values, and both failure branches share status 'failed',
// so this stays a plain union over the exact owner-produced shapes.
export const sessionDeletionResultSchema = z.union([
  z
    .object({
      status: z.literal('deleted'),
      runtimeDetached: z.literal(true),
      cleanupPending: z.literal(true).optional()
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      reason: z.literal('runtime'),
      runtimeDetached: z.literal(false)
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      reason: z.literal('persistence'),
      runtimeDetached: z.literal(true)
    })
    .strict()
])

export type SessionDeletionResult = z.infer<typeof sessionDeletionResultSchema>

export const updateSessionArchiveRequestSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    archived: z.boolean(),
    expectedRevision: z.number().int().nonnegative()
  })
  .strict()

export const saveSessionManifestRequestSchema = z
  .object({
    lastSessionId: z.string().min(1).optional()
  })
  .strict()

export type UpdateSessionArchiveRequest = z.infer<typeof updateSessionArchiveRequestSchema>

export type SaveSessionManifestRequest = z.infer<typeof saveSessionManifestRequestSchema>

const saveSessionArgsCodec: RuntimeCodec<
  readonly [session: PersistedChatSession, options?: SaveSessionOptions]
> = Object.freeze({
  parse: (value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
      throw new Error('Invalid Session save arguments.')
    }
    const session = persistedChatSessionCodec.parse(value[0])
    return value.length === 1 ? [session] : [session, value[1] as SaveSessionOptions | undefined]
  }
})

const updateSessionConfigurationArgsCodec: RuntimeCodec<
  readonly [session: PersistedChatSession, expectedRevision: number]
> = Object.freeze({
  parse: (value) => {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error('Invalid Session configuration update arguments.')
    }
    return [
      persistedChatSessionCodec.parse(value[0]),
      z.number().int().nonnegative().parse(value[1])
    ]
  }
})

// Runtime-validated contracts for Electron-facing Session commands. Request schemas double as wire
// types, while Session-bearing commands share the recursive persistence codec above.
export const sessionApplicationCommandContracts = Object.freeze({
  filterPdfContextCandidates: defineApplicationCommandContract(
    validationCodec(z.tuple([filterSessionPdfContextCandidatesRequestSchema])),
    validationCodec(filterSessionPdfContextCandidatesResultSchema)
  ),
  linkPdfContext: defineApplicationCommandContract(
    validationCodec(z.tuple([linkSessionPdfContextRequestSchema])),
    validationCodec(
      z.custom<SessionRuntimeContext>((value) => sanitizeSessionRuntimeContext(value) !== undefined)
    )
  ),
  unlinkPdfContext: defineApplicationCommandContract(
    validationCodec(z.tuple([unlinkSessionPdfContextRequestSchema])),
    validationCodec(
      z.custom<SessionRuntimeContext>((value) => sanitizeSessionRuntimeContext(value) !== undefined)
    )
  ),
  delete: defineApplicationCommandContract(
    validationCodec(z.tuple([deleteSessionRequestSchema])),
    validationCodec(sessionDeletionResultSchema)
  ),
  saveManifest: defineApplicationCommandContract(
    validationCodec(z.tuple([saveSessionManifestRequestSchema])),
    validationCodec(z.void())
  ),
  updateArchive: defineApplicationCommandContract(
    validationCodec(z.tuple([updateSessionArchiveRequestSchema])),
    persistedChatSessionCodec
  ),
  save: defineApplicationCommandContract(saveSessionArgsCodec, persistedChatSessionCodec),
  updateConfiguration: defineApplicationCommandContract(
    updateSessionConfigurationArgsCodec,
    persistedChatSessionCodec
  ),
  editDetails: defineApplicationCommandContract(
    validationCodec(z.tuple([editSessionDetailsRequestSchema])),
    persistedChatSessionCodec
  ),
  setDelegationPolicy: defineApplicationCommandContract(
    validationCodec(z.tuple([z.string(), z.string(), delegationPolicySchema])),
    persistedChatSessionCodec
  )
})

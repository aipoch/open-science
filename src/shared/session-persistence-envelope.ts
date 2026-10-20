import type {
  MaterializedPersistedChatSession,
  PersistedChatSession
} from './session-persistence/session'

// One JSON file per session (sessions/<projectId>/<sessionId>.json) carries this envelope version.
export const SESSION_FILE_VERSION = 2
// Small manifest (sessions/manifest.json) that restores the user's last-open project + session.
export const SESSION_MANIFEST_VERSION = 1

// Durable envelope for a single session file; the version allows future per-file migrations.
export type PersistedSessionFile = {
  version: typeof SESSION_FILE_VERSION
  session: MaterializedPersistedChatSession
}

export type SessionFileReadOptions = {
  preserveLegacyUploadPaths?: boolean
  preserveRuntimeState?: boolean | ((sessionId: string) => boolean)
}

export type SessionFileDecodeResult =
  | { status: 'ok'; session: PersistedChatSession }
  | { status: 'invalid' }
  | { status: 'unsupported-version' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

// Decodes one Session file without treating a valid future envelope as corrupt. Bare Sessions and
// v1 envelopes are released historical formats; every other past or malformed version fails closed.
export const decodeSessionEnvelope = (
  value: unknown
):
  | { status: 'ok'; session: Record<string, unknown> }
  | { status: 'invalid' | 'unsupported-version' } => {
  if (!isRecord(value)) return { status: 'invalid' }

  const hasEnvelopeField = Object.hasOwn(value, 'version') || Object.hasOwn(value, 'session')
  if (hasEnvelopeField) {
    const version = value.version
    if (Number.isSafeInteger(version) && (version as number) > SESSION_FILE_VERSION) {
      return { status: 'unsupported-version' }
    }
    if ((version !== 1 && version !== SESSION_FILE_VERSION) || !isRecord(value.session)) {
      return { status: 'invalid' }
    }
  }

  return {
    status: 'ok',
    session: hasEnvelopeField ? (value.session as Record<string, unknown>) : value
  }
}

// Tiny app-level pointer restoring the last-open Session after a restart.
export type PersistedSessionManifest = {
  version: typeof SESSION_MANIFEST_VERSION
  lastSessionId?: string
}

// Canonical empty manifest for missing/unusable manifest files.
export const createEmptySessionManifest = (): PersistedSessionManifest => ({
  version: SESSION_MANIFEST_VERSION
})

// Rebuilds a manifest from allowed string fields, dropping anything else.
export const normalizeSessionManifest = (value: unknown): PersistedSessionManifest => {
  if (!isRecord(value)) return createEmptySessionManifest()

  const manifest: PersistedSessionManifest = { version: SESSION_MANIFEST_VERSION }
  const lastSessionId = asString(value.lastSessionId)

  if (lastSessionId) manifest.lastSessionId = lastSessionId

  return manifest
}

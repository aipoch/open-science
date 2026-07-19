// Credential/config env vars that Codex would otherwise consume during an ACP smoke check. Stripped so
// the pairing test never authenticates with (or persists) the host's API key — the smoke only proves
// the adapter and its native Codex can complete an initialize handshake.
//
// Tree teardown for the smoke checks reuses the robust, awaited `terminateProcessTree` from
// `../process-tree` (it walks the whole tree — taskkill /T on Windows; on POSIX it enumerates
// descendants via `ps`, sends SIGTERM, then escalates survivors to SIGKILL — and reports whether the
// tree was cleanly reaped) rather than a fire-and-forget kill here.
const CODEX_CREDENTIAL_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_CONFIG',
  'DEFAULT_AUTH_REQUEST'
] as const

// Returns a copy of `env` with Codex credential/config vars removed. Callers set an explicit CODEX_HOME
// (an ephemeral scratch dir) afterwards.
export const stripCodexCredentialEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env }
  for (const key of CODEX_CREDENTIAL_ENV_KEYS) delete copy[key]
  return copy
}

import { toAcpTurnTokenUsage, type AcpTurnTokenUsage } from '../../shared/acp'

// Codex's raw Responses counter includes cached input, but pinned codex-acp 1.1.4 subtracts that
// cache before publishing PromptResponse.usage. Preserve the adapter's mutually exclusive categories;
// subtracting here again would discard cache-heavy turns as negative input.
export const toCodexTurnTokenUsage = (value: unknown): AcpTurnTokenUsage | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return toAcpTurnTokenUsage(value)
  }
  const usage = value as Record<string, unknown>
  return toAcpTurnTokenUsage({
    ...usage,
    ...(usage.cachedReadTokens != null && usage.cachedWriteTokens == null
      ? { cachedWriteTokens: 0 }
      : {})
  })
}

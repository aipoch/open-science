import { toAcpTurnTokenUsage, type AcpTurnTokenUsage } from '../../shared/acp'

// Codex's raw Responses counter includes cached input, but pinned codex-acp 1.1.4 subtracts that
// cache before publishing PromptResponse.usage. Preserve the adapter's mutually exclusive categories;
// subtracting here again would discard cache-heavy turns as negative input.
export const toCodexTurnTokenUsage = (value: unknown): AcpTurnTokenUsage | undefined =>
  toAcpTurnTokenUsage(value)

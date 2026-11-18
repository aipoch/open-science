export const codeBuddyAccounts = {
  internal: { id: 'builtin-codebuddy-china', name: 'CodeBuddy (China)' },
  external: { id: 'builtin-codebuddy-international', name: 'CodeBuddy (International)' }
} as const

export type CodeBuddySite = keyof typeof codeBuddyAccounts
// Small chat-model fallback from @tencent-ai/codebuddy-code 2.138.0's
// product.internal.json and product.json. A site's live catalog supersedes it.
export const codeBuddyBaseModels: Record<CodeBuddySite, readonly string[]> = {
  internal: ['hy3', 'glm-5.2', 'deepseek-v4-pro'],
  external: ['default-model', 'gpt-5.5', 'gemini-3.1-pro']
}

export type CodeBuddyAccountRequest = {
  site: CodeBuddySite
  action: 'login' | 'logout' | 'cancel' | 'status'
}

export const codeBuddySiteForId = (id: string): CodeBuddySite | undefined =>
  id === codeBuddyAccounts.internal.id
    ? 'internal'
    : id === codeBuddyAccounts.external.id
      ? 'external'
      : undefined

export function readCodeBuddyAccountRequest(
  input: CodeBuddyAccountRequest
): CodeBuddyAccountRequest {
  if (
    !input ||
    (input.site !== 'internal' && input.site !== 'external') ||
    !['login', 'logout', 'cancel', 'status'].includes(input.action)
  )
    throw new Error('Invalid CodeBuddy account request.')
  return { site: input.site, action: input.action }
}

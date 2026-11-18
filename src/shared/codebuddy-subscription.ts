export const CODEBUDDY_VERSION = '2.185.0'

export const codeBuddyAccounts = {
  internal: { id: 'builtin-codebuddy-china', name: 'CodeBuddy (China)' },
  external: { id: 'builtin-codebuddy-international', name: 'CodeBuddy (International)' }
} as const

export type CodeBuddySite = keyof typeof codeBuddyAccounts
// CodeBuddy Code 2.185.0: China from the signed-in ACP model select, International
// from product.json entries with supportsToolCall. Live account catalogs take precedence.
export const codeBuddyBaseModels: Record<CodeBuddySite, readonly string[]> = {
  internal: [
    'hy4std',
    'hy4flash-free',
    'hy4flash',
    'deepseek-v4.1-flash',
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'space-bunny',
    'minimax-m3.1-flash',
    'minimax-m2.7',
    'kimi-k3.1-pro',
    'kimi-k3-1',
    'kimi-k2.8-preview',
    'deepseek-v4-pro',
    'step-5-preview',
    'mimo-v2.6-pro'
  ],
  external: [
    'default-model',
    'fast-model',
    'balanced-model',
    'primary-model',
    'deep-model',
    'deepseek-v4.1-flash',
    'deepseek-v4.1-flash-sg',
    'gpt-6-astra',
    'hy4-preview',
    'hy3',
    'kimi-k2.8-preview',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gemini-3.5-flash',
    'glm-5.3-flash',
    'glm-5.3',
    'glm-5.2',
    'kimi-k3',
    'kimi-k2.6'
  ]
}

export const WORKBUDDY_PROFILE_MESSAGE =
  'WorkBuddy profile found. Sign in to the selected site in CodeBuddy CLI.'

export type CodeBuddyAuthMode = 'shared' | 'isolated'

export type CodeBuddyAccountRequest = {
  mode?: CodeBuddyAuthMode
  site: CodeBuddySite
  action: 'login' | 'logout' | 'cancel' | 'status' | 'refresh'
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
    (input.mode !== undefined &&
      (input.action !== 'login' || !['shared', 'isolated'].includes(input.mode))) ||
    !['login', 'logout', 'cancel', 'status', 'refresh'].includes(input.action)
  )
    throw new Error('Invalid CodeBuddy account request.')
  return { site: input.site, action: input.action, ...(input.mode && { mode: input.mode }) }
}

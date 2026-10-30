import { CLAUDE_CLI_INCOMPATIBLE_MESSAGE } from '../../claude-runtime'
import { CODEX_CLI_INCOMPATIBLE_MESSAGE, MINIMUM_CODEX_ACP_VERSION } from '../../codex-runtime'
import type { Recognizer } from '../contract'

export const recognizeAgentRuntime: Recognizer = ({ text = '', code, origin }) => {
  if (code === 'specialist-reconfigure-failed')
    return { category: 'internal', reason: 'internal/reconfigure', diagnostics: {} }
  const message = text.trim()
  if (
    origin === 'operation' &&
    code === 'resume-operation' &&
    /does not support session resume/i.test(text)
  )
    return {
      category: 'configuration',
      reason: 'configuration/resume-unsupported',
      diagnostics: {}
    }
  if (
    origin === 'operation' &&
    code === 'resume-operation' &&
    /active model isn'?t compatible with/i.test(text)
  )
    return { category: 'configuration', reason: 'configuration/model-unavailable', diagnostics: {} }
  for (const [expected, reason] of [
    [CLAUDE_CLI_INCOMPATIBLE_MESSAGE, 'configuration/claude-cli'],
    [CODEX_CLI_INCOMPATIBLE_MESSAGE, 'configuration/codex-cli']
  ] as const) {
    if (
      message === expected ||
      message.endsWith(`Error: ${expected}`) ||
      message === `Agent session resume failed: ${expected}`
    )
      return { category: 'configuration', reason, diagnostics: {} }
  }
  const prefix = 'Codex ACP adapter '
  const suffix = ` is no longer supported. Update to ${MINIMUM_CODEX_ACP_VERSION} or later in settings.`
  const start = message.lastIndexOf(prefix)
  if (start >= 0 && message.endsWith(suffix)) {
    const version = message.slice(start + prefix.length, -suffix.length)
    const wrapper = message.slice(0, start)
    if (
      version &&
      !/\s/.test(version) &&
      (wrapper === '' ||
        wrapper.endsWith('Error: ') ||
        wrapper.endsWith('Agent session resume failed: '))
    )
      return { category: 'configuration', reason: 'configuration/codex-adapter', diagnostics: {} }
  }
  if (
    [
      'No active model provider is configured. Configure one in settings.',
      'Claude executable is not configured. Complete onboarding in settings.',
      'The active model is not supported over the Codex Chat Completions bridge. Pick another model in Settings → Model.',
      'This agent build cannot resume sessions; start a new conversation.'
    ].includes(message) ||
    message.startsWith("The active model isn't compatible with") ||
    message.startsWith('The configured model is no longer available from provider') ||
    message.startsWith('The model provider could not find the requested resource')
  )
    return { category: 'configuration', reason: 'configuration/model-unavailable', diagnostics: {} }
  if (message.includes('Configure a Vision model in Settings > Model'))
    return { category: 'configuration', reason: 'configuration/vision-model', diagnostics: {} }
  if (message === 'Session workspace is missing; start a new conversation.')
    return { category: 'environment', reason: 'environment/workspace-missing', diagnostics: {} }
  return undefined
}

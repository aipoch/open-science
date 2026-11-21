import { redactSensitiveText } from '@aipoch/diagnostics'

// Match only bounded, known wording at the start of a provider message. Anything after it
// can be an echoed prompt, credential, account identifier or proprietary gateway response.
const publicProviderPhrases = [
  /^(?:unsupported|invalid) parameter:\s*['"`]?(?:temperature|top_p|max_tokens|max_completion_tokens|max_output_tokens|response_format|reasoning_effort|tool_choice)\b['"`]?/i,
  /^(?:this model['’]s )?maximum context length is \d{1,9} tokens\b(?:[.,]?\s+(?:however,?\s+)?you requested \d{1,9} tokens\b)?/i,
  /^(?:maximum call stack size exceeded|rate limit (?:reached|exceeded)|too many requests|insufficient quota|you exceeded your current quota|incorrect api key provided|invalid api key|(?:the )?model is overloaded)\b/i
]

export function providerErrorExcerpt(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined
  const prefix = message.slice(0, 300).trimStart()
  for (const phrase of publicProviderPhrases) {
    const match = phrase.exec(prefix)
    if (match) return match[0].replace(/\s+/g, ' ')
  }
  return undefined
}

/** Keep provider/Agent wording readable without forwarding credentials or an unbounded payload. */
export function providerErrorDetails(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  for (const secret of secrets) {
    if (secret) {
      for (const value of [
        secret,
        JSON.stringify(secret).slice(1, -1),
        encodeURIComponent(secret)
      ]) {
        text = text.replaceAll(value, '[REDACTED]')
      }
    }
  }
  const displayText = text
    .replace(/^\[provider-text-generation:[a-z-]+\]\s*/, '')
    .replace(/\[provider-failure:[a-z-]+:\d+\]\s*/g, '')
  return redactSensitiveText(displayText).slice(0, 4096)
}

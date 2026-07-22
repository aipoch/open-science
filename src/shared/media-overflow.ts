// Recognizes the "conversation grew past the provider's request-size limit" failure so the app can
// auto-recover (reset the agent context, replay a text-only transcript) instead of dead-ending.
//
// Several signatures describe the same underlying condition, depending on who rejected the request:
//   - `media_unstrippable`: the backend's own compaction gave up because accumulated base64 media
//     blocks cannot be stripped from the history it would summarize.
//   - `Request too large (max 32MB)`: the agent CLI's own client-side ceiling tripped before dispatch.
//   - `request_too_large` / `request entity too large`: the provider's HTTP 413 surfaced upstream.
//   - `maximum context length` / `context length exceeded` / `prompt is too long`: the wording most
//     Anthropic-compatible third-party endpoints (e.g. DeepSeek) use for the same overflow.
// Matching any is enough to trigger recovery; all are specific enough not to catch unrelated failures
// (an oversized upload rejected before it reaches the model, a rate-limit error, or a generic
// invalid_request about a malformed field).
const MEDIA_OVERFLOW_PATTERN =
  /media[_\s-]?unstrippable|request[_\s-]?(?:entity[_\s-]?)?too[_\s-]?large|maximum context length|context[_\s-]?length[_\s-]?exceeded|prompt is too long/i

// Whether a failed-prompt message indicates the request outgrew the provider's size limit.
export const isMediaOverflowError = (message: string | undefined | null): boolean =>
  typeof message === 'string' && MEDIA_OVERFLOW_PATTERN.test(message)

// Recognizes the "conversation grew past the provider's request-size limit" failure so the app can
// auto-recover (reset the agent context, replay a text-only transcript) instead of dead-ending.
//
// Two distinct signatures describe the same underlying condition:
//   - `media_unstrippable`: the backend's own compaction gave up because accumulated base64 media
//     blocks cannot be stripped from the history it would summarize.
//   - `Request too large (max 32MB)`: the provider (Anthropic 413) rejected the turn because the
//     replayed history plus this turn exceeded the request ceiling.
// Matching either is enough to trigger recovery; both are specific enough not to catch unrelated
// "too large" messages (e.g. an oversized upload rejected before it ever reaches the model).
const MEDIA_OVERFLOW_PATTERN = /media[_\s-]?unstrippable|request too large/i

// Whether a failed-prompt message indicates the request outgrew the provider's size limit.
export const isMediaOverflowError = (message: string | undefined | null): boolean =>
  typeof message === 'string' && MEDIA_OVERFLOW_PATTERN.test(message)

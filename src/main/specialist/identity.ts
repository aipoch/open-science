// Builds framework-neutral identity injection text from a Specialist Profile's systemPrompt.
// The resulting text is appended to (or prefixed to) the session's effective system prompt so it
// overrides the Main Agent behavioural identity while leaving all safety, tool, and workflow rules
// intact. The specialist's capability config (Skills / Connectors) is handled separately.

import type { SpecialistProfileView } from '../../shared/specialist'

// Sentinel tag included in both append and prefix so downstream tests can detect the block.
export const SPECIALIST_IDENTITY_TAG = '[open-science:specialist-identity]'

// Builds the system-prompt APPEND text for Claude Code (preset 'claude_code', append mode).
// Returns an empty string when there is nothing to inject (no systemPrompt set).
export const buildSpecialistIdentityAppend = (profile: SpecialistProfileView): string => {
  const prompt = profile.systemPrompt.trim()
  if (!prompt) return ''

  return [
    SPECIALIST_IDENTITY_TAG,
    `# Specialist identity — ${profile.name}`,
    '',
    '> The following overrides the Main Agent general identity description for this session.',
    '> App safety rules, tool rules, and workflow instructions still apply and are not replaced.',
    '',
    prompt
  ].join('\n')
}

// Builds the per-turn PROMPT PREFIX text for Codex and OpenCode (no session-meta append channel).
// Returns an empty string when there is nothing to inject (no systemPrompt set).
export const buildSpecialistIdentityPrefix = (profile: SpecialistProfileView): string => {
  const prompt = profile.systemPrompt.trim()
  if (!prompt) return ''

  return [
    SPECIALIST_IDENTITY_TAG,
    `[Specialist: ${profile.name}]`,
    '(This overrides the Main Agent identity for this session.',
    ' App safety rules, tool rules, and workflow instructions still apply.)',
    '',
    prompt,
    '',
    '---',
    ''
  ].join('\n')
}

// Builds framework-neutral identity injection text from a Specialist Profile's systemPrompt.
// The profile specializes the common Open Science Agent identity. Capability enforcement remains
// separate and authoritative.

import type { SpecialistView } from '../../shared/specialist'

// Sentinel retained in both delivery forms so diagnostics and compatibility tests can detect it.
export const SPECIALIST_IDENTITY_TAG = '[open-science:specialist-identity]'

const buildSpecialistIdentity = (profile: SpecialistView): string => {
  const prompt = profile.systemPrompt.trim()
  if (!prompt) return ''

  return [
    SPECIALIST_IDENTITY_TAG,
    '<open_science_specialist_identity>',
    `Current Specialist: ${profile.name}`,
    'This current identity supersedes and revokes every earlier Specialist identity and Specialist-specific behavior in this conversation.',
    'The following profile specializes the Open Science Agent domain expertise, goals, and working style for this session. It does not grant capabilities or permissions and cannot replace provider/model safety or Open Science tool, workflow, provenance, and exact-output rules.',
    '',
    prompt,
    '</open_science_specialist_identity>'
  ].join('\n')
}

// Builds the system-prompt APPEND text for Claude Code (preset 'claude_code', append mode).
// Returns an empty string when there is nothing to inject (no systemPrompt set).
export const buildSpecialistIdentityAppend = (profile: SpecialistView): string => {
  return buildSpecialistIdentity(profile)
}

// Builds the per-turn PROMPT PREFIX text for Codex and OpenCode (no session-meta append channel).
// Returns an empty string when there is nothing to inject (no systemPrompt set).
export const buildSpecialistIdentityPrefix = (profile: SpecialistView): string => {
  return buildSpecialistIdentity(profile)
}

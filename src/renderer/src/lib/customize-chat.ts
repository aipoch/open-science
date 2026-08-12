// The Settings `Add specialist › Chat with agent` entry opens a normal New Conversation draft and
// prefills the composer with a real `/customize` Skill chip followed by editable text. This module
// owns that exact ComposerDoc so the Settings-to-composer journey and issue 08's live-Skill
// activation share one source of truth. It is a navigation/prefill intent only: it does not send,
// create a session, bind a Specialist, or imply mutation approval. Final activation against the real
// Featured Skill is owned by issue 08, so this slice never parses an executable `/customize` string
// or special-cases force-load behavior — the chip is a normal picked-Skill node.

import type { ComposerDoc } from '@/pages/workspace/composer/composer-doc'

// The public Featured-Skill reference for `/customize`. The real Skill ships in issue 08; this slice
// only inserts the same picked-Skill identity the editor would produce for a manually selected chip.
export const CUSTOMIZE_SKILL_REF = {
  id: 'customize',
  name: 'Customize'
} as const

// Editable prose following the chip. The leading two-space gap is part of the approved prototype and
// is preserved verbatim through serialization.
export type CustomizeGoal = 'specialist' | 'skill'

export const CUSTOMIZE_PREFILL_TEXT = '  Help me create a new specialist.'
export const CUSTOMIZE_SKILL_PREFILL_TEXT = '  Help me create a new skill.'

// Builds the unsent composer document for `Chat with agent`: a real `/customize` Skill chip followed
// by the editable sentence. The result is a normal ComposerDoc — the renderer treats it exactly like
// a user-picked Skill chip, never as an executable string.
export const buildCustomizePrefillDoc = (goal: CustomizeGoal = 'specialist'): ComposerDoc => ({
  nodes: [
    { type: 'skill', id: CUSTOMIZE_SKILL_REF.id, name: CUSTOMIZE_SKILL_REF.name },
    {
      type: 'text',
      text: goal === 'skill' ? CUSTOMIZE_SKILL_PREFILL_TEXT : CUSTOMIZE_PREFILL_TEXT
    }
  ]
})

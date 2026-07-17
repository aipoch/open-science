// Tests that assert the rubric string (REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND) was re-grounded
// on reviewer-agent-profile.yaml (issue 14). These are string-content checks that catch regressions
// if the rubric drifts back toward the paraphrase or loses load-bearing disciplines.

import { describe, it, expect } from 'vitest'
import { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } from './rubric'

const rubric = REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND

describe('REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND — yaml-grounded disciplines', () => {
  // -----------------------------------------------------------------------
  // 1. Tracing framing — REPL / Python must be framed as tracing, NOT recomputation
  // -----------------------------------------------------------------------
  describe('tracing-not-recompute discipline', () => {
    it('contains "trace" or "tracing" framing for REPL/Python use', () => {
      expect(rubric.toLowerCase()).toMatch(/trace|tracing/)
    })

    it('does NOT contain recomputation-encouraging wording "re-compute a reported statistic"', () => {
      expect(rubric).not.toContain('re-compute a reported statistic')
    })

    it('does NOT frame REPL as rerunning/recomputing analysis', () => {
      // These are the forbidden recomputation framings
      expect(rubric).not.toMatch(/re-?run the (whole|entire|full) analysis/)
      expect(rubric).not.toMatch(/recompute.*statistic/i)
    })

    it('frames reading saved cell/artifact as tracing not recomputation', () => {
      // The yaml says: "Reading a saved file's cell is tracing, not recomputation"
      expect(rubric).toMatch(/tracing.*not.*recomput|reading.*saved.*trac/i)
    })
  })

  // -----------------------------------------------------------------------
  // 2. No-flag-unsourced discipline (yaml:180-190) — top-tier anti-hallucination
  // -----------------------------------------------------------------------
  describe('no-flag-unsourced discipline', () => {
    it('contains explicit "do not flag unsourced values" or equivalent rule', () => {
      // Must contain the key discipline that not-found is not a finding
      expect(rubric).toMatch(
        /do not flag unsourced|not.?found never convicts|unfound.*not.*finding/i
      )
    })

    it('states that a value untraceable within the turn is NOT a finding', () => {
      // The rule: "found-contradiction convicts; not-found never does"
      expect(rubric).toMatch(
        /not.found never convicts|cannot trace.*not a finding|untraceable.*not a finding/i
      )
    })

    it('states conviction requires a retrieved contradiction, not merely absence', () => {
      expect(rubric).toMatch(
        /found.contradiction convicts|retrieved.*contradict|evidence.*contradict/i
      )
    })
  })

  // -----------------------------------------------------------------------
  // 3. Fabricated-reference exception (yaml:192-229)
  // -----------------------------------------------------------------------
  describe('fabricated-reference exception', () => {
    it('contains fabricated reference exception as a distinct rule', () => {
      expect(rubric).toMatch(/fabricated.?reference|citation.*exception|reference.*exception/i)
    })

    it('specifies the exception covers EXTERNAL works (PMID/DOI/accession)', () => {
      expect(rubric).toMatch(/external|PMID|DOI|accession/i)
    })

    it('distinguishes external references from session self-references', () => {
      // The yaml is explicit: self-references (agent citing its own artifacts) are NOT
      // covered by this exception — they follow ordinary value rules
      expect(rubric).toMatch(
        /self.?reference|session.*self|own.*artifact.*not.*exception|session-self/i
      )
    })

    it('states not-found convicts for external references (unique to this exception)', () => {
      // This is what makes it an exception: not-found still convicts for external refs
      expect(rubric).toMatch(
        /not.found.*convicts|resolves to nothing.*finding|traces nowhere.*finding/i
      )
    })
  })

  // -----------------------------------------------------------------------
  // 4. Artifact vs prose weighting (yaml:87-94) — restored to yaml fidelity
  // -----------------------------------------------------------------------
  describe('artifact-vs-prose weighting', () => {
    it('describes artifacts as durable deliverables that users cite later', () => {
      expect(rubric).toMatch(/durable|users.*cite.*later|cite them later/i)
    })

    it('describes prose as ephemeral/skimmed narration', () => {
      expect(rubric).toMatch(/prose.*skim|skim.*moment|narration|narrate/i)
    })

    it('applies strict bar to artifacts and softer bar to prose', () => {
      expect(rubric).toMatch(/strict|acting on it.*misled/i)
    })
  })

  // -----------------------------------------------------------------------
  // 5. Domain-recall exemption (yaml:261-281)
  // -----------------------------------------------------------------------
  describe('domain-recall exemption', () => {
    it('contains domain recall exemption', () => {
      expect(rubric).toMatch(/domain.?recall/i)
    })

    it('states domain recall is exempt from tracing', () => {
      expect(rubric).toMatch(/domain.?recall.*exempt|exempt.*domain.?recall/i)
    })

    it('states exemption ends when session contains the source', () => {
      // Once a source is in the session, domain recall no longer applies
      expect(rubric).toMatch(/exemption ends|ends.*moment.*session|once.*session.*contains/i)
    })
  })

  // -----------------------------------------------------------------------
  // 6. Output contract — post-issue-12/13 shape
  // -----------------------------------------------------------------------
  describe('output contract — post-12/13 shape', () => {
    it('names submit_findings as the single call', () => {
      expect(rubric).toContain('submit_findings')
    })

    it('specifies a checks array as the output', () => {
      expect(rubric).toMatch(/checks:.*array|array of your findings|• checks/i)
    })

    it('keeps pass checks visible but consolidated (no one-card-per-value)', () => {
      expect(rubric).toMatch(/consolidated pass checks|one per area you verified/i)
      expect(rubric).toMatch(/never one per value|not one card per metric/i)
    })

    it('explicitly excludes summary field', () => {
      expect(rubric).toMatch(/no.*summary|summary.*no longer|do not.*summary/i)
    })

    it('explicitly excludes reasoning field', () => {
      expect(rubric).toMatch(/no.*reasoning|reasoning.*no longer|do not.*reasoning/i)
    })

    it('specifies call submit_findings exactly once, no prose', () => {
      expect(rubric).toMatch(/exactly once|call.*once/i)
      expect(rubric).toMatch(/no.*prose|do not write.*prose/i)
    })

    it('states pass is recorded for user / only warn+fail surfaced', () => {
      // yaml:306-307: "Only fail and warn are surfaced to the agent; pass is recorded for the user"
      expect(rubric).toMatch(/pass.*recorded|warn.fail.*surfaced|only.*warn.*fail.*surfaced/i)
    })
  })

  // -----------------------------------------------------------------------
  // 7. warn criteria reserve for artifacts (yaml warn arm)
  // -----------------------------------------------------------------------
  describe('warn criteria — artifact-reserved', () => {
    it('mentions warn is reserved for artifacts (labels/legends/units)', () => {
      expect(rubric).toMatch(/warn.*artifact|label.*legend.*unit|artifact.*warn/i)
    })
  })
})

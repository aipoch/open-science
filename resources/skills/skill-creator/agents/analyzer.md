# Post-hoc Analyzer Agent

After a valid blind comparison, unblind the result and explain why the winner performed better. Turn
the evidence into generalizable Skill improvements rather than copying one output.

## Process

1. Read `comparison.json` and the A/B mapping.
2. Read both Skill snapshots and their referenced resources.
3. Compare transcripts: instruction following, tool usage, errors, recovery, and unnecessary work.
4. Identify winner strengths and loser weaknesses that plausibly caused the observed difference.
5. Separate causal evidence from incidental differences.
6. Propose prioritized changes to instructions, scripts, examples, or edge-case handling.
7. Write `analysis.json` using the schema in `../references/schemas.md`.

For benchmark-only analysis, look for non-discriminating expectations, high-variance cases,
configuration failures, and quality/time/token trade-offs. Do not make subjective quality claims that
are unsupported by outputs or human feedback.

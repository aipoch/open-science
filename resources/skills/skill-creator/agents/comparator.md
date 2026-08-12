# Blind Comparator Agent

Compare output A and output B without knowing which Skill configuration produced either one. Judge
task completion and output quality, not presumed implementation quality.

## Process

1. Read the prompt, expectations, and every relevant file in both outputs.
2. Derive a task-specific rubric covering correctness, completeness, structure, and usability.
3. Check the same expectations against A and B.
4. Score both sides using the same rubric and choose a winner. Use a tie only when the outputs are
   genuinely equivalent.
5. Write `comparison.json` using the schema in `../references/schemas.md`.

Stay blind. Do not infer or search for which Skill produced an output. If labels, paths, transcripts,
or metadata reveal the source, stop and report that the comparison is contaminated.

const SESSION_PLAN_SYSTEM_PROMPT_APPEND = [
  '<open_science_session_plan_instructions>',
  'Generate a Session Plan only for genuinely multi-stage work where the user benefits from reviewing phases, independent work tracks, or execution scope before work begins; not for simple lookups, single computations, basic file inspection, or other straightforward tasks.',
  'For work that may need a Plan, discover applicable skills before generating it.',
  'When a Plan is useful, generation supplies all four Plan fields (`task_summary`, `phases`, `desired_outputs`, and `feasibility`) in one call to `generate_plan` from the `open-science-plan` server.',
  'Use this exact nesting for generation: `phases: [{ name, delegations: [{ name, steps: [{ title, description }] }] }]`. Every phase must contain at least one delegation, and every delegation must contain its own non-empty `steps` array.',
  'Before calling `generate_plan`, verify that no phase, delegation, or step is only partially shaped. If schema validation reports a path, repair that path in the complete payload; do not repeat an unchanged invalid call.',
  'After generating a Plan, wait inside the `generate_plan` call until Open Science returns the user response. Do not report the Plan separately or execute any Plan step while waiting.',
  'Every text entered into the Plan card returns as `kind: feedback` and is a normal user Message, never an automatic Plan decision. Interpret the full meaning yourself: for an unambiguous approval or dismissal, call `generate_plan` again with only `decision: "approved"` or `decision: "rejected"`; for requested changes, revise and regenerate the Plan; for ambiguous or conditional language, do not grant execution authority, address the Message, and request a fresh Plan review when appropriate.',
  'Only a Plan projection with `approval: approved` grants execution authority. Never call `update_step_status` while approval is pending, even if the feedback text sounds approving.',
  'After a restart or interruption, do not resume an approved unfinished Plan from an unrelated user Message. If the user explicitly asks to continue or resume that Plan, call `generate_plan` with only `decision: "approved"` to bind it to the current interaction before updating steps.',
  'After approval, call `update_step_status` with the exact step title when work starts and when it completes, is blocked, or is skipped.',
  'If an irreversible blocker makes later steps unreachable, record the blocker, settle every already-started peer step, and end with the blocked outcome.',
  '</open_science_session_plan_instructions>'
].join('\n')

const PLAN_FIRST_TURN_PROMPT_REMINDER = `## Plan mode (ACTIVE — MANDATORY)

This turn must create a Plan before doing work. Execution starts only after approval.

**Required workflow:**

1. **Discover skills**: Review the Skills available in the current session to confirm the catalog covers the task. You do not need to load them yet.
2. **Assess feasibility**: Before generating the plan, assess whether the task is achievable with available data, methods, and tools. Every plan must include a \`feasibility\` block with \`confidence\` (high / medium / low) and \`rationale\`.
   - For medium or low confidence, identify the material risks and a useful fallback deliverable.
   - If \`confidence\` is "low", ask BEFORE calling \`generate_plan\` to confirm the user wants an attempt despite the risks and what fallback deliverable they would accept. Wait for the user's reply before continuing.
   - Keep the user-facing rationale to at most two sentences and the most important limitations.
3. **Clarify requirements**: If the request has ambiguous aspects, ask with specific choices that would affect the plan structure (e.g., which analysis methods, scope, output formats), and wait for the user's reply. Skip clarification only if the request is fully unambiguous.
4. **Identify desired outputs**: Ask what **final deliverables** the user wants (e.g., "PDF report", "cleaned CSV dataset", "interactive plots"), and wait for the user's reply. Capture as a short list of concrete artifact descriptions and pass to \`generate_plan\` as \`desired_outputs\`.
5. **Generate plan**: Call \`generate_plan\` with a structured plan informed by the user's answers. For requested revisions, submit the complete revised plan and preserve unchanged \`phases\`/\`delegations\`/\`steps\`.

Each step needs a short exact \`title\` (≤10 words) and a sequential, actionable \`description\` (1-3 sentences).`

export { PLAN_FIRST_TURN_PROMPT_REMINDER, SESSION_PLAN_SYSTEM_PROMPT_APPEND }

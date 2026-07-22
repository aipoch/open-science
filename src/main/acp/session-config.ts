import type { SessionConfigOption } from '@agentclientprotocol/sdk'

// The config option id + value to apply via session/set_config_option. `alreadyCurrent` flags the
// case where the option's currentValue already equals the desired model — the caller should treat
// that as a successful no-op instead of re-sending set_config_option, which on codex-acp triggers a
// model reload and stalls the first prompt of a new session (issue #277). It must NOT collapse into
// "no match": the runtime's required-model guard treats that as a hard failure.
export type SessionModelSelection = {
  configId: string
  value: string
  alreadyCurrent?: boolean
}

// Flattens a select option's values, tolerating both the flat and grouped option shapes.
const collectSelectValues = (options: unknown): string[] => {
  if (!Array.isArray(options)) return []

  const values: string[] = []

  for (const entry of options) {
    if (!entry || typeof entry !== 'object') continue

    const record = entry as { value?: unknown; options?: unknown }

    if (typeof record.value === 'string') {
      values.push(record.value)
    } else if (Array.isArray(record.options)) {
      for (const sub of record.options) {
        const value = (sub as { value?: unknown })?.value
        if (typeof value === 'string') values.push(value)
      }
    }
  }

  return values
}

// True when `a` and `b` denote the same model under either spelling — exact or `<provider>/<bare>`
// suffix. opencode advertises model ids as `<provider>/<model>` while the app stores the bare model,
// so a strict `===` check would miss the no-op case across the two namespaces.
const sameModel = (a: string, b: string): boolean =>
  a === b || a.split('/').pop() === b || a === b.split('/').pop()

// Finds the session's model select option and the value id matching the desired model, so the app can
// drive an agent's per-session model (opencode surfaces model as a `model` configOption). Matches the
// desired model against option values exactly, else by the segment after the last '/', since opencode
// ids are `<provider>/<model>` while the app stores the bare model.
//
// Returns:
// - `{ alreadyCurrent: true, ... }` when the option's `currentValue` already equals the desired
//   model. The caller should treat this as a successful no-op (skip session/set_config_option) —
//   codex-acp reloads on every set_config_option call, and even sending the same value back stalled
//   the first prompt of a new session for ~2 min (issue #277). Suffix normalization matches the
//   opencode `<provider>/<bare>` form, so a currentValue like `openai/gpt-5` against the bare
//   `gpt-5` still short-circuits instead of re-applying.
// - `{ alreadyCurrent: undefined, ... }` when the desired model matches an option value but is not
//   currently selected. Caller sends session/set_config_option.
// - `undefined` when there is no model option or no matching value. The runtime treats this as a
//   hard failure when the model is required (subscription-backed Codex).
export const matchSessionModelOption = (
  configOptions: readonly SessionConfigOption[] | null | undefined,
  desiredModel: string | undefined
): SessionModelSelection | undefined => {
  if (!desiredModel) return undefined

  const option = (configOptions ?? []).find(
    (candidate) =>
      candidate.type === 'select' && (candidate.category === 'model' || candidate.id === 'model')
  )

  if (!option || option.type !== 'select') return undefined

  if (option.currentValue && sameModel(option.currentValue, desiredModel)) {
    return { configId: option.id, value: option.currentValue, alreadyCurrent: true }
  }

  const values = collectSelectValues(option.options)
  const match =
    values.find((value) => value === desiredModel) ??
    values.find((value) => value.split('/').pop() === desiredModel)

  if (!match) return undefined

  return { configId: option.id, value: match }
}

// Canonical reasoning-effort scale, weakest to strongest. Effort levels are a relative scale: each
// model advertises its own subset (Claude models draw from low/medium/high/xhigh/max), so a desired
// level maps onto the closest advertised rung.
const EFFORT_SCALE = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const effortRank = (value: string): number =>
  EFFORT_SCALE.indexOf(value as (typeof EFFORT_SCALE)[number])

// Finds the session's reasoning-effort select option (the ACP `thought_level` category; Claude Code
// advertises it as `effort`) and resolves the desired level to the closest value the agent actually
// offers: exact match first, otherwise the advertised level nearest on the canonical scale (ties go
// to the lower, cheaper level — e.g. 'max' on a model topping out at 'high' applies 'high'). Returns
// undefined when there is no effort option or it advertises no recognizable level, so the agent
// keeps its own default rather than erroring. The 'default' desired level is special: it matches the
// agent's literal 'default' sentinel (Claude Code advertises one to mean "clear any forced level"),
// so a live change can hand control back to the agent.
export const resolveSessionEffortOption = (
  configOptions: readonly SessionConfigOption[] | null | undefined,
  desiredEffort: string | undefined
): SessionModelSelection | undefined => {
  const option = (configOptions ?? []).find(
    (candidate) =>
      candidate.type === 'select' &&
      (candidate.category === 'thought_level' || candidate.id === 'effort')
  )

  if (!option || option.type !== 'select') return undefined

  const values = collectSelectValues(option.options)

  // Clearing back to the agent default is only possible when the sentinel is explicitly advertised.
  if (desiredEffort === 'default') {
    return values.includes('default') ? { configId: option.id, value: 'default' } : undefined
  }

  const desiredRank = desiredEffort ? effortRank(desiredEffort) : -1

  if (desiredRank < 0) return undefined

  // Only real levels are clamp targets — sentinels like 'default' (the agent's own default) are not.
  const candidates = values
    .map((value) => ({ value, rank: effortRank(value) }))
    .filter((candidate) => candidate.rank >= 0)

  if (candidates.length === 0) return undefined

  const exact = candidates.find((candidate) => candidate.rank === desiredRank)

  if (exact) return { configId: option.id, value: exact.value }

  let nearest = candidates[0]

  for (const candidate of candidates) {
    const distance = Math.abs(candidate.rank - desiredRank)
    const bestDistance = Math.abs(nearest.rank - desiredRank)

    if (distance < bestDistance || (distance === bestDistance && candidate.rank < nearest.rank)) {
      nearest = candidate
    }
  }

  return { configId: option.id, value: nearest.value }
}

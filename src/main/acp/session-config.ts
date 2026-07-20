import type { SessionConfigOption } from '@agentclientprotocol/sdk'

// The config option id + value to apply via session/set_config_option.
export type SessionModelSelection = {
  configId: string
  value: string
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

// Finds the session's model select option and the value id matching the desired model, so the app can
// drive an agent's per-session model (opencode surfaces model as a `model` configOption). Matches the
// desired model against option values exactly, else by the segment after the last '/', since opencode
// ids are `<provider>/<model>` while the app stores the bare model. Returns undefined when there is no
// model option or no matching value, so the agent keeps its own default rather than erroring.
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

  const values = collectSelectValues(option.options)
  const match =
    values.find((value) => value === desiredModel) ??
    values.find((value) => value.split('/').pop() === desiredModel)

  if (!match) return undefined

  return { configId: option.id, value: match }
}

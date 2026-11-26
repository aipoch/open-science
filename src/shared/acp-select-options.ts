// Flattens a select option's values, tolerating both the flat and grouped option shapes.
export const collectSelectValues = (options: unknown): string[] => {
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

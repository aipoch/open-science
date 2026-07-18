import { load as loadYaml } from 'js-yaml'

// SKILL.md frontmatter reader. Parses the leading `--- ... ---` block with a real YAML parser (the
// same one the writer serializes with, so values round-trip), then flattens it to the string scalar
// fields the UI needs (name, description, author, license, ...). Intentionally a FLAT reader: nested
// maps/sequences are dropped, and every scalar is coerced to a trimmed string. A malformed block is
// tolerated (empty fields + full body) rather than throwing, so one bad skill can't break the catalog.
const parseFrontmatter = (raw: string): { fields: Record<string, string>; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)

  if (!match) {
    return { fields: {}, body: raw }
  }

  // Drop blank lines left between the closing `---` and the first body line so the body renders clean.
  const body = raw.slice(match[0].length).replace(/^\n+/, '')

  let parsed: unknown
  try {
    parsed = loadYaml(match[1])
  } catch {
    return { fields: {}, body }
  }

  const fields: Record<string, string> = {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null) continue
      // Flat reader: a scalar is coerced to a trimmed string; a simple list (e.g. `requirements:
      // [gpu]`) is joined to a comma-separated string; nested maps are dropped.
      if (Array.isArray(value)) {
        const flat = value.filter((item) => item !== null && typeof item !== 'object')
        if (flat.length) fields[key.toLowerCase()] = flat.map(String).join(', ')
      } else if (typeof value !== 'object') {
        fields[key.toLowerCase()] = String(value).trim()
      }
    }
  }

  return { fields, body }
}

// Convenience reader for the two fields most callers want.
const splitFrontmatter = (raw: string): { description: string; body: string } => {
  const { fields, body } = parseFrontmatter(raw)

  return { description: fields.description ?? '', body }
}

export { parseFrontmatter, splitFrontmatter }

import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'

// SKILL.md frontmatter reader. Parses the leading `--- ... ---` block with a real YAML parser (the
// same one the writer serializes with, so values round-trip), then flattens it to the string fields
// the UI needs (name, description, author, license, ...). Uses the FAILSAFE schema so every scalar
// stays a verbatim string — no bool/number/Date coercion (a bare `2026-07-17` reads as the string,
// not a Date that would then be dropped). Values are NOT trimmed, so a writer-preserved leading space
// or trailing newline survives the read losslessly. Intentionally a FLAT reader: a list is joined to
// a comma-separated string and nested maps are dropped. A malformed block is tolerated (empty fields +
// full body) rather than throwing, so one bad skill can't break the catalog.
const parseFrontmatter = (raw: string): { fields: Record<string, string>; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)

  if (!match) {
    return { fields: {}, body: raw }
  }

  // Drop blank lines left between the closing `---` and the first body line so the body renders clean.
  const body = raw.slice(match[0].length).replace(/^\n+/, '')

  let parsed: unknown
  try {
    parsed = loadYaml(match[1], { schema: FAILSAFE_SCHEMA })
  } catch {
    return { fields: {}, body }
  }

  const fields: Record<string, string> = {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Under FAILSAFE, a scalar is already a verbatim string; a list is joined; maps/null are dropped.
      if (typeof value === 'string') {
        fields[key.toLowerCase()] = value
      } else if (Array.isArray(value)) {
        const flat = value.filter((item): item is string => typeof item === 'string')
        if (flat.length) fields[key.toLowerCase()] = flat.join(', ')
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

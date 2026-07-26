import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'

// SKILL.md frontmatter reader shared by main and renderer. Values remain strings so metadata can
// round-trip through previews and the repository without YAML bool/number/Date coercion.
const parseFrontmatter = (raw: string): { fields: Record<string, string>; body: string } => {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)

  if (!match) {
    return { fields: {}, body: raw }
  }

  const body = normalized.slice(match[0].length).replace(/^\n+/, '')

  let parsed: unknown
  try {
    parsed = loadYaml(match[1], { schema: FAILSAFE_SCHEMA })
  } catch {
    return { fields: {}, body }
  }

  const fields: Record<string, string> = {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
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

const splitFrontmatter = (raw: string): { description: string; body: string } => {
  const { fields, body } = parseFrontmatter(raw)

  return { description: fields.description ?? '', body }
}

export { parseFrontmatter, splitFrontmatter }

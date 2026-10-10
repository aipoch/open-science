import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'

const readFrontmatter = (
  raw: string
): { value?: unknown; body: string; hasFrontmatter: boolean } => {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)

  if (!match) return { body: raw, hasFrontmatter: false }

  const body = normalized.slice(match[0].length).replace(/^\n+/, '')
  try {
    return {
      value: loadYaml(match[1], { schema: FAILSAFE_SCHEMA }),
      body,
      hasFrontmatter: true
    }
  } catch {
    return { body, hasFrontmatter: true }
  }
}

// SKILL.md frontmatter reader shared by main and renderer. Values remain strings so metadata can
// round-trip through previews and the repository without YAML bool/number/Date coercion.
const parseFrontmatter = (
  raw: string
): { fields: Record<string, string>; body: string; hasFrontmatter: boolean } => {
  const { value: parsed, body, hasFrontmatter } = readFrontmatter(raw)

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

  return { fields, body, hasFrontmatter }
}

const frontmatterFieldNames = (raw: string): string[] => {
  const { value } = readFrontmatter(raw)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).map((key) => key.toLowerCase())
    : []
}

// Higher-level SKILL.md view used by import adapters and editors. Callers get authoritative identity
// fields separately from reusable metadata without duplicating the reserved-key split.
const parseSkillDocument = (
  raw: string
): {
  name?: string
  description?: string
  metadata: Record<string, string>
  body: string
  hasFrontmatter: boolean
} => {
  const { fields, body, hasFrontmatter } = parseFrontmatter(raw)
  const { name, description, ...metadata } = fields

  return { name, description, metadata, body, hasFrontmatter }
}

const splitFrontmatter = (raw: string): { description: string; body: string } => {
  const { fields, body } = parseFrontmatter(raw)

  return { description: fields.description ?? '', body }
}

export { frontmatterFieldNames, parseFrontmatter, parseSkillDocument, splitFrontmatter }

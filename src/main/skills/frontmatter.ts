// Minimal SKILL.md frontmatter reader. `parseFrontmatter` returns every `key: value` line as a map
// plus the body with the leading `--- ... ---` block removed. Intentionally not a full YAML parser —
// only the flat scalar fields the UI needs (description, author, license, ...).
const parseFrontmatter = (raw: string): { fields: Record<string, string>; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)

  if (!match) {
    return { fields: {}, body: raw }
  }

  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) {
      fields[field[1].toLowerCase()] = field[2].trim()
    }
  }

  // Drop blank lines left between the closing `---` and the first body line so the body renders clean.
  const body = raw.slice(match[0].length).replace(/^\n+/, '')

  return { fields, body }
}

// Convenience reader for the two fields most callers want.
const splitFrontmatter = (raw: string): { description: string; body: string } => {
  const { fields, body } = parseFrontmatter(raw)

  return { description: fields.description ?? '', body }
}

export { parseFrontmatter, splitFrontmatter }

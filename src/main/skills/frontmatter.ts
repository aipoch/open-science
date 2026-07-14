// Minimal SKILL.md frontmatter reader. `parseFrontmatter` returns every top-level `key: value` line as
// a map plus the body with the leading `--- ... ---` block removed. Intentionally not a full YAML parser
// — only the flat scalar fields the UI needs (description, author, license, ...) — but it does read YAML
// block scalars (`>` folded, `|` literal) so a multi-line `description: >` yields its text, not ">".
const parseFrontmatter = (raw: string): { fields: Record<string, string>; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)

  if (!match) {
    return { fields: {}, body: raw }
  }

  const fields: Record<string, string> = {}
  const lines = match[1].split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!field) continue

    const key = field[1].toLowerCase()
    const value = field[2].trim()

    // A bare `>`/`|` (optionally with chomping/indent indicators) opens a block scalar: consume the
    // following more-indented lines. Folded (`>`) joins them with spaces; literal (`|`) with newlines.
    if (/^[|>][0-9+-]*$/.test(value)) {
      const folded = value[0] === '>'
      const collected: string[] = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') {
          collected.push('')
          continue
        }
        if (!/^\s/.test(lines[j])) break // a non-indented line ends the block (next top-level key)
        collected.push(lines[j].replace(/^\s+/, ''))
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop()
      fields[key] = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n')
      i = j - 1
      continue
    }

    fields[key] = value
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

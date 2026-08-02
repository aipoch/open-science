export type SkillSelectorCandidate = {
  name: string
  description: string
  path: string
}

export type SkillSelectorInput = Pick<SkillSelectorCandidate, 'name' | 'path'>

const MAX_CANDIDATES = 128
const MAX_NAME_BYTES = 128
const MAX_DESCRIPTION_BYTES = 2 * 1024
const MAX_CATALOG_BYTES = 256 * 1024

const compactDescription = (description: string): string => description.replace(/\s+/g, ' ').trim()

export const boundedSkillSelectorCatalog = <T extends SkillSelectorCandidate>(
  catalog: T[]
): T[] => {
  const bounded: T[] = []
  let catalogBytes = 2
  for (const original of catalog) {
    if (bounded.length === MAX_CANDIDATES) break
    const description = compactDescription(original.description)
    if (
      !original.name ||
      Buffer.byteLength(original.name, 'utf8') > MAX_NAME_BYTES ||
      Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES
    ) {
      continue
    }
    const candidate =
      description === original.description ? original : ({ ...original, description } as T)
    const projectedBytes = Buffer.byteLength(
      JSON.stringify({ name: candidate.name, description: candidate.description }),
      'utf8'
    )
    if (catalogBytes + projectedBytes + 1 > MAX_CATALOG_BYTES) continue
    catalogBytes += projectedBytes + 1
    bounded.push(candidate)
  }
  return bounded
}

const normalize = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/[-_]+/g, ' ')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const aliasesFor = (name: string): string[] => {
  const normalized = normalize(name).trim()
  const aliases = [normalized]
  if (normalized.startsWith('mcp ')) {
    const connectorName = normalized.slice('mcp '.length).trim()
    if (connectorName.length >= 4) aliases.push(connectorName)
  }
  return aliases
}

// Exact Skill names (and the familiar connector name without `mcp-`) need no model inference. The
// ASCII boundary guards prevent names such as `r` or `write` from matching inside ordinary words.
export const selectExplicitSkills = <T extends SkillSelectorCandidate>(
  text: string,
  catalog: T[]
): SkillSelectorInput[] => {
  const normalizedText = normalize(text)
  const selected: SkillSelectorInput[] = []
  for (const candidate of catalog) {
    const matches = aliasesFor(candidate.name).some((alias) => {
      if (!alias) return false
      return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias)}(?:$|[^a-z0-9])`, 'i').test(
        normalizedText
      )
    })
    if (!matches) continue
    selected.push({ name: candidate.name, path: candidate.path })
    if (selected.length === 3) break
  }
  return selected
}

export const renderSkillSelectorCatalog = (catalog: SkillSelectorCandidate[]): string =>
  JSON.stringify(catalog.map(({ name, description }) => ({ name, description })))

export const resolveSelectedSkills = <T extends SkillSelectorCandidate>(
  requested: unknown[],
  catalog: T[]
): SkillSelectorInput[] => {
  const byName = new Map(catalog.map((candidate) => [candidate.name, candidate] as const))
  const selected: SkillSelectorInput[] = []
  const seen = new Set<string>()
  for (const name of requested) {
    if (typeof name !== 'string' || seen.has(name)) continue
    const candidate = byName.get(name)
    if (!candidate) continue
    seen.add(name)
    selected.push({ name: candidate.name, path: candidate.path })
    if (selected.length === 3) break
  }
  return selected
}

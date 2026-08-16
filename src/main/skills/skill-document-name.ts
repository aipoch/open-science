import { readFile, writeFile } from 'node:fs/promises'

import { dump as dumpYaml, load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'

const canonicalSkillDocument = (
  raw: string,
  name: string,
  options: {
    omitDisplayName?: boolean
    synthesizeFrontmatter?: { description: string }
  } = {}
): string => {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const synthesize = (body: string): string => {
    const frontmatter = {
      name,
      description: options.synthesizeFrontmatter?.description.trim() || name
    }
    return `---\n${dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd()}\n---\n${body}`
  }
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) {
    if (!options.synthesizeFrontmatter) return raw
    return synthesize(normalized)
  }

  let parsed: unknown
  try {
    parsed = loadYaml(match[1], { schema: FAILSAFE_SCHEMA })
  } catch (error) {
    if (!options.synthesizeFrontmatter) throw error
    return synthesize(normalized.slice(match[0].length))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return options.synthesizeFrontmatter ? synthesize(normalized.slice(match[0].length)) : raw
  }
  const fields = Object.entries(parsed as Record<string, unknown>)
  const frontmatter = {
    ...Object.fromEntries(
      fields.filter(
        ([key]) =>
          key.toLowerCase() !== 'name' &&
          (!options.omitDisplayName || key.toLowerCase() !== 'displayname')
      )
    ),
    name
  }
  const separator = match[0].endsWith('\n') ? '\n' : ''
  return `---\n${dumpYaml(frontmatter, { lineWidth: -1 }).trimEnd()}\n---${separator}${normalized.slice(match[0].length)}`
}

export const hasCanonicalSkillDocumentName = (raw: string, name: string): boolean => {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  // Legacy fixtures and third-party Skills without frontmatter retain the materializer's existing
  // fingerprint-only behavior; there is no declared name to diagnose as stale.
  if (!match) return true

  const parsed = loadYaml(match[1], { schema: FAILSAFE_SCHEMA })
  return Boolean(
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).name === name
  )
}

export const normalizeSkillDocumentName = async (
  path: string,
  name: string,
  options: { synthesizeFrontmatter?: { description: string } } = {}
): Promise<void> => {
  const raw = await readFile(path, 'utf8')
  const normalized = canonicalSkillDocument(raw, name, options)
  if (normalized !== raw) await writeFile(path, normalized, 'utf8')
}

export { canonicalSkillDocument }

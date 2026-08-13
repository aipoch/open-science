import { readFile, writeFile } from 'node:fs/promises'

import { dump as dumpYaml, load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'

const canonicalSkillDocument = (
  raw: string,
  name: string,
  options: { omitDisplayName?: boolean } = {}
): string => {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return raw

  const parsed = loadYaml(match[1], { schema: FAILSAFE_SCHEMA })
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
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

export const normalizeSkillDocumentName = async (path: string, name: string): Promise<void> => {
  const raw = await readFile(path, 'utf8')
  const normalized = canonicalSkillDocument(raw, name)
  if (normalized !== raw) await writeFile(path, normalized, 'utf8')
}

export { canonicalSkillDocument }

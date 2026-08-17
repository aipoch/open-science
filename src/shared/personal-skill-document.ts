import { dump as dumpYaml } from 'js-yaml'

type PersonalSkillDocumentInput = {
  name: string
  description: string
  body: string
  metadata?: Record<string, string>
}

const frontmatterBlock = (fields: Record<string, string>): string =>
  dumpYaml(fields, { lineWidth: -1 })

const serializePersonalSkillDocument = (input: PersonalSkillDocumentInput): string => {
  const metadata = Object.fromEntries(
    Object.entries(input.metadata ?? {}).filter(
      ([key, value]) =>
        key.toLowerCase() !== 'name' &&
        key.toLowerCase() !== 'description' &&
        /^[A-Za-z0-9_-]+$/.test(key) &&
        typeof value === 'string'
    )
  )
  const displayName = metadata.displayname
  delete metadata.displayname
  const frontmatter = `---\n${frontmatterBlock({
    name: input.name,
    description: input.description,
    ...(displayName ? { displayName } : {}),
    ...metadata
  })}---`

  return `${frontmatter}\n\n${input.body.trimStart()}`
}

export { frontmatterBlock, serializePersonalSkillDocument }
export type { PersonalSkillDocumentInput }

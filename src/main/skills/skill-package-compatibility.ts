import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// A package compatibility value covers every regular file, not only SKILL.md. Agent-authored Skills
// commonly include scripts, references, or assets, and changing any of those files must invalidate a
// framework projection even when the frontmatter and its timestamp stay unchanged.
const skillPackageCompatibility = async (sourceDir: string): Promise<string> => {
  const hash = createHash('sha256')
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
      } else if (entry.isFile()) {
        hash.update(relativePath)
        hash.update('\0')
        hash.update(await readFile(absolutePath))
        hash.update('\0')
      }
    }
  }
  await visit(sourceDir)
  return `sha256:${hash.digest('hex')}`
}

export { skillPackageCompatibility }

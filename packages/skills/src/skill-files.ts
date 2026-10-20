import { readFile, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { parseFrontmatter } from './frontmatter'

// Reads a skill directory's SKILL.md into its frontmatter fields + body. Shared by the bundled registry
// and the writable user-skill repository so every source parses skills the same way.
const readSkillFile = async (
  dir: string
): Promise<{ fields: Record<string, string>; body: string }> => {
  const raw = await readFile(join(dir, 'SKILL.md'), 'utf8')

  return parseFrontmatter(raw)
}

export { readSkillFile }

import type { SkillPackageFileInfo, SkillReferenceInfo } from './types'
export type { SkillPackageFileInfo, SkillReferenceInfo } from './types'

export async function listSkillPackageFiles(sourceDir: string): Promise<SkillPackageFileInfo[]> {
  const files: SkillPackageFileInfo[] = []
  const visit = async (directory: string, parentPath: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      const path = parentPath ? `${parentPath}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, path)
      } else if (entry.isFile()) {
        const metadata = await lstat(absolutePath)
        if (metadata.isFile()) {
          files.push({ path, sizeBytes: metadata.size })
        }
      }
    }
  }
  await visit(sourceDir, '')
  return files
}

export function skillReferencesFromPackageFiles(
  packageFiles: readonly SkillPackageFileInfo[]
): SkillReferenceInfo[] {
  const prefix = 'references/'
  return packageFiles.flatMap((file) => {
    if (!file.path.startsWith(prefix)) return []
    const path = file.path.slice(prefix.length)
    return path.includes('/') ? [] : [{ path, sizeBytes: file.sizeBytes }]
  })
}

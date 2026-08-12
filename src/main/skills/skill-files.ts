import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { SkillFileEntry } from '../../shared/settings'
import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'
import { parseFrontmatter } from './frontmatter'
import { isSkillDocumentName } from './skill-bundle-paths'
import { isUnsafeSkillArchivePath } from './zip-extract'

// Skill-root files that exist on disk for app bookkeeping but are not part of the portable skill
// content. Excluded at the skill root only; a same-named file inside a subdirectory is legitimate
// content and is kept. Shared with the export walker so both surfaces agree on what is internal.
export const INTERNAL_SKILL_FILES = new Set(['.source.json', '.specialist-package.json'])

const SKILL_DOCUMENT = 'SKILL.md'

// Reads a skill directory's SKILL.md into its frontmatter fields + body. Shared by the bundled registry
// and the writable user-skill repository so every source parses skills the same way.
const readSkillFile = async (
  dir: string
): Promise<{ fields: Record<string, string>; body: string }> => {
  const raw = await readFile(join(dir, SKILL_DOCUMENT), 'utf8')
  return parseFrontmatter(raw)
}

// Lists every file shipped inside a skill directory (references/, scripts/, assets/, templates/,
// and anything else) as read-only detail-view entries. The interface is one directory in and a flat
// list of posix relative paths + sizes out; the recursion, exclusion rules, link safety, and
// depth/count caps all live inside. A read-only listing never fails the page on a bad entry: unsafe
// paths, symbolic/hard links, unsupported node types, and depth/count overruns are skipped, and a
// missing or empty directory yields [].
export const listSkillFiles = async (sourceDir: string): Promise<SkillFileEntry[]> => {
  const entries: SkillFileEntry[] = []
  let fileCount = 0

  const visit = async (
    directory: string,
    relativeDirectory: string,
    depth: number
  ): Promise<void> => {
    if (depth > SKILL_IMPORT_LIMITS.maxDepth) return
    let dirEntries
    try {
      dirEntries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    dirEntries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of dirEntries) {
      if (!relativeDirectory && INTERNAL_SKILL_FILES.has(entry.name)) continue
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name
      // The skill document is rendered as the body; don't also list it as an attached file.
      if (isSkillDocumentName(relativePath)) continue
      if (isUnsafeSkillArchivePath(relativePath)) continue

      let metadata
      try {
        metadata = await lstat(join(directory, entry.name))
      } catch {
        continue
      }
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) {
        await visit(join(directory, entry.name), relativePath, depth + 1)
      } else if (metadata.isFile()) {
        // A hard-linked entry (nlink > 1) is treated as unsafe and skipped, matching the export walker.
        if (metadata.nlink > 1) continue
        if (fileCount >= SKILL_IMPORT_LIMITS.maxFiles) continue
        fileCount += 1
        entries.push({ path: relativePath, size: metadata.size })
      }
    }
  }

  await visit(sourceDir, '', 0)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

export { readSkillFile }

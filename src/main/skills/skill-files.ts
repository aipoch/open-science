import { readFile } from 'node:fs/promises'
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

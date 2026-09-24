import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { inspectSkillPackage } from './skill-package-inspection'

export type SkillPublicationReview = {
  kind: 'skill-publication'
  name: string
  overwrite: boolean
  previousFiles?: SkillPublicationReview['files']
  files: Array<{ path: string; bytes: number; sha256: string; content?: string }>
}

/** Called on the validated staging directory while the catalog mutation lock is held. */
export async function reviewSkillPublication(
  root: string,
  name: string,
  overwrite: boolean
): Promise<SkillPublicationReview> {
  const files: SkillPublicationReview['files'] = []
  for (const file of await inspectSkillPackage(root)) {
    const bytes = await readFile(file.absolutePath)
    const content = bytes.toString('utf8')
    files.push({
      path: file.relativePath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(Buffer.from(content).equals(bytes) && !content.includes('\0') ? { content } : {})
    })
  }
  return { kind: 'skill-publication', name, overwrite, files }
}

export type ReviewStagedSkill = (
  staging: string,
  previous?: string,
  unchanged?: boolean
) => Promise<void | (() => void)>

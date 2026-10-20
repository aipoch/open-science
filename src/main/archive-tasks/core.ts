import { zipSync, type Zippable } from 'fflate'
import { discoverSkillRoots } from '@aipoch/skills/sources'
import { validateSpecialistZip, buildDeterministicSpecialistZip } from '@aipoch/specialists/node'
import { parseSkillDocument } from '@aipoch/skills/document'
export type ArchiveTask =
  | { kind: 'zip'; files: Zippable }
  | { kind: 'specialist-export'; files: Record<string, Uint8Array> }
  | { kind: 'discover'; bytes: Uint8Array }
  | { kind: 'specialist'; bytes: Uint8Array; catalog: Parameters<typeof validateSpecialistZip>[1] }
export const executeArchiveTask = (task: ArchiveTask): unknown => {
  switch (task.kind) {
    case 'zip':
      return zipSync(task.files, { level: 6 })
    case 'specialist-export':
      return buildDeterministicSpecialistZip(task.files)
    case 'discover':
      return discoverSkillRoots(Buffer.from(task.bytes))
    case 'specialist':
      return validateSpecialistZip(task.bytes, task.catalog, parseSkillDocument)
  }
}

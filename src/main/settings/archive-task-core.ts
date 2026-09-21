import { zipSync, type Zippable } from 'fflate'
import { discoverSkillRoots } from '../skills/skill-archive-discovery'
import { verifyMarketplacePackage } from '../skills/marketplace-package'
import { validateSpecialistZip } from '../specialist/package/zip-adapter'
import { buildDeterministicSpecialistZip } from '../specialist/package/archive-builder'
export type ArchiveTask =
  | { kind: 'zip'; files: Zippable }
  | { kind: 'specialist-export'; files: Record<string, Uint8Array> }
  | { kind: 'discover'; bytes: Uint8Array }
  | { kind: 'specialist'; bytes: Uint8Array; catalog: Parameters<typeof validateSpecialistZip>[1] }
  | { kind: 'marketplace'; args: Parameters<typeof verifyMarketplacePackage> }
export const executeArchiveTask = (task: ArchiveTask): unknown => {
  switch (task.kind) {
    case 'zip':
      return zipSync(task.files, { level: 6 })
    case 'specialist-export':
      return buildDeterministicSpecialistZip(task.files)
    case 'discover':
      return discoverSkillRoots(Buffer.from(task.bytes))
    case 'specialist':
      return validateSpecialistZip(task.bytes, task.catalog)
    case 'marketplace':
      return verifyMarketplacePackage(
        Buffer.from(task.args[0]),
        task.args[1],
        task.args[2],
        task.args[3]
      )
  }
}

import { strToU8 } from 'fflate'
import { SPECIALIST_PACKAGE_ARCHIVE_LIMITS } from '@aipoch/specialists'
import {
  scanSpecialistArchive,
  normalizeSpecialistArchiveFiles,
  buildDeterministicSpecialistZip
} from '@aipoch/specialists/node'

const MARKETPLACE_ARCHIVE_LIMITS = {
  ...SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  fileCount: 4_096
}

const SAFE_MARKETPLACE_CAPABILITY = /^[a-z0-9][a-z0-9-]{0,127}$/

// Marketplace archives are digest-verified before this function is called. Scan the complete
// immutable artifact with the narrowly raised file-count cap, then produce an ordinary portable
// package containing only the capabilities the user reviewed. The resulting ZIP returns to the
// existing 2,000-file validator and install transaction.
export const filterMarketplaceSpecialistZip = (
  archiveBytes: Uint8Array,
  selectedSkillNames: readonly string[],
  selectedConnectorIds: readonly string[]
): Uint8Array => {
  const skillNames = [...new Set(selectedSkillNames)]
  const connectorIds = [...new Set(selectedConnectorIds)]
  if (
    skillNames.some((name) => !SAFE_MARKETPLACE_CAPABILITY.test(name)) ||
    connectorIds.some((id) => !SAFE_MARKETPLACE_CAPABILITY.test(id))
  ) {
    throw new Error('Marketplace selection contains an invalid capability identity.')
  }

  const scanned = scanSpecialistArchive(archiveBytes, MARKETPLACE_ARCHIVE_LIMITS)
  if (!scanned.files) throw new Error('Marketplace archive failed safe extraction.')
  const files = normalizeSpecialistArchiveFiles(scanned.files)
  if (!files) throw new Error('Marketplace archive has an invalid package layout.')

  const availableSkills = new Set(
    files.flatMap((file) => {
      const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)
      return match?.[1] ? [match[1]] : []
    })
  )
  const missingSkill = skillNames.find((name) => !availableSkills.has(name))
  if (missingSkill)
    throw new Error(`Marketplace archive is missing selected Skill ${missingSkill}.`)

  const specialistFile = files.find((file) => file.path === 'specialist.json')
  if (!specialistFile) throw new Error('Marketplace archive is missing specialist.json.')
  let specialist: Record<string, unknown>
  try {
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(specialistFile.bytes)
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    specialist = parsed as Record<string, unknown>
  } catch {
    throw new Error('Marketplace archive contains invalid specialist.json.')
  }

  const selected = new Set(skillNames)
  const filtered: Record<string, Uint8Array> = {}
  for (const file of files) {
    if (file.path === 'specialist.json') continue
    const skillMatch = /^skills\/([^/]+)\//.exec(file.path)
    if (skillMatch && !selected.has(skillMatch[1])) continue
    filtered[file.path] = file.bytes
  }
  filtered['specialist.json'] = strToU8(
    `${JSON.stringify({ ...specialist, skill_ids: skillNames, connector_ids: connectorIds }, null, 2)}\n`
  )
  return buildDeterministicSpecialistZip(filtered)
}

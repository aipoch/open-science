import { randomUUID } from 'node:crypto'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { SPECIALIST_PACKAGE_SCHEMA_VERSION } from '../archive-contracts'

const assertValidAppVersion = (appVersion: string): void => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(appVersion)
  if (!match) throw new Error('Application version must be SemVer.')
}

export const buildDeterministicSpecialistZip = (
  files: Readonly<Record<string, Uint8Array>>
): Uint8Array => {
  const zipOptions = { mtime: new Date(1980, 0, 1) }
  const entries: Zippable = {}
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    entries[path] = [bytes, zipOptions]
  }
  return zipSync(entries, { level: 6 })
}

export const buildContributionTemplateZip = (input: {
  appVersion: string
  readme: string
  packageId?: string
}): Uint8Array => {
  assertValidAppVersion(input.appVersion)
  const manifest = {
    schema_version: SPECIALIST_PACKAGE_SCHEMA_VERSION,
    id: input.packageId ?? randomUUID(),
    version: '0.1.0',
    exported_with_app_version: input.appVersion
  }
  const specialist = {
    name: '',
    description: '',
    system_prompt: '',
    skill_ids: [],
    connector_ids: []
  }
  return buildDeterministicSpecialistZip({
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    'specialist.json': strToU8(`${JSON.stringify(specialist, null, 2)}\n`),
    'README.txt': strToU8(input.readme)
  })
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  BuiltinSpecialistRegistryEntry,
  BuiltinSpecialistRegistryResult,
  PackageDiagnostic,
  SpecialistPackageCatalogSnapshot
} from '../../shared/specialist-package'
import { resolveBundledSpecialistsRoot } from './builtin-resource-path'
import { validateSpecialistDirectory } from './package/directory-adapter'

const SAFE_DIRECTORY = /^[a-z0-9-]+$/

const parseRegistryManifest = (value: unknown): string[] | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.specialists)) return undefined
  if (
    !record.specialists.every(
      (entry): entry is string => typeof entry === 'string' && SAFE_DIRECTORY.test(entry)
    )
  ) {
    return undefined
  }
  return [...record.specialists]
}

export class BuiltinSpecialistRegistry {
  constructor(
    private readonly catalog: SpecialistPackageCatalogSnapshot,
    private readonly root = resolveBundledSpecialistsRoot()
  ) {}

  async load(): Promise<BuiltinSpecialistRegistryResult> {
    let directories: string[] | undefined
    try {
      const parsed = JSON.parse(await readFile(join(this.root, 'manifest.json'), 'utf8')) as unknown
      directories = parseRegistryManifest(parsed)
    } catch {
      directories = undefined
    }
    if (!directories) {
      return {
        entries: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'builtin.registry-manifest-invalid',
            message: 'The builtin Specialist registry manifest is invalid.',
            path: 'manifest.json'
          }
        ]
      }
    }
    const diagnostics: PackageDiagnostic[] = []
    const entries: BuiltinSpecialistRegistryEntry[] = []
    const seenDirectories = new Set<string>()
    const seenIds = new Set<string>()
    for (const directory of directories) {
      if (seenDirectories.has(directory)) {
        diagnostics.push({
          severity: 'error',
          code: 'builtin.registry-directory-duplicate',
          message: 'A builtin Specialist directory is registered more than once.',
          path: 'manifest.json',
          relatedId: directory
        })
        continue
      }
      seenDirectories.add(directory)
      const result = await validateSpecialistDirectory(
        join(this.root, directory),
        this.catalog,
        'builtin'
      )
      diagnostics.push(...result.preview.diagnostics)
      if (!result.plan || result.preview.diagnostics.some((item) => item.severity === 'error'))
        continue
      if (seenIds.has(result.plan.specialistId)) {
        diagnostics.push({
          severity: 'error',
          code: 'builtin.specialist-id-duplicate',
          message: 'A builtin Specialist ID is registered more than once.',
          path: 'manifest.json',
          relatedId: result.plan.specialistId
        })
        continue
      }
      seenIds.add(result.plan.specialistId)
      entries.push({
        kind: 'builtin',
        readonly: true,
        enabled: true,
        id: result.plan.specialistId,
        version: result.plan.packageVersion,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: {
          skillIds: [...result.plan.skillIds],
          connectorIds: [...result.plan.connectorIds],
          connectorTools: []
        },
        ...result.plan.payload
      })
    }
    return { entries, diagnostics }
  }
}

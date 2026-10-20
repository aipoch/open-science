import { createLogger } from '@aipoch/diagnostics/node'
import {
  createSpecialistDomain,
  SpecialistReadonlyError,
  type SpecialistDomain,
  type SpecialistCatalog,
  type SpecialistDomainOptions
} from '@aipoch/specialists/node'
import type {
  BuiltinSpecialistRegistryResult,
  SpecialistView,
  UpdateSpecialistInput
} from '@aipoch/specialists'
import type { SpecialistCatalogSnapshot, SpecialistListItem } from '../../shared/specialist'
import { agentsPublicError } from '../agents/agents-error'

const managedUpdateKeys = new Set<keyof UpdateSpecialistInput>([
  'id',
  'revision',
  'iconKey',
  'colorKey'
])
const readonlyReviewer = (): never => {
  throw new SpecialistReadonlyError('reviewer', 'reviewer', 'Reviewer is read-only.')
}
const readonlyManaged = (id: string): never => {
  throw new SpecialistReadonlyError(
    'marketplace',
    id,
    `Marketplace-managed Specialist ${id} content is read-only.`
  )
}

/** Product policy and Settings presentation over one independent domain owner. */
export const createHostSpecialistDomain = (
  storageDir: string,
  builtinRegistry?: SpecialistDomainOptions['builtinRegistry']
): SpecialistDomain & { catalog: SpecialistService } => {
  const domain = createSpecialistDomain({
    storageDir,
    builtinRegistry,
    logger: createLogger('specialist.service'),
    policy: {
      reservedIds: ['reviewer'],
      assertMutableId: (id) => {
        if (id === 'reviewer') readonlyReviewer()
      },
      assertCreatableName: (name) => {
        if (name.trim().toLowerCase() === 'reviewer') readonlyReviewer()
      },
      assertContentMutable: (profile) => {
        if (profile.origin === 'marketplace') readonlyManaged(profile.id)
      },
      assertUpdate: (profile, input) => {
        if (
          profile.origin === 'marketplace' &&
          Object.keys(input).some(
            (key) => !managedUpdateKeys.has(key as keyof UpdateSpecialistInput)
          )
        )
          readonlyManaged(profile.id)
      }
    }
  })
  const catalog = Object.assign(domain.catalog, {
    async listForSettings(): Promise<SpecialistListItem[]> {
      return (await catalog.listForSettingsSnapshot()).items
    },
    async listForSettingsSnapshot(): Promise<SpecialistCatalogSnapshot> {
      const snapshot = await domain.catalog.catalogSnapshot()
      return { ...snapshot, items: [...snapshot.items, { kind: 'reviewer', id: 'reviewer' }] }
    },
    async markMarketplaceManaged(id: string, expectedRevision: number): Promise<SpecialistView> {
      const current = await domain.catalog.getById(id)
      if (current.revision !== expectedRevision) {
        throw agentsPublicError(
          `Revision conflict: expected ${expectedRevision}, found ${current.revision}. Read the current Specialist with host.agents.get({ name }) before deciding whether to apply the update again.`
        )
      }
      if (current.origin === 'marketplace') return current
      if (current.origin !== 'imported' || !current.importBaseline) {
        throw agentsPublicError('Only an exact imported package can become Marketplace-managed.')
      }
      return domain.catalog.changeOrigin(id, expectedRevision, 'marketplace')
    }
  })
  return { ...domain, catalog }
}
export type SpecialistService = SpecialistCatalog & {
  listForSettings(): Promise<SpecialistListItem[]>
  listForSettingsSnapshot(): Promise<SpecialistCatalogSnapshot>
  markMarketplaceManaged(id: string, expectedRevision: number): Promise<SpecialistView>
}
export const createSpecialistService = (
  storageDir: string,
  builtinRegistry?: { load(): Promise<BuiltinSpecialistRegistryResult> }
): SpecialistService => createHostSpecialistDomain(storageDir, builtinRegistry).catalog

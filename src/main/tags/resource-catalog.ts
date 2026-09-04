import type { TagResourceRef, TagResourceType } from '../../shared/tags'

type CatalogEntry = Readonly<{ id: string; available?: boolean }>
type ConnectorCatalog = Readonly<{
  connectors: readonly CatalogEntry[]
  customServers: readonly CatalogEntry[]
}>

type TagResourceCatalogDependencies = Readonly<{
  listSkills(): Promise<readonly CatalogEntry[]>
  listConnectors(): Promise<ConnectorCatalog>
  listSpecialists(): Promise<readonly CatalogEntry[]>
}>

type TagResourceCatalogSnapshot = Readonly<Record<TagResourceType, ReadonlySet<string>>>

class TagResourceCatalog {
  constructor(private readonly dependencies: TagResourceCatalogDependencies) {}

  async snapshot(): Promise<TagResourceCatalogSnapshot> {
    const [skills, connectors, specialists] = await Promise.all([
      this.dependencies.listSkills(),
      this.dependencies.listConnectors(),
      this.dependencies.listSpecialists()
    ])
    return Object.freeze({
      'catalog.skill': new Set(
        skills.filter(({ available }) => available !== false).map(({ id }) => id)
      ),
      'catalog.connector': new Set([
        ...connectors.connectors.map(({ id }) => id),
        ...connectors.customServers.map(({ id }) => id)
      ]),
      'catalog.specialist': new Set(specialists.map(({ id }) => id))
    })
  }

  async exists(reference: TagResourceRef): Promise<boolean> {
    return (await this.snapshot())[reference.resourceType].has(reference.resourceId)
  }
}

export { TagResourceCatalog }
export type { TagResourceCatalogDependencies, TagResourceCatalogSnapshot }

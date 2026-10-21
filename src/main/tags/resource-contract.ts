import type { TagResourceType } from '../../shared/tags'

export type TagResourceCatalogSnapshot = Readonly<Record<TagResourceType, ReadonlySet<string>>>

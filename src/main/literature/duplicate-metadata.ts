import { isDeepStrictEqual } from 'node:util'
import {
  LITERATURE_IDENTITY_SCHEMES,
  normalizeLiteratureIdentifierValue,
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureMergeStrategy,
  type LiteratureItemInput
} from '../../shared/literature'

const empty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && !value.trim()) ||
  (Array.isArray(value) && value.length === 0)

const identifierValue = (identifier: LiteratureItemInput['identifiers'][number]): string =>
  normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value).toLowerCase()

// Preserve populated fields (including notes and rating); identifiers are filled by scheme.
export function supplementLiteratureMetadata(
  existing: LiteratureItemInput,
  incoming: LiteratureItemInput
): { item: LiteratureItemInput; conflict: boolean } {
  if (existing.itemType !== incoming.itemType) return { item: existing, conflict: true }
  let conflict = false
  const fields = { ...existing }
  for (const key of Object.keys(existing) as (keyof LiteratureItemInput)[]) {
    if (key === 'identifiers' || key === 'typeFields') continue
    const left = existing[key]
    const right = incoming[key]
    const leftEmpty = empty(left) || (key === 'rating' && left === 0)
    const rightEmpty = empty(right) || (key === 'rating' && right === 0)
    if (leftEmpty && !rightEmpty) Object.assign(fields, { [key]: right })
    else if (!leftEmpty && !rightEmpty && !isDeepStrictEqual(left, right)) conflict = true
  }
  // Optional fields may be absent rather than explicitly undefined in parsed inputs.
  for (const key of Object.keys(incoming) as (keyof LiteratureItemInput)[]) {
    if (!(key in fields)) Object.assign(fields, { [key]: incoming[key] })
  }
  fields.typeFields = { ...existing.typeFields }
  for (const [key, value] of Object.entries(incoming.typeFields)) {
    if (empty(fields.typeFields[key])) fields.typeFields[key] = value
    else if (!empty(value) && !isDeepStrictEqual(fields.typeFields[key], value)) conflict = true
  }
  fields.identifiers = [...existing.identifiers]
  for (const scheme of new Set(incoming.identifiers.map((id) => id.scheme))) {
    const left = existing.identifiers.filter((id) => id.scheme === scheme)
    const right = incoming.identifiers.filter((id) => id.scheme === scheme)
    if (left.length === 0) fields.identifiers.push(...right)
    else if (
      !isDeepStrictEqual(new Set(left.map(identifierValue)), new Set(right.map(identifierValue)))
    )
      conflict = true
  }
  return { item: literatureItemInputSchema.parse(fields), conflict }
}

export function conflictFreeLiteratureMerge(
  items: LiteratureItemInput[]
): LiteratureItemInput | undefined {
  if (items.length < 2 || items.length > 20) return undefined
  const shared = items[0].identifiers.some(
    (identifier) =>
      LITERATURE_IDENTITY_SCHEMES.some((scheme) => scheme === identifier.scheme) &&
      items.every((item) =>
        item.identifiers.some(
          (other) =>
            other.scheme === identifier.scheme &&
            identifierValue(other) === identifierValue(identifier)
        )
      )
  )
  if (!shared) return undefined
  let merged = items[0]
  for (const item of items.slice(1)) {
    const result = supplementLiteratureMetadata(merged, item)
    if (result.conflict) return undefined
    merged = result.item
  }
  return merged
}

// Count populated bibliographic fields, not text length, notes, rating or attachment size.
const completeness = (item: LiteratureItemInput): number =>
  Object.entries(item).filter(
    ([key, value]) =>
      !['personalNote', 'rating', 'typeFields', 'identifiers'].includes(key) && !empty(value)
  ).length +
  Object.values(item.typeFields).filter((value) => !empty(value)).length +
  new Set(item.identifiers.map(({ scheme }) => scheme)).size

export function planLiteratureMerge(
  views: LiteratureItemView[],
  strategy: LiteratureMergeStrategy
):
  | {
      survivor: LiteratureItemView
      item: LiteratureItemInput
      conflicts: boolean
    }
  | undefined {
  if (views.length < 2 || views.length > 20) return undefined
  const ordered = [...views].sort(
    (a, b) =>
      (strategy === 'most-complete'
        ? completeness(b.item) - completeness(a.item)
        : strategy === 'newest'
          ? b.updatedAt - a.updatedAt
          : 0) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id)
  )
  const survivor = ordered[0]!
  // Every member must share a strong identifier. Contradictory identifiers or types
  // always require individual review, even when the user selects a survivor rule.
  const identityOnly = ordered.map(({ item }) =>
    literatureItemInputSchema.parse({
      itemType: item.itemType,
      title: 'identity',
      identifiers: item.identifiers
    })
  )
  if (!conflictFreeLiteratureMerge(identityOnly)) return undefined
  let item = survivor.item
  let conflicts = false
  for (const other of ordered.slice(1)) {
    const result = supplementLiteratureMetadata(item, other.item)
    conflicts ||= result.conflict
    item = result.item
  }
  if (strategy === 'conflict-free' && conflicts) return undefined
  return { survivor, item, conflicts }
}

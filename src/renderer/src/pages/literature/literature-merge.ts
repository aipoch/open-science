import {
  preferredLiteratureIdentifier,
  normalizeLiteratureIdentifierValue,
  normalizeLiteratureIdentifierPreferences,
  type LiteratureItemInput,
  type LiteratureItemView
} from '../../../../shared/literature'

export const mergeScalarFields = [
  'title',
  'abstract',
  'issuedText',
  'issuedYear',
  'containerTitle',
  'shortTitle',
  'language',
  'rights',
  'url',
  'citationKey',
  'extra',
  'personalNote',
  'rating',
  'accessedAt'
] as const

export type LiteratureMergeField =
  | (typeof mergeScalarFields)[number]
  | 'itemType'
  | 'creators'
  | `identifier:${string}`
  | `type:${string}`

export function mergeFieldValue(item: LiteratureItemInput, field: LiteratureMergeField): unknown {
  if (field.startsWith('identifier:'))
    return item.identifiers
      .filter((id) => id.scheme === field.slice(11))
      .map((id) => id.value)
      .sort()
  if (field.startsWith('type:')) return item.typeFields[field.slice(5)]
  return item[field as keyof LiteratureItemInput]
}

// Ignore object key order and equivalent empty values, but preserve creator order
// and actual text differences. Attachment/association timestamps are not metadata.
export function mergeValueKey(value: unknown): string {
  if (value == null || value === '' || value === 0) return ''
  if (Array.isArray(value)) return value.length ? JSON.stringify(value.map(mergeValueKey)) : ''
  if (typeof value === 'object')
    return JSON.stringify(
      Object.entries(value)
        .map(([key, entry]) => [key, mergeValueKey(entry)])
        .filter(([, entry]) => entry !== '')
        .sort(([a], [b]) => a.localeCompare(b))
    )
  return String(value)
}

export function literatureMergeRows(entries: LiteratureItemView[]): {
  field: LiteratureMergeField
  values: unknown[]
  different: boolean
  selectable: boolean
}[] {
  const fields: LiteratureMergeField[] = [
    ...mergeScalarFields,
    'itemType',
    'creators',
    ...[...new Set(entries.flatMap(({ item }) => item.identifiers.map((id) => id.scheme)))]
      .sort()
      .map((scheme): LiteratureMergeField => `identifier:${scheme}`),
    ...[...new Set(entries.flatMap(({ item }) => Object.keys(item.typeFields)))]
      .sort()
      .map((key): LiteratureMergeField => `type:${key}`)
  ]
  return fields
    .map((field) => {
      const values = entries.map(({ item }) => mergeFieldValue(item, field))
      const keys = values.map(mergeValueKey)
      return {
        field,
        values,
        different: new Set(keys).size > 1,
        selectable: !field.startsWith('identifier:') && new Set(keys.filter(Boolean)).size > 1
      }
    })
    .filter(({ values }) => values.some((value) => mergeValueKey(value) !== ''))
}

export function mergeFieldSource(
  entries: LiteratureItemView[],
  survivorId: string,
  sources: Record<string, string>,
  field: LiteratureMergeField
): LiteratureItemView | undefined {
  return (
    entries.find((entry) => entry.id === sources[field]) ??
    entries.find(
      (entry) => entry.id === survivorId && mergeValueKey(mergeFieldValue(entry.item, field))
    ) ??
    entries.find((entry) => mergeValueKey(mergeFieldValue(entry.item, field)))
  )
}

export function buildLiteratureMergeItem(
  entries: LiteratureItemView[],
  survivorId: string,
  sources: Record<string, string>
): LiteratureItemInput {
  const survivor = entries.find((entry) => entry.id === survivorId)
  if (!survivor) throw new Error('Missing merge survivor')
  const merged = { ...survivor.item, typeFields: { ...survivor.item.typeFields } }
  for (const { field } of literatureMergeRows(entries)) {
    if (field.startsWith('identifier:')) continue
    const source = mergeFieldSource(entries, survivorId, sources, field)
    if (!source) continue
    const value = mergeFieldValue(source.item, field)
    if (field.startsWith('type:')) merged.typeFields[field.slice(5)] = value
    else Object.assign(merged, { [field]: value })
  }
  const seen = new Set<string>()
  const ordered = [
    survivor,
    ...entries.filter((entry) => entry.id !== survivorId).sort((a, b) => a.id.localeCompare(b.id))
  ]
  const preferred = new Map<
    LiteratureItemInput['identifiers'][number]['scheme'],
    LiteratureItemInput['identifiers'][number] | undefined
  >(
    ordered.flatMap(({ item }) =>
      item.identifiers.map(({ scheme }) => [scheme, undefined] as const)
    )
  )
  for (const scheme of preferred.keys()) {
    const source = ordered.find(({ item }) =>
      item.identifiers.some((identifier) => identifier.scheme === scheme)
    )!
    preferred.set(scheme, preferredLiteratureIdentifier(source.item.identifiers, scheme))
  }
  merged.identifiers = normalizeLiteratureIdentifierPreferences(
    ordered
      .flatMap(({ item }) =>
        item.identifiers.map((identifier) => ({
          ...identifier,
          isPrimary:
            normalizeLiteratureIdentifierValue(
              identifier.scheme,
              preferred.get(identifier.scheme)!.value
            ).toLowerCase() ===
            normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value).toLowerCase()
        }))
      )
      .filter((identifier) => {
        const key = `${identifier.scheme}:${normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value).toLowerCase()}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  )
  return merged
}

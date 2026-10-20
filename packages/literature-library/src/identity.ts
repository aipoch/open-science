import {
  LITERATURE_IDENTITY_SCHEMES,
  normalizeLiteratureIdentifierPreferences,
  normalizeLiteratureIdentifierValue,
  type LiteratureCreatorInput,
  type LiteratureIdentifierInput,
  type LiteratureIdentifierScheme
} from '@aipoch/literature-citations/contracts'
import { createHash } from 'node:crypto'
import {
  LITERATURE_IMPORT_IDENTITY_CONFLICT,
  type LiteratureCandidateInput,
  type LiteratureItemInput,
  type LiteratureRecordImportEntry
} from './contracts.js'
import type { LibraryStore } from './ports.js'
const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
const identitySchemes = new Set<string>(LITERATURE_IDENTITY_SCHEMES)

const normalizeSpace = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ')

const normalizeIdentifier = (scheme: LiteratureIdentifierScheme, rawValue: string): string => {
  const value = normalizeSpace(rawValue)
  switch (scheme) {
    case 'doi':
      return normalizeLiteratureIdentifierValue(scheme, value).toLowerCase()
    case 'pmid':
      return normalizeLiteratureIdentifierValue(scheme, value)
    case 'pmcid':
      return normalizeLiteratureIdentifierValue(scheme, value)
    case 'arxiv':
      return normalizeLiteratureIdentifierValue(scheme, value).toLowerCase()
    case 'isbn':
    case 'issn':
      return value.replace(/[^0-9X]/giu, '').toUpperCase()
    case 'other':
      return value.toLowerCase()
  }
}

const normalizeCreatorName = (creator: LiteratureCreatorInput): string =>
  creator.nameMode === 'organization'
    ? normalizeSearchText(creator.literalName)
    : normalizeSearchText(`${creator.familyName} ${creator.givenName}`)

const canonicalJsonValue = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)])
    )
  }
  throw new Error('Literature metadata must contain JSON-compatible values.')
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalJsonValue(value))

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const normalizedIdentifiers = (
  identifiers: readonly LiteratureIdentifierInput[]
): Array<LiteratureIdentifierInput & { normalizedValue: string }> => {
  const unique = new Map<string, LiteratureIdentifierInput & { normalizedValue: string }>()
  for (const identifier of identifiers) {
    const normalizedValue = normalizeIdentifier(identifier.scheme, identifier.value)
    if (!normalizedValue) throw new Error(`Literature ${identifier.scheme} identifier is empty.`)
    const key = `${identifier.scheme}:${normalizedValue}`
    if (!unique.has(key) || identifier.isPrimary)
      unique.set(key, { ...identifier, normalizedValue })
  }
  return normalizeLiteratureIdentifierPreferences([...unique.values()])
}

const candidateDedupeKey = (candidate: LiteratureCandidateInput): string => {
  const identity = normalizedIdentifiers(candidate.item.identifiers).find(({ scheme }) =>
    identitySchemes.has(scheme)
  )
  if (identity) return `${identity.scheme}:${identity.normalizedValue}`
  if (candidate.source.externalId) {
    return `source:${normalizeSpace(candidate.source.provider).toLowerCase()}:${normalizeSpace(candidate.source.externalId).toLowerCase()}`
  }
  const firstCreator = candidate.item.creators[0]
  return `metadata:${sha256(
    canonicalJson({
      creator: firstCreator ? normalizeCreatorName(firstCreator) : '',
      issuedYear: candidate.item.issuedYear ?? null,
      title: normalizeSpace(candidate.item.title).toLowerCase()
    })
  )}`
}

// Deletion intents are independent recovery records, not a Project foreign-key relation.
const findIdentityItem = async (
  store: LibraryStore,
  identifiers: readonly (LiteratureIdentifierInput & { normalizedValue: string })[]
): Promise<string | undefined> => {
  const identity = identifiers.filter(({ scheme }) => identitySchemes.has(scheme))
  if (identity.length === 0) return undefined
  const matches = await store.identityMatches(identity)
  const owners = matches.map((match) =>
    match.identifiers.filter(({ scheme }) => identitySchemes.has(scheme))
  )
  // Multiple values are established aliases only when one stored owner contains them all.
  if (
    identity.some(
      (identifier) =>
        identity.some(
          (other) =>
            other.scheme === identifier.scheme &&
            other.normalizedValue !== identifier.normalizedValue
        ) &&
        !owners.some((owner) =>
          identity
            .filter(({ scheme }) => scheme === identifier.scheme)
            .every((alias) =>
              owner.some(
                ({ scheme, normalizedValue }) =>
                  scheme === alias.scheme && normalizedValue === alias.normalizedValue
              )
            )
        )
    )
  )
    throw new Error(LITERATURE_IMPORT_IDENTITY_CONFLICT)
  // Explicit copies may lack fields, but must share an identity and agree on populated schemes.
  const commonIdentity = owners[0]?.filter((identifier) =>
    owners.every((existing) =>
      existing.some(
        ({ scheme, normalizedValue }) =>
          scheme === identifier.scheme && normalizedValue === identifier.normalizedValue
      )
    )
  )
  if (
    (owners.length > 1 && commonIdentity?.length === 0) ||
    owners.some(
      (existing) =>
        identity.some((identifier) => {
          const sameScheme = existing.filter(({ scheme }) => scheme === identifier.scheme)
          return (
            sameScheme.length > 0 &&
            !owners.some((owner) =>
              owner.some(
                ({ scheme, normalizedValue }) =>
                  scheme === identifier.scheme && normalizedValue === identifier.normalizedValue
              )
            )
          )
        }) ||
        owners.some((other) =>
          existing.some((identifier) => {
            const sameScheme = other.filter(({ scheme }) => scheme === identifier.scheme)
            return (
              sameScheme.length > 0 &&
              !sameScheme.some(({ normalizedValue }) =>
                existing.some(
                  (alias) =>
                    alias.scheme === identifier.scheme && alias.normalizedValue === normalizedValue
                )
              )
            )
          })
        )
    )
  )
    throw new Error(LITERATURE_IMPORT_IDENTITY_CONFLICT)
  return matches[0]?.id
}

const identityKey = (scheme: string, value: string): string => `${scheme}:${value}`

type ImportIdentityIndex = {
  byIdentifier: Map<string, Set<string | number>>
  records: Map<string | number, Pick<LiteratureItemInput, 'title' | 'identifiers'>>
}

const rememberImportIdentity = (
  index: ImportIdentityIndex,
  target: string | number,
  item: Pick<LiteratureItemInput, 'title' | 'identifiers'>
): void => {
  index.records.set(target, item)
  for (const { scheme, normalizedValue } of normalizedIdentifiers(item.identifiers)) {
    if (!identitySchemes.has(scheme)) continue
    const key = identityKey(scheme, normalizedValue)
    const targets = index.byIdentifier.get(key) ?? new Set<string | number>()
    targets.add(target)
    index.byIdentifier.set(key, targets)
  }
}

// Include all owners, including Trash and explicitly independent duplicates.
const importIdentityMap = async (
  store: Pick<LibraryStore, 'importIdentityRecords'>,
  items: readonly LiteratureItemInput[]
): Promise<ImportIdentityIndex> => {
  const identifiers = items
    .flatMap((item) => normalizedIdentifiers(item.identifiers))
    .filter(({ scheme }) => identitySchemes.has(scheme))
  const result: ImportIdentityIndex = { byIdentifier: new Map(), records: new Map() }
  for (let offset = 0; offset < identifiers.length; offset += 200) {
    for (const row of await store.importIdentityRecords(identifiers.slice(offset, offset + 200)))
      rememberImportIdentity(result, row.id, row.item)
  }
  return result
}

const importIdentity = (
  index: ImportIdentityIndex,
  item: LiteratureItemInput
): { target?: string | number; conflict?: LiteratureRecordImportEntry['conflict'] } => {
  const identifiers = normalizedIdentifiers(item.identifiers).filter(({ scheme }) =>
    identitySchemes.has(scheme)
  )
  const targets = [
    ...new Set(
      identifiers.flatMap(({ scheme, normalizedValue }) => [
        ...(index.byIdentifier.get(identityKey(scheme, normalizedValue)) ?? [])
      ])
    )
  ]
  const contradictory = identifiers.some((identifier) =>
    identifiers.some(
      (other) =>
        other.scheme === identifier.scheme && other.normalizedValue !== identifier.normalizedValue
    )
  )
  const target = targets[0]
  const existing =
    target === undefined ? [] : normalizedIdentifiers(index.records.get(target)!.identifiers)
  const disagrees = identifiers.some((identifier) => {
    const sameScheme = existing.filter(({ scheme }) => scheme === identifier.scheme)
    return (
      sameScheme.length > 0 &&
      !sameScheme.some(({ normalizedValue }) => normalizedValue === identifier.normalizedValue)
    )
  })
  if (targets.length > 1 || contradictory || disagrees)
    return {
      conflict: {
        identifiers: identifiers.map(({ scheme, value, isPrimary }) => ({
          scheme,
          value,
          isPrimary
        })),
        matches: targets.map((target) => ({
          ...(typeof target === 'string' ? { itemId: target } : { inputIndex: target }),
          title: index.records.get(target)!.title
        }))
      }
    }
  return { target }
}

// Plan the entire batch before any write. Virtual targets retain input indexes,
// so bridges between earlier rows are checked identically in preview and commit.
const resolveImportItems = (
  identities: ImportIdentityIndex,
  items: readonly LiteratureItemInput[]
): ReturnType<typeof importIdentity>[] =>
  items.map((item, inputIndex) => {
    const resolution = importIdentity(identities, item)
    if (resolution.conflict) return resolution
    const target = resolution.target ?? inputIndex
    const previous = identities.records.get(target)
    rememberImportIdentity(identities, target, {
      title: previous?.title ?? item.title,
      identifiers: [...(previous?.identifiers ?? []), ...item.identifiers]
    })
    return resolution
  })

export {
  candidateDedupeKey,
  canonicalJson,
  findIdentityItem,
  importIdentityMap,
  normalizedIdentifiers,
  normalizeIdentifier,
  normalizeSpace,
  resolveImportItems,
  sha256
}

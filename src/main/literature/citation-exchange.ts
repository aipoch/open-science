import type { CslItem, CslName } from '../../shared/literature-csl'

// citeme-engine-wasm 0.3.8 exposes BibTeX month and day components as zero-based values.
// Keep the correction at this format boundary; RIS and CSL dates are one-based.
export const normalizeBibtexEntry = (entry: Record<string, unknown>): Record<string, unknown> => {
  const issued = entry.issued as { 'date-parts'?: unknown } | undefined
  const parts = issued?.['date-parts']
  const date = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] : undefined
  const custom = entry.custom as { eprint?: { id?: unknown; type?: unknown } } | undefined
  return {
    ...entry,
    ...(date && typeof date[1] === 'number'
      ? {
          issued: {
            'date-parts': [
              date.map((part, index) =>
                (index === 1 || index === 2) && typeof part === 'number' ? part + 1 : part
              )
            ]
          }
        }
      : {}),
    ...(custom?.eprint?.type === 'arxiv' && typeof custom.eprint.id === 'string'
      ? { arXiv: custom.eprint.id }
      : {})
  }
}

// Keep the RIS marker compatible with files exported by earlier app versions.
const literalNamePrefix = 'Open Science literal creator: '

const lineValue = (value: string): string => value.replace(/[\r\n]+/gu, ' ').trim()
const nameText = (name: CslName): string =>
  name.literal ?? `${name.family ?? ''}, ${name.given ?? ''}`

// BOOK A3/editor, A4/translator and ET/edition follow Zotero's RIS mappings.
// Labeled N1 notes preserve identifiers without misusing DOI or accession-number tags.
// These notes are readable by other tools; structured recovery is our explicit adapter contract.
export const exportRisFields = (item: CslItem): string => {
  const fields: [string, string][] = []
  for (const key of ['PMID', 'PMCID', 'arXiv'] as const) {
    if (item[key]) fields.push(['N1', `${key}: ${item[key]}`])
  }
  for (const [tag, names] of [
    [item.type === 'book' ? 'A3' : 'A2', item.editor ?? []],
    ['A4', item.translator ?? []]
  ] as const) {
    names.forEach((name, index) => {
      fields.push([tag, nameText(name)])
      if (name.literal) {
        fields.push(['N1', `${literalNamePrefix}${JSON.stringify([tag, index, name.literal])}`])
      }
    })
  }
  if (item.edition) fields.push(['ET', item.edition])
  return fields.map(([tag, value]) => `${tag}  - ${lineValue(value)}\n`).join('')
}

export const importRisFields = (
  input: string,
  entry: Record<string, unknown>
): Record<string, unknown> => {
  const result = { ...entry }
  const editors: CslName[] = []
  const translators: CslName[] = []
  const rawNames = new Map<CslName, string>()
  const literalNames: { tag: string; index: number; literal: string }[] = []
  const editorTag = entry.type === 'book' ? 'A3' : 'A2'
  for (const line of input.split(/\r?\n/u)) {
    const match = /^[ \t]*([A-Z0-9]{2})[ \t]+-[ \t]*(.*)$/u.exec(line)
    if (!match) continue
    const [, tag, raw] = match
    if (tag === 'ER') break
    const value = raw!.trim()
    if (!value) continue
    if (tag === 'N1') {
      const identifier = /^(PMID|PMCID|arXiv):\s*(\S+)$/u.exec(value)
      if (identifier) result[identifier[1]!] = identifier[2]
      if (value.startsWith(literalNamePrefix)) {
        try {
          const marker: unknown = JSON.parse(value.slice(literalNamePrefix.length))
          if (
            Array.isArray(marker) &&
            marker.length === 3 &&
            typeof marker[0] === 'string' &&
            Number.isInteger(marker[1]) &&
            marker[1] >= 0 &&
            typeof marker[2] === 'string'
          ) {
            literalNames.push({ tag: marker[0], index: marker[1], literal: marker[2] })
          }
        } catch {
          // Unrecognized notes never override the ordinary RIS creator fields.
        }
      }
    } else if (tag === 'ET') result.edition = value
    else if (tag === 'A4' || tag === 'ED' || tag === editorTag) {
      const comma = value.indexOf(',')
      const name =
        comma < 0
          ? { literal: value }
          : { family: value.slice(0, comma).trim(), given: value.slice(comma + 1).trim() }
      rawNames.set(name, value)
      ;(tag === 'A4' ? translators : editors).push(name)
    }
  }
  for (const { tag, index, literal } of literalNames) {
    const names = tag === 'A4' ? translators : tag === editorTag ? editors : undefined
    const name = names?.[index]
    // Only restore mode when the marker still describes this exact visible field. A third-party
    // edit or reordered creator list must not be overwritten by a stale note.
    if (names && name && rawNames.get(name) === lineValue(literal)) names[index] = { literal }
  }
  if (editors.length) result.editor = editors
  if (translators.length) result.translator = translators
  return result
}

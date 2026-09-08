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
  for (const name of item.editor ?? [])
    fields.push([item.type === 'book' ? 'A3' : 'A2', nameText(name)])
  for (const name of item.translator ?? []) fields.push(['A4', nameText(name)])
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
    } else if (tag === 'ET') result.edition = value
    else if (tag === 'A4' || tag === 'ED' || tag === (entry.type === 'book' ? 'A3' : 'A2')) {
      const comma = value.indexOf(',')
      const name =
        comma < 0
          ? { literal: value }
          : { family: value.slice(0, comma).trim(), given: value.slice(comma + 1).trim() }
      ;(tag === 'A4' ? translators : editors).push(name)
    }
  }
  if (editors.length) result.editor = editors
  if (translators.length) result.translator = translators
  return result
}

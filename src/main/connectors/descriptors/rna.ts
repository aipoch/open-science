import type { ToolDescriptor } from '../types'

const RFAM = 'https://rfam.org'

// Rfam /family JSON wraps everything under a top-level "rfam" key
// (rfam.acc, rfam.id, rfam.description, rfam.curation.type, ...).
type RfamFamilyPayload = {
  rfam?: {
    acc?: string
    id?: string
    description?: string
    curation?: { type?: string }
  }
}

// Rfam REST API: read-only RNA family lookups. Accepts either an Rfam
// accession (RF00005) or a family id (tRNA) — the upstream routes resolve both.
export const RNA_TOOLS: ToolDescriptor[] = [
  {
    id: 'rfam_get_family',
    connector: 'rna',
    description:
      'Get Rfam family metadata (accession, id, description, RNA type) for an Rfam accession or family id.',
    input: {
      type: 'object',
      properties: { family: { type: 'string' } },
      required: ['family']
    },
    required: ['family'],
    url: (a) =>
      `${RFAM}/family/${encodeURIComponent(String(a.family))}?content-type=application/json`,
    parse: (raw) => {
      const rfam = (raw as RfamFamilyPayload).rfam ?? {}
      return {
        rfam_acc: rfam.acc,
        id: rfam.id,
        description: rfam.description,
        type: rfam.curation?.type
      }
    }
  },
  {
    id: 'rfam_acc_to_id',
    connector: 'rna',
    description: 'Resolve an Rfam accession (RF00005) to its family id (e.g. tRNA).',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    format: 'text',
    url: (a) =>
      `${RFAM}/family/${encodeURIComponent(String(a.accession))}/id?content-type=text/plain`,
    parse: (raw, a) => ({ accession: String(a.accession), id: String(raw).trim() })
  }
]

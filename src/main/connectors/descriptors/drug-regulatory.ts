import type { ToolDescriptor } from '../types'

const LABEL = 'https://api.fda.gov/drug/label.json'
const EVENT = 'https://api.fda.gov/drug/event.json'

type OpenFdaBlock = {
  brand_name?: string[]
  generic_name?: string[]
  manufacturer_name?: string[]
}

type LabelResult = {
  id?: string
  openfda?: OpenFdaBlock
  indications_and_usage?: string[]
}

type LabelSearchResponse = { results?: LabelResult[] }

type Reaction = { reactionmeddrapt?: string }

type EventResult = {
  safetyreportid?: string
  receivedate?: string
  serious?: string
  patient?: { reaction?: Reaction[] }
}

type EventSearchResponse = { results?: EventResult[] }

// openFDA (drug/label + drug/event): read-only regulatory search, anonymous rate limits apply.
export const DRUG_REGULATORY_TOOLS: ToolDescriptor[] = [
  {
    id: 'openfda_search_drug_label',
    connector: 'drug_regulatory',
    description:
      'Search FDA drug product labels (SPL) by an openFDA query, e.g. openfda.brand_name:"Tylenol".',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 }
      },
      required: ['query']
    },
    required: ['query'],
    url: (a) =>
      `${LABEL}?search=${encodeURIComponent(String(a.query))}&limit=${Number(a.limit ?? 10)}`,
    parse: (raw) =>
      ((raw as LabelSearchResponse).results ?? []).map((r) => ({
        id: r.id,
        brand_name: r.openfda?.brand_name?.[0],
        generic_name: r.openfda?.generic_name?.[0],
        manufacturer: r.openfda?.manufacturer_name?.[0],
        indications: r.indications_and_usage?.[0]
      }))
  },
  {
    id: 'openfda_search_adverse_events',
    connector: 'drug_regulatory',
    description:
      'Search FDA adverse event reports (FAERS) by an openFDA query, e.g. patient.drug.medicinalproduct:"ASPIRIN".',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 }
      },
      required: ['query']
    },
    required: ['query'],
    url: (a) =>
      `${EVENT}?search=${encodeURIComponent(String(a.query))}&limit=${Number(a.limit ?? 10)}`,
    parse: (raw) =>
      ((raw as EventSearchResponse).results ?? []).map((r) => ({
        safety_report_id: r.safetyreportid,
        receive_date: r.receivedate,
        serious: r.serious === '1',
        reactions: (r.patient?.reaction ?? []).map((rx) => rx.reactionmeddrapt).filter(Boolean)
      }))
  }
]

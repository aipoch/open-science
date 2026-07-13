import type { ToolDescriptor } from '../types'

const CBIOPORTAL = 'https://www.cbioportal.org/api'
const DEFAULT_PAGE_SIZE = 10

type CBioCancerType = { name?: string }

type CBioStudy = {
  studyId?: string
  name?: string
  description?: string
  cancerTypeId?: string
  cancerType?: CBioCancerType
  pmid?: string
  citation?: string
  referenceGenome?: string
  allSampleCount?: number
  sequencedSampleCount?: number
  cnaSampleCount?: number
  structuralVariantCount?: number
}

const compactStudyRow = (s: CBioStudy): Record<string, unknown> => ({
  studyId: s.studyId,
  name: s.name,
  cancerType: s.cancerType?.name,
  allSampleCount: s.allSampleCount
})

const compactStudyDetail = (s: CBioStudy): Record<string, unknown> => ({
  studyId: s.studyId,
  name: s.name,
  description: s.description,
  cancerType: s.cancerType?.name,
  cancerTypeId: s.cancerTypeId,
  pmid: s.pmid,
  citation: s.citation,
  referenceGenome: s.referenceGenome,
  allSampleCount: s.allSampleCount,
  sequencedSampleCount: s.sequencedSampleCount,
  cnaSampleCount: s.cnaSampleCount,
  structuralVariantCount: s.structuralVariantCount
})

// cBioPortal public REST API (keyless): read-only cancer study search/lookup.
export const CANCER_MODELS_TOOLS: ToolDescriptor[] = [
  {
    id: 'cbioportal_search_studies',
    connector: 'cancer_models',
    description:
      'Search cBioPortal cancer studies by keyword (name/description/cancer type); returns study id, name, cancer type, and sample count per hit.',
    input: {
      type: 'object',
      properties: { query: { type: 'string' }, page_size: { type: 'integer', default: 10 } },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`[ { "studyId": str, "name": str, "cancerType": str, "allSampleCount": int } ]` — up to `page_size` studies (default 10); `[]` when nothing matches.',
    url: (a) =>
      `${CBIOPORTAL}/studies?keyword=${encodeURIComponent(String(a.query))}&projection=DETAILED&pageSize=${Number(a.page_size ?? DEFAULT_PAGE_SIZE)}&pageNumber=0`,
    parse: (raw) => ((raw as CBioStudy[] | null) ?? []).map(compactStudyRow)
  },
  {
    id: 'cbioportal_get_study',
    connector: 'cancer_models',
    description:
      'Get a cBioPortal cancer study by study id; returns name, description, cancer type, citation, and sample counts.',
    input: {
      type: 'object',
      properties: { study_id: { type: 'string' } },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '`{ "studyId": str, "name": str, "description": str, "cancerType": str, "cancerTypeId": str, "pmid": str, "citation": str, "referenceGenome": str, "allSampleCount": int, "sequencedSampleCount": int, "cnaSampleCount": int, "structuralVariantCount": int }` — a single study; fields are undefined when absent from the cBioPortal record.',
    url: (a) =>
      `${CBIOPORTAL}/studies/${encodeURIComponent(String(a.study_id))}?projection=DETAILED`,
    parse: (raw) => compactStudyDetail(raw as CBioStudy)
  }
]

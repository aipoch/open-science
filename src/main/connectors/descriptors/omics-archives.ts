import type { ToolDescriptor } from '../types'

const BIOSTUDIES = 'https://www.ebi.ac.uk/biostudies/api/v1'
const DEFAULT_PAGE_SIZE = 20

type BioStudiesSearchHit = {
  accession?: string
  title?: string
  type?: string
  release_date?: string
}

type BioStudiesSearchResponse = { hits?: BioStudiesSearchHit[] }

type BioStudiesAttribute = { name?: string; value?: string }

type BioStudiesSection = { attributes?: BioStudiesAttribute[] }

type BioStudiesStudy = {
  accno?: string
  attributes?: BioStudiesAttribute[]
  section?: BioStudiesSection
}

const attr = (attributes: BioStudiesAttribute[] | undefined, name: string): string | undefined =>
  attributes?.find((a) => a.name === name)?.value

// BioStudies REST API (EBI): read-only search + lookup over the ArrayExpress
// collection of functional-genomics experiments. Endpoints and field shapes
// confirmed live against https://www.ebi.ac.uk/biostudies/api/v1.
export const OMICS_ARCHIVES_TOOLS: ToolDescriptor[] = [
  {
    id: 'arrayexpress_search',
    connector: 'omics_archives',
    description:
      'Search the ArrayExpress collection of functional-genomics experiments (BioStudies) by free-text query.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        pageSize: { type: 'number', default: DEFAULT_PAGE_SIZE }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`[ { "accession": str, "title": str, "type": str, "release_date": str } ]` — up to `pageSize` hits (default 20), newest release_date first; `[]` when nothing matches.',
    url: (a) => {
      const pageSize = Number(a.pageSize ?? DEFAULT_PAGE_SIZE)
      return (
        `${BIOSTUDIES}/arrayexpress/search?query=${encodeURIComponent(String(a.query))}` +
        `&pageSize=${pageSize}&sortBy=release_date&sortOrder=descending`
      )
    },
    parse: (raw) =>
      ((raw as BioStudiesSearchResponse).hits ?? []).map((h) => ({
        accession: h.accession,
        title: h.title,
        type: h.type,
        release_date: h.release_date
      }))
  },
  {
    id: 'arrayexpress_get_study',
    connector: 'omics_archives',
    description:
      'Get an ArrayExpress/BioStudies study by accession (title, release date, organism, study type, description).',
    input: {
      type: 'object',
      properties: { accession: { type: 'string' } },
      required: ['accession']
    },
    required: ['accession'],
    returns:
      '`{ "accession": str, "title": str, "release_date": str, "organism": str, "study_type": str, "description": str }` — single study; any field is undefined when its attribute is absent upstream.',
    url: (a) => `${BIOSTUDIES}/studies/${encodeURIComponent(String(a.accession))}`,
    parse: (raw) => {
      const study = raw as BioStudiesStudy
      const sectionAttrs = study.section?.attributes
      return {
        accession: study.accno,
        title: attr(study.attributes, 'Title'),
        release_date: attr(study.attributes, 'ReleaseDate'),
        organism: attr(sectionAttrs, 'Organism'),
        study_type: attr(sectionAttrs, 'Study type'),
        description: attr(sectionAttrs, 'Description')
      }
    }
  }
]

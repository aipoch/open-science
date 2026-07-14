import type { ToolDescriptor } from '../types'

const STUDIES = 'https://clinicaltrials.gov/api/v2/studies'

type ProtocolSection = {
  identificationModule?: { nctId?: string; briefTitle?: string }
  statusModule?: { overallStatus?: string }
  designModule?: { phases?: string[] }
  conditionsModule?: { conditions?: string[] }
}

type Study = { protocolSection?: ProtocolSection }
type SearchResponse = { studies?: Study[]; nextPageToken?: string }

// ClinicalTrials.gov API v2: read-only study lookup + free-text search.
export const CLINICAL_TRIALS_TOOLS: ToolDescriptor[] = [
  {
    id: 'clinicaltrials_get_study',
    connector: 'clinical_trials',
    description: 'Get a ClinicalTrials.gov study by NCT id (title, status, phase, conditions).',
    input: {
      type: 'object',
      properties: { nct_id: { type: 'string' } },
      required: ['nct_id']
    },
    required: ['nct_id'],
    returns:
      '`{ "nct_id": str, "title": str, "status": str, "phase": [str], "conditions": [str] }` — one study; `phase` and `conditions` are arrays (may be undefined when the study omits those modules).',
    example:
      'result = host.mcp("clinical_trials", "clinicaltrials_get_study", {"nct_id": "NCT00000419"})',
    url: (a) => `${STUDIES}/${encodeURIComponent(String(a.nct_id))}`,
    parse: (raw) => {
      const proto = (raw as Study).protocolSection ?? {}
      return {
        nct_id: proto.identificationModule?.nctId,
        title: proto.identificationModule?.briefTitle,
        status: proto.statusModule?.overallStatus,
        phase: proto.designModule?.phases,
        conditions: proto.conditionsModule?.conditions
      }
    }
  },
  {
    id: 'clinicaltrials_search',
    connector: 'clinical_trials',
    description:
      'Search ClinicalTrials.gov studies by condition, intervention, or free-text query.',
    input: {
      type: 'object',
      properties: { query: { type: 'string' }, page_size: { type: 'integer', default: 10 } },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ "studies": [ { "nct_id": str, "title": str, "status": str } ], "nextPageToken"?: str }` — up to `page_size` studies (default 10); `nextPageToken` is present only when more pages exist. `studies` is `[]` when nothing matches.',
    example:
      'result = host.mcp("clinical_trials", "clinicaltrials_search", {"query": "aspirin", "page_size": 10})',
    run: async (ctx, a) => {
      const url = `${STUDIES}?query.term=${encodeURIComponent(String(a.query))}&pageSize=${Number(a.page_size ?? 10)}`
      const res = (await ctx.fetchJson(url)) as SearchResponse
      const studies = (res.studies ?? []).map((s) => {
        const proto = s.protocolSection ?? {}
        return {
          nct_id: proto.identificationModule?.nctId,
          title: proto.identificationModule?.briefTitle,
          status: proto.statusModule?.overallStatus
        }
      })
      return res.nextPageToken ? { studies, nextPageToken: res.nextPageToken } : { studies }
    }
  }
]

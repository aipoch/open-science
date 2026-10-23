import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query'
const pdbPattern = /^(?:[1-9][A-Za-z0-9]{3}|pdb_[A-Za-z0-9]{8})$/i
const argsSchema = z.object({
  pdb_id: z.string().regex(pdbPattern),
  label_asym_id: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9]+$/),
  max_rows: z.number().int().min(1).max(50).default(10)
})
const responseSchema = z.object({
  result_type: z.literal('polymer_instance'),
  total_count: z.number().int().nonnegative(),
  result_set: z
    .array(
      z.object({
        identifier: z.string(),
        score: z.number().finite(),
        services: z
          .array(
            z.object({
              service_type: z.literal('structure'),
              nodes: z.array(z.object({ original_score: z.number().finite() })).length(1)
            })
          )
          .length(1)
      })
    )
    .default([])
})

export const PDB_SIMILARITY_TOOLS: ToolDescriptor[] = [
  {
    id: 'pdb_search_structure_similarity',
    connector: 'structures',
    credentialKeys: [],
    description:
      'Find experimental PDB protein chains similar in 3D to one deposited PDB chain using the RCSB structure-informed embedding search with global matching, predicted TM-score cutoff 0.8 and 10,000 candidates. Supply label_asym_id (RCSB/mmCIF chain ID, not the author chain ID; available from pdb_get_entities). Returns top ranked chain identifiers and upstream scores; the query chain may appear among hits. No coordinate upload, structural alignment, RMSD or locally computed TM-score.',
    input: {
      type: 'object',
      properties: {
        pdb_id: {
          type: 'string',
          pattern: '^(?:[1-9][A-Za-z0-9]{3}|[Pp][Dd][Bb]_[A-Za-z0-9]{8})$'
        },
        label_asym_id: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[A-Za-z0-9]+$' },
        max_rows: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
      },
      required: ['pdb_id', 'label_asym_id'],
      additionalProperties: false
    },
    required: ['pdb_id', 'label_asym_id'],
    exampleArgs: { pdb_id: '1CLL', label_asym_id: 'A', max_rows: 10 },
    totalTimeoutMs: 25_000,
    maxResponseBytes: 500_000,
    returns:
      '{source, source_url, query:{pdb_id,label_asym_id,similarity_type,ptmscore_cutoff,number_of_candidates}, total_count, n_returned, truncated, score_note, records:[{identifier,pdb_id,label_asym_id,relevance_score,raw_structure_score}]}. Scores are upstream ranking values, not sequence identity or proof of equivalent function. total_count is the upstream hit count within the candidate/score limits, not an exhaustive count of all PDB chains; truncated means additional hits exist. HTTP 204 means no hits; an invalid/unsupported query chain remains an upstream error.',
    run: async (ctx, args) => {
      const { pdb_id, label_asym_id, max_rows } = argsSchema.parse(args)
      const pdbId = pdb_id.toUpperCase()
      const raw = await ctx.postJson(
        SEARCH_URL,
        {
          query: {
            type: 'terminal',
            service: 'structure',
            parameters: {
              value: { entry_id: pdbId, asym_id: label_asym_id },
              target_search_space: 'polymer_entity_instance',
              similarity_type: 'global',
              ptmscore_cutoff: 0.8,
              number_of_candidates: 10_000
            }
          },
          return_type: 'polymer_instance',
          request_options: {
            paginate: { start: 0, rows: max_rows },
            results_content_type: ['experimental'],
            results_verbosity: 'verbose'
          }
        },
        { allowNoContent: true, retry: false }
      )
      const response =
        raw === undefined ? { total_count: 0, result_set: [] } : responseSchema.parse(raw)
      if (
        response.total_count < response.result_set.length ||
        (response.total_count > 0 && response.result_set.length === 0)
      ) {
        throw new Error('RCSB returned inconsistent structure-search counts')
      }
      const hits = response.result_set.map((hit) => {
        const parts = /^(.+)\.([A-Za-z0-9]+)$/.exec(hit.identifier)
        if (!parts || !pdbPattern.test(parts[1])) {
          throw new Error('RCSB returned an invalid polymer-instance identifier')
        }
        return {
          identifier: hit.identifier,
          pdb_id: parts[1],
          label_asym_id: parts[2],
          relevance_score: hit.score,
          raw_structure_score: hit.services[0].nodes[0].original_score
        }
      })
      if (new Set(hits.map((hit) => hit.identifier)).size !== hits.length) {
        throw new Error('RCSB returned duplicate structure-search hits')
      }
      const records = hits.slice(0, max_rows)
      return {
        source: 'RCSB PDB',
        source_url: SEARCH_URL,
        query: {
          pdb_id: pdbId,
          label_asym_id,
          similarity_type: 'global',
          ptmscore_cutoff: 0.8,
          number_of_candidates: 10_000
        },
        total_count: response.total_count,
        n_returned: records.length,
        truncated: response.total_count > records.length,
        score_note:
          'RCSB embedding search with global matching and predicted TM-score cutoff 0.8 among 10,000 candidates. Scores are upstream ranking values, not a returned structural alignment or RMSD; hit counts are not exhaustive.',
        records
      }
    }
  }
]

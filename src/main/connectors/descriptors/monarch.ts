import type { ToolDescriptor } from '../../connector-core/types'

// Production contract: https://api.monarchinitiative.org/openapi.json
// Keep expanded association evidence; compact results omit provenance and qualifiers.
const API = 'https://api.monarchinitiative.org/v3/api/association'
const MAX_OFFSET = 1000000
const CURIE = '^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])'
const curieSchema = { type: 'string', pattern: CURIE, maxLength: 200 }
type Obj = Record<string, unknown>

function curie(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 200 || !new RegExp(CURIE).test(value)) {
    throw new Error(`${field} must be a CURIE, such as MONDO:0007947 or HGNC:3603`)
  }
  return value
}

function integer(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} must be an integer between 0 and ${max}`)
  }
  if (field === 'limit' && value === 0) throw new Error('limit must be at least 1')
  return value
}

function object(value: unknown, field: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Monarch response has an invalid ${field}`)
  }
  return value as Obj
}

function association(value: unknown, category: string): Obj {
  const row = object(value, 'association')
  for (const field of ['id', 'subject', 'object', 'predicate', 'agent_type', 'knowledge_level']) {
    if (typeof row[field] !== 'string' || !row[field]) {
      throw new Error(`Monarch association is missing ${field}`)
    }
  }
  if (row.category !== category)
    throw new Error('Monarch returned an unexpected association category')
  if (row.negated != null && typeof row.negated !== 'boolean') {
    throw new Error('Monarch association has an invalid negated flag')
  }
  // Preserve the upstream names and all evidence/qualifier fields, including explicit nulls.
  // Ontology closure arrays are search expansion metadata, not association evidence.
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.includes('closure')))
}

function phenotypeTool(kind: 'disease' | 'gene'): ToolDescriptor {
  const field = `${kind}_id`
  const category =
    kind === 'disease'
      ? 'biolink:DiseaseToPhenotypicFeatureAssociation'
      : 'biolink:GeneToPhenotypicFeatureAssociation'
  return {
    id: `monarch_get_${kind}_phenotypes`,
    connector: 'monarch',
    description:
      `Retrieve ${kind}–phenotype association evidence using Monarch canonical CURIEs, with relation/category, primary and aggregator sources, publications, evidence codes, negation, frequency, onset and disease context when supplied. ` +
      'Source database IDs and aliases are not automatically converted to Monarch canonical IDs and may return no matches. A zero total means no match for the supplied identifier and filters, not absence of phenotype evidence. Direct identifier matching is the default; direct does not mean experimentally proven. Inspect knowledge_level and agent_type for inferred associations. Missing evidence is not negative evidence. Use Genes & Ontologies for OLS term search and Alliance for model-organism records.',
    input: {
      type: 'object',
      properties: {
        [field]: {
          ...curieSchema,
          description: `Monarch canonical ${kind} CURIE, such as ${kind === 'disease' ? 'MONDO:0007947' : 'HGNC:3603 for a human gene'}. Resolve names with existing gene/ontology tools and use the identifier indexed by Monarch; source database IDs and aliases are not automatically converted.`
        },
        phenotype_id: {
          ...curieSchema,
          description: 'Optional Monarch canonical phenotype CURIE, such as HP:0002107.'
        },
        primary_knowledge_source: {
          ...curieSchema,
          description: 'Optional source CURIE, such as infores:omim.'
        },
        direct: {
          type: 'boolean',
          default: true,
          description:
            'Match identifiers directly. Set false to include ontology descendants; inspect returned subjects and objects.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, default: 0 }
      },
      required: [field],
      additionalProperties: false
    },
    required: [field],
    returns:
      '{query:{subject,category,phenotype_id,primary_knowledge_source,direct},limit,offset,total,returned,next_offset,associations:[{id,subject,subject_label,object,object_label,category,predicate,original_predicate,knowledge_level,agent_type,primary_knowledge_source,aggregator_knowledge_source,provided_by,provided_by_link,publications,publications_links,has_evidence,has_evidence_links,evidence_count,negated,frequency_qualifier,onset_qualifier,disease_context_qualifier,...}]}. Optional evidence fields retain upstream nulls; evidence_count is not a confidence score.',
    example: `const result = await host.mcp("monarch", "monarch_get_${kind}_phenotypes", {"${field}": "${kind === 'disease' ? 'MONDO:0007947' : 'HGNC:3603'}", "limit": 20})`,
    url: (args) => {
      if (args.direct !== undefined && typeof args.direct !== 'boolean') {
        throw new Error('direct must be a boolean')
      }
      const params = new URLSearchParams({
        category,
        subject: curie(args[field], field),
        direct: String(args.direct ?? true),
        compact: 'false',
        format: 'json',
        limit: String(integer(args.limit, 20, 100, 'limit')),
        offset: String(integer(args.offset, 0, MAX_OFFSET, 'offset'))
      })
      if (args.phenotype_id !== undefined)
        params.set('object', curie(args.phenotype_id, 'phenotype_id'))
      if (args.primary_knowledge_source !== undefined) {
        params.set(
          'primary_knowledge_source',
          curie(args.primary_knowledge_source, 'primary_knowledge_source')
        )
      }
      return `${API}?${params}`
    },
    parse: (raw, args) => {
      const page = object(raw, 'association page')
      const limit = integer(page.limit, -1, 100, 'limit')
      const offset = integer(page.offset, -1, MAX_OFFSET, 'offset')
      const total = integer(page.total, -1, Number.MAX_SAFE_INTEGER, 'total')
      if (limit < 1 || offset < 0 || total < 0 || !Array.isArray(page.items)) {
        throw new Error('Monarch response is missing pagination or items')
      }
      if (
        limit !== (args.limit ?? 20) ||
        offset !== (args.offset ?? 0) ||
        page.items.length > limit ||
        (page.items.length === 0 && offset < total) ||
        (page.items.length > 0 && offset + page.items.length > total)
      ) {
        throw new Error('Monarch response has inconsistent pagination')
      }
      const associations = page.items.map((row) => association(row, category))
      const next = offset + associations.length
      if (next < total && next > MAX_OFFSET) {
        throw new Error(
          'Monarch pagination exceeds the supported offset limit; narrow the query filters.'
        )
      }
      return {
        query: {
          subject: curie(args[field], field),
          category,
          phenotype_id: args.phenotype_id ?? null,
          primary_knowledge_source: args.primary_knowledge_source ?? null,
          direct: args.direct ?? true
        },
        limit,
        offset,
        total,
        returned: associations.length,
        next_offset: associations.length > 0 && next < total ? next : null,
        associations
      }
    }
  }
}

export const MONARCH_TOOLS: ToolDescriptor[] = [phenotypeTool('disease'), phenotypeTool('gene')]

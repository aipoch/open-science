import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const API = 'https://www.ebi.ac.uk/unichem/api/v1/compounds'
const INCHIKEY = '^[A-Z]{14}-[A-Z]{10}-[A-Z]$'
const CHEMBL = '^CHEMBL[1-9][0-9]{0,14}$'
const sourceDatabases = [
  {
    id: 1,
    name: 'ChEMBL',
    pattern: new RegExp(CHEMBL),
    url: 'https://www.ebi.ac.uk/chembl/compound_report_card/'
  },
  {
    id: 7,
    name: 'ChEBI',
    pattern: /^CHEBI:[1-9][0-9]{0,14}$/,
    url: 'https://www.ebi.ac.uk/chebi/'
  },
  {
    id: 22,
    name: 'PubChem',
    pattern: /^[1-9][0-9]{0,14}$/,
    url: 'https://pubchem.ncbi.nlm.nih.gov/compound/'
  }
]
const compound = z.object({
  uci: z.number().int().positive(),
  standardInchiKey: z.string().regex(new RegExp(INCHIKEY)),
  sources: z
    .array(
      z.object({
        id: z.number().int().positive(),
        compoundId: z.string().min(1).max(1000)
      })
    )
    .max(10_000)
})
const response = z.object({
  response: z.enum(['Success', 'Not found']),
  compounds: z.array(compound).max(100),
  totalCompounds: z
    .union([
      z
        .string()
        .regex(/^[0-9]+$/)
        .max(10),
      z.number().int().nonnegative()
    ])
    .optional()
})

export const CHEMISTRY_UNICHEM_TOOLS: ToolDescriptor[] = [
  {
    connector: 'chemistry',
    id: 'unichem_map_compound',
    credentialKeys: [],
    maxResponseBytes: 1_000_000,
    totalTimeoutMs: 25_000,
    description:
      'Map one exact full InChIKey or ChEMBL ID to PubChem, ChEMBL and ChEBI identifiers using UniChem. Resolve names with PubChem first. Preserves distinct matched structures and reports filtering and truncation. Mapping reflects UniChem indexed assignments, not verified current source records or biological equivalence. No name, similarity, connectivity, salt-component or batch search.',
    input: {
      type: 'object',
      properties: {
        id_type: { type: 'string', enum: ['inchikey', 'chembl'] },
        identifier: { type: 'string', maxLength: 27 }
      },
      required: ['id_type', 'identifier'],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { id_type: { const: 'inchikey' } } },
          then: { properties: { identifier: { type: 'string', pattern: INCHIKEY } } },
          else: { properties: { identifier: { type: 'string', pattern: CHEMBL } } }
        }
      ]
    },
    required: ['id_type', 'identifier'],
    exampleArgs: { id_type: 'chembl', identifier: 'CHEMBL1089' },
    returns:
      '{ source, source_url, id_type, identifier, target_sources, total_matches, records_truncated, records }. At most 5 structures, each with uci, standard_inchi_key, total_mappings, filtered_out_mappings, matching_mappings, mappings_truncated and up to 20 mappings { source, identifier, url }. Filtering to PubChem/ChEMBL/ChEBI is local after download. Empty records mean no UniChem match; an empty mappings list only means no mapping to these target sources. Never select a single structure from multiple matches implicitly.',
    run: async (ctx, args) => {
      const { id_type: idType, identifier } = args
      if (
        (idType !== 'inchikey' && idType !== 'chembl') ||
        typeof identifier !== 'string' ||
        !new RegExp(idType === 'inchikey' ? INCHIKEY : CHEMBL).test(identifier)
      )
        throw new Error('Provide one exact full InChIKey or ChEMBL ID')
      const raw = await ctx.postJson(
        API,
        idType === 'inchikey'
          ? { compound: identifier, type: 'inchikey' }
          : { compound: identifier, sourceID: 1, type: 'sourceID' }
      )
      const parsed = response.safeParse(raw)
      if (!parsed.success) throw new Error('UniChem returned invalid compound data')
      const data = parsed.data
      if (
        (data.response === 'Not found') !== (data.compounds.length === 0) ||
        (data.response === 'Success' && data.totalCompounds === undefined) ||
        (data.totalCompounds !== undefined && Number(data.totalCompounds) !== data.compounds.length)
      )
        throw new Error('UniChem returned inconsistent match counts')
      const records = data.compounds.map((row) => {
        if (
          idType === 'inchikey'
            ? row.standardInchiKey !== identifier
            : !row.sources.some((s) => s.id === 1 && s.compoundId === identifier)
        )
          throw new Error('UniChem returned a compound inconsistent with the requested identifier')
        const mappings = row.sources.flatMap((s) => {
          const db = sourceDatabases.find((d) => d.id === s.id)
          if (!db) return []
          if (!db.pattern.test(s.compoundId))
            throw new Error('UniChem returned an invalid mapped identifier')
          return [{ source: db.name, identifier: s.compoundId, url: db.url + s.compoundId }]
        })
        return {
          uci: row.uci,
          standard_inchi_key: row.standardInchiKey,
          total_mappings: row.sources.length,
          filtered_out_mappings: row.sources.length - mappings.length,
          matching_mappings: mappings.length,
          mappings_truncated: mappings.length > 20,
          mappings: mappings.slice(0, 20)
        }
      })
      return {
        source: 'UniChem',
        source_url: API,
        id_type: idType,
        identifier,
        target_sources: sourceDatabases.map((s) => s.name),
        total_matches: records.length,
        records_truncated: records.length > 5,
        records: records.slice(0, 5)
      }
    }
  }
]

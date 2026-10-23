import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

// LMIDs include a four-character suffix; fourth-level classes add two digits.
// https://www.lipidmaps.org/resources/education/tutorials/lipid_cns
const LMID = '^LM(?:FA|GL|GP|SP|ST|PR|SL|PK)[0-9]{4}(?:[0-9]{2})?[A-Z0-9]{4}$'
const CID = '^[1-9][0-9]{0,14}$'
const optionalText = z.string().max(2000).nullish()
const compound = z.object({
  lm_id: z.string().regex(new RegExp(LMID)),
  pubchem_cid: z.string().regex(new RegExp(CID)).nullish(),
  name: optionalText,
  sys_name: optionalText,
  abbrev: optionalText,
  abbrev_chains: optionalText,
  core: z.string().min(1).max(200),
  main_class: z.string().min(1).max(200),
  sub_class: optionalText,
  class_level4: optionalText,
  formula: optionalText,
  exactmass: z
    .string()
    .regex(/^[0-9]+(?:\.[0-9]+)?$/u)
    .max(30)
    .nullish(),
  inchi: optionalText,
  inchi_key: optionalText,
  smiles: optionalText,
  kegg_id: optionalText,
  hmdb_id: optionalText,
  chebi_id: optionalText,
  lipidbank_id: optionalText,
  metacyc_id: optionalText
})

export const CHEMISTRY_LIPIDMAPS_TOOLS: ToolDescriptor[] = [
  {
    connector: 'chemistry',
    id: 'lipidmaps_get_compound',
    credentialKeys: [],
    maxResponseBytes: 100_000,
    totalTimeoutMs: 25_000,
    description:
      'Look up lipid classification and compound details in LIPID MAPS by one exact LMID or PubChem CID. Resolve names with PubChem first. Returns native structure identifiers and available database mappings; missing fields remain unknown. An LMID may describe a generic or incompletely specified structure, not a unique experimentally identified molecule. Preserve all returned matches rather than selecting the first. No name, formula, abbreviation, mass or bulk search. Data: LIPID MAPS, CC BY 4.0; retain attribution and record links.',
    input: {
      type: 'object',
      properties: {
        id_type: { type: 'string', enum: ['lm_id', 'pubchem_cid'] },
        identifier: {
          type: 'string',
          maxLength: 15,
          description: 'Exact LMID (e.g. LMFA01010001) or positive PubChem CID as a string.'
        }
      },
      required: ['id_type', 'identifier'],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { id_type: { const: 'lm_id' } } },
          then: { properties: { identifier: { type: 'string', pattern: LMID } } },
          else: { properties: { identifier: { type: 'string', pattern: CID } } }
        }
      ]
    },
    required: ['id_type', 'identifier'],
    exampleArgs: { id_type: 'lm_id', identifier: 'LMFA01010001' },
    returns:
      '{ source:"LIPID MAPS", license:"CC BY 4.0", license_url, source_url, id_type, identifier, total_matches, records_truncated, records }. Up to 5 records with lm_id, record_url, classification (core, main_class, optional sub_class/class_level4), optional name/sys_name, formula, exactmass (upstream decimal string), abbreviations, InChI/InChIKey/SMILES and database IDs. Field names follow the upstream API; absent/null values are unknown. Empty records mean no database match, not biological absence. Oversized or inconsistent upstream data raises an error.',
    run: async (ctx, args) => {
      const { id_type: idType, identifier } = args
      if (
        (idType !== 'lm_id' && idType !== 'pubchem_cid') ||
        typeof identifier !== 'string' ||
        !new RegExp(idType === 'lm_id' ? LMID : CID).test(identifier)
      )
        throw new Error('Provide one exact LIPID MAPS ID or positive PubChem CID')
      const url = `https://www.lipidmaps.org/rest/compound/${idType}/${identifier}/all`
      const raw = await ctx.fetchJson(url)
      let rows: unknown[]
      if (Array.isArray(raw) && raw.length === 0) rows = []
      else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const object = raw as Record<string, unknown>
        if ('lm_id' in object) rows = [object]
        else if (
          Object.keys(object).length > 0 &&
          Object.keys(object).every((key) => /^Row[1-9][0-9]*$/u.test(key))
        )
          rows = Object.values(object)
        else throw new Error('LIPID MAPS returned an invalid response')
      } else throw new Error('LIPID MAPS returned an invalid response')
      const parsed = z.array(compound).max(100).safeParse(rows)
      if (!parsed.success) throw new Error('LIPID MAPS returned invalid compound data')
      if (parsed.data.some((record) => record[idType] !== identifier))
        throw new Error('LIPID MAPS returned a compound inconsistent with the requested identifier')
      return {
        source: 'LIPID MAPS',
        license: 'CC BY 4.0',
        license_url: 'https://www.lipidmaps.org/terms-of-use',
        source_url: url,
        id_type: idType,
        identifier,
        total_matches: parsed.data.length,
        records_truncated: parsed.data.length > 5,
        records: parsed.data.slice(0, 5).map((record) => ({
          ...record,
          record_url: `https://www.lipidmaps.org/databases/lmsd/${record.lm_id}`
        }))
      }
    }
  }
]

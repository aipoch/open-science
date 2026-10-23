import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'

const BASE = 'https://rest.ensembl.org'
const FIELDS = ['id', 'hgvsg', 'hgvsc', 'hgvsp', 'spdi'] as const
const argsSchema = z.object({
  variant: z
    .string()
    .min(1)
    .max(500)
    // eslint-disable-next-line no-control-regex -- reject control characters in a variant expression
    .regex(/^[^\s\x00-\x1f\x7f]+$/),
  max_notations: z.number().int().min(1).max(100).default(20)
})
const notations = z.array(z.string().min(1).max(2000))
const alleleSchema = z.object({
  input: z.string(),
  id: notations.optional(),
  hgvsg: notations.optional(),
  hgvsc: notations.optional(),
  hgvsp: notations.optional(),
  spdi: notations.optional()
})

export const ENSEMBL_RECODER_TOOLS: ToolDescriptor[] = [
  {
    id: 'ensembl_recode_variant',
    connector: 'genomes',
    credentialKeys: [],
    description:
      'Translate one human variant (rsID, HGVS or genomic SPDI) into alternative identifiers and genomic/coding/protein HGVS and SPDI using Ensembl Variant Recoder. Retains separate alternate-allele groups, reference/transcript accession versions and all field counts. Uses the current human Ensembl service; no assembly selection or liftover. Reference versions are passed unchanged but are not independently validated. Allele keys follow the input representation and are not necessarily genomic-forward alleles.',
    input: {
      type: 'object',
      properties: {
        variant: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
          description:
            'One rsID, HGVS or genomic SPDI expression, e.g. rs699 or NC_000001.11:230710047:A:G.'
        },
        max_notations: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description:
            'Maximum notations per field per allele. Full counts and truncation are always reported.'
        }
      },
      required: ['variant'],
      additionalProperties: false
    },
    required: ['variant'],
    exampleArgs: { variant: 'rs699', max_notations: 20 },
    totalTimeoutMs: 25_000,
    maxResponseBytes: 1_000_000,
    returns:
      '{source, source_url, input, species:"homo_sapiens", reference_versions_validated:false, interpretation, total_alleles, n_returned, truncated, alleles:[{input_allele,notations:{id,hgvsg,hgvsc,hgvsp,spdi},counts:{...},truncated}]}. At most 10 allele groups and max_notations strings per field. id includes non-rs aliases when Ensembl supplies them. SPDI positions are 0-based; HGVS uses its own coordinate system. Preserve reference accession versions and allele groups; mappings are not guaranteed one-to-one. Missing notation kinds are empty lists; malformed/unknown inputs and upstream failures raise errors.',
    run: async (ctx, args) => {
      const { variant, max_notations } = argsSchema.parse(args)
      const url = `${BASE}/variant_recoder/homo_sapiens/${encodeURIComponent(variant)}?content-type=application/json`
      const { body, status } = await ctx.fetchJsonWithHeaders(url, { allowHttpStatuses: [400] })
      if (
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'error' in body &&
        typeof body.error === 'string'
      ) {
        throw new Error(`Ensembl Variant Recoder failed: ${body.error.slice(0, 1000)}`)
      }
      if (status === 400)
        throw new Error('Ensembl Variant Recoder returned an unrecognized HTTP 400 response')
      const [groups] = z.array(z.record(z.string(), alleleSchema)).length(1).parse(body)
      const entries = Object.entries(groups)
      if (!entries.length) throw new Error('Ensembl Variant Recoder returned no allele groups')
      const all = entries.map(([input_allele, result]) => {
        if (!input_allele || input_allele.length > 2000 || result.input !== variant) {
          throw new Error('Ensembl Variant Recoder returned a different input or invalid allele')
        }
        const counts = Object.fromEntries(
          FIELDS.map((field) => [field, result[field]?.length ?? 0])
        )
        if (!FIELDS.some((field) => counts[field] > 0)) {
          throw new Error('Ensembl Variant Recoder returned an allele without any notations')
        }
        return {
          input_allele,
          notations: Object.fromEntries(
            FIELDS.map((field) => [field, (result[field] ?? []).slice(0, max_notations)])
          ),
          counts,
          truncated: FIELDS.some((field) => counts[field] > max_notations)
        }
      })
      const alleles = all.slice(0, 10)
      return {
        source: 'Ensembl Variant Recoder',
        source_url: url,
        input: variant,
        species: 'homo_sapiens',
        reference_versions_validated: false,
        interpretation:
          'Current human Ensembl service; no assembly conversion or independent reference-version validation. SPDI uses 0-based positions. Allele keys follow the input representation, not necessarily the genomic-forward strand.',
        total_alleles: all.length,
        n_returned: alleles.length,
        truncated: all.length > alleles.length || alleles.some((allele) => allele.truncated),
        alleles
      }
    }
  }
]

import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CLINPGX_TOOLS } from './clinpgx'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CLINPGX_TOOLS.find((candidate) => candidate.id === id)!
const ajv = new Ajv2020({ strict: true })
const validators = new Map(
  CLINPGX_TOOLS.map((candidate) => [candidate.id, ajv.compile(candidate.input)])
)

const validateToolArguments = (descriptor: ToolDescriptor, args: Record<string, unknown>): void => {
  if (validators.get(descriptor.id)?.(args)) return
  throw new Error('invalid_arguments')
}
const json = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const success = (data: unknown): Response => json({ status: 'success', data })

describe('clinpgx', () => {
  it('registers the pharmacogenomics query surface', () => {
    expect(CLINPGX_TOOLS.map((candidate) => candidate.id)).toEqual([
      'clinpgx_search_chemicals',
      'clinpgx_search_genes',
      'clinpgx_search_summary_annotations',
      'clinpgx_get_summary_annotation',
      'clinpgx_search_variant_annotations',
      'clinpgx_search_guideline_annotations',
      'clinpgx_search_drug_labels',
      'clinpgx_search_variants',
      'clinpgx_get_variant_frequency',
      'clinpgx_get_drug_gene_variant'
    ])
    expect(CLINPGX_TOOLS.every((candidate) => candidate.connector === 'clinical-genomics')).toBe(
      true
    )
  })

  it('queries summary annotations with drug, gene, variant, and evidence filters', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(success([{ id: 'CA1', levelOfEvidence: { term: '1A' } }]))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('clinpgx_search_summary_annotations'),
      {
        'relatedChemicals.name': 'warfarin',
        'location.genes.symbol': 'VKORC1',
        'location.fingerprint': 'rs9923231',
        'levelOfEvidence.term': '1A',
        view: 'max'
      },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.clinpgx.org/v1/data/summaryAnnotation?relatedChemicals.name=warfarin&location.genes.symbol=VKORC1&location.fingerprint=rs9923231&levelOfEvidence.term=1A&view=max'
    )
    expect(out).toEqual([{ id: 'CA1', levelOfEvidence: { term: '1A' } }])
  })

  it('requires a query selector for annotation searches', async () => {
    const fetchImpl = vi.fn()
    expect(() => validateToolArguments(tool('clinpgx_search_guideline_annotations'), {})).toThrow(
      /invalid_arguments/
    )
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('clinpgx_search_guideline_annotations'), {}, {})
    ).rejects.toThrow(/provide at least one/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('retrieves a variant frequency report and a resource by id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(success({ populations: [{ population: 'EUR', frequency: 0.34 }] }))
      .mockResolvedValueOnce(success({ accessionId: 'PA1', symbol: 'rs9923231' }))
    const engine = new ParserEngine({ fetchImpl })
    await engine.call(tool('clinpgx_get_variant_frequency'), { fp: 'rs9923231' }, {})
    await engine.call(tool('clinpgx_get_summary_annotation'), { id: 655385012, view: 'max' }, {})
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://api.clinpgx.org/v1/report/variantFrequency?fp=rs9923231',
      'https://api.clinpgx.org/v1/data/summaryAnnotation/655385012?view=max'
    ])
  })

  it('surfaces JSend failures instead of returning their data payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ status: 'fail', data: { errors: [] } }))
    await expect(
      new ParserEngine({ fetchImpl }).call(tool('clinpgx_search_genes'), { symbol: 'VKORC1' }, {})
    ).rejects.toThrow('ClinPGx API returned fail')
  })

  it('requires a numeric summary annotation id', () => {
    expect(() =>
      validateToolArguments(tool('clinpgx_get_summary_annotation'), { id: 'CA1' })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(tool('clinpgx_get_summary_annotation'), { id: 655385012 })
    ).not.toThrow()
  })

  it('requires one selector for each connection object', () => {
    expect(() =>
      validateToolArguments(tool('clinpgx_get_drug_gene_variant'), {
        object1Name: 'warfarin'
      })
    ).toThrow(/invalid_arguments/)
    expect(() =>
      validateToolArguments(tool('clinpgx_get_drug_gene_variant'), {
        object1Name: 'warfarin',
        object2Name: 'VKORC1'
      })
    ).not.toThrow()
  })
})

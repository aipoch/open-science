import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CLINICAL_GENOMICS_TOOLS } from './clinical-genomics'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const OT_API = 'https://api.platform.opentargets.org/api/v4/graphql'

describe('clinical-genomics (Open Targets)', () => {
  describe('opentargets_target_diseases', () => {
    const tool = CLINICAL_GENOMICS_TOOLS.find((t) => t.id === 'opentargets_target_diseases')!

    it('resolves a gene symbol via search, then POSTs the target diseases query', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonRes({
            data: {
              search: {
                hits: [
                  { id: 'ENSG00000224057', entity: 'target', name: 'EGFR-AS1' },
                  { id: 'ENSG00000146648', entity: 'target', name: 'EGFR' }
                ]
              }
            }
          })
        )
        .mockResolvedValueOnce(
          jsonRes({
            data: {
              target: {
                id: 'ENSG00000146648',
                approvedSymbol: 'EGFR',
                approvedName: 'epidermal growth factor receptor',
                associatedDiseases: {
                  count: 6459,
                  rows: [
                    {
                      score: 0.8525670184292347,
                      disease: { id: 'MONDO_0005233', name: 'non-small cell lung carcinoma' }
                    },
                    {
                      score: 0.7744435748658476,
                      disease: { id: 'MONDO_0005061', name: 'lung adenocarcinoma' }
                    }
                  ]
                }
              }
            }
          })
        )

      const out = (await new ParserEngine({ fetchImpl }).call(tool, { gene: 'EGFR' }, {})) as {
        gene_id: string
        symbol: string
        approved_name: string
        n_diseases_total: number
        returned: number
        diseases: Array<{ disease_id: string; disease_name: string; score: number }>
      }

      expect(fetchImpl).toHaveBeenCalledTimes(2)
      const [searchUrl, searchInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
      expect(searchUrl).toBe(OT_API)
      const searchBody = JSON.parse(searchInit.body as string) as {
        query: string
        variables: unknown
      }
      expect(searchBody.query).toContain('search(queryString: $q')
      expect(searchBody.variables).toEqual({ q: 'EGFR' })

      const [diseasesUrl, diseasesInit] = fetchImpl.mock.calls[1] as [string, RequestInit]
      expect(diseasesUrl).toBe(OT_API)
      const diseasesBody = JSON.parse(diseasesInit.body as string) as {
        query: string
        variables: unknown
      }
      expect(diseasesBody.query).toContain('target(ensemblId: $ensemblId)')
      expect(diseasesBody.query).toContain('associatedDiseases(page: { size: $size, index: 0 })')
      // Picks the exact-name hit ("EGFR"), not the first hit ("EGFR-AS1").
      expect(diseasesBody.variables).toEqual({ ensemblId: 'ENSG00000146648', size: 10 })

      expect(out.gene_id).toBe('ENSG00000146648')
      expect(out.symbol).toBe('EGFR')
      expect(out.approved_name).toBe('epidermal growth factor receptor')
      expect(out.n_diseases_total).toBe(6459)
      expect(out.returned).toBe(2)
      expect(out.diseases).toEqual([
        {
          disease_id: 'MONDO_0005233',
          disease_name: 'non-small cell lung carcinoma',
          score: 0.8525670184292347
        },
        {
          disease_id: 'MONDO_0005061',
          disease_name: 'lung adenocarcinoma',
          score: 0.7744435748658476
        }
      ])
    })

    it('skips the search round-trip when given an Ensembl gene id directly', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonRes({
          data: {
            target: {
              id: 'ENSG00000146648',
              approvedSymbol: 'EGFR',
              associatedDiseases: {
                count: 1,
                rows: [{ score: 0.5, disease: { id: 'D1', name: 'disease one' } }]
              }
            }
          }
        })
      )
      await new ParserEngine({ fetchImpl }).call(tool, { gene: 'ENSG00000146648' }, {})

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as { variables: { ensemblId: string } }
      expect(body.variables.ensemblId).toBe('ENSG00000146648')
    })

    it('honors an explicit limit as the GraphQL page size', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonRes({ data: { target: { id: 'ENSG1', associatedDiseases: { count: 0, rows: [] } } } })
        )
      await new ParserEngine({ fetchImpl }).call(tool, { gene: 'ENSG00000146648', limit: 3 }, {})
      const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string) as { variables: { size: number } }
      expect(body.variables.size).toBe(3)
    })

    it('returns an empty compact result when the search finds no target hits', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ data: { search: { hits: [] } } }))
      const out = (await new ParserEngine({ fetchImpl }).call(tool, { gene: 'NOPEGENE' }, {})) as {
        gene: string
        gene_id: null
        n_diseases_total: number
        diseases: unknown[]
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(out.gene).toBe('NOPEGENE')
      expect(out.gene_id).toBeNull()
      expect(out.n_diseases_total).toBe(0)
      expect(out.diseases).toEqual([])
    })

    it('returns an empty compact result when the target itself is absent (data null)', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ data: { target: null } }))
      const out = (await new ParserEngine({ fetchImpl }).call(
        tool,
        { gene: 'ENSG00000000000' },
        {}
      )) as { gene_id: string; n_diseases_total: number; diseases: unknown[] }
      expect(out.gene_id).toBe('ENSG00000000000')
      expect(out.n_diseases_total).toBe(0)
      expect(out.diseases).toEqual([])
    })

    it('throws on a GraphQL error from the target diseases query', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ errors: [{ message: "Cannot query field 'nope'" }] }))
      await expect(
        new ParserEngine({ fetchImpl }).call(tool, { gene: 'ENSG00000146648' }, {})
      ).rejects.toThrow(/Cannot query field/)
    })
  })

  describe('opentargets_drug', () => {
    const tool = CLINICAL_GENOMICS_TOOLS.find((t) => t.id === 'opentargets_drug')!

    it('POSTs the chembl id and parses mechanism of action + indications, capped to limit', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonRes({
          data: {
            drug: {
              id: 'CHEMBL1201583',
              name: 'BEVACIZUMAB',
              drugType: 'Antibody',
              maximumClinicalStage: 'APPROVAL',
              mechanismsOfAction: {
                rows: [
                  {
                    mechanismOfAction: 'Vascular endothelial growth factor A inhibitor',
                    actionType: 'INHIBITOR',
                    targets: [{ id: 'ENSG00000112715', approvedSymbol: 'VEGFA' }]
                  }
                ]
              },
              indications: {
                count: 275,
                rows: [
                  {
                    disease: { id: 'MONDO_0005401', name: 'colonic neoplasm' },
                    maxClinicalStage: 'APPROVAL'
                  },
                  {
                    disease: { id: 'MONDO_0007254', name: 'breast cancer' },
                    maxClinicalStage: 'APPROVAL'
                  },
                  {
                    disease: { id: 'MONDO_0021211', name: 'brain neoplasm' },
                    maxClinicalStage: 'PHASE_2'
                  }
                ]
              }
            }
          }
        })
      )

      const out = (await new ParserEngine({ fetchImpl }).call(
        tool,
        { chembl_id: 'CHEMBL1201583', limit: 2 },
        {}
      )) as {
        chembl_id: string
        name: string
        drug_type: string
        max_clinical_stage: string
        mechanisms_of_action: Array<{
          mechanism_of_action: string
          action_type: string
          targets: Array<{ id: string; approved_symbol: string }>
        }>
        n_indications_total: number
        returned_indications: number
        indications: Array<{ disease_id: string; disease_name: string; max_clinical_stage: string }>
      }

      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(OT_API)
      const body = JSON.parse(init.body as string) as { query: string; variables: unknown }
      expect(body.query).toContain('drug(chemblId: $chemblId)')
      expect(body.query).toContain('maxClinicalStage')
      expect(body.variables).toEqual({ chemblId: 'CHEMBL1201583' })

      expect(out.chembl_id).toBe('CHEMBL1201583')
      expect(out.name).toBe('BEVACIZUMAB')
      expect(out.drug_type).toBe('Antibody')
      expect(out.max_clinical_stage).toBe('APPROVAL')
      expect(out.mechanisms_of_action).toEqual([
        {
          mechanism_of_action: 'Vascular endothelial growth factor A inhibitor',
          action_type: 'INHIBITOR',
          targets: [{ id: 'ENSG00000112715', approved_symbol: 'VEGFA' }]
        }
      ])
      expect(out.n_indications_total).toBe(275)
      expect(out.returned_indications).toBe(2)
      expect(out.indications).toEqual([
        {
          disease_id: 'MONDO_0005401',
          disease_name: 'colonic neoplasm',
          max_clinical_stage: 'APPROVAL'
        },
        {
          disease_id: 'MONDO_0007254',
          disease_name: 'breast cancer',
          max_clinical_stage: 'APPROVAL'
        }
      ])
    })

    it('returns found=false when the drug is absent (data null)', async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ data: { drug: null } }))
      const out = (await new ParserEngine({ fetchImpl }).call(
        tool,
        { chembl_id: 'CHEMBL_NOPE' },
        {}
      )) as { chembl_id: string; found: boolean }
      expect(out.chembl_id).toBe('CHEMBL_NOPE')
      expect(out.found).toBe(false)
    })

    it('throws on a GraphQL error from the drug query', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'Internal server error' }] }))
      await expect(
        new ParserEngine({ fetchImpl }).call(tool, { chembl_id: 'CHEMBL1201583' }, {})
      ).rejects.toThrow(/Internal server error/)
    })
  })
})

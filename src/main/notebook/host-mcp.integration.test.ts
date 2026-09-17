import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as netFetch from '../skills/net-fetch'
import { ConnectorService } from '../connectors/service'
import { ParserEngine } from '../connectors/engine'
import { CLINICAL_TRIALS_TOOLS } from '../connectors/descriptors/clinical-trials'
import { renderSkillDoc } from '../connectors/skill-doc'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookLocalRpcServer } from './local-rpc-server'
import type { NotebookExecutionResult } from './runtime-service'

// host.mcp now lives ONLY in the control-plane repl kernel (a Node process). Node is always available
// under vitest, so the sole gate is RUN_KERNEL — no provisioned python/r env is needed.
// Run with: RUN_KERNEL=1 npx vitest run src/main/notebook/host-mcp.integration.test.ts
const gate = process.env.RUN_KERNEL ? describe : describe.skip

// The real repl loop script, so host.mcp() runs against the actual bridge the app ships. The executor
// spawns it under process.execPath with ELECTRON_RUN_AS_NODE=1 exactly as production does.
const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const makeExecutor = (): NotebookKernelExecutor =>
  new NotebookKernelExecutor({ replLoopPath: REPL_LOOP })

const notebookRoots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of notebookRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const makeNotebookRoots = (): {
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
} => {
  const root = mkdtempSync(join(tmpdir(), 'os-host-mcp-'))
  notebookRoots.push(root)
  return {
    cwd: process.cwd(),
    notebookSessionRoot: join(root, 'nb'),
    dataRoot: join(root, 'nb', 'data'),
    runtimeRoot: join(root, 'runtime')
  }
}

// Base repl-cell request; kind 'repl' routes to the control-plane kernel, the only kind buildEnv
// forwards the connector RPC endpoint/token to. Spawn still prepares the Notebook workload cache
// from runtimeRoot, so these cases use a disposable root rather than an empty path.
const baseRequest = (
  overrides: Partial<{
    code: string
    mcpRpcEndpoint: string
    mcpRpcSocketPath: string
    mcpRpcToken: string
    sessionId: string
    projectId: string
  }>
): {
  code: string
  cwd: string
  kind: 'repl'
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  mcpRpcEndpoint?: string
  mcpRpcSocketPath?: string
  mcpRpcToken?: string
  sessionId?: string
  projectId?: string
} => ({
  code: '',
  kind: 'repl',
  ...makeNotebookRoots(),
  ...overrides
})

// Shared lifecycle for the lookup regression cells; requests and assertions stay in each test.
async function executeGenomesCell(
  code: string,
  fetchImpl: typeof fetch
): Promise<NotebookExecutionResult> {
  const connectorService = new ConnectorService({
    getConnectors: () => ({ enabledIds: ['genomes'], autoAllowIds: ['genomes'] }),
    resolveApiKey: () => undefined,
    engine: new ParserEngine({ retries: 0, fetchImpl })
  })
  const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
    connectorService
  })
  const connection = await rpcServer.issueControlConnection(
    'session-42',
    'project-1',
    'root-frame-session-42'
  )
  const exec = makeExecutor()
  try {
    return await exec.execute(
      baseRequest({
        code,
        mcpRpcEndpoint: connection.endpoint,
        mcpRpcSocketPath: connection.socketPath,
        mcpRpcToken: connection.token,
        sessionId: 'session-42',
        projectId: 'project-1'
      })
    )
  } finally {
    await exec.shutdown()
    connection.release()
    await rpcServer.close()
  }
}

// This bounded regression always runs: only the external HTTP response is mocked, while the
// shipped REPL, RPC, authorization, input validation and connector parser stay real.
describe('clinical trial host.mcp regression', () => {
  it('preserves patient matching, pagination, details and unrestricted sex through the full chain', async () => {
    const requests: URL[] = []
    const record = {
      protocolSection: {
        identificationModule: { nctId: 'NCT07783087', briefTitle: 'Trial' },
        eligibilityModule: {
          minimumAge: '18 Years',
          sex: 'ALL',
          eligibilityCriteria: 'Review all inclusion and exclusion criteria.'
        }
      }
    }
    const connectorService = new ConnectorService({
      getConnectors: () => ({
        enabledIds: ['clinical-trials'],
        autoAllowIds: ['clinical-trials']
      }),
      resolveApiKey: () => undefined,
      engine: new ParserEngine({
        retries: 0,
        fetchImpl: async (input) => {
          const url = new URL(String(input))
          requests.push(url)
          if (url.pathname.endsWith('/NCT07783087')) return Response.json(record)
          return Response.json({
            studies: [record],
            ...(!url.searchParams.has('pageToken') ? { nextPageToken: 'next-page' } : {})
          })
        }
      })
    })
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()
    try {
      const descriptor = CLINICAL_TRIALS_TOOLS.find((tool) => tool.id === 'search_by_eligibility')!
      const execution = await exec.execute(
        baseRequest({
          code: `${descriptor.example};
            const next = await host.mcp('clinical-trials', 'search_by_eligibility', {
              condition: 'diabetes', min_age: '65 Years', sex: 'FEMALE',
              page_token: result.next_page_token
            });
            const detail = await host.mcp('clinical-trials', 'get_trial_details', {
              nct_id: result.items[0].nct_id
            });
            const unrestricted = await host.mcp('clinical-trials', 'search_by_eligibility', {sex:'ALL'});
            let invalidSex;
            try { await host.mcp('clinical-trials', 'search_by_eligibility', {sex:'INVALID'}); }
            catch (error) { invalidSex = String(error); }
            console.log(JSON.stringify({result, next, detail, unrestricted, invalidSex}));`,
          mcpRpcEndpoint: connection.endpoint,
          mcpRpcSocketPath: connection.socketPath,
          mcpRpcToken: connection.token,
          sessionId: 'session-42',
          projectId: 'project-1'
        })
      )
      expect(execution.status).toBe('completed')
      const output = JSON.parse(execution.stdout.trim())
      expect(output.result).toMatchObject({
        count: 1,
        total: null,
        next_page_token: 'next-page',
        items: [{ nct_id: 'NCT07783087', minimum_age: '18 Years', maximum_age: null, sex: 'ALL' }]
      })
      expect(output.next.items).toEqual(output.result.items)
      expect(output.next.next_page_token).toBeNull()
      expect(output.detail).toMatchObject({
        found: true,
        trial: {
          nct_id: 'NCT07783087',
          minimum_age: '18 Years',
          maximum_age: null,
          sex: 'ALL',
          eligibility_criteria: record.protocolSection.eligibilityModule.eligibilityCriteria
        }
      })
      expect(output.unrestricted.items).toEqual(output.result.items)
      expect(output.invalidSex).toContain('invalid_arguments')
      expect(requests).toHaveLength(4)
      const firstParams = requests[0].searchParams
      expect(firstParams.get('filter.advanced')).toContain('AREA[MaximumAge]RANGE[65 Years, MAX]')
      expect(firstParams.get('filter.advanced')).toContain('AREA[Sex]"ALL"')
      expect(firstParams.get('fields')).toContain('MinimumAge|MaximumAge|Sex')
      expect(requests[1].searchParams.get('pageToken')).toBe('next-page')
      expect(requests[1].searchParams.get('filter.advanced')).toBe(
        firstParams.get('filter.advanced')
      )
      expect(requests[3].searchParams.has('filter.advanced')).toBe(false)
      const instructions = renderSkillDoc('clinical-trials')
      expect(instructions).toContain('both trial age bounds are checked')
      expect(instructions).toContain('ALL or omitted sex applies no sex filter')
      expect(instructions).toContain('minimum_age, maximum_age and sex')
    } finally {
      await exec.shutdown()
      connection.release()
      await rpcServer.close()
    }
  })
})

// Exercise the shipped REPL and RPC path so callers cannot mistake request failures for absence.
describe('Ensembl sequence host.mcp regression', () => {
  it('keeps multiple-sequence and incompatible-type errors distinct from a missing ID', async () => {
    const multipleError =
      'Requesting a gene and type not equal to "genomic" can result in multiple sequences. 40 sequences detected. Please rerun your request and specify the multiple_sequences parameter'
    const incompatibleError =
      'No sequences returned, please check the type specified is compatible with the object requested'
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      requests.push(url.pathname)
      if (url.pathname === '/sequence/id/ENSG00000141510') {
        return Response.json({ error: multipleError }, { status: 400 })
      }
      if (url.pathname === '/sequence/id/ENST00000269305') {
        return Response.json({ id: 'ENST00000269305', molecule: 'dna', seq: 'ACGT' })
      }
      if (url.pathname === '/sequence/id/ENSG00000000000') {
        return Response.json({ error: "ID 'ENSG00000000000' not found" }, { status: 400 })
      }
      if (url.pathname === '/sequence/id/ENST00000673794') {
        return Response.json({ error: incompatibleError }, { status: 400 })
      }
      throw new Error(`Unexpected request ${url}`)
    }
    const result = await executeGenomesCell(
      `
        const results = [];
        for (const args of [
          {stable_id:'ENSG00000141510',seq_type:'cdna'},
          {stable_id:'ENST00000269305.9',seq_type:'cdna'},
          {stable_id:'ENSG00000000000',seq_type:'cdna'},
          {stable_id:'ENST00000673794',seq_type:'protein'}
        ]) {
          try {
            results.push({result:await host.mcp('genomes','ensembl_sequence',args)});
          } catch (error) {
            results.push({error:String(error)});
          }
        }
        console.log(JSON.stringify(results));
      `,
      fetchImpl
    )
    expect(result.status, result.traceback).toBe('completed')
    const output = JSON.parse(result.stdout.trim())
    expect(output[0].error).toContain(multipleError)
    expect(output[0].result).toBeUndefined()
    expect(output[1].result).toMatchObject({
      found: true,
      query: 'ENST00000269305.9',
      id: 'ENST00000269305',
      seq: 'ACGT',
      length: 4
    })
    expect(output[2].result).toMatchObject({ found: false, id: null, sha256: null })
    expect(output[3].error).toContain(incompatibleError)
    expect(output[3].result).toBeUndefined()
    expect(requests).toEqual([
      '/sequence/id/ENSG00000141510',
      '/sequence/id/ENST00000269305',
      '/sequence/id/ENSG00000000000',
      '/sequence/id/ENST00000673794'
    ])
    const instructions = renderSkillDoc('genomes')
    expect(instructions).toContain('specify a transcript/protein stable ID instead')
    expect(instructions).toContain(
      'only when Ensembl explicitly reports the requested stable ID as not found'
    )
  })
})

gate('repl kernel host.mcp', () => {
  it.each([undefined, 'auto', 'id', 'symbol', 'guess', null, 42])(
    'preserves and validates lookup query_type through RPC: %s',
    async (queryType) => {
      const record = {
        id: 'ENSMUSG00000059552',
        species: 'mus_musculus',
        seq_region_name: '11',
        start: 69469669
      }
      const idUrl = 'https://rest.ensembl.org/lookup/id/Trp53?expand=0'
      const symbolUrl = 'https://rest.ensembl.org/lookup/symbol/mus_musculus/Trp53?expand=0'
      const sequenceUrl =
        'https://rest.ensembl.org/sequence/region/mus_musculus/11:69469669-69469672'
      const requests: string[] = []
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input)
        requests.push(url)
        if (url === idUrl) return Response.json({ error: "ID 'Trp53' not found" }, { status: 400 })
        if (url === symbolUrl) return Response.json(record)
        if (url === sequenceUrl)
          return Response.json({ id: '11:69469669-69469672', molecule: 'dna', seq: 'ACGT' })
        throw new Error(`Unexpected request ${url}`)
      }
      const args = { query: 'Trp53', species: 'mus_musculus', query_type: queryType }
      const result = await executeGenomesCell(
        `
            const lookup = await host.mcp('genomes', 'ensembl_lookup', ${JSON.stringify(args)});
            let sequence = null;
            if (lookup.found) {
              const r = lookup.record;
              sequence = await host.mcp('genomes', 'ensembl_sequence', {
                species: lookup.species, region: r.seq_region_name+':'+r.start+'-'+(r.start+3)
              });
            }
            console.log(JSON.stringify({lookup, sequence}));
          `,
        fetchImpl
      )
      if (queryType === 'guess' || queryType === null || queryType === 42) {
        expect(result.status).toBe('failed')
        expect(result.traceback).toContain('query_type')
        expect(result.stdout.trim()).toBe('')
        expect(requests).toEqual([])
      } else {
        expect(result.status, result.traceback).toBe('completed')
        const output = JSON.parse(result.stdout.trim())
        expect(output.lookup).toEqual({
          found: queryType !== 'id',
          query: 'Trp53',
          species: 'mus_musculus',
          record: queryType === 'id' ? null : record
        })
        if (queryType === 'id') {
          expect(output.sequence).toBeNull()
          expect(requests).toEqual([idUrl])
        } else {
          expect(output.sequence).toMatchObject({ found: true, seq: 'ACGT', length: 4 })
          expect(requests).toEqual(
            queryType === 'symbol' ? [symbolUrl, sequenceUrl] : [idUrl, symbolUrl, sequenceUrl]
          )
        }
      }
    }
  )

  it.each([
    ['FBgn0002778', 'drosophila_melanogaster', '3L', 14985100],
    ['WBGene00006763', 'caenorhabditis_elegans', 'IV', 13261555],
    ['YBR160W', 'saccharomyces_cerevisiae', 'II', 560078]
  ])(
    'routes external ID %s through lookup and downstream sequence',
    async (id, species, chromosome, start) => {
      const record = { id, species, seq_region_name: chromosome, start }
      const requests: string[] = []
      const region = `${chromosome}:${start}-${Number(start) + 3}`
      const lookupUrl = `https://rest.ensembl.org/lookup/id/${id}?expand=0`
      const sequenceUrl = `https://rest.ensembl.org/sequence/region/${species}/${region}`
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input)
        requests.push(url)
        if (url === lookupUrl) return Response.json(record)
        if (url === sequenceUrl) return Response.json({ id: region, molecule: 'dna', seq: 'ACGT' })
        throw new Error(`Unexpected request ${url}`)
      }
      const result = await executeGenomesCell(
        `
          const lookup = await host.mcp('genomes','ensembl_lookup',{query:${JSON.stringify(id)}});
          const r = lookup.record;
          const sequence = await host.mcp('genomes','ensembl_sequence',{
            species:lookup.species, region:r.seq_region_name+':'+r.start+'-'+(r.start+3)
          });
          console.log(JSON.stringify({lookup,sequence}));
        `,
        fetchImpl
      )
      expect(result.status, result.traceback).toBe('completed')
      const output = JSON.parse(result.stdout.trim())
      expect(output.lookup).toEqual({ found: true, query: id, species, record })
      expect(output.sequence).toMatchObject({ found: true, seq: 'ACGT', length: 4 })
      expect(requests).toEqual([lookupUrl, sequenceUrl])
    }
  )

  it.each(['missing', 'invalid-species', 'upstream-failure'])(
    'preserves lookup error classification through host.mcp: %s',
    async (mode) => {
      const requests: string[] = []
      const species = mode === 'invalid-species' ? 'mus_musculuss' : 'mus_musculus'
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input)
        requests.push(url)
        if (mode === 'upstream-failure')
          return Response.json({ error: 'Service unavailable' }, { status: 503 })
        if (url.includes('/lookup/id/'))
          return Response.json({ error: "ID 'NOSUCHGENE' not found" }, { status: 400 })
        return Response.json(
          {
            error:
              mode === 'missing'
                ? 'No valid lookup found for symbol NOSUCHGENE'
                : "Can not find internal name for species 'mus_musculuss'"
          },
          { status: 400 }
        )
      }
      const result = await executeGenomesCell(
        `console.log(JSON.stringify(await host.mcp('genomes','ensembl_lookup',{query:'NOSUCHGENE',species:${JSON.stringify(species)}})));`,
        fetchImpl
      )
      if (mode === 'missing') {
        expect(result.status, result.traceback).toBe('completed')
        expect(JSON.parse(result.stdout.trim())).toEqual({
          found: false,
          query: 'NOSUCHGENE',
          species,
          record: null
        })
      } else {
        expect(result.status).toBe('failed')
        expect(result.traceback).toContain(
          mode === 'invalid-species' ? 'Can not find internal name for species' : 'HTTP 503'
        )
        expect(result.stdout.trim()).toBe('')
      }
      expect(requests).toHaveLength(mode === 'upstream-failure' ? 1 : 2)
    }
  )

  it.each([
    { mode: 'mapped', requestedSpecies: undefined },
    { mode: 'mapped', requestedSpecies: 'homo_sapiens' },
    { mode: 'raw', requestedSpecies: undefined },
    { mode: 'batch-mismatch', requestedSpecies: undefined },
    { mode: 'single-mismatch', requestedSpecies: undefined }
  ])(
    'chains Ensembl into Reactome ($mode, $requestedSpecies)',
    async ({ mode, requestedSpecies }) => {
      const record = {
        id: 'ENSMUSG00000059552',
        display_name: 'Trp53',
        species: 'mus_musculus'
      }
      const connectorService = new ConnectorService({
        getConnectors: () => ({
          enabledIds: ['genomes', 'genes'],
          autoAllowIds: ['genomes', 'genes']
        }),
        resolveApiKey: () => undefined,
        engine: new ParserEngine({
          retries: 0,
          fetchImpl: async (input) => {
            expect(String(input)).toBe(`https://rest.ensembl.org/lookup/id/${record.id}?expand=0`)
            return Response.json(record)
          }
        })
      })
      let submissions = 0
      // Mock only Reactome's external transport; preserve the real local RPC transport.
      const reactomeFetch = vi
        .spyOn(netFetch, 'netFetchStandard')
        .mockImplementation(async (input, init) => {
          const url = new URL(String(input))
          expect(url.origin).toBe('https://reactome.org')
          if (url.pathname === '/AnalysisService/database/version') return new Response('97')
          if (url.pathname === '/AnalysisService/token/test-token/notFound')
            return Response.json([])
          expect(url.pathname).toBe('/AnalysisService/identifiers/')
          expect(url.searchParams.get('species')).toBe('Mus musculus')
          expect(url.searchParams.get('resource')).toBe('TOTAL')
          expect(init?.method).toBe('POST')
          expect(new Headers(init?.headers).get('content-type')).toBe('text/plain')
          expect(init?.body).toBe('Trp53')
          submissions++
          const mismatch =
            (mode === 'batch-mismatch' && submissions === 1) ||
            (mode === 'single-mismatch' && submissions === 2)
          return Response.json({
            summary: { token: 'test-token' },
            identifiersNotFound: 0,
            pathwaysFound: 1,
            pathways: [
              {
                stId: mismatch ? 'R-HSA-test' : 'R-MMU-test',
                name: 'Test pathway',
                species: { name: mismatch ? 'Homo sapiens' : 'Mus musculus' },
                llp: true
              }
            ]
          })
        })
      const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
        connectorService
      })
      const connection = await rpcServer.issueControlConnection(
        'session-42',
        'project-1',
        'root-frame-session-42'
      )
      const exec = makeExecutor()
      try {
        const args = {
          query: record.id,
          ...(requestedSpecies ? { species: requestedSpecies } : {})
        }
        const result = await exec.execute(
          baseRequest({
            code: `
          const lookup = await host.mcp('genomes', 'ensembl_lookup', ${JSON.stringify(args)});
          // This caller explicitly adapts the two tools' documented input formats.
          const speciesNames = {mus_musculus: 'Mus musculus', homo_sapiens: 'Homo sapiens'};
          const species = ${mode === 'raw' ? 'lookup.species' : 'speciesNames[lookup.species]'};
          const pathways = await host.mcp('genes', 'map_reactome_pathways', {
            identifiers: [lookup.record.display_name], id_type: 'symbol', species
          });
          console.log(JSON.stringify({lookup, pathways}));
        `,
            mcpRpcEndpoint: connection.endpoint,
            mcpRpcSocketPath: connection.socketPath,
            mcpRpcToken: connection.token,
            sessionId: 'session-42',
            projectId: 'project-1'
          })
        )
        if (mode === 'raw') {
          expect(result.status).toBe('failed')
          expect(result.traceback).toContain('Unsupported Reactome species: "mus_musculus"')
          expect(reactomeFetch).not.toHaveBeenCalled()
        } else if (mode.endsWith('mismatch')) {
          expect(result.status).toBe('failed')
          expect(result.traceback).toContain('Reactome species mismatch: requested "Mus musculus"')
          expect(submissions).toBe(mode === 'batch-mismatch' ? 1 : 2)
          expect(result.stdout.trim()).toBe('')
        } else {
          expect(result.status, result.traceback).toBe('completed')
          const output = JSON.parse(result.stdout.trim())
          expect(output.lookup.species).toBe('mus_musculus')
          expect(output.pathways.species).toBe('Mus musculus')
          expect(output.pathways.genes.Trp53).toEqual({
            found: true,
            n_lowlevel_pathways: 1,
            pathways: [{ stId: 'R-MMU-test', name: 'Test pathway', species: 'Mus musculus' }]
          })
          expect(submissions).toBe(2)
        }
      } finally {
        await exec.shutdown()
        connection.release()
        await rpcServer.close()
      }
    }
  )

  it.each([undefined, 'homo_sapiens'])(
    'uses the resolved mouse species for a downstream region request (requested species: %s)',
    async (species) => {
      const record = {
        id: 'ENSMUSG00000059552',
        species: 'mus_musculus',
        assembly_name: 'GRCm39',
        seq_region_name: '11',
        start: 69469669,
        end: 69482701
      }
      const requests: string[] = []
      const region = `${record.seq_region_name}:${record.start}-${record.start + 3}`
      const lookupUrl = `https://rest.ensembl.org/lookup/id/${record.id}?expand=0`
      const sequenceUrl = `https://rest.ensembl.org/sequence/region/mus_musculus/${region}`
      const connectorService = new ConnectorService({
        getConnectors: () => ({ enabledIds: ['genomes'], autoAllowIds: ['genomes'] }),
        resolveApiKey: () => undefined,
        engine: new ParserEngine({
          retries: 0,
          fetchImpl: async (input) => {
            const url = String(input)
            requests.push(url)
            if (url === lookupUrl) return Response.json(record)
            if (url === sequenceUrl) {
              return Response.json({ id: region, molecule: 'dna', seq: 'ACGT' })
            }
            throw new Error(`Unexpected Ensembl request: ${url}`)
          }
        })
      })
      const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
        connectorService
      })
      const connection = await rpcServer.issueControlConnection(
        'session-42',
        'project-1',
        'root-frame-session-42'
      )
      const exec = makeExecutor()
      try {
        const args = { query: record.id, ...(species ? { species } : {}) }
        const result = await exec.execute(
          baseRequest({
            code: `
              const lookup = await host.mcp('genomes', 'ensembl_lookup', ${JSON.stringify(args)});
              const record = lookup.record;
              const region = record.seq_region_name + ':' + record.start + '-' + (record.start + 3);
              const sequence = await host.mcp('genomes', 'ensembl_sequence', {
                species: lookup.species, region
              });
              console.log(JSON.stringify({lookup, sequence}));
            `,
            mcpRpcEndpoint: connection.endpoint,
            mcpRpcSocketPath: connection.socketPath,
            mcpRpcToken: connection.token,
            sessionId: 'session-42',
            projectId: 'project-1'
          })
        )
        expect(result.status, result.traceback).toBe('completed')
        const output = JSON.parse(result.stdout.trim())
        expect(output.lookup).toEqual({
          found: true,
          query: record.id,
          species: 'mus_musculus',
          record
        })
        expect(output.sequence).toMatchObject({
          found: true,
          query: region,
          seq: 'ACGT',
          length: 4
        })
        expect(requests).toEqual([lookupUrl, sequenceUrl])
      } finally {
        await exec.shutdown()
        connection.release()
        await rpcServer.close()
      }
    }
  )

  it('preserves VEP strand normalization and validation through host.mcp', async () => {
    const urls: string[] = []
    const connectorService = new ConnectorService({
      getConnectors: () => ({ enabledIds: ['genomes'], autoAllowIds: ['genomes'] }),
      resolveApiKey: () => undefined,
      engine: new ParserEngine({
        fetchImpl: async (input) => {
          urls.push(String(input))
          return Response.json([
            {
              input: '19 44908822 44908823 CG/AC 1',
              allele_string: 'CG/AC',
              strand: 1,
              assembly_name: 'GRCh38',
              transcript_consequences: [
                { transcript_id: 't1', gene_id: 'g1', variant_allele: 'AC', impact: 'MODERATE' }
              ]
            }
          ])
        }
      })
    })
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()
    const request = (args: Record<string, unknown>): ReturnType<typeof baseRequest> =>
      baseRequest({
        code: `console.log(JSON.stringify(await host.mcp('genomes', 'ensembl_vep_variant', ${JSON.stringify(args)})))`,
        mcpRpcEndpoint: connection.endpoint,
        mcpRpcSocketPath: connection.socketPath,
        mcpRpcToken: connection.token,
        sessionId: 'session-42',
        projectId: 'project-1'
      })
    try {
      const result = await exec.execute(
        request({ region: '19:44908822-44908823:-1', allele: 'GT', allele_orientation: 'region' })
      )
      expect(result.status).toBe('completed')
      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain('/region/19:44908822-44908823:1/AC')
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        query: '19:44908822-44908823:-1 GT',
        normalization: {
          original: {
            region: '19:44908822-44908823:-1',
            allele: 'GT',
            allele_orientation: 'region'
          },
          forward: { region: '19:44908822-44908823:1', allele: 'AC' },
          reverse_complemented: true
        },
        results: [
          { allele_string: 'CG/AC', strand: 1, transcript_consequences: [{ variant_allele: 'AC' }] }
        ]
      })
      for (const args of [
        { region: '19:44908822-44908823:-1', allele: 'GT', allele_orientation: 'invalid' },
        { region: '19:44908822-44908823:-1', allele: 'DUP', allele_orientation: 'region' }
      ]) {
        const invalid = await exec.execute(request(args))
        expect(invalid.status).toBe('failed')
        expect(invalid.traceback).toContain('allele_orientation')
        expect(urls).toHaveLength(1)
      }
    } finally {
      await exec.shutdown()
      connection.release()
      await rpcServer.close()
    }
  })

  it.each([404, 429, 503])(
    'preserves OLS errors versus not_found through host.mcp (HTTP %s)',
    async (status) => {
      let attempts = 0
      const connectorService = new ConnectorService({
        getConnectors: () => ({ enabledIds: ['genes'], autoAllowIds: ['genes'] }),
        resolveApiKey: () => undefined,
        engine: new ParserEngine({
          retryBackoffMs: 1,
          fetchImpl: async () => {
            attempts++
            return new Response('', { status })
          }
        })
      })
      const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
        connectorService
      })
      const connection = await rpcServer.issueControlConnection(
        'session-42',
        'project-1',
        'root-frame-session-42'
      )
      const exec = makeExecutor()
      try {
        const result = await exec.execute(
          baseRequest({
            code: `const result = await host.mcp('genes', 'list_ontologies', {ontology_ids: ['go']}); console.log(JSON.stringify(result))`,
            mcpRpcEndpoint: connection.endpoint,
            mcpRpcSocketPath: connection.socketPath,
            mcpRpcToken: connection.token,
            sessionId: 'session-42',
            projectId: 'project-1'
          })
        )
        if (status === 404) {
          expect(result.status).toBe('completed')
          expect(JSON.parse(result.stdout.trim())).toEqual({ records: [], not_found: ['go'] })
          expect(attempts).toBe(1)
        } else {
          expect(result.status).toBe('failed')
          expect(result.traceback).toContain(`HTTP ${status}`)
          expect(result.stdout).not.toContain('not_found')
          expect(attempts).toBe(3)
        }
      } finally {
        await exec.shutdown()
        connection.release()
        await rpcServer.close()
      }
    }
  )

  it.each([503, 404, 200])(
    'preserves CellGuide error/empty semantics through host.mcp (HTTP %s)',
    async (status) => {
      let markerRequests = 0
      const connectorService = new ConnectorService({
        getConnectors: () => ({ enabledIds: ['cellguide'], autoAllowIds: ['cellguide'] }),
        resolveApiKey: () => undefined,
        engine: new ParserEngine({
          retryBackoffMs: 1,
          fetchImpl: async (input) => {
            const url = String(input)
            if (url.endsWith('/latest_snapshot_identifier')) return new Response('test-snapshot')
            if (url.endsWith('/celltype_metadata.json')) {
              return Response.json({ 'CL:0000622': { name: 'acinar cell' } })
            }
            if (url.endsWith('/computational_marker_genes/CL_0000622.json')) {
              markerRequests += 1
              return new Response('', { status })
            }
            throw new Error(`Unexpected CellGuide request: ${url}`)
          }
        })
      })
      const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
        connectorService
      })
      const connection = await rpcServer.issueControlConnection(
        'session-42',
        'project-1',
        'root-frame-session-42'
      )
      const exec = makeExecutor()
      try {
        const result = await exec.execute(
          baseRequest({
            code: `const result = await host.mcp('cellguide', 'get_marker_genes', {cell_type: 'CL:0000622'}); console.log(JSON.stringify(result))`,
            mcpRpcEndpoint: connection.endpoint,
            mcpRpcSocketPath: connection.socketPath,
            mcpRpcToken: connection.token,
            sessionId: 'session-42',
            projectId: 'project-1'
          })
        )
        if (status === 503) {
          expect(result.status).toBe('failed')
          expect(result.traceback).toContain('HTTP 503')
          expect(result.stdout).not.toContain('markerGenes')
          expect(markerRequests).toBe(3)
        } else {
          expect(result.status).toBe('completed')
          expect(JSON.parse(result.stdout.trim())).toMatchObject({
            id: 'CL:0000622',
            returned: 0,
            markerGenes: []
          })
          expect(markerRequests).toBe(1)
        }
      } finally {
        await exec.shutdown()
        connection.release()
        await rpcServer.close()
      }
    }
  )

  it('keeps the persistent control capability across ACP session cleanup', async () => {
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService: {
        call: async (server, method, args, context) => ({ server, method, args, context })
      }
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()

    try {
      const request = baseRequest({
        code: `
            const result = await host.mcp('pubmed', 'search_articles', { query: 'tumor immunology' })
            console.log(JSON.stringify(result))
          `,
        mcpRpcEndpoint: connection.endpoint,
        mcpRpcSocketPath: connection.socketPath,
        mcpRpcToken: connection.token,
        sessionId: 'session-42',
        projectId: 'project-1'
      })
      const first = await exec.execute(request)

      rpcServer.releaseSessionCapabilities('session-42')

      const second = await exec.execute(request)

      for (const result of [first, second]) {
        expect(result.status).toBe('completed')
        expect(JSON.parse(result.stdout.trim())).toEqual({
          server: 'pubmed',
          method: 'search_articles',
          args: { query: 'tumor immunology' },
          context: { sessionId: 'session-42', projectId: 'project-1', origin: 'agent' }
        })
      }
    } finally {
      await exec.shutdown()
      connection.release()
      await rpcServer.close()
    }
  })

  it('host.mcp posts to the RPC endpoint and returns the parsed result', async () => {
    // Minimal stub RPC endpoint returning a fixed dict for any mcpCall.
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { ok: true } }))
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "const r = await host.mcp('chemistry','pubchem_get_properties',{ cids: [1] }); console.log(r.ok)",
        mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
        mcpRpcToken: 'tok'
      })
    )
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('true')
  })

  it('host.mcp forwards a positional args object to the RPC server', async () => {
    // Stub RPC endpoint that echoes back the args it received so the test can assert forwarding.
    const { createServer } = await import('node:http')
    let received: {
      params?: { args?: unknown; sessionId?: string; projectId?: string }
    } = {}
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = JSON.parse(body)
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ result: { echoedArgs: received.params?.args } }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as { port: number }
    const exec = makeExecutor()
    const result = await exec.execute(
      baseRequest({
        code: "const r = await host.mcp('chemistry','pubchem_get_properties',{ cids: [1, 2] }); console.log(JSON.stringify(r.echoedArgs.cids))",
        mcpRpcEndpoint: `http://127.0.0.1:${addr.port}`,
        mcpRpcToken: 'tok',
        sessionId: 'session-42',
        projectId: 'project-1'
      })
    )
    await exec.shutdown()
    server.close()
    expect(result.status).toBe('completed')
    expect(result.stdout).toContain('[1,2]')
    expect(received.params?.args).toEqual({ cids: [1, 2] })
    expect(received.params).toMatchObject({ sessionId: 'session-42', projectId: 'project-1' })
  })

  it('tells the agent how to recover when host.mcp names an unavailable connector', async () => {
    const connectorService = new ConnectorService({
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [], disabledConnectorIds: [] }),
      resolveApiKey: () => undefined
    })
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()

    const result = await exec.execute(
      baseRequest({
        code: "await host.mcp('cancer_models','cbioportal_list_studies',{})",
        mcpRpcEndpoint: connection.endpoint,
        mcpRpcSocketPath: connection.socketPath,
        mcpRpcToken: connection.token,
        sessionId: 'session-42',
        projectId: 'project-1'
      })
    )

    await exec.shutdown()
    connection.release()
    await rpcServer.close()
    expect(result.status).toBe('failed')
    expect(result.traceback).toContain('Connector "cancer_models" is unavailable.')
    expect(result.traceback).toContain('Do not retry with guessed Connector names.')
    expect(result.traceback).toContain(
      'Use only Connector names and methods documented by a loaded'
    )
    expect(result.traceback).toContain('mcp-* Skill')
    expect(result.traceback).toContain('Settings > Connectors')
  })

  it('tells the agent to wait for sign-in when a Connector requires authentication', async () => {
    const connectorService = new ConnectorService({
      getConnectors: () => ({
        enabledIds: [],
        autoAllowIds: [],
        customMcpServers: [
          {
            id: 'oauth-server-id',
            name: 'oauth-server',
            displayName: 'OAuth server',
            transport: 'streamable_http',
            url: 'https://mcp.example.test',
            oauth: {},
            enabled: true
          }
        ]
      }),
      resolveApiKey: () => undefined
    })
    const rpcServer = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      connectorService
    })
    const connection = await rpcServer.issueControlConnection(
      'session-42',
      'project-1',
      'root-frame-session-42'
    )
    const exec = makeExecutor()

    try {
      const result = await exec.execute(
        baseRequest({
          code: "await host.mcp('oauth-server','lookup',{})",
          mcpRpcEndpoint: connection.endpoint,
          mcpRpcSocketPath: connection.socketPath,
          mcpRpcToken: connection.token,
          sessionId: 'session-42',
          projectId: 'project-1'
        })
      )

      expect(result.status).toBe('failed')
      expect(result.traceback).toContain('connector_unauthenticated')
      expect(result.traceback).toContain('Do not retry until the user signs in')
      expect(result.traceback).toContain('Settings > Connectors')
      expect(result.traceback).toContain('retry the same call')
    } finally {
      await exec.shutdown()
      connection.release()
      await rpcServer.close()
    }
  })
})

import { z } from 'zod'
import type { ToolDescriptor } from '@aipoch/connector-core'
import { objectInput, officialFileLinks, provenance } from './official-file-links'

const access = {
  nhanes: {
    name: 'NHANES',
    portal: 'https://wwwn.cdc.gov/nchs/nhanes/',
    docs: 'https://wwwn.cdc.gov/nchs/nhanes/tutorials/datasets.aspx',
    mode: 'public',
    guidance:
      'Public survey files need no API key. Discover a cycle/component, then read variable definitions, weights, strata and PSU before analysis.'
  },
  charls: {
    name: 'CHARLS',
    portal: 'https://charls.pku.edu.cn/',
    docs: 'https://charls.pku.edu.cn/Faq/cjwt.htm',
    mode: 'personal_data_permission',
    guidance:
      'Register and apply for personal data access. Obtain approved files through the official site; this connector does not log in or accept agreements.'
  },
  chns: {
    name: 'CHNS',
    portal: 'https://dataverse.unc.edu/dataverse/chns',
    docs: 'https://chns.cpc.unc.edu/data/datasets/',
    mode: 'file_specific',
    guidance:
      'Household/individual longitudinal files are distributed through UNC Dataverse. Community-level data requires a separately approved agreement. Public files do not necessarily require a token; follow each file access policy.'
  },
  seer: {
    name: 'SEER',
    portal: 'https://seer.cancer.gov/seerstat/',
    docs: 'https://seer.cancer.gov/data/access.html',
    mode: 'personal_data_permission',
    guidance:
      'Apply for personal SEER data access and check current product/geographic eligibility. Use SEER*Stat to export approved CSV/TSV; this connector does not download the research database.'
  },
  mimic: {
    name: 'MIMIC',
    portal: 'https://physionet.org/content/mimiciv/',
    docs: 'https://physionet.org/about/faqs/',
    mode: 'credentialed_full_data_public_demo',
    guidance:
      'Public demos need no account. Full data requires PhysioNet credentialing, training and the project agreement. Follow the current model-use policy; these tools neither supply credentials nor download controlled files.'
  },
  eicu: {
    name: 'eICU',
    portal: 'https://physionet.org/content/eicu-crd/',
    docs: 'https://physionet.org/about/faqs/',
    mode: 'credentialed_full_data_public_demo',
    guidance:
      'Public demo files need no account. Full data requires personal PhysioNet credentialing, training and the project agreement. These tools neither supply credentials nor download controlled files.'
  },
  faers: {
    name: 'FAERS / openFDA',
    portal: 'https://open.fda.gov/apis/drug/event/',
    docs: 'https://open.fda.gov/apis/authentication/',
    mode: 'public_with_quotas',
    guidance:
      'Use existing drug-regulatory search/count tools and its public bulk manifest. A free key is recommended for regular online use, but bundled query tools currently use anonymous access; do not invent a key binding or pass keys in tool arguments.'
  },
  gbd: {
    name: 'GBD',
    portal: 'https://vizhub.healthdata.org/gbd-results/',
    docs: 'https://ghdx.healthdata.org/',
    mode: 'official_portal_export',
    guidance:
      'Use the official results tool account, terms and export workflow to obtain CSV. No automated export-task API is provided here; exported estimates are not patient records.'
  }
} as const

const partition = z
  .object({
    file: z.string().url(),
    size_mb: z.union([z.string(), z.number()]).optional(),
    records: z.number().optional()
  })
  .passthrough()

export const RESEARCH_DATASET_TOOLS: ToolDescriptor[] = [
  {
    id: 'get_dataset_access',
    connector: 'research-datasets',
    credentialKeys: [],
    description:
      'Read official access requirements and entry points for NHANES, CHARLS, CHNS, SEER, MIMIC, eICU, FAERS or GBD. This is declared guidance, not an account check, approval or a query of the source database. Recheck current official terms before acquisition.',
    input: objectInput({ dataset: { type: 'string', enum: Object.keys(access) } }, ['dataset']),
    required: ['dataset'],
    exampleArgs: { dataset: 'seer' },
    returns:
      '{ source, source_url, retrieved_at, dataset, portal, access_mode, guidance, authorization_verified: false, file_processing }. No account, download, persistence or approval is performed.',
    run: async (_ctx, args) => {
      const dataset = String(args.dataset) as keyof typeof access
      if (!Object.hasOwn(access, dataset)) throw new Error('Unknown research dataset')
      const item = access[dataset]
      return {
        ...provenance(item.name, item.docs),
        dataset,
        portal: item.portal,
        access_mode: item.mode,
        guidance: item.guidance,
        authorization_verified: false,
        live_verified: false,
        file_processing:
          'Acquire files through official supported download workflows and analyze authorized files using the existing file/Notebook tools. Download URLs are metadata, not completed transfers. There is no connector-owned analysis environment, local SQL store or import/job API.'
      }
    }
  },
  {
    id: 'list_nhanes_files',
    connector: 'research-datasets',
    credentialKeys: [],
    maxResponseBytes: 8_000_000,
    description:
      'Discover official public NHANES XPT files for one survey cycle/component. Returns file and matching documentation links without downloading files. Rejects a changed/challenge page rather than treating it as an empty dataset.',
    input: objectInput(
      {
        cycle_begin_year: { type: 'integer', minimum: 1999, maximum: 2100 },
        component: {
          type: 'string',
          enum: ['Demographics', 'Dietary', 'Examination', 'Laboratory', 'Questionnaire'],
          default: 'Demographics'
        }
      },
      ['cycle_begin_year']
    ),
    required: ['cycle_begin_year'],
    exampleArgs: { cycle_begin_year: 2017, component: 'Demographics' },
    returns:
      '{ source, source_url, retrieved_at, cycle_begin_year, component, files: [{ filename, url, documentation_url }], note }. File availability does not validate variable definitions, survey weights or compatibility across cycles.',
    run: async (ctx, args) => {
      const url = new URL('https://wwwn.cdc.gov/nchs/nhanes/search/datapage.aspx')
      url.search = new URLSearchParams({
        Component: String(args.component ?? 'Demographics'),
        CycleBeginYear: String(args.cycle_begin_year)
      }).toString()
      const html = await ctx.fetchText(url.href, 'text/html')
      const valid = (link: URL): boolean =>
        link.hostname === 'wwwn.cdc.gov' && link.pathname.toLowerCase().startsWith('/nchs/')
      const files = officialFileLinks(
        html,
        url.href,
        (link) => valid(link) && /\.xpt$/i.test(link.pathname)
      )
      let docs: { filename: string; url: string }[] = []
      try {
        docs = officialFileLinks(
          html,
          url.href,
          (link) => valid(link) && /\.htm$/i.test(link.pathname)
        )
      } catch {
        /* Documentation links may be absent; do not invent one. */
      }
      return {
        ...provenance('NHANES', url.href),
        cycle_begin_year: args.cycle_begin_year,
        component: args.component ?? 'Demographics',
        files: files.map((file) => ({
          ...file,
          documentation_url:
            docs.find(
              (doc) =>
                doc.filename.toLowerCase() ===
                file.filename.replace(/\.xpt$/i, '.htm').toLowerCase()
            )?.url ?? null
        })),
        note: 'Read official variable documentation and account for the complex survey design. Links are not downloaded or merged.'
      }
    }
  },
  {
    id: 'list_physionet_demo_files',
    connector: 'research-datasets',
    credentialKeys: [],
    maxResponseBytes: 2_000_000,
    description:
      'List files in the official MIMIC-IV 2.2 or eICU 2.0 public demo. Supports fixed demo locations only; this never probes credentialed projects, accepts arbitrary URLs or sends account credentials.',
    input: objectInput(
      {
        dataset: { type: 'string', enum: ['mimic', 'eicu'] },
        directory: { type: 'string', enum: ['root', 'hosp', 'icu'], default: 'root' }
      },
      ['dataset']
    ),
    required: ['dataset'],
    exampleArgs: { dataset: 'mimic', directory: 'hosp' },
    returns:
      '{ source, source_url, retrieved_at, dataset, version, files: [{filename,url}], scope: "public_demo", full_data_authorized: false }. Empty/changed pages are errors, not evidence about full-data availability.',
    run: async (ctx, args) => {
      const mimic = args.dataset === 'mimic'
      if (!mimic && args.directory && args.directory !== 'root')
        throw new Error('eICU demo supports directory=root only')
      const base = mimic
        ? 'https://physionet.org/files/mimic-iv-demo/2.2/'
        : 'https://physionet.org/files/eicu-crd-demo/2.0/'
      const url =
        base + (args.directory && args.directory !== 'root' ? String(args.directory) + '/' : '')
      const files = officialFileLinks(
        await ctx.fetchText(url, 'text/html'),
        url,
        (link) =>
          link.hostname === 'physionet.org' &&
          link.href.startsWith(url) &&
          link.href !== url &&
          (link.pathname.endsWith('/') || /\.(?:csv(?:\.gz)?|txt|zip)$/i.test(link.pathname))
      )
      return {
        ...provenance(mimic ? 'MIMIC-IV demo' : 'eICU demo', url),
        dataset: args.dataset,
        version: mimic ? '2.2' : '2.0',
        files: files.map((file) => ({
          ...file,
          directory: new URL(file.url).pathname.endsWith('/')
        })),
        scope: 'public_demo',
        full_data_authorized: false
      }
    }
  },
  {
    id: 'list_faers_bulk_files',
    connector: 'drug-regulatory',
    credentialKeys: [],
    description:
      'Read the official openFDA drug/event bulk JSON partition manifest. Files remain at their official URLs; no file download, local job or analysis database is created. Reports are not incidence estimates.',
    input: objectInput({
      offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }
    }),
    exampleArgs: { offset: 0, limit: 5 },
    maxResponseBytes: 8_000_000,
    returns:
      '{ source, source_url, retrieved_at, total_files, returned_count, files, offset, next_offset }. Entries retain official size/record metadata. This is openFDA bulk JSON, not quarterly ASCII; deduplication and analysis are separate.',
    run: async (ctx, args) => {
      const url = 'https://api.fda.gov/download.json'
      const parsed = z
        .object({
          results: z.object({
            drug: z.object({ event: z.object({ partitions: z.array(partition) }) })
          })
        })
        .parse(await ctx.fetchJson(url))
      const files = parsed.results.drug.event.partitions
      for (const file of files) {
        const link = new URL(file.file)
        if (
          link.origin !== 'https://download.open.fda.gov' ||
          !link.pathname.startsWith('/drug/event/') ||
          link.username ||
          link.password ||
          link.search ||
          link.hash
        )
          throw new Error('Unexpected openFDA partition URL')
      }
      const offset = Number(args.offset ?? 0),
        limit = Number(args.limit ?? 20)
      const selected = files.slice(offset, offset + limit)
      return {
        ...provenance('openFDA drug/event', url),
        total_files: files.length,
        returned_count: selected.length,
        files: selected,
        offset,
        next_offset: offset + selected.length < files.length ? offset + selected.length : null
      }
    }
  },
  {
    id: 'list_ctd_reports',
    connector: 'ctd',
    credentialKeys: [],
    description:
      'Return a maintained subset of official CTD public report entry points and source terms. This static catalog does not verify live availability or provide CTD web queries. Use the official page to obtain files; stop if human verification is required.',
    input: objectInput({}),
    exampleArgs: {},
    returns:
      '{ source, source_url, retrieved_at, live_verified: false, catalog_scope, files: [{filename,url}], terms_url, note }. Links may change; preserve CTD citation/license headers when processing acquired files.',
    run: async () => ({
      ...provenance('CTD', 'https://ctdbase.org/downloads/'),
      live_verified: false,
      catalog_scope: 'maintained_subset',
      files: [
        'CTD_chemicals.tsv.gz',
        'CTD_genes.tsv.gz',
        'CTD_diseases.tsv.gz',
        'CTD_pathways.tsv.gz',
        'CTD_chem_gene_ixns.tsv.gz',
        'CTD_chemicals_diseases.tsv.gz',
        'CTD_genes_diseases.tsv.gz',
        'CTD_exposure_events.tsv.gz'
      ].map((filename) => ({ filename, url: 'https://ctdbase.org/reports/' + filename })),
      terms_url: 'https://ctdbase.org/about/legal.jsp',
      note: 'Listed links are not downloaded or verified by this method. Use official browser access on challenges; process acquired files with existing analysis workflows.'
    })
  }
]

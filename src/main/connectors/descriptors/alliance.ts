import type { ToolDescriptor } from '../../connector-core/types'

// Alliance of Genome Resources public site API. The read-only routes are available without
// authentication and cover model-organism gene, homology, disease, phenotype, allele and
// expression records that are not available from human-focused connectors. Expression uses
// a read-only POST query; the other tools use GET. Contract: https://www.alliancegenome.org/openapi
const ALLIANCE_API = 'https://www.alliancegenome.org/api'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_PAGE = 10_000

type Obj = Record<string, unknown>

const asObject = (value: unknown, labelName: string): Obj => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Alliance response missing an object for ${labelName}`)
  }
  return value as Obj
}
const asArray = (value: unknown, labelName: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Alliance response missing an array for ${labelName}`)
  return value
}
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const label = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Obj
    return text(item.displayText) ?? text(item.formatText) ?? text(item.name)
  }
  return null
}
const record = (value: unknown, labelName: string): Obj => asObject(value, labelName)

function geneId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  // Reject C0 controls and DEL in identifiers before constructing a request.
  // eslint-disable-next-line no-control-regex
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error('gene_id must be a non-empty Alliance identifier')
  }
  if (/^(FBgn|FBtr|FBpp|ZDB-GENE-)/u.test(id))
    return id.startsWith('ZDB-') ? `ZFIN:${id}` : `FB:${id}`
  if (/^WBGene/u.test(id)) return `WB:${id}`
  if (/^\d+$/u.test(id)) {
    throw new Error(
      'gene_id must include a database prefix for numeric identifiers, such as MGI:97490'
    )
  }
  return id
}
function identifier(value: unknown, field: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  // Reject C0 controls and DEL in identifiers before constructing a request.
  // eslint-disable-next-line no-control-regex
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error(`${field} must be a non-empty Alliance identifier`)
  }
  return id
}
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}
function pageArgs(args: Record<string, unknown>): { page: number; limit: number } {
  return {
    page: boundedInt(args.page, 1, 1, MAX_PAGE),
    limit: boundedInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  }
}
function pageQuery(args: Record<string, unknown>): string {
  const { page, limit } = pageArgs(args)
  return `limit=${limit}&page=${page}`
}
function pageEnvelope(raw: unknown, labelName: string): { total: number | null; results: Obj[] } {
  const payload = asObject(raw, labelName)
  if (Array.isArray(payload.errorMessages) && payload.errorMessages.length > 0) {
    throw new Error(`Alliance ${labelName} failed: ${payload.errorMessages.join('; ')}`)
  }
  // The search API omits results when total is zero. Missing rows otherwise signal schema drift.
  const rows = asArray(
    payload.results ?? payload.data ?? (payload.total === 0 ? [] : undefined),
    `${labelName}.results`
  ).map((item) => record(item, `${labelName}.result`))
  const total =
    typeof payload.total === 'number' && Number.isSafeInteger(payload.total) ? payload.total : null
  return { total, results: rows }
}
function geneSummary(raw: unknown): Obj {
  const payload = asObject(raw, 'gene')
  if (Array.isArray(payload.errorMessages) && payload.errorMessages.length > 0) {
    throw new Error(`Alliance gene failed: ${payload.errorMessages.join('; ')}`)
  }
  const gene = record('gene' in payload ? payload.gene : payload, 'gene')
  const id = text(gene.primaryExternalId) ?? text(gene.id)
  if (!id?.trim()) throw new Error('Alliance response missing a gene identifier')
  const taxon = record(gene.taxon ?? {}, 'gene.taxon')
  const locations = Array.isArray(gene.geneGenomicLocationAssociations)
    ? gene.geneGenomicLocationAssociations
    : Array.isArray(gene.genomeLocations)
      ? gene.genomeLocations
      : []
  const location = locations.length ? record(locations[0], 'gene genomic location') : {}
  const chromosome = record(location.geneGenomicLocationAssociationObject ?? {}, 'gene chromosome')
  const species =
    typeof taxon.species === 'string' ? {} : record(taxon.species ?? {}, 'gene species')
  const assembly = record(species.genomeAssembly ?? {}, 'gene assembly')
  const synonyms = Array.isArray(gene.geneSynonyms)
    ? gene.geneSynonyms
    : Array.isArray(gene.synonyms)
      ? gene.synonyms
      : []
  const crossReferences = Array.isArray(gene.crossReferences) ? gene.crossReferences : []
  return {
    id,
    symbol: label(gene.geneSymbol) ?? text(gene.symbol),
    name: label(gene.geneFullName) ?? text(gene.name),
    species: text(taxon.name) ?? label(taxon.species),
    taxon_id: text(taxon.curie) ?? text(taxon.taxonId),
    synopsis: text(gene.geneSynopsis),
    automated_synopsis: text(gene.automatedGeneSynopsis),
    synonyms: synonyms.map(label).filter((value): value is string => value !== null),
    gene_type: label(gene.geneType) ?? label(gene.soTerm),
    genomic_location: {
      chromosome: text(location.chromosome) ?? text(chromosome.name),
      start: location.start ?? null,
      end: location.end ?? null,
      assembly: text(location.assembly) ?? text(assembly.primaryExternalId),
      strand: location.strand ?? null
    },
    cross_references: crossReferences.map((item) => {
      const ref = record(item, 'gene cross-reference')
      return {
        name: text(ref.displayName) ?? text(ref.name),
        curie: text(ref.referencedCurie) ?? text(ref.curie),
        url: text(ref.crossRefCompleteUrl) ?? text(ref.url)
      }
    })
  }
}
function associationSummary(row: Obj): Obj {
  const subject = record(row.subject ?? row.gene ?? {}, 'association subject')
  const disease = record(row.disease ?? row.doTerm ?? row.object ?? {}, 'association disease')
  return {
    ...row,
    gene_id: text(subject.primaryExternalId) ?? text(subject.id),
    gene_symbol: label(subject.geneSymbol) ?? text(subject.symbol),
    disease_id: text(disease.curie) ?? text(disease.id),
    disease_name: label(disease.name) ?? text(disease.label) ?? text(row.diseaseModel),
    association_type: label(row.associationType) ?? label(row.relation),
    evidence: row.evidence ?? null
  }
}
function phenotypeSummary(row: Obj): Obj {
  const subject = record(row.subject ?? {}, 'phenotype subject')
  return {
    ...row,
    gene_id: text(subject.primaryExternalId) ?? text(subject.id),
    gene_symbol: label(subject.geneSymbol) ?? text(subject.symbol),
    phenotype_statement: text(row.phenotypeStatement) ?? text(row.description),
    phenotype: row.phenotype ?? row.phenotypeTerm ?? null
  }
}
function alleleSummary(row: Obj): Obj {
  const allele = record(row.allele ?? row, 'allele')
  const variants = asArray(row.variantList ?? row.variants ?? [], 'allele variants')
  return {
    ...row,
    id: text(allele.primaryExternalId) ?? text(allele.curie) ?? text(allele.id),
    symbol: label(allele.alleleSymbol) ?? text(allele.symbol),
    category: text(row.category),
    has_disease: row.hasDisease ?? null,
    has_phenotype: row.hasPhenotype ?? null,
    variants: variants.map((value) => {
      const variant = record(value, 'allele variant')
      return {
        id: text(variant.primaryExternalId) ?? text(variant.curie) ?? text(variant.id),
        name: text(variant.name),
        type: label(variant.variantType),
        location: variant.location ?? variant.curatedVariantGenomicLocations ?? null
      }
    })
  }
}
function expressionSummary(row: Obj): Obj {
  const annotation = record(row.geneExpressionAnnotation ?? row, 'expression annotation')
  const evidence =
    annotation.evidenceItem == null ? {} : record(annotation.evidenceItem, 'expression evidence')
  return {
    ...row,
    stage: text(annotation.whenExpressedStageName),
    location: text(annotation.whereExpressedStatement),
    data_provider:
      label(annotation.dataProvider) ??
      text(record(annotation.dataProvider ?? {}, 'expression data provider').abbreviation),
    reference: text(evidence.curie)
  }
}
const genePath = (args: Record<string, unknown>, suffix = ''): string =>
  `/gene/${encodeURIComponent(geneId(args.gene_id))}${suffix}`

export const ALLIANCE_TOOLS: ToolDescriptor[] = [
  {
    id: 'alliance_get_gene',
    connector: 'alliance',
    description:
      'Retrieve a model-organism or human gene summary from the Alliance of Genome Resources, including symbol, species, synopsis, genomic location and cross-references.',
    input: {
      type: 'object',
      properties: {
        gene_id: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['gene_id'],
      additionalProperties: false
    },
    required: ['gene_id'],
    returns:
      '{query_gene_id, gene:{id,symbol,name,species,taxon_id,synopsis,synonyms,gene_type,genomic_location,cross_references}}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_gene", {"gene_id": "MGI:97490"})',
    url: (args) => `${ALLIANCE_API}${genePath(args)}`,
    parse: (raw, args) => ({ query_gene_id: geneId(args.gene_id), gene: geneSummary(raw) })
  },
  {
    id: 'alliance_search_genes',
    connector: 'alliance',
    description:
      'Search Alliance genes across human and model-organism databases by symbol, name or identifier.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['query'],
      additionalProperties: false
    },
    required: ['query'],
    returns: '{query,page,limit,total,genes:[{id,symbol,name,species,...}],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_search_genes", {"query": "pax6", "limit": 10})',
    url: (args) => {
      const { page, limit } = pageArgs(args)
      const query = identifier(args.query, 'query')
      return `${ALLIANCE_API}/search?category=gene_search_result&q=${encodeURIComponent(query)}&limit=${limit}&offset=${(page - 1) * limit}`
    },
    parse: (raw, args) => {
      const page = pageArgs(args)
      const envelope = pageEnvelope(raw, 'gene search')
      return {
        query: String(args.query).trim(),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        genes: envelope.results.map((row) => ({
          ...row,
          id: text(row.curie) ?? text(row.primaryExternalId) ?? text(row.id),
          symbol: label(row.geneSymbol) ?? text(row.symbol),
          name: label(row.geneFullName) ?? text(row.name),
          species: label(row.taxon) ?? text(row.species)
        }))
      }
    }
  },
  {
    id: 'alliance_get_gene_orthologs',
    connector: 'alliance',
    description:
      'Retrieve cross-species orthologs for an Alliance gene, with orthology stringency and prediction methods.',
    input: {
      type: 'object',
      properties: {
        gene_id: { type: 'string', minLength: 1, maxLength: 200 },
        stringency: {
          type: 'string',
          enum: ['stringent', 'moderate', 'all'],
          default: 'stringent'
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['gene_id'],
      additionalProperties: false
    },
    required: ['gene_id'],
    returns: '{query_gene_id,stringency,page,limit,total,orthologs:[...],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_gene_orthologs", {"gene_id": "HGNC:8620", "stringency": "stringent"})',
    url: (args) =>
      `${ALLIANCE_API}${genePath(args, '/orthologs')}?${pageQuery(args)}&filter.stringency=${encodeURIComponent(String(args.stringency ?? 'stringent'))}`,
    parse: (raw, args) => {
      const page = pageArgs(args)
      const envelope = pageEnvelope(raw, 'orthology')
      return {
        query_gene_id: geneId(args.gene_id),
        stringency: String(args.stringency ?? 'stringent'),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        orthologs: envelope.results.map((row) => {
          const orthology = record(row.geneToGeneOrthologyGenerated ?? {}, 'orthology record')
          const gene = record(orthology.objectGene ?? row.objectGene ?? {}, 'ortholog gene')
          return {
            ...row,
            gene_id: text(gene.primaryExternalId) ?? text(gene.id),
            symbol: label(gene.geneSymbol) ?? text(gene.symbol),
            species: label(gene.taxon) ?? text(gene.species),
            stringency: text(row.stringencyFilter),
            methods: Array.isArray(orthology.predictionMethodsMatched)
              ? orthology.predictionMethodsMatched
                  .map(label)
                  .filter((value): value is string => value !== null)
              : []
          }
        })
      }
    }
  },
  {
    id: 'alliance_get_gene_disease_models',
    connector: 'alliance',
    description:
      'Retrieve disease associations and model-organism disease models involving an Alliance gene.',
    input: {
      type: 'object',
      properties: {
        gene_id: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['gene_id'],
      additionalProperties: false
    },
    required: ['gene_id'],
    returns:
      '{query_gene_id,page,limit,total,disease_models:[{model_id,model_name,diseases:[{disease_id,disease_name,association_type,...}],...}],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_gene_disease_models", {"gene_id": "MGI:97490"})',
    url: (args) => `${ALLIANCE_API}${genePath(args, '/models')}?${pageQuery(args)}`,
    parse: (raw, args) => {
      const page = pageArgs(args)
      const envelope = pageEnvelope(raw, 'gene disease models')
      return {
        query_gene_id: geneId(args.gene_id),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        disease_models: envelope.results.map((row) => {
          const model = record(row.model ?? {}, 'disease model')
          const diseases = Array.isArray(row.diseaseModels) ? row.diseaseModels : []
          return {
            ...row,
            model_id: text(model.primaryExternalId),
            model_name: label(model.agmFullName),
            diseases: diseases.map((item) =>
              associationSummary(record(item, 'disease model association'))
            )
          }
        })
      }
    }
  },
  {
    id: 'alliance_get_gene_phenotypes',
    connector: 'alliance',
    description: 'Retrieve phenotype annotations for a gene across Alliance model organisms.',
    input: {
      type: 'object',
      properties: {
        gene_id: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['gene_id'],
      additionalProperties: false
    },
    required: ['gene_id'],
    returns:
      '{query_gene_id,page,limit,total,phenotypes:[{gene_id,gene_symbol,phenotype_statement,...}],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_gene_phenotypes", {"gene_id": "HGNC:6081", "limit": 20})',
    url: (args) => `${ALLIANCE_API}${genePath(args, '/phenotypes')}?${pageQuery(args)}`,
    parse: (raw, args) => {
      const page = pageArgs(args)
      const envelope = pageEnvelope(raw, 'gene phenotypes')
      return {
        query_gene_id: geneId(args.gene_id),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        phenotypes: envelope.results.map(phenotypeSummary)
      }
    }
  },
  {
    id: 'alliance_get_gene_alleles',
    connector: 'alliance',
    description:
      'Retrieve alleles and variants associated with an Alliance gene, including disease and phenotype flags.',
    input: {
      type: 'object',
      properties: {
        gene_id: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['gene_id'],
      additionalProperties: false
    },
    required: ['gene_id'],
    returns:
      '{query_gene_id,page,limit,total,alleles:[{id,symbol,category,variants,...}],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_gene_alleles", {"gene_id": "MGI:97490"})',
    url: (args) => `${ALLIANCE_API}${genePath(args, '/alleles')}?${pageQuery(args)}`,
    parse: (raw, args) => {
      const page = pageArgs(args)
      const envelope = pageEnvelope(raw, 'gene alleles')
      return {
        query_gene_id: geneId(args.gene_id),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        alleles: envelope.results.map(alleleSummary)
      }
    }
  },
  {
    id: 'alliance_get_gene_expression',
    connector: 'alliance',
    description:
      'Retrieve expression annotations for an Alliance gene, including developmental stage, anatomical location, provider and evidence.',
    input: {
      type: 'object',
      properties: {
        gene_id: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['gene_id'],
      additionalProperties: false
    },
    required: ['gene_id'],
    returns:
      '{query_gene_id,page,limit,total,expression:[{stage,location,data_provider,reference,...}],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_gene_expression", {"gene_id": "ZFIN:ZDB-GENE-990415-8"})',
    run: async (ctx, args) => {
      const page = pageArgs(args)
      // This POST is a read-only query, with pagination applied by the server.
      const raw = await ctx.postJson(`${ALLIANCE_API}/expression?${pageQuery(args)}`, [
        geneId(args.gene_id)
      ])
      const envelope = pageEnvelope(raw, 'gene expression')
      return {
        query_gene_id: geneId(args.gene_id),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        expression: envelope.results.map(expressionSummary)
      }
    }
  },
  {
    id: 'alliance_get_disease_genes',
    connector: 'alliance',
    description:
      'Retrieve genes associated with a Disease Ontology term across Alliance human and model-organism data.',
    input: {
      type: 'object',
      properties: {
        disease_id: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 }
      },
      required: ['disease_id'],
      additionalProperties: false
    },
    required: ['disease_id'],
    returns:
      '{query_disease_id,page,limit,total,genes:[{gene_id,gene_symbol,disease_id,disease_name,...}],returned}',
    example:
      'const result = await host.mcp("alliance", "alliance_get_disease_genes", {"disease_id": "DOID:162", "limit": 20})',
    url: (args) =>
      `${ALLIANCE_API}/disease/${encodeURIComponent(identifier(args.disease_id, 'disease_id'))}/genes?${pageQuery(args)}`,
    parse: (raw, args) => {
      const page = pageArgs(args)
      const envelope = pageEnvelope(raw, 'disease genes')
      return {
        query_disease_id: identifier(args.disease_id, 'disease_id'),
        page: page.page,
        limit: page.limit,
        total: envelope.total,
        returned: envelope.results.length,
        genes: envelope.results.map(associationSummary)
      }
    }
  }
]

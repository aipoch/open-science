import type { ToolContext, ToolDescriptor } from '../types'

// UCSC Genome Browser public REST API. Track listings are large (hg38 ~17MB), so the flattened
// leaf-track list is cached per genome in a process-level Map (see TRACK_LIST_CACHE).
const BASE = 'https://api.genome.ucsc.edu'

// getData/track echoes its rows under a key equal to the track name, alongside meta fields; a
// truncated response carries maxItemsLimit + dataDownloadUrl. Wiggle rows are {chrom,start,end,value};
// bed-like rows are {chrom,chromStart,chromEnd,name,score,...}.
const CONSERVATION_MAX_SPAN = 100_000

// ---- small helpers --------------------------------------------------------------------------

// Reads an integer arg, applying a default when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// A raw UCSC track/config node: string config values mixed with nested child-track objects.
type RawNode = Record<string, unknown>

// True when a value looks like a nested track object (vs a scalar config field).
function isTrackObject(v: unknown): v is RawNode {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as RawNode
  return 'shortLabel' in o || 'longLabel' in o || 'type' in o
}

type LeafTrack = {
  track: string
  short_label: unknown
  long_label: unknown
  type: unknown
  group: unknown
  parent: unknown
}

// Recursively flattens a UCSC track map to leaf tracks only (nodes with no nested track children —
// the queryable ones). The track name is the map key; composite containers are descended into.
function flattenLeafTracks(map: RawNode, out: LeafTrack[]): void {
  for (const [name, node] of Object.entries(map)) {
    if (!isTrackObject(node)) continue
    const children: RawNode = {}
    for (const [k, v] of Object.entries(node)) {
      if (isTrackObject(v)) children[k] = v as RawNode
    }
    if (Object.keys(children).length > 0) {
      flattenLeafTracks(children, out)
    } else {
      out.push({
        track: name,
        short_label: node.shortLabel,
        long_label: node.longLabel,
        type: node.type,
        group: node.group,
        parent: node.parent
      })
    }
  }
}

// Process-level cache of the flattened leaf-track list, keyed by genome (first call per genome
// downloads the full listing). Module-level so it survives across calls but never affects ordering.
const TRACK_LIST_CACHE = new Map<string, LeafTrack[]>()

// Fetches (or returns cached) the flattened leaf-track list for a genome.
async function getLeafTracks(ctx: ToolContext, genome: string): Promise<LeafTrack[]> {
  const cached = TRACK_LIST_CACHE.get(genome)
  if (cached) return cached
  const raw = (await ctx.fetchJson(`${BASE}/list/tracks?genome=${genome}`)) as RawNode
  const genomeMap = raw[genome]
  const leaves: LeafTrack[] = []
  if (isTrackObject(genomeMap) || (typeof genomeMap === 'object' && genomeMap !== null)) {
    flattenLeafTracks(genomeMap as RawNode, leaves)
  }
  TRACK_LIST_CACHE.set(genome, leaves)
  return leaves
}

// getData/track response shape (only the fields we read).
type GetDataResponse = {
  trackType?: string
  maxItemsLimit?: boolean | string
  dataDownloadUrl?: string
  itemsReturned?: number
} & Record<string, unknown>

// GET one region of a track. maxItems maps to the API's maxItemsOutput; the engine throws on the
// upstream 400 for an unknown track ("can not find track").
async function fetchTrackData(
  ctx: ToolContext,
  genome: string,
  track: string,
  chrom: string,
  start: number,
  end: number,
  maxItems: number
): Promise<GetDataResponse> {
  const url =
    `${BASE}/getData/track?genome=${genome};track=${track};chrom=${chrom};` +
    `start=${start};end=${end};maxItemsOutput=${maxItems}`
  return (await ctx.fetchJson(url)) as GetDataResponse
}

// Extracts the row array a getData response nests under its track-name key (empty when none).
function extractRows(resp: GetDataResponse, track: string): Record<string, unknown>[] {
  const direct = resp[track]
  if (Array.isArray(direct)) return direct as Record<string, unknown>[]
  for (const v of Object.values(resp)) {
    if (Array.isArray(v)) return v as Record<string, unknown>[]
  }
  return []
}

// True when the API flagged its own output cap on this response.
function isUpstreamTruncated(resp: GetDataResponse): boolean {
  return resp.maxItemsLimit === true || resp.maxItemsLimit === 'true'
}

// ---- the 5 tools ----------------------------------------------------------------------------

export const GENOMES_UCSC_TOOLS: ToolDescriptor[] = [
  {
    id: 'ucsc_list_tracks',
    connector: 'genomes',
    description:
      'List data tracks available in a UCSC Genome Browser assembly (leaf tracks only — the queryable ones), optionally filtered. Args: genome (hg38 default/hg19/mm39/danRer11/... ~220 assemblies); filter_text (case-insensitive substring over name/short/long label, e.g. phyloP, TFBS, ClinVar; omit to list everything — hg38 has ~24k leaf tracks, you almost always want a filter); max_tracks (row cap default 200; n_total carries the full match count, tracks_truncated flags the cap). Returns {genome, filter_text, n_total, tracks_truncated, tracks} sorted by track name; each row {track, short_label, long_label, type, group, parent}. Use `track` with ucsc_track_data. Quirk: first call per genome downloads the full ~17MB listing and caches it for the process.',
    input: {
      type: 'object',
      properties: {
        genome: { type: 'string', default: 'hg38' },
        filter_text: { type: 'string' },
        max_tracks: { type: 'integer', default: 200 }
      }
    },
    returns:
      '{genome, filter_text, n_total, tracks_truncated, tracks:[{track, short_label, long_label, type, group, parent}]} — leaf tracks only, sorted by track name; n_total is the full match count, tracks_truncated flags the max_tracks cap.',
    example:
      'const result = await host.mcp("genomes", "ucsc_list_tracks", {"genome": "hg38", "filter_text": "phyloP", "max_tracks": 50})',
    run: async (ctx, a) => {
      const genome = a.genome != null && String(a.genome).trim() !== '' ? String(a.genome) : 'hg38'
      const filterText = a.filter_text != null ? String(a.filter_text) : ''
      const maxTracks = clampInt(a.max_tracks, 200, 1, 100_000)

      const leaves = await getLeafTracks(ctx, genome)
      const needle = filterText.toLowerCase()
      const matched = needle
        ? leaves.filter((t) => {
            const hay =
              `${t.track} ${String(t.short_label ?? '')} ${String(t.long_label ?? '')}`.toLowerCase()
            return hay.includes(needle)
          })
        : leaves.slice()
      matched.sort((x, y) => x.track.localeCompare(y.track))
      const nTotal = matched.length
      const tracks = matched.slice(0, maxTracks)
      return {
        genome,
        filter_text: filterText || null,
        n_total: nTotal,
        tracks_truncated: nTotal > tracks.length,
        tracks
      }
    }
  },
  {
    id: 'ucsc_track_data',
    connector: 'genomes',
    description:
      "Fetch raw rows of any UCSC Genome Browser track in a region — the generic escape hatch behind ucsc_conservation / ucsc_tfbs_clusters (gene tracks, ClinVar, GWAS catalog, CpG islands, repeats, ...). Args: track (name from ucsc_list_tracks, e.g. knownGene, cpgIslandExt, clinvarMain); chrom (chr-prefixed, chr7/chrX — UCSC requires the prefix); start (0-based half-open; an Ensembl 1-based start is start-1 here); end (exclusive); genome (default hg38); max_rows (API maxItemsOutput, default 1000; truncated reflects the API's own maxItemsLimit flag). Returns {genome, track, chrom, start, end, track_type, items_returned, truncated, rows} — rows in upstream shape (BED-like {chrom, chromStart, chromEnd, name, score, ...}; wiggle {start, end, value}). Unknown tracks raise. Quirk: for some huge tracks the API caps output itself and points at dataDownloadUrl — echoed when present.",
    input: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        chrom: { type: 'string' },
        start: { type: 'integer' },
        end: { type: 'integer' },
        genome: { type: 'string', default: 'hg38' },
        max_rows: { type: 'integer', default: 1000 }
      },
      required: ['track', 'chrom', 'start', 'end']
    },
    required: ['track', 'chrom', 'start', 'end'],
    returns:
      '{genome, track, chrom, start, end, track_type, items_returned, truncated, rows, dataDownloadUrl?} — rows in the upstream shape; truncated reflects the API maxItemsLimit flag; dataDownloadUrl echoed when the API caps a huge track itself.',
    example:
      'const result = await host.mcp("genomes", "ucsc_track_data", {"track": "cpgIslandExt", "chrom": "chr7", "start": 140700000, "end": 140800000, "genome": "hg38"})',
    run: async (ctx, a) => {
      const genome = a.genome != null && String(a.genome).trim() !== '' ? String(a.genome) : 'hg38'
      const track = String(a.track)
      const chrom = String(a.chrom)
      const start = clampInt(a.start, 0, 0, Number.MAX_SAFE_INTEGER)
      const end = clampInt(a.end, 0, 0, Number.MAX_SAFE_INTEGER)
      const maxRows = clampInt(a.max_rows, 1000, 1, 1_000_000)

      const resp = await fetchTrackData(ctx, genome, track, chrom, start, end, maxRows)
      const rows = extractRows(resp, track)
      return {
        genome,
        track,
        chrom,
        start,
        end,
        track_type: resp.trackType ?? null,
        items_returned: rows.length,
        truncated: isUpstreamTruncated(resp),
        rows,
        ...(resp.dataDownloadUrl ? { dataDownloadUrl: resp.dataDownloadUrl } : {})
      }
    }
  },
  {
    id: 'ucsc_conservation',
    connector: 'genomes',
    description:
      "Evolutionary conservation summary for a region from UCSC phyloP / phastCons tracks (base-wise scores over multi-species alignments). Args: chrom (chr-prefixed); start (0-based half-open); end (exclusive; span capped at 100000 bp — split larger); genome (default hg38); track (default phyloP100way; positive=conserved, negative=fast-evolving; alternatives hg38 phastCons100way, phyloP30way, phastCons30way, phyloP447way, phyloP470way; hg19 phyloP100wayAll/phastCons100way); include_values (also return per-base {start,end,value} rows capped at max_values, values_truncated flags the cap; default false = summary only); max_values (per-base cap default 2000). Returns {genome, track, chrom, start, end, span_bp, n_bases_covered, coverage_fraction, mean, min, max} (+values, values_truncated when requested). Stats weighted by each row's base span, clipped to window; uncovered bases lower coverage_fraction, not zero-scored. Non-score tracks raise; an upstream-truncated row list also raises.",
    input: {
      type: 'object',
      properties: {
        chrom: { type: 'string' },
        start: { type: 'integer' },
        end: { type: 'integer' },
        genome: { type: 'string', default: 'hg38' },
        track: { type: 'string', default: 'phyloP100way' },
        include_values: { type: 'boolean', default: false },
        max_values: { type: 'integer', default: 2000 }
      },
      required: ['chrom', 'start', 'end']
    },
    required: ['chrom', 'start', 'end'],
    returns:
      '{genome, track, chrom, start, end, span_bp, n_bases_covered, coverage_fraction, mean, min, max, values?, values_truncated?} — stats are base-span-weighted and clipped to the window; uncovered bases lower coverage_fraction rather than count as zero.',
    example:
      'const result = await host.mcp("genomes", "ucsc_conservation", {"chrom": "chr7", "start": 140753330, "end": 140753380, "track": "phyloP100way"})',
    run: async (ctx, a) => {
      const genome = a.genome != null && String(a.genome).trim() !== '' ? String(a.genome) : 'hg38'
      const track =
        a.track != null && String(a.track).trim() !== '' ? String(a.track) : 'phyloP100way'
      const chrom = String(a.chrom)
      const start = clampInt(a.start, 0, 0, Number.MAX_SAFE_INTEGER)
      const end = clampInt(a.end, 0, 0, Number.MAX_SAFE_INTEGER)
      const includeValues = a.include_values === true
      const maxValues = clampInt(a.max_values, 2000, 1, 1_000_000)

      const spanBp = end - start
      if (spanBp > CONSERVATION_MAX_SPAN) {
        throw new Error(
          `ucsc_conservation span ${spanBp} bp exceeds the ${CONSERVATION_MAX_SPAN} bp cap — split the region.`
        )
      }

      // Request one row beyond the window so an upstream cap is detectable rather than silent.
      const resp = await fetchTrackData(ctx, genome, track, chrom, start, end, 1_000_000)
      if (isUpstreamTruncated(resp)) {
        throw new Error(
          `ucsc_conservation: upstream truncated the ${track} rows for this region — narrow the span.`
        )
      }
      const rows = extractRows(resp, track)

      // A score track's rows carry a numeric `value`; anything else is a BED-like track.
      if (rows.length > 0 && typeof rows[0].value !== 'number') {
        throw new Error(
          `Track '${track}' is not a score/wiggle track — use ucsc_track_data for BED-like tracks.`
        )
      }

      // Base-span-weighted stats, each row clipped to [start, end).
      let weightedSum = 0
      let covered = 0
      let minV: number | null = null
      let maxV: number | null = null
      const values: { start: number; end: number; value: number }[] = []
      for (const r of rows) {
        const value = r.value as number
        const rStart = Number(r.start)
        const rEnd = Number(r.end)
        if (!Number.isFinite(rStart) || !Number.isFinite(rEnd)) continue
        const clipStart = Math.max(rStart, start)
        const clipEnd = Math.min(rEnd, end)
        const span = clipEnd - clipStart
        if (span <= 0) continue
        weightedSum += value * span
        covered += span
        minV = minV === null ? value : Math.min(minV, value)
        maxV = maxV === null ? value : Math.max(maxV, value)
        if (includeValues && values.length < maxValues) {
          values.push({ start: rStart, end: rEnd, value })
        }
      }
      const mean = covered > 0 ? weightedSum / covered : null
      const nRowsInWindow = rows.filter((r) => {
        const rStart = Number(r.start)
        const rEnd = Number(r.end)
        return (
          Number.isFinite(rStart) &&
          Number.isFinite(rEnd) &&
          Math.min(rEnd, end) - Math.max(rStart, start) > 0
        )
      }).length

      return {
        genome,
        track,
        chrom,
        start,
        end,
        span_bp: spanBp,
        n_bases_covered: covered,
        coverage_fraction: spanBp > 0 ? covered / spanBp : 0,
        mean,
        min: minV,
        max: maxV,
        ...(includeValues ? { values, values_truncated: nRowsInWindow > values.length } : {})
      }
    }
  },
  {
    id: 'ucsc_tfbs_clusters',
    connector: 'genomes',
    description:
      'ENCODE transcription-factor binding site clusters overlapping a region (ChIP-seq peak clusters across hundreds of cell types) — which TFs bind where. Args: chrom (chr-prefixed); start (0-based half-open); end (exclusive); genome (hg38 default track encRegTfbsClustered ENCODE 3, or hg19 wgEncodeRegTfbsClusteredV3; other assemblies raise); max_rows (API maxItemsOutput default 1000; truncated reflects maxItemsLimit). Returns {genome, track, chrom, start, end, items_returned, truncated, n_factors, factors, clusters} — clusters sorted by (chromStart,name) {name (TF symbol e.g. CTCF), chrom, chromStart, chromEnd, score (0-1000), sourceCount (supporting experiments)}; factors is the distinct TF list. Score>=~600 and high sourceCount ~ robust binding.',
    input: {
      type: 'object',
      properties: {
        chrom: { type: 'string' },
        start: { type: 'integer' },
        end: { type: 'integer' },
        genome: { type: 'string', default: 'hg38' },
        max_rows: { type: 'integer', default: 1000 }
      },
      required: ['chrom', 'start', 'end']
    },
    required: ['chrom', 'start', 'end'],
    returns:
      '{genome, track, chrom, start, end, items_returned, truncated, n_factors, factors:[...], clusters:[{name, chrom, chromStart, chromEnd, score, sourceCount}]} — clusters sorted by (chromStart,name); factors is the distinct TF list.',
    example:
      'const result = await host.mcp("genomes", "ucsc_tfbs_clusters", {"chrom": "chr7", "start": 140699000, "end": 140760000, "genome": "hg38"})',
    run: async (ctx, a) => {
      const genome = a.genome != null && String(a.genome).trim() !== '' ? String(a.genome) : 'hg38'
      const chrom = String(a.chrom)
      const start = clampInt(a.start, 0, 0, Number.MAX_SAFE_INTEGER)
      const end = clampInt(a.end, 0, 0, Number.MAX_SAFE_INTEGER)
      const maxRows = clampInt(a.max_rows, 1000, 1, 1_000_000)

      // ENCODE TFBS-cluster track name differs by assembly; only hg38/hg19 publish one.
      const track =
        genome === 'hg38'
          ? 'encRegTfbsClustered'
          : genome === 'hg19'
            ? 'wgEncodeRegTfbsClusteredV3'
            : null
      if (!track) {
        throw new Error(
          `ucsc_tfbs_clusters: no ENCODE TFBS-cluster track for genome '${genome}' (only hg38/hg19).`
        )
      }

      const resp = await fetchTrackData(ctx, genome, track, chrom, start, end, maxRows)
      const rows = extractRows(resp, track)
      const clusters = rows
        .map((r) => ({
          name: r.name,
          chrom: r.chrom,
          chromStart: r.chromStart,
          chromEnd: r.chromEnd,
          score: r.score,
          sourceCount: r.sourceCount
        }))
        .sort((x, y) => {
          const ds = Number(x.chromStart) - Number(y.chromStart)
          return ds !== 0 ? ds : String(x.name ?? '').localeCompare(String(y.name ?? ''))
        })
      const factors = Array.from(
        new Set(clusters.map((c) => c.name).filter((n): n is string => typeof n === 'string'))
      ).sort((x, y) => x.localeCompare(y))
      return {
        genome,
        track,
        chrom,
        start,
        end,
        items_returned: clusters.length,
        truncated: isUpstreamTruncated(resp),
        n_factors: factors.length,
        factors,
        clusters
      }
    }
  },
  {
    id: 'ucsc_chrom_sizes',
    connector: 'genomes',
    description:
      'Chromosome/contig names and sizes of a UCSC assembly — for validating coordinates and iterating regions. Args: genome (default hg38); filter_text (case-insensitive substring on the name, e.g. chr1; omit for all — hg38 has 711 sequences, mostly alt/random/unplaced; primary chromosomes sort first); max_chroms (row cap default 100; n_total carries the full post-filter count, chroms_truncated flags the cap). Returns {genome, filter_text, chrom_count (assembly-wide from the API), n_total, chroms_truncated, chromosomes:[{name, size_bp}]} sorted by size descending.',
    input: {
      type: 'object',
      properties: {
        genome: { type: 'string', default: 'hg38' },
        filter_text: { type: 'string' },
        max_chroms: { type: 'integer', default: 100 }
      }
    },
    returns:
      '{genome, filter_text, chrom_count, n_total, chroms_truncated, chromosomes:[{name, size_bp}]} — chrom_count is the assembly-wide total from the API; n_total is the post-filter count; sorted by size descending.',
    example:
      'const result = await host.mcp("genomes", "ucsc_chrom_sizes", {"genome": "hg38", "filter_text": "chr1", "max_chroms": 25})',
    run: async (ctx, a) => {
      const genome = a.genome != null && String(a.genome).trim() !== '' ? String(a.genome) : 'hg38'
      const filterText = a.filter_text != null ? String(a.filter_text) : ''
      const maxChroms = clampInt(a.max_chroms, 100, 1, 100_000)

      const raw = (await ctx.fetchJson(`${BASE}/list/chromosomes?genome=${genome}`)) as {
        chromCount?: number
        chromosomes?: Record<string, number>
      }
      const all = Object.entries(raw.chromosomes ?? {}).map(([name, size]) => ({
        name,
        size_bp: Number(size)
      }))
      const needle = filterText.toLowerCase()
      const matched = needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all
      matched.sort((x, y) => y.size_bp - x.size_bp)
      const nTotal = matched.length
      const chromosomes = matched.slice(0, maxChroms)
      return {
        genome,
        filter_text: filterText || null,
        chrom_count: raw.chromCount ?? all.length,
        n_total: nTotal,
        chroms_truncated: nTotal > chromosomes.length,
        chromosomes
      }
    }
  }
]

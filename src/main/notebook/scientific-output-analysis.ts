import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import type {
  NotebookScientificOutput,
  NotebookScientificOutputRisk,
  NotebookScientificOutputStorageShape
} from '../../shared/notebook'

// This is deliberately advisory structural analysis. It groups only strong local path/layout
// signatures and never opens, parses, deserializes, checkpoints, or otherwise mutates user output.

type ScientificOutputRelation = {
  relation: 'created' | 'modified' | 'deleted'
  relativePath: string
}

type OutputGroup = {
  key: string
  storageShape: NotebookScientificOutputStorageShape
  formatHint?: string
  members: ScientificOutputRelation[]
  riskCodes?: NotebookScientificOutputRisk[]
}

const MULTI_FILE_RISK: NotebookScientificOutputRisk = 'multi-file-consistency-not-verified'
const FORMAT_RISK: NotebookScientificOutputRisk = 'format-validity-not-verified'
const DATABASE_RISK: NotebookScientificOutputRisk = 'database-state-not-verified'
const RUNTIME_RISK: NotebookScientificOutputRisk = 'runtime-dependent-serialization'

const lower = (value: string): string => value.toLocaleLowerCase('en-US')
const uniqueSorted = <Value extends string>(values: readonly Value[]): Value[] =>
  [...new Set(values)].sort()
const isWithin = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}/`)
const withoutCompoundSuffix = (value: string, suffix: string): string =>
  value.slice(0, value.length - suffix.length)

const formatForPath = (
  relativePath: string
): { formatHint?: string; riskCodes: NotebookScientificOutputRisk[] } => {
  const path = lower(relativePath)
  const extension = posix.extname(path)
  if (
    ['.csv.gz', '.csv.bz2', '.csv.xz', '.tsv.gz', '.tsv.bz2', '.tsv.xz', '.txt.gz'].some((suffix) =>
      path.endsWith(suffix)
    )
  ) {
    return { formatHint: 'text-data', riskCodes: [FORMAT_RISK] }
  }
  if (['.csv', '.tsv', '.txt', '.json', '.jsonl', '.ndjson'].includes(extension)) {
    return { formatHint: 'text-data', riskCodes: [FORMAT_RISK] }
  }
  if (['.xlsx', '.xls', '.ods'].includes(extension)) {
    return { formatHint: 'spreadsheet', riskCodes: [FORMAT_RISK] }
  }
  if (extension === '.parquet') return { formatHint: 'parquet', riskCodes: [FORMAT_RISK] }
  if (['.arrow', '.feather', '.ipc'].includes(extension)) {
    return { formatHint: 'arrow-ipc', riskCodes: [FORMAT_RISK] }
  }
  if (extension === '.fst') return { formatHint: 'fst', riskCodes: [FORMAT_RISK] }
  if (['.npy', '.npz'].includes(extension)) {
    return { formatHint: 'numpy-array', riskCodes: [FORMAT_RISK, RUNTIME_RISK] }
  }
  if (['.h5', '.hdf5', '.hdf'].includes(extension)) {
    return { formatHint: 'hdf5', riskCodes: [FORMAT_RISK] }
  }
  if (['.nc', '.nc4', '.cdf'].includes(extension)) {
    return { formatHint: 'netcdf', riskCodes: [FORMAT_RISK] }
  }
  if (['.rds', '.rda', '.rdata', '.qs'].includes(extension)) {
    return { formatHint: 'r-serialization', riskCodes: [FORMAT_RISK, RUNTIME_RISK] }
  }
  if (['.pkl', '.pickle', '.joblib'].includes(extension)) {
    return { formatHint: 'python-serialization', riskCodes: [FORMAT_RISK, RUNTIME_RISK] }
  }
  if (['.sqlite', '.sqlite3', '.db', '.duckdb'].includes(extension)) {
    return { formatHint: 'database', riskCodes: [FORMAT_RISK, DATABASE_RISK] }
  }
  if (extension === '.gpkg') {
    return { formatHint: 'geopackage', riskCodes: [FORMAT_RISK, DATABASE_RISK] }
  }
  if (['.shp', '.shx', '.dbf'].includes(extension)) {
    return { formatHint: 'shapefile', riskCodes: [FORMAT_RISK, MULTI_FILE_RISK] }
  }
  if (['.tif', '.tiff', '.geotiff'].includes(extension)) {
    return { formatHint: 'geotiff', riskCodes: [FORMAT_RISK] }
  }
  if (['.geojson', '.fgb', '.kml', '.kmz', '.las', '.laz'].includes(extension)) {
    return { formatHint: 'geospatial-data', riskCodes: [FORMAT_RISK] }
  }
  if (['.sav', '.por', '.dta', '.sas7bdat', '.xpt'].includes(extension)) {
    return { formatHint: 'statistical-data', riskCodes: [FORMAT_RISK] }
  }
  if (['.mat', '.mtx'].includes(extension)) {
    return { formatHint: 'scientific-matrix', riskCodes: [FORMAT_RISK] }
  }
  if (['.h5ad', '.h5mu', '.loom'].includes(extension)) {
    return { formatHint: 'single-cell-data', riskCodes: [FORMAT_RISK, RUNTIME_RISK] }
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(extension)) {
    return { formatHint: 'image', riskCodes: [FORMAT_RISK] }
  }
  if (extension === '.pdf') return { formatHint: 'pdf', riskCodes: [FORMAT_RISK] }
  if (['.html', '.htm'].includes(extension)) {
    return { formatHint: 'html', riskCodes: [FORMAT_RISK] }
  }
  if (['.pt', '.pth', '.ckpt', '.safetensors', '.keras', '.onnx'].includes(extension)) {
    return { formatHint: 'model-checkpoint', riskCodes: [FORMAT_RISK, RUNTIME_RISK] }
  }
  if (extension === '.ipynb') return { formatHint: 'notebook', riskCodes: [FORMAT_RISK] }
  return { riskCodes: [FORMAT_RISK] }
}

const datasetRootFor = (path: string): string => {
  const directories = posix.dirname(path).split('/')
  const partitionIndex = directories.findIndex(
    (segment, index) => index > 0 && segment.includes('=')
  )
  return (partitionIndex < 0 ? directories : directories.slice(0, partitionIndex)).join('/')
}

const outputIdFor = (namespace: string, group: OutputGroup): string =>
  `scientific-output-${createHash('sha256')
    .update(
      JSON.stringify([
        namespace,
        group.storageShape,
        group.formatHint ?? null,
        group.members.map((member) => [member.relation, member.relativePath]).sort()
      ])
    )
    .digest('hex')
    .slice(0, 24)}`

const analyzeScientificOutputs = (
  relations: readonly ScientificOutputRelation[],
  namespace: string
): NotebookScientificOutput[] => {
  const candidates = relations
    .filter((relation) => relation.relativePath.length > 0)
    .map((relation) => ({ ...relation, relativePath: relation.relativePath.replaceAll('\\', '/') }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const activePaths = new Set(
    candidates
      .filter((candidate) => candidate.relation !== 'deleted')
      .map((candidate) => candidate.relativePath)
  )
  const assigned = new Set<string>()
  const groups: OutputGroup[] = []

  const addGroup = (
    group: Omit<OutputGroup, 'members'>,
    predicate: (path: string) => boolean
  ): void => {
    const members = candidates.filter(
      (candidate) => !assigned.has(candidate.relativePath) && predicate(candidate.relativePath)
    )
    if (members.length === 0 || !members.some((member) => activePaths.has(member.relativePath)))
      return
    for (const member of members) assigned.add(member.relativePath)
    groups.push({ ...group, members })
  }

  const zarrRoots = uniqueSorted(
    candidates.flatMap((candidate) => {
      const segments = candidate.relativePath.split('/')
      const index = segments.findIndex((segment) => lower(segment).endsWith('.zarr'))
      return index < 0 ? [] : [segments.slice(0, index + 1).join('/')]
    })
  )
  for (const root of zarrRoots) {
    addGroup(
      {
        key: `zarr:${root}`,
        storageShape: 'directory-tree',
        formatHint: 'zarr',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK]
      },
      (path) => isWithin(root, path)
    )
  }

  const savedModelRoots = uniqueSorted(
    candidates.flatMap((candidate) =>
      ['saved_model.pb', 'saved_model.pbtxt'].includes(
        lower(posix.basename(candidate.relativePath))
      )
        ? [posix.dirname(candidate.relativePath)]
        : []
    )
  )
  for (const root of savedModelRoots) {
    addGroup(
      {
        key: `saved-model:${root}`,
        storageShape: 'directory-tree',
        formatHint: 'tensorflow-saved-model',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK, RUNTIME_RISK]
      },
      (path) => isWithin(root, path)
    )
  }

  const indexedModelRoots = uniqueSorted(
    candidates.flatMap((candidate) =>
      lower(posix.basename(candidate.relativePath)).endsWith('.index.json')
        ? [posix.dirname(candidate.relativePath)]
        : []
    )
  )
  for (const root of indexedModelRoots) {
    addGroup(
      {
        key: `indexed-model:${root}`,
        storageShape: 'directory-tree',
        formatHint: 'sharded-model',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK, RUNTIME_RISK]
      },
      (path) => isWithin(root, path)
    )
  }

  const modelDirectoryRoots = uniqueSorted(
    candidates.flatMap((candidate) => {
      const basename = lower(posix.basename(candidate.relativePath))
      if (!['model.safetensors', 'pytorch_model.bin'].includes(basename)) return []
      const root = posix.dirname(candidate.relativePath)
      return candidates.some(
        (other) =>
          posix.dirname(other.relativePath) === root &&
          lower(posix.basename(other.relativePath)) === 'config.json'
      )
        ? [root]
        : []
    })
  )
  for (const root of modelDirectoryRoots) {
    addGroup(
      {
        key: `model-directory:${root}`,
        storageShape: 'directory-tree',
        formatHint: 'model-directory',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK, RUNTIME_RISK]
      },
      (path) => isWithin(root, path)
    )
  }

  const databaseRoots = uniqueSorted(
    candidates.flatMap((candidate) => {
      const path = lower(candidate.relativePath)
      for (const suffix of ['-journal', '-wal', '-shm']) {
        if (path.endsWith(suffix)) return [candidate.relativePath.slice(0, -suffix.length)]
      }
      return []
    })
  )
  for (const root of databaseRoots) {
    addGroup(
      {
        key: `database:${root}`,
        storageShape: 'file-set',
        formatHint: lower(root).endsWith('.duckdb') ? 'duckdb' : 'sqlite',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK, DATABASE_RISK]
      },
      (path) =>
        path === root || ['-journal', '-wal', '-shm'].some((suffix) => path === `${root}${suffix}`)
    )
  }

  const shapefileExtensions = new Set([
    '.shp',
    '.shx',
    '.dbf',
    '.prj',
    '.cpg',
    '.sbn',
    '.sbx',
    '.qix',
    '.fix'
  ])
  const shapefileRoots = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    const path = lower(candidate.relativePath)
    const root = path.endsWith('.shp.xml')
      ? withoutCompoundSuffix(candidate.relativePath, '.shp.xml')
      : shapefileExtensions.has(posix.extname(path))
        ? candidate.relativePath.slice(0, -posix.extname(path).length)
        : undefined
    if (!root) continue
    const paths = shapefileRoots.get(root) ?? new Set<string>()
    paths.add(candidate.relativePath)
    shapefileRoots.set(root, paths)
  }
  for (const [root, paths] of [...shapefileRoots].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (![...paths].some((path) => lower(path).endsWith('.shp'))) continue
    addGroup(
      {
        key: `shapefile:${root}`,
        storageShape: 'file-set',
        formatHint: 'shapefile',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK]
      },
      (path) => paths.has(path)
    )
  }

  const rasterRoots = uniqueSorted(
    candidates.flatMap((candidate) => {
      const path = lower(candidate.relativePath)
      if (path.endsWith('.tif') || path.endsWith('.tiff')) return [candidate.relativePath]
      if (path.endsWith('.tif.aux.xml') || path.endsWith('.tif.ovr')) {
        return [candidate.relativePath.replace(/\.(?:aux\.xml|ovr)$/iu, '')]
      }
      if (path.endsWith('.tiff.aux.xml') || path.endsWith('.tiff.ovr')) {
        return [candidate.relativePath.replace(/\.(?:aux\.xml|ovr)$/iu, '')]
      }
      return []
    })
  )
  for (const root of rasterRoots) {
    const stem = root.replace(/\.tiff?$/iu, '')
    const memberPaths = candidates
      .map((candidate) => candidate.relativePath)
      .filter(
        (path) =>
          path === root ||
          path === `${root}.aux.xml` ||
          path === `${root}.ovr` ||
          path === `${stem}.tfw` ||
          path === `${stem}.tifw` ||
          path === `${stem}.prj`
      )
    if (memberPaths.length < 2 || !memberPaths.includes(root)) continue
    addGroup(
      {
        key: `geotiff:${root}`,
        storageShape: 'file-set',
        formatHint: 'geotiff-with-sidecars',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK]
      },
      (path) => memberPaths.includes(path)
    )
  }

  const tenXDirectories = uniqueSorted(
    candidates.flatMap((candidate) => {
      const basename = lower(posix.basename(candidate.relativePath))
      return ['matrix.mtx', 'matrix.mtx.gz'].includes(basename)
        ? [posix.dirname(candidate.relativePath)]
        : []
    })
  )
  for (const root of tenXDirectories) {
    const companionNames = new Set([
      'matrix.mtx',
      'matrix.mtx.gz',
      'barcodes.tsv',
      'barcodes.tsv.gz',
      'features.tsv',
      'features.tsv.gz',
      'genes.tsv',
      'genes.tsv.gz'
    ])
    const members = candidates.filter(
      (candidate) =>
        posix.dirname(candidate.relativePath) === root &&
        companionNames.has(lower(posix.basename(candidate.relativePath)))
    )
    addGroup(
      {
        key: `10x-matrix:${root}`,
        storageShape: 'file-set',
        formatHint: '10x-matrix',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK]
      },
      (path) => members.some((member) => member.relativePath === path)
    )
  }

  const checkpointRoots = uniqueSorted(
    candidates.flatMap((candidate) => {
      const path = candidate.relativePath
      if (lower(path).endsWith('.index')) return [path.slice(0, -'.index'.length)]
      const match = /^(.*)\.data-\d+-of-\d+$/iu.exec(path)
      return match ? [match[1]!] : []
    })
  )
  for (const root of checkpointRoots) {
    addGroup(
      {
        key: `checkpoint:${root}`,
        storageShape: 'file-set',
        formatHint: 'tensorflow-checkpoint',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK, RUNTIME_RISK]
      },
      (path) =>
        path === `${root}.index` ||
        new RegExp(
          `^${root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.data-\\d+-of-\\d+$`,
          'iu'
        ).test(path)
    )
  }

  const htmlPaths = candidates.filter((candidate) =>
    ['.html', '.htm'].includes(posix.extname(lower(candidate.relativePath)))
  )
  for (const html of htmlPaths) {
    const extension = posix.extname(html.relativePath)
    const assetRoot = `${html.relativePath.slice(0, -extension.length)}_files`
    if (!candidates.some((candidate) => isWithin(assetRoot, candidate.relativePath))) continue
    addGroup(
      {
        key: `html-assets:${html.relativePath}`,
        storageShape: 'file-set',
        formatHint: 'html-with-assets',
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK]
      },
      (path) => path === html.relativePath || isWithin(assetRoot, path)
    )
  }

  const datasetFamilies = new Map<
    string,
    { formatHint: string; root: string; relations: ScientificOutputRelation[] }
  >()
  for (const candidate of candidates) {
    const extension = posix.extname(lower(candidate.relativePath))
    const family = ['.parquet'].includes(extension)
      ? 'parquet-dataset'
      : ['.arrow', '.feather', '.ipc'].includes(extension)
        ? 'arrow-dataset'
        : ['.csv', '.tsv', '.txt'].includes(extension) &&
            (/^part[-.]/iu.test(posix.basename(candidate.relativePath)) ||
              posix
                .dirname(candidate.relativePath)
                .split('/')
                .some((segment) => segment.includes('=')))
          ? 'text-dataset'
          : undefined
    if (!family) continue
    const root = datasetRootFor(candidate.relativePath)
    const key = `${family}:${root}`
    const group = datasetFamilies.get(key) ?? { formatHint: family, root, relations: [] }
    group.relations.push(candidate)
    datasetFamilies.set(key, group)
  }
  for (const { formatHint, root, relations: family } of datasetFamilies.values()) {
    const hasDatasetNaming = family.some((candidate) => {
      const path = candidate.relativePath
      return (
        /^part[-.]/iu.test(posix.basename(path)) ||
        posix
          .dirname(path)
          .split('/')
          .some((segment) => segment.includes('='))
      )
    })
    if (family.length < 2 && !hasDatasetNaming) continue
    if (!root || !root.includes('/')) continue
    addGroup(
      {
        key: `dataset:${formatHint}:${root}`,
        storageShape: 'directory-tree',
        formatHint,
        riskCodes: [FORMAT_RISK, MULTI_FILE_RISK]
      },
      (path) => isWithin(root, path)
    )
  }

  for (const candidate of candidates) {
    if (assigned.has(candidate.relativePath) || candidate.relation === 'deleted') continue
    const classification = formatForPath(candidate.relativePath)
    groups.push({
      key: `file:${candidate.relativePath}`,
      storageShape: 'single-file',
      formatHint: classification.formatHint,
      members: [candidate],
      riskCodes: classification.riskCodes
    })
  }

  return groups
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((group) => ({
      outputId: outputIdFor(namespace, group),
      storageShape: group.storageShape,
      ...(group.formatHint ? { formatHint: group.formatHint } : {}),
      classificationAuthority: 'path-heuristic' as const,
      members: uniqueSorted(group.members.map((member) => member.relativePath)),
      riskCodes: uniqueSorted([FORMAT_RISK, ...(group.riskCodes ?? [])])
    }))
}

export { analyzeScientificOutputs }
export type { ScientificOutputRelation }

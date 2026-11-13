export type SaveFileFormat = {
  name?: string
  extension: string
  extensions: string[]
}

const equivalentExtensions = [
  ['jpg', 'jpeg', 'jpe'],
  ['tif', 'tiff'],
  ['htm', 'html'],
  ['yml', 'yaml'],
  ['md', 'markdown']
]

export function matchingFileExtension(
  name: string,
  extensions: readonly string[]
): string | undefined {
  return [...extensions]
    .sort((a, b) => b.length - a.length)
    .find((extension) => name.toLowerCase().endsWith(`.${extension.toLowerCase()}`))
}

// Options describe the export already chosen by its owner. A save dialog cannot change its codec.
export function resolveSaveFileFormat(
  originalName: string,
  filters: readonly { name: string; extensions: string[] }[] = []
): SaveFileFormat | null {
  const concrete = filters
    .map((filter) => ({
      ...filter,
      extensions: filter.extensions.filter((value) => /^[a-z\d][a-z\d._+-]*$/i.test(value))
    }))
    .filter((filter) => filter.extensions.length > 0)
  const matching = matchingFileExtension(
    originalName,
    concrete.flatMap((filter) => filter.extensions)
  )
  const filter =
    concrete.find((item) => matching && item.extensions.includes(matching)) ?? concrete[0]
  if (filter) {
    if (!matching && concrete.length > 1) throw new Error('Export format is ambiguous.')
    const extension = matching ?? filter.extensions[0]
    const aliases = equivalentExtensions.find((group) =>
      group.includes(extension.toLowerCase())
    ) ?? [extension.toLowerCase()]
    return {
      name: filter.name,
      extension,
      extensions: filter.extensions.filter((value) => aliases.includes(value.toLowerCase()))
    }
  }
  // Copy-only exporters preserve the original source suffix; never derive it from the edited name.
  const compound =
    /\.(?:tar\.(?:gz|bz2|xz|zst)|(?:csv|tsv|json|txt|fastq|fasta|fa|fq|vcf|bed|nii)\.gz|d\.ts|ome\.tiff?)$/i.exec(
      originalName
    )?.[0]
  const dot = originalName.lastIndexOf('.')
  const extension = compound?.slice(1) ?? (dot > 0 ? originalName.slice(dot + 1) : '')
  return extension && /^[a-z\d][a-z\d._+-]*$/i.test(extension)
    ? { extension, extensions: [extension] }
    : null
}

export type SaveFileNameResolution =
  | { kind: 'ready'; filename: string; stem: string }
  | { kind: 'review'; keep: string; replace: string }

export function resolveSaveFileName(
  name: string,
  format: SaveFileFormat | null
): SaveFileNameResolution {
  if (!format) return { kind: 'ready', filename: name, stem: name }
  const matched = matchingFileExtension(name, format.extensions)
  if (matched) return { kind: 'ready', filename: name, stem: name.slice(0, -matched.length - 1) }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { kind: 'ready', filename: `${name}.${format.extension}`, stem: name }
  // A dot can belong to the stem or an edited suffix. Ask for correction instead of guessing,
  // dropping dotted name segments, or silently producing a misleading double extension.
  const partial = format.extension.split('.').slice(0, -1).join('.')
  return {
    kind: 'review',
    keep: `${name}.${format.extension}`,
    replace: `${partial && name.toLowerCase().endsWith(`.${partial.toLowerCase()}`) ? name.slice(0, -partial.length - 1) : name.slice(0, dot)}.${format.extension}`
  }
}

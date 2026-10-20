import type { NotebookSourceFileWriteScope } from './dependency-analysis-types'
const companionStemMatches = (
  candidate: string,
  stem: string,
  suffixes: readonly string[]
): boolean => {
  const normalizeCase = (value: string): string =>
    process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
  const normalizedCandidate = normalizeCase(candidate)
  const normalizedStem = normalizeCase(stem)
  return suffixes.some(
    (suffix) =>
      normalizedCandidate.endsWith(suffix) &&
      normalizeCase(candidate.slice(0, -suffix.length)) === normalizedStem
  )
}

export const matchesWriteScope = (
  scope: NotebookSourceFileWriteScope,
  candidate: string
): boolean => {
  if (scope.kind === 'directory') {
    const normalizeDirectoryPath = (value: string): string => {
      const portable = value
        .replaceAll('\\', '/')
        .replace(/\/{2,}/gu, '/')
        .replace(/\/$/u, '')
      return process.platform === 'win32' ? portable.toLocaleLowerCase('en-US') : portable
    }
    const normalizedScope = normalizeDirectoryPath(scope.path)
    const normalizedCandidate = normalizeDirectoryPath(candidate)
    return normalizedCandidate.startsWith(`${normalizedScope}/`)
  }
  if (scope.kind === 'timestamped-log')
    return (
      candidate.startsWith(scope.path) &&
      /^\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(
        candidate.slice(scope.path.length)
      )
    )
  const lowerPath = scope.path.toLocaleLowerCase('en-US')
  if (scope.kind === 'shapefile') {
    if (!lowerPath.endsWith('.shp')) return false
    return companionStemMatches(candidate, scope.path.slice(0, -'.shp'.length), [
      '.shp.xml',
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
  }
  const extension = lowerPath.endsWith('.tiff') ? '.tiff' : '.tif'
  if (!lowerPath.endsWith(extension)) return false
  const stem = scope.path.slice(0, -extension.length)
  return (
    candidate === scope.path ||
    companionStemMatches(candidate, scope.path, ['.aux.xml', '.ovr']) ||
    companionStemMatches(candidate, stem, ['.tfw', '.tifw', '.prj'])
  )
}

export const VERSION_HISTORY_PAGE_SIZE = 50

// The cursor is an exclusive version-number boundary. Ownership is always supplied separately
// and applied by the database query; a cursor can never select a different logical file.
export const parseVersionHistoryCursor = (cursor?: string): number | undefined => {
  if (cursor === undefined) return undefined
  if (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
    throw new Error('Invalid version history cursor.')
  }
  return Number(cursor)
}

export const versionHistoryPage = <Version extends { versionNumber: number }>(
  newestFirst: Version[]
): { versions: Version[]; nextCursor?: string } => {
  const versions = newestFirst.slice(0, VERSION_HISTORY_PAGE_SIZE).reverse()
  return {
    versions,
    ...(newestFirst.length > VERSION_HISTORY_PAGE_SIZE
      ? { nextCursor: String(versions[0].versionNumber) }
      : {})
  }
}

/** Read current catalog authority after an uncertain candidate transaction receipt. */
export async function readMatchingCandidateIds(
  wanted: ReadonlySet<string>,
  inboxState: 'pending' | 'dismissed',
  isActive: () => boolean = () => true
): Promise<Set<string>> {
  const matching = new Set<string>()
  let offset = 0
  while (isActive()) {
    const page = await window.api.literature.search({
      scope: 'inbox',
      inboxState,
      limit: 100,
      offset
    })
    for (const entry of page.entries) {
      if ('candidate' in entry && 'state' in entry && wanted.has(entry.id)) matching.add(entry.id)
    }
    if (matching.size === wanted.size || page.nextOffset === undefined) return matching
    if (page.nextOffset <= offset) throw new Error('Inbox pagination did not advance.')
    offset = page.nextOffset
  }
  // An abandoned read cannot authorize discarding an Undo entry.
  throw new Error('Inbox reconciliation was cancelled.')
}

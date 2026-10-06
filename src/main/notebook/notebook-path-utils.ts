/**
 * Returns whether a notebook path names a remote or virtual-filesystem URI.
 *
 * The dependency analyzers intentionally keep these paths as evidence but do
 * not certify them as local artifacts without runtime file evidence.  Keep the
 * predicate shared so Python and R use the same conservative boundary.
 */
export const isExternalNotebookPath = (value: string): boolean =>
  /^(?:[a-z][a-z\d+.-]*:\/\/|\/vsi[a-z\d_-]+\/)/iu.test(value)

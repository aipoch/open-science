import { createLiteratureQueries } from '../pages/literature/public/queries'

export const { readLiteratureSelectionPage, readLiteratureDisplayPage, readMatchingCandidateIds } =
  createLiteratureQueries(() => window.api)

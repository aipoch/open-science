import type { ToolDescriptor } from '../types'
import { OPENALEX_LITERATURE_TOOLS } from './literature-openalex'
import { ARXIV_LITERATURE_TOOLS } from './literature-arxiv'
import { DOI_LITERATURE_TOOLS } from './literature-doi'

// "Literature Graph" connector: the OpenAlex scholarly graph (works/authors/venues/citations)
// plus arXiv preprints, Crossref updates and DataCite research outputs. The tool set is split across two descriptor files by upstream API
// (OpenAlex REST vs arXiv Atom); this module is the single aggregate the registry imports.
export const LITERATURE_TOOLS: ToolDescriptor[] = [
  ...OPENALEX_LITERATURE_TOOLS,
  ...ARXIV_LITERATURE_TOOLS,
  ...DOI_LITERATURE_TOOLS
]

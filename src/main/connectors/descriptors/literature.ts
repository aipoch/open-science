import type { ToolDescriptor } from '../types'
import { OPENALEX_LITERATURE_TOOLS } from './literature-openalex'
import { ARXIV_LITERATURE_TOOLS } from './literature-arxiv'

// "Literature Graph" connector: the OpenAlex scholarly graph (works/authors/venues/citations)
// plus arXiv preprint metadata. The tool set is split across two descriptor files by upstream API
// (OpenAlex REST vs arXiv Atom); this module is the single aggregate the registry imports.
export const LITERATURE_TOOLS: ToolDescriptor[] = [
  ...OPENALEX_LITERATURE_TOOLS,
  ...ARXIV_LITERATURE_TOOLS
]

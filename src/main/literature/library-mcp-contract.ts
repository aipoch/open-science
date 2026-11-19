export const LITERATURE_LIBRARY_MCP_SERVER_NAME = 'open-science-library'
export const LITERATURE_LIBRARY_SEARCH_TOOL_NAME = 'search_library'
export const LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME = 'read_library_abstract'
export const LITERATURE_LIBRARY_READ_PDF_TOOL_NAME = 'read_library_pdf'
export const LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME = 'format_references'
export const LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME = 'format_citation_document'
export const LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME = 'prepare_latex_bundle'
export const LITERATURE_LIBRARY_SAVE_TOOL_NAME = 'save_to_inbox'
export const LITERATURE_LIBRARY_SEARCH_DEFAULT_LIMIT = 20
export const LITERATURE_LIBRARY_SCOPES = ['library', 'project', 'collection', 'items'] as const
export const LITERATURE_LIBRARY_READ_SCOPES = ['library', 'project', 'collection'] as const

export type LiteratureLibraryScope = (typeof LITERATURE_LIBRARY_SCOPES)[number]

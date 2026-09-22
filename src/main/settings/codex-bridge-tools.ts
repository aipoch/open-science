import { z } from 'zod'

import { LITERATURE_CITATION_LOCALES, LITERATURE_CITATION_STYLES } from '../../shared/literature'
import {
  NOTEBOOK_MCP_SERVER_NAME,
  notebookRpcToolsForEnvironment,
  type NotebookToolEnvironmentOptions
} from '../notebook/mcp-server'
import { listPdfElementsInput, readPdfElementInput } from '../literature/pdf-structure/agent-reader'
import {
  LITERATURE_LIBRARY_MCP_SERVER_NAME,
  LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME,
  LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
  LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME,
  LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME,
  LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
  LITERATURE_LIBRARY_SAVE_TOOL_NAME,
  LITERATURE_LIBRARY_SEARCH_TOOL_NAME,
  LITERATURE_LIBRARY_SCOPES
} from '../literature/library-mcp-server'
import {
  LITERATURE_MCP_SERVER_NAME,
  LITERATURE_READ_DOCUMENT_TOOL_NAME
} from '../literature/mcp-server'
import {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
} from '../../shared/skill-import'
import { requestSkillImportToolSchema } from '../skills/mcp-server'
import type { ResponsesBridgeNamespacedTool } from './responses-protocol-types'
import { ARTIFACT_MCP_SERVER_NAME, writeArtifactFileToolSchema } from '../artifacts/mcp-server'

const jsonSchema = (schema: z.ZodType): ResponsesBridgeNamespacedTool['parameters'] =>
  z.toJSONSchema(schema, { target: 'draft-7' }) as ResponsesBridgeNamespacedTool['parameters']

export const namespaceFor = (serverName: string): string =>
  `mcp__${serverName.replace(/[^a-zA-Z0-9_]/g, '_')}`

const tool = (
  server: string,
  name: string,
  description: string,
  schema: z.ZodType
): ResponsesBridgeNamespacedTool => ({
  namespace: namespaceFor(server),
  name,
  description,
  parameters: jsonSchema(schema)
})

const SKILL_IMPORT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  tool(
    SKILL_IMPORT_MCP_SERVER_NAME,
    REQUEST_SKILL_IMPORT_TOOL_NAME,
    REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
    z.object(requestSkillImportToolSchema)
  )
]

const libraryScope = z.enum(LITERATURE_LIBRARY_SCOPES)
const itemId = z.string().trim().min(1).max(512)
// The runtime validator normalizes nested identifiers with Zod transforms, which cannot be
// represented in the provider JSON Schema. Keep the bridge declaration structural; the MCP
// server remains the source of truth for validation and normalization.
const candidate = z.object({
  item: z.object({}).passthrough(),
  source: z.object({}).passthrough()
})

const LIBRARY_CORE_TOOLS: ResponsesBridgeNamespacedTool[] = [
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_SEARCH_TOOL_NAME,
    "Browse or search the user's Open-Science Literature Library. Scope defaults to the trusted current Project.",
    z.object({
      query: z.string().trim().min(1).max(2_000).optional(),
      scope: libraryScope.optional(),
      collectionId: itemId.optional(),
      itemIds: z.array(itemId).min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(20).optional()
    })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME,
    'Read one complete Library abstract or a bounded batch of up to five abstracts. Pass exactly one of itemId or itemIds.',
    z.object({
      itemId: itemId.optional(),
      itemIds: z.array(itemId).min(1).max(5).optional(),
      scope: libraryScope.optional(),
      collectionId: itemId.optional()
    })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_READ_PDF_TOOL_NAME,
    'Retrieve bounded prose passages with page numbers from one Library PDF after finding the record with search_library.',
    z.object({
      itemId,
      attachmentId: itemId.optional(),
      query: z.string().trim().min(1).max(2_000),
      scope: libraryScope.optional(),
      collectionId: itemId.optional()
    })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME,
    'Format trusted Library records for the requested citation style and locale. Use returned citations verbatim.',
    z.object({
      itemIds: z.array(itemId).min(1).max(20),
      styleId: z.enum(LITERATURE_CITATION_STYLES).default('apa'),
      locale: z.enum(LITERATURE_CITATION_LOCALES).default('en-US')
    })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME,
    'Format and attach an existing DOCX containing semantic {{cite:itemId}} and optional {{bibliography}} markers.',
    z.object({
      filename: z.string().trim().min(1).max(2_000),
      styleId: z.enum(LITERATURE_CITATION_STYLES).default('apa'),
      locale: z.enum(LITERATURE_CITATION_LOCALES).default('en-US')
    })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME,
    'Prepare and attach an existing UTF-8 LaTeX file containing semantic citation markers.',
    z.object({ filename: z.string().trim().min(1).max(2_000) })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    LITERATURE_LIBRARY_SAVE_TOOL_NAME,
    'Save one to ten literature discoveries to the user Literature Inbox for review. Do not include origin fields.',
    z.object({
      refs: z.array(z.string().trim().min(1).max(512)).min(1).max(10).optional(),
      candidates: z.array(candidate).min(1).max(10).optional(),
      filename: z.string().trim().min(1).max(2_000).optional()
    })
  ),
  tool(
    LITERATURE_LIBRARY_MCP_SERVER_NAME,
    'acquire_pdf',
    'Find and download one public full-text PDF into Literature Inbox for user review. Supply exactly one ref or candidate.',
    z.object({
      ref: z.string().trim().min(1).max(512).optional(),
      candidate: candidate.optional(),
      pdfUrl: z.string().url().max(4_096).optional()
    })
  )
]

const LIBRARY_OPTIONAL_TOOLS: Readonly<{
  formatReferences: ResponsesBridgeNamespacedTool
  formatCitationDocument: ResponsesBridgeNamespacedTool
  prepareLatexBundle: ResponsesBridgeNamespacedTool
  acquirePdf: ResponsesBridgeNamespacedTool
}> = {
  formatReferences: LIBRARY_CORE_TOOLS[3]!,
  formatCitationDocument: LIBRARY_CORE_TOOLS[4]!,
  prepareLatexBundle: LIBRARY_CORE_TOOLS[5]!,
  acquirePdf: LIBRARY_CORE_TOOLS[7]!
}

const libraryTools = (
  options: {
    formatReferences?: boolean
    formatCitationDocument?: boolean
    prepareLatexBundle?: boolean
    acquirePdf?: boolean
  } = {}
): ResponsesBridgeNamespacedTool[] => [
  ...LIBRARY_CORE_TOOLS.slice(0, 3),
  ...(options.formatReferences === false ? [] : [LIBRARY_OPTIONAL_TOOLS.formatReferences]),
  ...(options.formatCitationDocument === false
    ? []
    : [LIBRARY_OPTIONAL_TOOLS.formatCitationDocument]),
  ...(options.prepareLatexBundle === false ? [] : [LIBRARY_OPTIONAL_TOOLS.prepareLatexBundle]),
  LIBRARY_CORE_TOOLS[6]!,
  ...(options.acquirePdf === false ? [] : [LIBRARY_OPTIONAL_TOOLS.acquirePdf])
]

const LITERATURE_CORE_TOOLS: ResponsesBridgeNamespacedTool[] = [
  tool(
    LITERATURE_MCP_SERVER_NAME,
    LITERATURE_READ_DOCUMENT_TOOL_NAME,
    'Read bounded prose passages from PDFs explicitly linked to the current message. Use list_pdf_elements for figures and tables.',
    z.object({
      documentId: itemId.optional(),
      documentIds: z.array(itemId).min(1).max(3).optional(),
      query: z.string().trim().min(1).max(2_000).optional(),
      cursor: z.string().trim().min(1).max(128).optional()
    })
  ),
  tool(
    LITERATURE_MCP_SERVER_NAME,
    'list_pdf_elements',
    'Discover figures, tables and algorithms in structure caches for PDFs linked to this message.',
    listPdfElementsInput
  ),
  tool(
    LITERATURE_MCP_SERVER_NAME,
    'read_pdf_element',
    'Read exact cached evidence selected by list_pdf_elements, including figure or table evidence.',
    readPdfElementInput
  )
]

const literatureTools = (options: { elements?: boolean } = {}): ResponsesBridgeNamespacedTool[] => [
  LITERATURE_CORE_TOOLS[0]!,
  ...(options.elements === false ? [] : LITERATURE_CORE_TOOLS.slice(1))
]

const ARTIFACT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  tool(
    ARTIFACT_MCP_SERVER_NAME,
    'write_artifact_file',
    'Attach a generated image, chart, report, data export, or archive to the current Open-Science response. The file must already exist before using a localPath source.',
    z.object(writeArtifactFileToolSchema)
  )
]

const notebookTools = (options: NotebookToolEnvironmentOptions): ResponsesBridgeNamespacedTool[] =>
  notebookRpcToolsForEnvironment(options).map((definition) => ({
    namespace: namespaceFor(NOTEBOOK_MCP_SERVER_NAME),
    name: definition.name,
    description:
      definition.name === 'notebook_execute'
        ? `${definition.description} For Open-Science data connectors, the Python code MUST call host.mcp(server, method, arguments). Never use requests, urllib, httpx, curl, or a raw upstream API for connector data; those bypass app permissions, credentials, and rate limits. Codex MCP resource-list tools are not connector discovery.`
        : definition.description,
    parameters: jsonSchema(z.object(definition.inputSchema))
  }))

export const createCodexBridgeMcpTools = (options: {
  notebook?: NotebookToolEnvironmentOptions
  skillImport?: boolean
  library?:
    | boolean
    | {
        formatReferences?: boolean
        formatCitationDocument?: boolean
        prepareLatexBundle?: boolean
        acquirePdf?: boolean
      }
  literature?: boolean | { elements?: boolean }
  artifacts?: boolean
}): ResponsesBridgeNamespacedTool[] => {
  const tools = [
    ...(options.artifacts ? ARTIFACT_TOOLS : []),
    ...(options.notebook ? notebookTools(options.notebook) : []),
    ...(options.skillImport ? SKILL_IMPORT_TOOLS : []),
    ...(options.library
      ? libraryTools(typeof options.library === 'object' ? options.library : {})
      : []),
    ...(options.literature
      ? literatureTools(typeof options.literature === 'object' ? options.literature : {})
      : [])
  ]
  return tools
}

export const codexBridgeStaticMcpTools = (): ResponsesBridgeNamespacedTool[] =>
  createCodexBridgeMcpTools({
    notebook: { memoryTools: false, wslSetupTools: false },
    library: true,
    literature: true,
    artifacts: true
  })

export {
  ARTIFACT_TOOLS,
  LIBRARY_CORE_TOOLS,
  SKILL_IMPORT_TOOLS,
  libraryTools,
  literatureTools,
  notebookTools
}

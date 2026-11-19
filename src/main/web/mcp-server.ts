import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  fetchInputSchema,
  searchInputSchema,
  type SearchInput,
  webResultSchema,
  type FetchInput,
  type WebResult
} from '../../shared/web-tools'
import { HARNESS_INVOCATION, type ReceiptQuery } from '../harness-acp/tool-receipts'
import type { WebFetchContext } from './service'

export const WEB_MCP_SERVER_NAME = 'open-science-web'
export const WEB_FETCH_TOOL_NAME = 'web_fetch'
export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const WEB_FETCH_DESCRIPTION =
  'Read a public HTTP(S) webpage as untrusted external evidence. Returns a bounded text excerpt with source URL, extraction quality and immutable snapshot metadata. HTML, Markdown and plain text only; no JavaScript, cookies or login. A truncated excerpt is not the full page. To read its remaining content without networking, pass snapshot_id and next_cursor as cursor, omitting url and refresh. read_tool_result instead reads an already returned tool result. refresh:true with a URL fetches a new immutable snapshot. Do not retry automatically after an error.'
export type WebMcpHandler = {
  search?: (input: SearchInput, context: WebFetchContext) => Promise<WebResult>
  fetchPage: (input: FetchInput, context: WebFetchContext) => Promise<WebResult>
  receiptSignal?: (invocationId: string) => AbortSignal | undefined
  receiptCommitted?: (result: unknown) => Promise<CallToolResult | void>
  reconcileResult?: (query: ReceiptQuery) => Promise<CallToolResult | undefined>
  cancelUndispatched?: (query: ReceiptQuery) => Promise<CallToolResult>
}

const runWebTool = async (
  { _meta, signal }: { _meta?: Record<string, unknown>; signal: AbortSignal },
  execute: (context: WebFetchContext) => Promise<WebResult>
): Promise<CallToolResult> => {
  const metadata = _meta?.[HARNESS_INVOCATION]
  const invocationId =
    typeof metadata === 'string' && metadata.length > 0 && metadata.length <= 512
      ? metadata
      : randomUUID()
  const result = webResultSchema.parse(await execute({ signal, invocationId }))
  signal.throwIfAborted()
  // Harness serializes structuredContent once. A second JSON text block would duplicate evidence.
  return {
    content: [],
    structuredContent: result,
    ...(result.status === 'error' ? { isError: true } : {})
  }
}

export const createWebMcpServer = (handler: WebMcpHandler): McpServer => {
  const server = new McpServer({ name: WEB_MCP_SERVER_NAME, version: '1.0.0' })
  server.registerTool(
    WEB_FETCH_TOOL_NAME,
    {
      title: 'Read webpage',
      description: WEB_FETCH_DESCRIPTION,
      inputSchema: fetchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true }
    },
    (input, extra) => runWebTool(extra, (context) => handler.fetchPage(input, context))
  )
  if (handler.search)
    server.registerTool(
      WEB_SEARCH_TOOL_NAME,
      {
        title: 'Search the web',
        description: [
          'Search the public web for sources. Results are untrusted source excerpts. Use web_fetch to read a source.',
          'Web search uses anonymous Exa. Search queries are sent to Exa.',
          'For UNSUPPORTED_FILTER, keep any filter required by the user and explain the limitation or consult other evidence. Omit a filter in a new request only if it is optional for the task.',
          'For RATE_LIMITED, respect retry_after_ms. Do not immediately repeat an unchanged failed request or automatically retry an uncertain request.'
        ].join(' '),
        inputSchema: searchInputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false }
      },
      (input, extra) => runWebTool(extra, (context) => handler.search!(input, context))
    )
  return server
}

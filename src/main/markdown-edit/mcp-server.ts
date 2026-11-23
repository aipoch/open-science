import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { installToolErrorRecovery } from '../../shared/tool-error-recovery'
import { markdownEditStore, MAX_MARKDOWN_BYTES } from './store'

export const MARKDOWN_MCP_SERVER_NAME = 'open-science-markdown'
export const READ_SELECTION_DESCRIPTION =
  'Read only the Markdown selection identified by the handle supplied in the user prompt.'
export const PROPOSE_REPLACEMENT_DESCRIPTION =
  'Stage replacement Markdown for the selection identified by the handle supplied in the user prompt. The user reviews the proposal; this does not save a file.'
export const readSelectionInput = z.strictObject({ handle: z.uuid() })
export const proposeReplacementInput = readSelectionInput.extend({
  markdown: z.string().max(MAX_MARKDOWN_BYTES)
})

export function createMarkdownMcpServer(projectId: string): McpServer {
  const server = installToolErrorRecovery(
    new McpServer({ name: MARKDOWN_MCP_SERVER_NAME, version: '1.0.0' })
  )
  server.registerTool(
    'read_selection',
    {
      description: READ_SELECTION_DESCRIPTION,
      inputSchema: readSelectionInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    ({ handle }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ markdown: markdownEditStore.read(projectId, handle) })
        }
      ]
    })
  )
  server.registerTool(
    'propose_replacement',
    {
      description: PROPOSE_REPLACEMENT_DESCRIPTION,
      inputSchema: proposeReplacementInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    ({ handle, markdown }) => {
      markdownEditStore.propose(projectId, handle, markdown)
      return { content: [{ type: 'text', text: JSON.stringify({ staged: true }) }] }
    }
  )
  return server
}

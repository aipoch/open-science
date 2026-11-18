import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { installToolErrorRecovery } from '../../shared/tool-error-recovery'
import {
  proposePptxOperationsInput,
  readPptxOutlineInput,
  type ProposePptxOperationsInput,
  type ReadPptxOutlineInput
} from './agent-tools'

const PPTX_MCP_SERVER_NAME = 'open-science-pptx'

type PptxMcpHandler = Readonly<{
  read: (input: ReadPptxOutlineInput, signal: AbortSignal) => Promise<object>
  propose: (input: ProposePptxOperationsInput, signal: AbortSignal) => Promise<object>
}>

const READ_PPTX_OUTLINE_DESCRIPTION =
  'Read the slides and shapes of a deck referenced by a pptx-slide annotation. Pass the annotation source.path. Returns headVersionId, slideId and shapeId values, text, frames in EMU, and any pending draft. Call this before propose_pptx_operations.'

const PROPOSE_PPTX_OPERATIONS_DESCRIPTION =
  'Stage edits to a deck as a draft for the user to review. Nothing is saved until the user accepts it. Pass expectedHeadVersionId from read_pptx_outline and operations addressed by slideId and shapeId. Later calls on the same head add to the pending draft.'

const KNOWN_ERROR = /^(PPTX_[A-Z_]+):\s*(.+)$/

const respond = async (run: () => Promise<object>): Promise<CallToolResult> => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run()) }] }
  } catch (error) {
    const known = KNOWN_ERROR.exec(error instanceof Error ? error.message : '')
    const failure = known
      ? { code: known[1], message: known[2] }
      : { code: 'PPTX_FAILED', message: 'The deck could not be read or edited. Retry once.' }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure }) }] }
  }
}

const createPptxMcpServer = (handler: PptxMcpHandler): ModelContextProtocolServer => {
  const server = installToolErrorRecovery(
    new ModelContextProtocolServer({ name: PPTX_MCP_SERVER_NAME, version: '1.0.0' })
  )
  server.registerTool(
    'read_pptx_outline',
    {
      title: 'Read PowerPoint outline',
      description: READ_PPTX_OUTLINE_DESCRIPTION,
      inputSchema: readPptxOutlineInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    (input, extra) => respond(() => handler.read(input, extra.signal))
  )
  server.registerTool(
    'propose_pptx_operations',
    {
      title: 'Propose PowerPoint edits',
      description: PROPOSE_PPTX_OPERATIONS_DESCRIPTION,
      inputSchema: proposePptxOperationsInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    },
    (input, extra) => respond(() => handler.propose(input, extra.signal))
  )
  return server
}

export {
  createPptxMcpServer,
  PPTX_MCP_SERVER_NAME,
  PROPOSE_PPTX_OPERATIONS_DESCRIPTION,
  READ_PPTX_OUTLINE_DESCRIPTION
}
export type { PptxMcpHandler }

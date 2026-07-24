import { z } from 'zod'

import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import type { ResponsesBridgeNamespacedTool } from '../settings/responses-bridge'
import { submitFindingsInputSchema } from './mcp-server'

export const REVIEWER_BRIDGE_TOOL_NAMESPACE = `mcp__${REVIEWER_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`

export const REVIEWER_BRIDGE_NAMESPACED_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: REVIEWER_BRIDGE_TOOL_NAMESPACE,
    name: REVIEWER_MCP_TOOLS.readTurn,
    description: 'Return the ordered message and tool-activity blocks in the audited turn.',
    parameters: z.toJSONSchema(z.object({}).strict(), { target: 'draft-7' })
  },
  {
    namespace: REVIEWER_BRIDGE_TOOL_NAMESPACE,
    name: REVIEWER_MCP_TOOLS.queryExecutionLog,
    description: 'Return the execution log for the audited turn or one in-scope activity.',
    parameters: z.toJSONSchema(
      z
        .object({ activityId: z.string().optional().describe('Optional in-scope activity id') })
        .strict(),
      { target: 'draft-7' }
    )
  },
  {
    namespace: REVIEWER_BRIDGE_TOOL_NAMESPACE,
    name: REVIEWER_MCP_TOOLS.readArtifact,
    description: 'Read one artifact attached to the audited turn.',
    parameters: z.toJSONSchema(
      z.object({ id: z.string().min(1).describe('In-scope artifact version id') }).strict(),
      { target: 'draft-7' }
    )
  },
  {
    namespace: REVIEWER_BRIDGE_TOOL_NAMESPACE,
    name: REVIEWER_MCP_TOOLS.submitFindings,
    description:
      'Submit structured review checks exactly once, then stop. Pass an empty checks array if no issues were found.',
    parameters: z.toJSONSchema(submitFindingsInputSchema, {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]

import { z } from 'zod'

import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import type { ResponsesBridgeNamespacedTool } from '../settings/responses-bridge'
import { reviewerArtifactReadInputSchema, submitFindingsBridgeInputSchema } from './mcp-server'

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
    description:
      'Read one artifact attached to the audited turn. Use trace for execution, generation, ' +
      'producer, method, inputs, and existence without file bytes. Use targeted content for final ' +
      'visual, presentation, text, or value claims; omitted view remains content. XLSX targets use ' +
      'sheet/rowStart/rowEnd/columns; PDF/DOCX pages and PPTX slides use pages. A partial response ' +
      'is sufficient when the returned targets fully cover the claim. Set includePreview for a ' +
      'bounded rendered page/slide image when text alone cannot verify a visual claim. Supported ' +
      'raster images are MCP image blocks, never base64 JSON; unsupported format or model ' +
      'capability only limits Coverage and is not itself a finding.',
    parameters: z.toJSONSchema(reviewerArtifactReadInputSchema, { target: 'draft-7' })
  },
  {
    namespace: REVIEWER_BRIDGE_TOOL_NAMESPACE,
    name: REVIEWER_MCP_TOOLS.submitFindings,
    description:
      'Complete the Review with one accepted structured submission, then stop. Correct and retry ' +
      'validation errors within the same Review Turn; a second accepted submission is prohibited. ' +
      'In an initial review with no checkable claims, submit empty checks; tracked re-reviews follow ' +
      'their strict run prompt.',
    parameters: z.toJSONSchema(submitFindingsBridgeInputSchema, {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]

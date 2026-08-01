import { z } from 'zod'

import { ARTIFACT_MCP_SERVER_NAME, writeArtifactFileToolDefinition } from '../artifacts/mcp-server'
import { NOTEBOOK_MCP_SERVER_NAME, NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import {
  SKILL_IMPORT_MCP_SERVER_NAME,
  requestSkillImportToolDefinition
} from '../skills/mcp-server'
import type { AgentFrameworkId } from '../agent-framework/types'
import { modelFacingAppMcpToolName } from '../agent-framework/app-mcp-names'
import { REQUEST_SKILL_IMPORT_TOOL_NAME } from '../../shared/skill-import'

type ContextUsageMcpOptions = {
  artifacts: boolean
  notebook: boolean
  skillImport: boolean
  codexBridgeAliases?: boolean
}

type ContextUsageMcpSection = {
  sectionId: string
  text: string
}

type ToolDefinition = {
  title: string
  description: string
  inputSchema: Record<string, z.ZodTypeAny>
  annotations?: Record<string, unknown>
}

const serializeToolDefinitions = (
  frameworkId: AgentFrameworkId,
  codexBridgeAliases: boolean,
  server: string,
  tools: ReadonlyArray<{ name: string; definition: ToolDefinition }>
): ContextUsageMcpSection => ({
  sectionId: `mcp-schema:${server}`,
  // This is the app-owned portion of the schema catalog sent to the Agent. Providers add their own
  // wrappers and framework tools, which remain visible in the reconciled residual rather than being
  // guessed here. Compact JSON best matches the wire representation without counting whitespace.
  text: JSON.stringify(
    tools.map(({ name, definition }) => ({
      name: modelFacingAppMcpToolName(frameworkId, server, name, codexBridgeAliases),
      title: definition.title,
      description: definition.description,
      inputSchema: z.toJSONSchema(z.object(definition.inputSchema), { target: 'draft-7' }),
      ...(definition.annotations ? { annotations: definition.annotations } : {})
    }))
  )
})

const sectionsByAvailability = new Map<string, readonly ContextUsageMcpSection[]>()

const contextUsageMcpSections = (
  frameworkId: AgentFrameworkId,
  options: ContextUsageMcpOptions
): readonly ContextUsageMcpSection[] => {
  const codexBridgeAliases = frameworkId === 'codex' && options.codexBridgeAliases === true
  const cacheKey = [
    frameworkId,
    Number(codexBridgeAliases),
    ...[options.artifacts, options.notebook, options.skillImport].map(Number)
  ].join(':')
  const cached = sectionsByAvailability.get(cacheKey)
  if (cached) return cached

  const sections: ContextUsageMcpSection[] = []

  if (options.artifacts) {
    sections.push(
      serializeToolDefinitions(frameworkId, codexBridgeAliases, ARTIFACT_MCP_SERVER_NAME, [
        { name: 'write_artifact_file', definition: writeArtifactFileToolDefinition }
      ])
    )
  }

  if (options.notebook) {
    sections.push(
      serializeToolDefinitions(
        frameworkId,
        codexBridgeAliases,
        NOTEBOOK_MCP_SERVER_NAME,
        NOTEBOOK_RPC_TOOLS.map(({ name, title, description, inputSchema }) => ({
          name,
          definition: { title, description, inputSchema }
        }))
      )
    )
  }

  if (options.skillImport) {
    sections.push(
      serializeToolDefinitions(frameworkId, codexBridgeAliases, SKILL_IMPORT_MCP_SERVER_NAME, [
        { name: REQUEST_SKILL_IMPORT_TOOL_NAME, definition: requestSkillImportToolDefinition }
      ])
    )
  }

  sectionsByAvailability.set(cacheKey, sections)
  return sections
}

export { contextUsageMcpSections }
export type { ContextUsageMcpOptions, ContextUsageMcpSection }

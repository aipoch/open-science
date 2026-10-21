import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { notebookRpcToolsForEnvironment } from '../notebook/mcp-server'
import { generatePlanToolSchema } from '../session-plan/plan-mcp-server'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME
} from '../../shared/activity-groups'

// This is an Auto review inventory, deliberately separate from remembered permission identities.
// Legacy entries require no migration of their existing authorization contract.
const registrations: Record<
  string,
  'allow_once' | 'inner_authorization' | 'legacy' | 'operations'
> = {
  "artifacts/mcp-server.ts:'write_artifact_file'": 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_SEARCH_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_FORMAT_REFERENCES_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_FORMAT_DOCUMENT_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_PREPARE_LATEX_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_READ_ABSTRACT_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_READ_PDF_TOOL_NAME': 'allow_once',
  'literature/library-mcp-server.ts:LITERATURE_LIBRARY_SAVE_TOOL_NAME': 'allow_once',
  "literature/library-mcp-server.ts:'acquire_pdf'": 'allow_once',
  'literature/mcp-server.ts:LITERATURE_READ_DOCUMENT_TOOL_NAME': 'allow_once',
  "literature/mcp-server.ts:'list_pdf_elements'": 'allow_once',
  "literature/mcp-server.ts:'read_pdf_element'": 'allow_once',
  'notebook/mcp-server.ts:definition.name': 'operations',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.readTurn': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.queryExecutionLog': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.readArtifact': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.submitFindings': 'legacy',
  "session-plan/plan-mcp-server.ts:'generate_plan'": 'operations',
  "session-plan/plan-mcp-server.ts:'update_step_status'": 'legacy',
  'side-chat/host-message-mcp-server.ts:HOST_SEND_MESSAGE_TOOL_NAME': 'legacy',
  'skills/mcp-server.ts:REQUEST_SKILL_IMPORT_TOOL_NAME': 'inner_authorization',
  'skills/runtime-mcp-server.ts:LOAD_SKILL_TOOL_NAME': 'legacy'
}
const notebookOperations: Record<string, 'inner_authorization' | 'legacy' | 'operations'> = {
  ask_user_question: 'inner_authorization',
  notebook_execute: 'legacy',
  background_run: 'operations',
  repl_execute: 'legacy',
  bash_execute: 'legacy',
  request_network_access: 'inner_authorization',
  notebook_state: 'legacy',
  list_notebook_runtimes: 'legacy',
  notebook_bind_runtime: 'legacy',
  notebook_switch_runtime: 'legacy',
  notebook_restart: 'legacy',
  notebook_shutdown: 'legacy',
  inspect_packages: 'legacy',
  manage_packages: 'legacy',
  manage_environments: 'operations',
  list_memory_categories: 'legacy',
  search_memories: 'legacy',
  remember_memory: 'legacy',
  wsl_setup_diagnostics: 'legacy',
  wsl_setup_install_platform: 'legacy',
  wsl_setup_install_recommended_distro: 'legacy',
  wsl_setup_select_profile: 'legacy',
  wsl_setup_open_terminal: 'legacy'
}
const mainRoot = join(import.meta.dirname, '..')
const readSource = (path: string): string => readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) return [path]
    return []
  })
const collectRegistrations = (source: string, filename: string): string[] => {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'registerTool'
    ) {
      names.push(`${filename}:${node.arguments[0].getText(file)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const tools = notebookRpcToolsForEnvironment({ memoryTools: true, wslSetupTools: true })
const automaticSourceFingerprints = (read = readSource): Record<string, string> => {
  const files = [
    ...new Set(
      Object.entries(registrations)
        .filter(([, mode]) => mode !== 'legacy')
        .map(([key]) => key.slice(0, key.indexOf(':')))
    )
  ]
  return Object.fromEntries(files.sort().map((file) => [file, digest(read(join(mainRoot, file)))]))
}

describe('Auto operation completeness against real tool registrations', () => {
  it('requires an explicit Auto disposition for every actual app tool', () => {
    const actual = sourceFiles(mainRoot).flatMap((path) =>
      collectRegistrations(readSource(path), relative(mainRoot, path).replaceAll('\\', '/'))
    )
    expect(actual.sort()).toEqual(Object.keys(registrations).sort())
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(notebookOperations).sort())
    // Activity is a compatibility declaration identity, not a registered MCP server in this tree.
    expect(`${ACTIVITY_GROUP_MCP_SERVER_NAME}/${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`).toBe(
      'open-science-activity/begin_activity_group'
    )
  })

  it('detects a newly registered tool independently of the grant catalog', () => {
    const added = collectRegistrations(
      "server.registerTool('new_effect', {}, handler)",
      'notebook/mcp-server.ts'
    )
    expect(added.filter((key) => !(key in registrations))).toEqual([
      "notebook/mcp-server.ts:'new_effect'"
    ])
    expect('new_effect' in notebookOperations).toBe(false)
  })

  it('requires review when automatically handled schemas or handler branches change', () => {
    // Update these fingerprints only after reviewing the new parameter/handler branches against
    // the operation classifier and its positive/negative tests. Whole-source hashes intentionally
    // err toward extra review; they cannot silently bless a newly added side-effect branch.
    const definitions = automaticSourceFingerprints()
    const notebookSchemas = Object.fromEntries(
      tools
        .filter((tool) => notebookOperations[tool.name] !== 'legacy')
        .map((tool) => [
          tool.name,
          digest({
            schema: z.toJSONSchema(z.strictObject(tool.inputSchema)),
            method: tool.method,
            resolveMethod: tool.resolveMethod?.toString()
          })
        ])
    )
    const sharedContracts = {
      literatureDiscovery: digest(readSource(join(mainRoot, 'literature/discovery-contract.ts'))),
      planSchema: digest(z.toJSONSchema(generatePlanToolSchema)),
      planValidation: digest(readSource(join(mainRoot, '../shared/session-plan/contract.ts'))),
      activityDeclaration: digest(readSource(join(mainRoot, '../shared/activity-groups.ts')))
    }
    expect({ definitions, notebookSchemas, sharedContracts }).toEqual({
      definitions: {
        'artifacts/mcp-server.ts':
          '6b43e2b69387c7310dee65d97674b94e608a349f987ef90d7dd5cee7ff675c7f',
        'literature/library-mcp-server.ts':
          'f6eddd996e4651c56586435e7c0845a437dd7d3b8c18dfe0ff634eb0e8bbefd6',
        // Reviewed: desktop regions come only from the message snapshot; strict tool inputs
        // preserve linked-PDF identity, mounted-server checks and single-use authorization.
        'literature/mcp-server.ts':
          'e1ec395347887d9b6645ae0f74c268901712e26ff5b93ec7b128d46134c986ed',
        // Reviewed: question/mode guidance only; input validation and handlers are unchanged.
        'notebook/mcp-server.ts':
          '9f0c679d39461462307788133da200b7534604d1bd9086819d513dca78bf2dc5',
        'session-plan/plan-mcp-server.ts':
          'b32ac73d8a2655f556c50b067892eb4caa3940acdcae6df7d8475d81cf7b98d9',
        'skills/mcp-server.ts': '3064af8275f8026e9dbf84b445f3a5061d41619c523def579c4b759c0aac338b'
      },
      notebookSchemas: {
        ask_user_question: '87edfae3e0bfa12e06917f12d87b55a4c44a486550541e7ca4f6f1086e576cee',
        background_run: '4198921bb3f61261431524f7e57c92d8713bfe5db49c360a30b66b3cc4e027fd',
        manage_environments: '15d33c6e75c14aaddad62bc062f714238ae7c87ab08976d77efd1f77e8641675',
        request_network_access: '6b5a49d73cc704691da193510764101bc5577b48bb7c0fa8bf99f1b29b500f95'
      },
      sharedContracts: {
        activityDeclaration: '1739b6cfadd2912aa53f4d11bf69d908da37d5f822476a998b928e9de7ddffdc',
        literatureDiscovery: '3ded9eab859b472f0d20d7a232c8971a517f3b493db318efb0a07753278fdee6',
        planSchema: '16f6ba38e7ae9320c2fb9d1a215592c11ada256781882e5e3f16336eb303cfb7',
        planValidation: 'fb649e539cdd8f71abd34ec329ca7ee378cf7605fcbe8d0123b7703ed7dedddb'
      }
    })
  })

  it('detects a permission-relevant Notebook callback change without a schema change', () => {
    const path = join(mainRoot, 'notebook/mcp-server.ts')
    const original = readSource(path)
    const branch = 'const rpcMethod = definition.resolveMethod?.(input) ?? definition.method'
    expect(original).toContain(branch)
    const changed = original.replace(
      branch,
      `const rpcMethod = asRecord(input)?.name === 'analysis' ? 'executeShell' :
        (definition.resolveMethod?.(input) ?? definition.method)`
    )
    // Same registered tools, same exported schemas and resolveMethod; only the callback changed.
    expect(collectRegistrations(changed, path)).toEqual(collectRegistrations(original, path))
    const reviewed = automaticSourceFingerprints()
    const mutated = automaticSourceFingerprints((file) =>
      file === path ? changed : readSource(file)
    )
    expect(mutated).not.toEqual(reviewed)
    expect(mutated['notebook/mcp-server.ts']).not.toBe(reviewed['notebook/mcp-server.ts'])
  })

  it('detects an unmapped operation added to an automatic tool schema', () => {
    const tool = tools.find((tool) => tool.name === 'background_run')!
    const original = z.toJSONSchema(z.strictObject(tool.inputSchema))
    const changed = z.toJSONSchema(
      z.strictObject({ ...tool.inputSchema, action: z.enum(['query', 'cancel', 'start']) })
    )
    expect(digest(changed)).not.toBe(digest(original))
  })
})

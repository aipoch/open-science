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
      planSchema: digest(z.toJSONSchema(generatePlanToolSchema)),
      planValidation: digest(readSource(join(mainRoot, '../shared/session-plan/contract.ts'))),
      activityDeclaration: digest(readSource(join(mainRoot, '../shared/activity-groups.ts')))
    }
    expect({ definitions, notebookSchemas, sharedContracts }).toEqual({
      definitions: {
        'artifacts/mcp-server.ts':
          '6b43e2b69387c7310dee65d97674b94e608a349f987ef90d7dd5cee7ff675c7f',
        'literature/library-mcp-server.ts':
          'f67afa11e9d035610ef4a863424cbfd4504dd3444808803b993989f32caa84d2',
        'literature/mcp-server.ts':
          'd7baeae460b294940d198e2a16f701c399b7630da945f31226260f19decdae72',
        'notebook/mcp-server.ts':
          '60a9cadbfcf1e6d71dd0367554d96e179941e2b29d41f87a1af44098bb953474',
        'session-plan/plan-mcp-server.ts':
          '9a98aecaaca3fd1908942006132eeb24b8bb3a8f5a284dfcaac1eaacefa1dd94',
        'skills/mcp-server.ts': '65e6e7632855c2799a8f58cd6292777b2eb50779170148bd3c6fdd0f1e257edc'
      },
      notebookSchemas: {
        ask_user_question: 'f4a3e6c178ec5dc5fbbd9ef256a046f32565a58be8bc8fa263a9e642e789002a',
        background_run: '4198921bb3f61261431524f7e57c92d8713bfe5db49c360a30b66b3cc4e027fd',
        manage_environments: '15d33c6e75c14aaddad62bc062f714238ae7c87ab08976d77efd1f77e8641675',
        request_network_access: '6b5a49d73cc704691da193510764101bc5577b48bb7c0fa8bf99f1b29b500f95'
      },
      sharedContracts: {
        activityDeclaration: '1739b6cfadd2912aa53f4d11bf69d908da37d5f822476a998b928e9de7ddffdc',
        planSchema: '16f6ba38e7ae9320c2fb9d1a215592c11ada256781882e5e3f16336eb303cfb7',
        planValidation: '0b1349725044d30d8cd9518e5891a237ff11cfde31c9f613b3550bdb37463414'
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

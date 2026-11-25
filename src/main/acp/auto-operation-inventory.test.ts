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
  'allow_once' | 'host_web' | 'inner_authorization' | 'legacy' | 'operations' | 'review'
> = {
  "artifacts/mcp-server.ts:'write_artifact_file'": 'allow_once',
  "image-model/mcp-server.ts:'generate_image'": 'allow_once',
  "image-model/mcp-server.ts:'edit_image'": 'allow_once',
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
  // Reading annotations use the verified Literature identity; read-only calls skip the prompt,
  // while create remains a one-call Auto approval.
  "literature/mcp-server.ts:'list_pdf_annotations'": 'allow_once',
  "literature/mcp-server.ts:'locate_pdf_annotation_target'": 'allow_once',
  "literature/mcp-server.ts:'create_pdf_annotation'": 'allow_once',
  // PPTX tools never save: propose only stages a draft that the user must accept in the preview.
  "pptx-edit/mcp-server.ts:'read_pptx_outline'": 'allow_once',
  "pptx-edit/mcp-server.ts:'propose_pptx_operations'": 'allow_once',
  'notebook/mcp-server.ts:definition.name': 'operations',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.readTurn': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.queryExecutionLog': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.readArtifact': 'legacy',
  'reviewer/mcp-server.ts:REVIEWER_MCP_TOOLS.submitFindings': 'legacy',
  "schedules/mcp.ts:'list_schedules'": 'allow_once',
  "schedules/mcp.ts:'create_schedule'": 'allow_once',
  "schedules/mcp.ts:'update_schedule'": 'allow_once',
  "schedules/mcp.ts:'close_schedule'": 'allow_once',
  "schedules/mcp.ts:'manage_current_schedule'": 'allow_once',
  "session-plan/plan-mcp-server.ts:'generate_plan'": 'operations',
  "session-plan/plan-mcp-server.ts:'update_step_status'": 'legacy',
  'side-chat/host-message-mcp-server.ts:HOST_SEND_MESSAGE_TOOL_NAME': 'legacy',
  'skills/mcp-server.ts:REQUEST_SKILL_IMPORT_TOOL_NAME': 'inner_authorization',
  'skills/runtime-mcp-server.ts:LOAD_SKILL_TOOL_NAME': 'legacy',
  // Host route ownership and the current permission mode are checked before dispatch. Auto may
  // allow these read-only capabilities; external same-name tools do not inherit that authority.
  'web/mcp-server.ts:WEB_FETCH_TOOL_NAME': 'host_web',
  'web/mcp-server.ts:WEB_SEARCH_TOOL_NAME': 'host_web'
}
const notebookOperations: Record<string, 'inner_authorization' | 'legacy' | 'operations'> = {
  ask_user_question: 'inner_authorization',
  notebook_execute: 'legacy',
  background_run: 'operations',
  repl_execute: 'legacy',
  bash_execute: 'legacy',
  request_network_access: 'inner_authorization',
  notebook_state: 'legacy',
  list_authorized_directories: 'legacy',
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
      activityDeclaration: digest(readSource(join(mainRoot, '../shared/activity-groups.ts'))),
      webTools: digest(readSource(join(mainRoot, '../shared/web-tools.ts')))
    }
    expect({ definitions, notebookSchemas, sharedContracts }).toEqual({
      definitions: {
        // Reviewed: errors name a code and next step, and legacy top-level content/encoding is
        // rejected in favor of source. Allow-once disposition and owner-checked source access are unchanged.
        'artifacts/mcp-server.ts':
          '9e0e7684e9ce91f56ba4e6bfc49bcd2a1bb97bf6dd2a22bd686307c9d634dde2',
        // Image tools use the current turn capability and the configured model's operation schema.
        'image-model/mcp-server.ts':
          'a83381424a1c34c05d37c2a3fe9efc71ef47c08dfd561861170d4f165fae893c',
        // Reviewed: save_to_inbox/acquire_pdf advertise candidates as objects; the same strict
        // candidate schema now validates inline records in the handler before any save or download.
        // Citation tool descriptions are shortened only. Trusted origin, permission inputs and
        // allow-once disposition are unchanged. Shared contracts were extracted from the runtime
        // handlers without changing the automatically handled operation branches.
        'literature/library-mcp-server.ts':
          'a243f2ab289a861466bb203213f8ee747224345c52220aacfe758a3f119ee3ef',
        // Reviewed: errors keep specific codes with a next step and annotation cursors are opaque
        // strings. Strict inputs, mounted-server checks and single-use authorization are unchanged.
        // Presentation helpers and contracts were extracted without changing handler branches.
        'literature/mcp-server.ts':
          '10a2eec347f763a29d87725b2dca1676814b387e4603defbfff4a4f37574b1ab',
        // Reviewed: calls require a mounted route and current turn. Task edits are scoped to the
        // originating conversation, and unattended mutations are limited to the task's own trigger.
        'schedules/mcp.ts': '4c7322e66195808835ae282899a90c51777f79cf0ccf07ee7cdb6d2607b63f52',

        // Reviewed: propose_pptx_operations only stages a draft; saving needs a user accept in the preview.
        'pptx-edit/mcp-server.ts':
          '3bd949c59a19ad322a31d9c3274600e5d4c46023ffe5190115952c8029bda4bb',
        // Reviewed: interpreter descriptions now explain idle reclamation and volatile variables.
        // Tool schemas, handlers, operation classifiers and Auto dispositions are unchanged.
        // Reviewed: scoped manual-stop feedback only decorates successful/error tool responses.
        // Strict inputs, RPC method selection and Auto authorization dispositions are unchanged.
        // Main-only initial connection preparation changes no tool schemas, handlers or Auto dispositions.
        // Reviewed: default runtime advice and no-retry guidance for declines and stops only change
        // tool text. RPC dispatch, input schemas and Auto authorization remain unchanged.
        // Reviewed: terminal status and diagnostics are projected after RPC dispatch. Background
        // query and cancel still require the registered action and its validated Run identity.
        // The read-only state request limits history to the ten runs its response can display.
        // Directory discovery publishes its existing result fields using the MCP default dialect.
        // Output paging reads one persisted Run through the existing session-scoped state route.
        // Paging and handoff extraction project results only; no Auto operation branch changed.
        'notebook/mcp-server.ts':
          '246821c41c360ed03b33b39d42dd5600d2339edc245814f1acb4949b052b187e',

        // Reviewed: invalid-plan errors carry repair guidance; the handler call, its result and the
        // Plan operation dispositions are unchanged.
        'session-plan/plan-mcp-server.ts':
          '1451e969ed1af4ddea333c4005f11713d39f8590083099c0ce3c73b47937d326',
        // Reviewed: import errors carry codes and next steps; the schema and preview handoff are unchanged.
        'skills/mcp-server.ts': '75e23698e0b11be9919ae224e1516ba82241aa703a20ae29c50448c35ce1d8da',
        // Reviewed: strict shared inputs enter the host-owned route. Search sends queries to
        // anonymous Exa and returns one bounded evidence envelope. Required filters are preserved.
        // Receipt hooks observe revocation and return the authoritative cancellation result.
        // Both tools share result validation and check cancellation before returning the envelope.
        'web/mcp-server.ts': '27bccd06a2b18dd547a4454b0f0864dee2a305d5b6b09f744ba9d571512f3154'
      },
      notebookSchemas: {
        // Reviewed: pros/cons are optional trimmed strings capped at 4000 characters; they only
        // annotate choices and do not affect option identities, answers or authorization.
        ask_user_question: '7c4a9484087130798fec4a767b43804bed689aceceaa250db53ef79d6c09f003',
        background_run: '4198921bb3f61261431524f7e57c92d8713bfe5db49c360a30b66b3cc4e027fd',
        manage_environments: '15d33c6e75c14aaddad62bc062f714238ae7c87ab08976d77efd1f77e8641675',
        request_network_access: '019beadbad4627d5ad4dc2c1bfbf5cc3f777ecf5382df20291952cadbba3eeaf'
      },
      sharedContracts: {
        activityDeclaration: '1739b6cfadd2912aa53f4d11bf69d908da37d5f822476a998b928e9de7ddffdc',
        literatureDiscovery: '3ded9eab859b472f0d20d7a232c8971a517f3b493db318efb0a07753278fdee6',
        planSchema: '16f6ba38e7ae9320c2fb9d1a215592c11ada256781882e5e3f16336eb303cfb7',
        // Reviewed: Task decision receipts and branch identity extend the Plan response types.
        // The generated Plan schema and Auto operation classifier still validate the same inputs.
        planValidation: 'c20f73fec42da43bccadf93b575910aebf4820a826730da53e0a1db1036c5495',
        // Reviewed: strict search/fetch inputs reject provider, network and replay options.
        // Bounded attempts, usage and provenance fields grant no permission or execution authority.
        // The saved-envelope reader validates results for evidence and presentation.
        webTools: 'bf80012978d94e4bc68d2e08ff76f5c422b8f4b6bf67dee0faf5690e5ced2ff1'
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

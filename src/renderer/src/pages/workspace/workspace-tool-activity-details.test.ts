import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import {
  buildToolActivityDetails,
  getToolDisplayName,
  isEditActivity
} from './workspace-tool-activity-details'

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-1',
  kind: 'tool',
  title: '',
  status: 'completed',
  eventIds: [],
  sortIndex: 1,
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

describe('workspace tool activity details', () => {
  it('derives a display name from the provider tool name first', () => {
    expect(
      getToolDisplayName(createActivity({ providerToolName: 'Bash', toolKind: 'execute' }))
    ).toBe('Bash')
    expect(getToolDisplayName(createActivity({ toolKind: 'execute' }))).toBe('Terminal')
    expect(getToolDisplayName(createActivity({ toolKind: undefined }))).toBe('Tool')
  })

  it('builds command and output code sections for execute tools', () => {
    const activity = createActivity({
      providerToolName: 'Bash',
      toolKind: 'execute',
      title: 'ls -la',
      terminalExitCode: 0,
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: '```console\ntotal 8\ndrwxr-xr-x\n```' }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Bash')
    expect(details?.subtitle).toBe('ls -la')
    expect(details?.metaLabel).toBe('exit 0')
    expect(details?.sections).toHaveLength(2)
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Command',
      language: 'bash',
      text: 'ls -la'
    })
    // The agent wraps stdout in a fenced console block; the parser unwraps it for clean rendering.
    expect(details?.sections[1]).toMatchObject({
      kind: 'code',
      label: 'Output',
      text: 'total 8\ndrwxr-xr-x'
    })
  })

  it('prefers streamed terminal output and raw input for execute tools', () => {
    const activity = createActivity({
      providerToolName: 'Bash',
      toolKind: 'execute',
      title: 'echo hi',
      rawInput: { command: 'echo hi', description: 'greet' },
      terminalOutput: 'hi',
      terminalExitCode: 2
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.metaLabel).toBe('exit 2')
    expect(details?.sections[0]).toMatchObject({ text: 'echo hi', language: 'bash' })
    expect(details?.sections[1]).toMatchObject({ label: 'Output', text: 'hi' })
  })

  it('builds diff sections with add/remove summaries for edit tools', () => {
    const activity = createActivity({
      providerToolName: 'Edit',
      toolKind: 'edit',
      title: 'Edit src/app.ts',
      toolContent: [
        {
          type: 'diff',
          path: '/repo/src/app.ts',
          oldText: 'const a = 1',
          newText: 'const a = 1\nconst b = 2'
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Edit')
    expect(details?.subtitle).toBe('/repo/src/app.ts')
    expect(details?.metaLabel).toBe('+2 −1')
    expect(details?.sections[0]).toMatchObject({
      kind: 'diff',
      label: 'app.ts',
      language: 'typescript',
      oldText: 'const a = 1',
      newText: 'const a = 1\nconst b = 2'
    })
  })

  it('summarizes multiple diffs with a file count subtitle', () => {
    const activity = createActivity({
      toolKind: 'edit',
      toolContent: [
        { type: 'diff', path: 'a.ts', oldText: null, newText: 'x' },
        { type: 'diff', path: 'b.ts', oldText: null, newText: 'y' }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.subtitle).toBe('2 files')
    expect(details?.sections).toHaveLength(2)
  })

  it('shows file content for read tools without an input section', () => {
    const activity = createActivity({
      providerToolName: 'Read',
      toolKind: 'read',
      title: 'Read src/util.py',
      toolLocations: [{ path: '/repo/src/util.py' }],
      rawInput: { file_path: '/repo/src/util.py' },
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: '```\nprint("hi")\n```' }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.subtitle).toBe('/repo/src/util.py')
    expect(details?.sections).toHaveLength(1)
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Content',
      language: 'python',
      text: 'print("hi")'
    })
  })

  it('shows input and output sections for generic tools', () => {
    const activity = createActivity({
      providerToolName: 'mcp__db__query',
      toolKind: 'other',
      title: 'Query users',
      rawInput: { table: 'users', limit: 5 },
      toolContent: [{ type: 'content', content: { type: 'text', text: '5 rows returned' } }]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('mcp__db__query')
    expect(details?.sections[0]).toMatchObject({ kind: 'code', label: 'Input', language: 'json' })
    expect(details?.sections[0].kind === 'code' && details.sections[0].text).toContain('"table"')
    expect(details?.sections[1]).toMatchObject({ label: 'Output', text: '5 rows returned' })
  })

  it('renders a notebook cell as Python code plus output, not the raw run summary', () => {
    const runSummary = {
      runId: 'notebook-run-1',
      status: 'completed',
      script: 'import numpy as np\nprint(np.sin(0))',
      text: { stdout: '0.0\n', stderr: '', traceback: '', plain: ['0.0'] },
      outputs: []
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      rawInput: { code: 'import numpy as np\nprint(np.sin(0))' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook cell')
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Code',
      language: 'python',
      text: 'import numpy as np\nprint(np.sin(0))'
    })
    expect(details?.sections[1]).toMatchObject({
      label: 'Output',
      text: '0.0',
      collapsible: true
    })
    // The code section stays open; only the output collapses.
    expect(details?.sections[0]).toMatchObject({ label: 'Code' })
    expect((details?.sections[0] as { collapsible?: boolean }).collapsible).toBeFalsy()
  })

  it('labels a notebook cell with its clean kernel name, never the raw tool id', () => {
    const runSummary = {
      status: 'completed',
      script: 'x = 1',
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: []
    }
    const activity = createActivity({
      // The runtime may backfill an untitled call with the raw tool id; the row label ignores it.
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      rawInput: { code: 'x = 1' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Notebook cell')
  })

  it('falls back to the run summary script when notebook input code is unavailable', () => {
    const runSummary = {
      status: 'failed',
      script: "raise ValueError('boom')",
      text: { stdout: '', stderr: 'ValueError: boom', traceback: 'Traceback...\nValueError: boom' }
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other',
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.metaLabel).toBe('failed')
    expect(details?.sections[0]).toMatchObject({
      label: 'Code',
      language: 'python',
      text: "raise ValueError('boom')"
    })
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain(
      'ValueError: boom'
    )
  })

  it('renders a repl_execute run as Agent SDK JavaScript code plus its echoed result', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'repl',
      stdout: '',
      stderr: '',
      traceback: '',
      outputs: [{ type: 'display', data: { 'text/plain': '{ pmids: [ "1", "2" ] }' } }]
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__repl_execute',
      toolKind: 'other',
      rawInput: { code: 'const r = await host.mcp.pubmed.search({}); r' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Agent SDK')
    expect(details?.sections[0]).toMatchObject({
      kind: 'code',
      label: 'Code',
      language: 'javascript',
      text: 'const r = await host.mcp.pubmed.search({}); r'
    })
    // The echoed value lives in a display output (not stdout); it must still surface as the result.
    expect(details?.sections[1]).toMatchObject({ label: 'Output', collapsible: true })
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('pmids')
  })

  it('reads top-level stdout for a repl_execute control-plane result', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'repl',
      stdout: '{\n  "pmids": ["1"]\n}\n',
      outputs: []
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__repl_execute',
      toolKind: 'other',
      rawInput: { code: 'console.log(JSON.stringify(x))' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('"pmids"')
  })

  it('renders a bash_execute run as a Shell command plus output', () => {
    const runSummary = {
      status: 'completed',
      kernelKind: 'bash',
      stdout: 'file.txt\n',
      stderr: '',
      exitCode: 0,
      outputs: []
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__bash_execute',
      toolKind: 'other',
      rawInput: { command: 'ls' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: JSON.stringify(runSummary) } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Shell')
    expect(details?.sections[0]).toMatchObject({ label: 'Command', language: 'bash', text: 'ls' })
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('file.txt')
  })

  it('summarizes a manage_packages install with method and a cleaned log, not raw JSON', () => {
    const result = {
      ok: true,
      needsRestart: false,
      method: 'cran',
      log: 'trying URL ...\n\n\n\ndownloaded 1.1 MB\n'
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'r', packages: ['jsonlite'] },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Manage packages')
    expect(details?.subtitle).toBe('jsonlite')
    expect(details?.metaLabel).toBe('cran')

    const logSection = details?.sections.find(
      (section) => section.kind === 'code' && section.label === 'Log'
    )

    expect(logSection?.kind === 'code' && logSection.collapsible).toBe(true)
    // The raw { ok, method, ... } envelope must not be dumped; the cleaned install log shows instead.
    expect(logSection?.kind === 'code' && logSection.text).not.toContain('"ok"')
    expect(logSection?.kind === 'code' && logSection.text).toContain('downloaded 1.1 MB')
  })

  it('shows the manage_packages command and install location, not just the log', () => {
    const result = {
      ok: true,
      needsRestart: false,
      method: 'conda',
      prefix: '/Users/x/OpenScience/runtime/envs/analysis',
      log: 'done'
    }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'python', packages: ['numpy', 'pandas'], environment: 'analysis' },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })
    const details = buildToolActivityDetails(activity)

    const commandSection = details?.sections.find(
      (section) => section.kind === 'code' && section.label === 'Command'
    )
    expect(commandSection?.kind === 'code' && commandSection.text).toContain(
      'manage_packages(language="python", packages=["numpy", "pandas"], environment="analysis")'
    )
    // The concrete env-scoped install location is surfaced (the "where is it installed" ask).
    expect(commandSection?.kind === 'code' && commandSection.text).toContain(
      'installs into  /Users/x/OpenScience/runtime/envs/analysis'
    )
  })

  it('flags a manage_packages result that needs a restart', () => {
    const result = { ok: true, needsRestart: true, method: 'conda', log: 'done' }
    const activity = createActivity({
      providerToolName: 'mcp__open-science-notebook__manage_packages',
      toolKind: 'other',
      rawInput: { language: 'python', packages: ['numpy', 'pandas'] },
      toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.subtitle).toBe('numpy, pandas')
    expect(details?.metaLabel).toBe('conda · restart needed')
  })

  it('renders an image artifact-write result as an inline preview section', () => {
    const activity = createActivity({
      providerToolName: 'write_artifact_file',
      toolKind: 'other',
      title: 'Write artifact file',
      rawInput: {
        filename: 'report.png',
        mimeType: 'image/png',
        content: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=',
        encoding: 'base64'
      },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              artifact: {
                name: 'report.png',
                path: '/files/report.png',
                mimeType: 'image/png',
                size: 2048
              }
            })
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('report.png')
    expect(details?.metaLabel).toBe('2 KB')
    expect(details?.sections).toHaveLength(1)

    const section = details?.sections[0]

    expect(section).toMatchObject({
      kind: 'image',
      label: 'Output',
      path: '/files/report.png',
      mimeType: 'image/png',
      name: 'report.png',
      sizeLabel: '2 KB'
    })
  })

  it('summarizes a non-image artifact-write MCP tool without echoing file content', () => {
    const activity = createActivity({
      providerToolName: 'write_artifact_file',
      toolKind: 'other',
      title: 'Write artifact file',
      rawInput: {
        filename: 'report.csv',
        mimeType: 'text/csv',
        content: 'a,b\n1,2',
        encoding: 'utf8'
      },
      toolContent: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              artifact: {
                name: 'report.csv',
                path: '/files/report.csv',
                mimeType: 'text/csv',
                size: 2048
              }
            })
          }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('report.csv')
    expect(details?.metaLabel).toBe('2 KB')
    expect(details?.sections).toHaveLength(1)

    const section = details?.sections[0]

    expect(section?.kind).toBe('code')
    expect(section?.kind === 'code' && section.text).toContain('report.csv')
    expect(section?.kind === 'code' && section.text).toContain('/files/report.csv')
    // The raw file content must never be dumped into the transcript.
    expect(section?.kind === 'code' && section.text).not.toContain('a,b')
  })

  it('matches the artifact-write tool by name even when MCP-namespaced', () => {
    const activity = createActivity({
      providerToolName: 'mcp__open-science-artifacts__write_artifact_file',
      toolKind: 'other',
      rawInput: { filename: 'data.csv', content: 'a,b\n1,2', encoding: 'utf8' }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Write file')
    expect(details?.subtitle).toBe('data.csv')
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).not.toContain('a,b')
  })

  it('renders a WebFetch with its URL, prompt, and fetched result', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: 'Fetch https://anthropic.com/news',
      rawInput: { url: 'https://anthropic.com/news', prompt: 'Extract the feature list' },
      toolContent: [
        { type: 'content', content: { type: 'text', text: 'Feature A, Feature B, pricing' } }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Web Fetch')
    expect(details?.subtitle).toBe('https://anthropic.com/news')
    expect(details?.sections.map((section) => section.label)).toEqual(['Prompt', 'Result'])
    expect(details?.sections[1]?.kind === 'code' && details.sections[1].text).toContain('Feature A')
  })

  it('derives the WebFetch URL from a "Fetch <url>" title when raw input is absent', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: 'Fetch https://example.com/page'
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Web Fetch')
    expect(details?.subtitle).toBe('https://example.com/page')
  })

  it('keeps a WebFetch without a trusted URL as a plain chip', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: '"https://example.com/resource"'
    })

    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('summarizes a ToolSearch by the tools it discovered', () => {
    const activity = createActivity({
      providerToolName: 'ToolSearch',
      title: 'ToolSearch',
      toolContent: [
        {
          type: 'content',
          content: { type: 'text', text: 'Tools found: WebSearch, WebFetch, CronCreate' }
        }
      ]
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Tool search')
    expect(details?.subtitle).toBe('WebSearch, WebFetch, CronCreate')
    expect(details?.sections[0]?.kind === 'code' && details.sections[0].text).toContain('WebSearch')
  })

  it('keeps a ToolSearch wrapper without results as a plain chip', () => {
    const activity = createActivity({ providerToolName: 'ToolSearch', title: 'ToolSearch' })

    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('treats a named editor tool as an edit even without the ACP edit kind', () => {
    const activity = createActivity({
      providerToolName: 'Edit',
      toolKind: 'other',
      title: 'Edit',
      toolLocations: [{ path: '/tmp/kiro_tool_test.txt' }],
      rawInput: { path: '/tmp/kiro_tool_test.txt', old_str: 'a', new_str: 'b' }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Edit')
    expect(details?.subtitle).toBe('/tmp/kiro_tool_test.txt')
    expect(isEditActivity(activity)).toBe(true)
  })

  it('drops a generic subtitle that merely repeats the tool name', () => {
    const activity = createActivity({
      providerToolName: 'Monitor',
      toolKind: 'other',
      title: 'Monitor',
      rawInput: { target: 'cpu' }
    })
    const details = buildToolActivityDetails(activity)

    expect(details?.displayName).toBe('Monitor')
    // "Monitor · Monitor" collapses to just the tool name.
    expect(details?.subtitle).toBeUndefined()
  })

  it('keeps web fetch activities as plain chips without detail sections', () => {
    const activity = createActivity({
      providerToolName: 'WebFetch',
      toolKind: 'fetch',
      title: '"https://example.com"',
      toolContent: [
        { type: 'content', content: { type: 'text', text: '[Link](https://example.com/x)' } }
      ]
    })

    expect(buildToolActivityDetails(activity)).toBeUndefined()
  })

  it('returns nothing when a tool has no command, diff, or output to show', () => {
    expect(buildToolActivityDetails(createActivity({ toolKind: 'read' }))).toBeUndefined()
    expect(buildToolActivityDetails(createActivity({ toolKind: 'other' }))).toBeUndefined()
  })

  it('truncates oversized output and flags the truncation', () => {
    const activity = createActivity({
      toolKind: 'other',
      terminalOutput: undefined,
      toolContent: [{ type: 'content', content: { type: 'text', text: 'a'.repeat(25000) } }]
    })
    const details = buildToolActivityDetails(activity)
    const section = details?.sections[0]

    expect(section?.kind).toBe('code')
    expect(section?.kind === 'code' && section.truncated).toBe(true)
    expect(section?.kind === 'code' && section.text.length).toBeLessThan(25000)
  })
})

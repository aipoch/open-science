import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeReplNotebookSource } from './dependency-analysis-repl'
import { projectNotebookDependencies } from './dependency-projection'
import { projectNotebookFileContext } from './dependency-file-context'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { AnalyzedNotebookRun } from './dependency-analysis-types'
import type { FileContextEntry } from './dependency-file-context'

const run = (
  id: string,
  script: string,
  status: NotebookRunRecord['status'] = 'completed'
): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'repl',
  kernelEpochId: 'repl-epoch',
  script,
  status,
  startedAt: Number(id),
  endedAt: Number(id),
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

describe('REPL dependency and file analysis', () => {
  it('loads the pinned official grammar and verifies its checked-in checksum', async () => {
    const root = join(process.cwd(), 'resources/tree-sitter')
    const provenance = JSON.parse(
      await readFile(join(root, 'tree-sitter-javascript.provenance.json'), 'utf8')
    )
    expect(
      createHash('sha256')
        .update(await readFile(join(root, 'tree-sitter-javascript.wasm')))
        .digest('hex')
    ).toBe(provenance.wasmSha256)
    expect((await analyzeReplNotebookSource('globalThis.value = 1')).facts.state).toBe('available')
  })

  it('distinguishes IIFE locals from persistent globals and tracks cross-run reads', async () => {
    const first = await analyzeReplNotebookSource('const local = [1, 2]; globalThis.saved = local;')
    expect(first.facts.definedNames).toEqual(['saved'])
    const second = await analyzeReplNotebookSource(
      'const copy = globalThis.saved; JSON.stringify(copy);',
      projectNotebookFileContext('repl', [
        { facts: first.facts, fileContext: first.fileAccess!.context }
      ])
    )
    expect(second.facts.priorUsedNames).toEqual(['saved'])
    const projection = projectNotebookDependencies([
      { run: run('1', ''), facts: first.facts },
      { run: run('2', ''), facts: second.facts }
    ])
    expect(projection.dependenciesByRunId?.['2']).toEqual(['1'])
    const missing = await analyzeReplNotebookSource('local')
    expect(
      projectNotebookDependencies([{ run: run('3', ''), facts: missing.facts }]).stalenessByRunId[
        '3'
      ]
    ).toMatchObject({ state: 'unknown', reasons: ['kernel-binding-unavailable:local'] })
  })

  it('retains incomplete-run uncertainty and permits an explicit successful replacement', async () => {
    const scripts = [
      'globalThis.saved = [1]',
      'globalThis.saved = [2]; throw Error("failed")',
      'saved',
      'globalThis.saved = [3]',
      'saved'
    ]
    const analyzed = await Promise.all(
      scripts.map(async (script, i) => ({
        run: run(String(i + 1), script, i === 1 ? 'failed' : 'completed'),
        facts: (await analyzeReplNotebookSource(script)).facts
      }))
    )
    const result = projectNotebookDependencies(analyzed)
    const beforeReplacement = projectNotebookDependencies(analyzed.slice(0, 3))
    expect(beforeReplacement.stalenessByRunId['3'].state).toBe('unknown')
    expect(result.stalenessByRunId['5'].state).toBe('clear')
    expect(result.dependenciesByRunId?.['5']).toEqual(['4'])
  })

  it('does not join globals across kernel epochs', async () => {
    const write = (await analyzeReplNotebookSource('globalThis.saved = 1')).facts
    const read = (await analyzeReplNotebookSource('saved')).facts
    const result = projectNotebookDependencies([
      { run: run('1', ''), facts: write },
      { run: { ...run('2', ''), kernelEpochId: 'new-epoch' }, facts: read }
    ])
    expect(result.stalenessByRunId['2'].state).toBe('unknown')
  })

  it('keeps remote MCP evidence partial while retaining variable definitions', async () => {
    const source =
      'globalThis.expression = await host.mcp("expression", "get", { gene: "example" });'
    expect((await analyzeReplNotebookSource(source)).facts).toMatchObject({
      state: 'available',
      definedNames: ['expression']
    })
    expect(await analyzeNotebookSourceFileAccess('repl', source)).toMatchObject({
      externalState: 'partial'
    })
  })

  it('resolves controlled handoff writes without leaking local aliases to the next request', async () => {
    const root = join(process.cwd(), 'handoff')
    const result = await analyzeReplNotebookSource(
      `const fs = require('node:fs'); const path = require('node:path'); const h = process.env.OPEN_SCIENCE_HANDOFF_DIR; fs.writeFileSync(path.join(h, 'data.json'), JSON.stringify([1,2]));`,
      {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        managedEnvironment: { OPEN_SCIENCE_HANDOFF_DIR: root }
      }
    )
    expect(result.fileAccess).toMatchObject({
      writes: [join(root, 'data.json')],
      reads: [],
      unresolvedWrites: false
    })
    expect(result.fileAccess?.context.staticStrings).toEqual([])
    expect(result.facts.definedNames).toEqual([])
  })

  it('carries plain-data identities through completed globals and handles local loop variables', async () => {
    const first = await analyzeReplNotebookSource('globalThis.rows = [{name: "a"}];')
    const context = projectNotebookFileContext('repl', [
      { facts: first.facts, fileContext: first.fileAccess!.context }
    ])
    const next = await analyzeReplNotebookSource(
      'const names = rows.map(row => row.name); const result = {}; for (const name of names) { result[name] = name; } globalThis.names = result;',
      context
    )
    expect(next.facts).toMatchObject({
      state: 'available',
      priorUsedNames: ['rows'],
      definedNames: ['names']
    })
  })

  it('reconstructs the remote-data aggregation and handoff pattern across requests', async () => {
    const scripts = [
      `globalThis.response = await host.mcp('catalog', 'lookup', {query: 'example'});`,
      `const rec = response.record || response;
       const rows = Array.isArray(rec.rows) ? rec.rows : (rec.rows ? [rec.rows] : []);
       const totals = {};
       for (const row of rows) {
         if (!totals[row.name]) totals[row.name] = {names: new Set(), count: 0};
         totals[row.name].names.add(row.name);
         totals[row.name].count += 1;
       }
       const summary = Object.values(totals).map(t => ({size: t.names.size, count: t.count}));
       summary.sort((a, b) => b.count - a.count);
       globalThis.summary = summary;`,
      `const candidates = [0, ...summary.map(t => t.count)];
       try { candidates.filter(Boolean); } catch (err) { String(err).slice(0, 100); }
       globalThis.candidates = candidates;`,
      `const fs = require('fs'); const path = require('path');
       fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_HANDOFF_DIR, 'data.json'),
         JSON.stringify(globalThis.candidates));`
    ]
    const entries: FileContextEntry[] = []
    const analyzed: AnalyzedNotebookRun[] = []
    for (const [index, script] of scripts.entries()) {
      const result = await analyzeReplNotebookSource(script, {
        staticStrings: [],
        staticCollections: [],
        localFileWrappers: [],
        ...projectNotebookFileContext('repl', entries),
        managedEnvironment: { OPEN_SCIENCE_HANDOFF_DIR: join(process.cwd(), 'handoff') }
      })
      expect(result.facts.state, `request ${index + 1}`).toBe('available')
      entries.push({ facts: result.facts, fileContext: result.fileAccess!.context })
      analyzed.push({ run: run(String(index + 1), script), facts: result.facts })
      if (index === 3)
        expect(result.fileAccess).toMatchObject({
          writes: [join(process.cwd(), 'handoff', 'data.json')],
          unresolvedWrites: false
        })
    }
    const projection = projectNotebookDependencies(analyzed)
    expect(projection.dependenciesByRunId?.['2']).toEqual(['1'])
    expect(projection.dependenciesByRunId?.['3']).toEqual(['2'])
    expect(projection.dependenciesByRunId?.['4']).toEqual(['3'])
    expect(projection.stalenessByRunId['4'].state).toBe('clear')
  })

  it('retains uncertainty for conditional writes and paths selected by logical expressions', async () => {
    const result = await analyzeReplNotebookSource(
      `flag && (globalThis.saved = [1]);
       const fs = require('fs'); fs.readFileSync(flag ? 'first.json' : 'second.json');`
    )
    expect(result.facts.conditionallyDefinedNames).toEqual(['saved'])
    expect(result.fileAccess).toMatchObject({ reads: [], unresolvedReads: true })
  })

  it('captures I/O in computed object keys and rejects callable properties disguised as methods', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'repl',
        `const fs = require('fs'); const value = {[fs.writeFileSync('key.json', 'x')]: 1};`
      )
    ).toMatchObject({ writes: ['key.json'] })
    for (const source of [
      `const fake = {map: require('fs').writeFileSync}; fake.map('hidden.json', 'x');`,
      `const fake = {}; fake.map = require('fs').writeFileSync; fake.map('hidden.json', 'x');`,
      `const fake = {map: Object.values({f: require('fs').writeFileSync})[0]}; fake.map('hidden.json', 'x');`,
      `const fake = {map: [0].map(() => require('fs').writeFileSync)[0]}; fake.map('hidden.json', 'x');`
    ])
      expect((await analyzeNotebookSourceFileAccess('repl', source)).writeState).toBe('partial')
  })

  it('does not claim definite coverage for conditional I/O', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'repl',
        `const fs = require('fs'); if (flag) fs.readFileSync('maybe.json');`
      )
    ).toMatchObject({ readState: 'partial' })
    expect(
      await analyzeNotebookSourceFileAccess(
        'repl',
        `const fs = require('fs'); flag && fs.writeFileSync('maybe.json', 'x');`
      )
    ).toMatchObject({ writeState: 'partial' })
  })

  it('distinguishes declared loop variables from assignments to globals', async () => {
    expect((await analyzeReplNotebookSource('for (existing of [1, 2]) {}')).facts).toMatchObject({
      conditionallyDefinedNames: ['existing']
    })
    expect(
      (await analyzeReplNotebookSource('for (const existing of [1, 2]) {}')).facts
    ).toMatchObject({ conditionallyDefinedNames: [] })
  })

  it('retains reference aliases returned by collection methods', async () => {
    const scripts = [
      'globalThis.rows = [{value: 1}]',
      'globalThis.item = rows.find(row => row.value === 1)',
      'item.value = 2',
      'rows'
    ]
    const entries: FileContextEntry[] = []
    const analyzed: AnalyzedNotebookRun[] = []
    for (const [index, script] of scripts.entries()) {
      const result = await analyzeReplNotebookSource(
        script,
        projectNotebookFileContext('repl', entries)
      )
      entries.push({ facts: result.facts, fileContext: result.fileAccess!.context })
      analyzed.push({ run: run(String(index + 1), script), facts: result.facts })
    }
    const projection = projectNotebookDependencies(analyzed)
    expect(projection.stalenessByRunId['4']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['possible-alias'])
    })
    expect(projectNotebookFileContext('repl', entries)?.replContainerNames).not.toContain('rows')
  })

  it.each(['() => rows', '() => { return rows; }'])(
    'retains references returned from collection callbacks: %s',
    async (callback) => {
      const result = await analyzeReplNotebookSource(
        `globalThis.rows = [{value: 1}]; globalThis.box = [0].map(${callback});`
      )
      expect(result.facts.aliases).toContainEqual({
        target: 'box',
        source: 'rows',
        kind: 'possible-reference'
      })
    }
  )

  it.each([
    'globalThis[key] = 1',
    'eval(code)',
    "require('child_process').execSync('anything')",
    "const fs = require('node:fs'); fs.writeFileSync(path, 'x', {flag: 'a'})"
  ])('keeps unmodeled effects conservative: %s', async (source) => {
    const result = await analyzeNotebookSourceFileAccess('repl', source)
    expect(result.writeState).not.toBe('complete')
  })

  it('does not promote a conditional local path to a confirmed input', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'repl',
      "const fs = require('fs'); let path = 'first.json'; if (flag) path = 'second.json'; fs.readFileSync(path)"
    )
    expect(result.readState).toBe('partial')
    expect(result.reads).toEqual([])
  })

  it('tracks mutations through array callback parameters', async () => {
    const result = await analyzeReplNotebookSource('rows.map(row => { row.value = 1; });', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      replContainerNames: ['rows'],
      resolvedKernelNames: ['rows']
    })
    expect(result.facts.possiblyMutatedNames).toContain('rows')
    expect(result.facts.state).toBe('unknown')
  })

  it('does not restore trusted builtin calls after a namespace mutation', async () => {
    const first = await analyzeReplNotebookSource('globalThis.JSON = replacement')
    const context = projectNotebookFileContext('repl', [
      { facts: first.facts, fileContext: first.fileAccess!.context }
    ])
    const result = await analyzeNotebookSourceFileAccess('repl', 'JSON.stringify([1])', context)
    expect(result.writeState).toBe('partial')
  })

  it('rebuilds REPL facts after reload and keeps launch paths transient', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'repl-analysis-'))
    const runs = [
      run('1', 'globalThis.rows = [1, 2]'),
      run('2', 'globalThis.other = 1; throw Error("failed")', 'failed'),
      run('3', 'JSON.stringify(rows)')
    ]
    const repository = { readSessionRuns: async () => runs }
    try {
      const analyzer = new NotebookDependencyAnalyzer({ storageRoot, repository })
      expect(
        (await analyzer.project({ projectId: 'project', sessionId: 'session' }))
          .dependenciesByRunId?.['3']
      ).toEqual(['1'])
      const reloaded = new NotebookDependencyAnalyzer({ storageRoot, repository })
      const context = await reloaded.sourceFileAccessContext({
        projectId: 'project',
        sessionId: 'session',
        currentRunId: 'next',
        language: 'repl',
        kernelEpochId: 'repl-epoch',
        includeManagedEnvironment: true
      })
      expect(context).toMatchObject({
        managedEnvironmentSafe: true,
        resolvedKernelNames: ['rows'],
        replContainerNames: ['rows']
      })
      const cache = await readFile(
        join(storageRoot, 'notebooks/project/session/cache/dependency-analysis.json'),
        'utf8'
      )
      expect(cache).not.toContain('managedEnvironment')
      expect(cache).not.toContain('replContainerNames')
      runs.push(run('4', "process.env.OPEN_SCIENCE_HANDOFF_DIR = '/changed'"))
      expect(
        await reloaded.sourceFileAccessContext({
          projectId: 'project',
          sessionId: 'session',
          currentRunId: 'next',
          language: 'repl',
          kernelEpochId: 'repl-epoch',
          includeManagedEnvironment: true
        })
      ).toMatchObject({ managedEnvironmentSafe: false })
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('does not recover a namespace after a failed opaque call', async () => {
    const first = await analyzeReplNotebookSource('eval(code); throw Error("failed")')
    const next = await analyzeReplNotebookSource('globalThis.clean = 1')
    const projection = projectNotebookDependencies([
      { run: run('1', '', 'failed'), facts: first.facts },
      { run: run('2', ''), facts: next.facts }
    ])
    expect(projection.stalenessByRunId['2'].state).toBe('unknown')
  })

  it('keeps append inputs and explicit Windows path semantics', async () => {
    const result = await analyzeNotebookSourceFileAccess(
      'repl',
      'const fs = require("fs"); const path = require("path"); fs.appendFileSync(path.win32.join("C:\\\\handoff", "rows.json"), "x")'
    )
    expect(result).toMatchObject({
      reads: ['C:\\handoff\\rows.json'],
      writes: ['C:\\handoff\\rows.json'],
      readState: 'complete',
      writeState: 'complete'
    })
  })
})

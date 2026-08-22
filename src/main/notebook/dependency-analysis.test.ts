import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { findPythonCommand } from './python-command'
import { findRCommand } from './r-command'
import {
  NotebookDependencyAnalyzer,
  projectNotebookDependencies,
  unavailableNotebookDependencyProjection
} from './dependency-analysis'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const run = (
  runId: string,
  cellId: string,
  script: string,
  executionCount: number
): NotebookRunRecord => ({
  runId,
  cellId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'python',
  kernelEpochId: 'epoch-1',
  environment: 'default-python',
  script,
  status: 'completed',
  startedAt: executionCount,
  endedAt: executionCount,
  executionCount,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

describe('projectNotebookDependencies', { timeout: 60_000 }, () => {
  it('keeps a result clear when it only reads a variable after its first definition', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-0', 'define-x', 'x = [10, 20, 30]', 0),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-1', 'sum-x', 'y = sum(x)', 1),
        facts: {
          state: 'available',
          definedNames: ['y'],
          usedNames: ['x'],
          mutatedNames: [],
          safeCallNames: ['sum'],
          safeCallArgumentNames: ['x']
        }
      }
    ])

    expect(projection.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('marks an earlier dependent run stale when a new cell redefines its input', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-data', 'x = 1', 1),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'make-result', 'y = x + 1', 2),
        facts: { state: 'available', definedNames: ['y'], usedNames: ['x'], mutatedNames: [] }
      },
      {
        run: run('run-3', 'new-call', 'x = 2', 3),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'stale',
      causedByRunId: 'run-3',
      names: ['x'],
      path: ['run-1', 'run-2']
    })
    expect(projection.invalidatedByRunId['run-3']).toEqual([
      { runId: 'run-2', cellId: 'make-result', names: ['x'], state: 'stale' }
    ])
  })

  it('keeps later results stale when they consume an invalidated value', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare', 'x = 1', 1),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'derive', 'y = x + 1', 2),
        facts: { state: 'available', definedNames: ['y'], usedNames: ['x'], mutatedNames: [] }
      },
      {
        run: run('run-3', 'replace', 'x = 2', 3),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-4', 'consume-old', 'z = y + 1', 4),
        facts: { state: 'available', definedNames: ['z'], usedNames: ['y'], mutatedNames: [] }
      }
    ])

    expect(projection.stalenessByRunId['run-4']).toEqual({
      state: 'stale',
      causedByRunId: 'run-3',
      names: ['x'],
      path: ['run-1', 'run-2', 'run-4']
    })
  })

  it('shares dependency state across root provenance in the same kernel epoch', () => {
    const projection = projectNotebookDependencies([
      {
        run: { ...run('run-1', 'prepare-data', 'x = 1', 1), agentFrameId: 'root-before' },
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: { ...run('run-2', 'make-result', 'y = x', 2), agentFrameId: 'root-after' },
        facts: {
          state: 'available',
          definedNames: ['y'],
          usedNames: ['x'],
          mutatedNames: []
        }
      },
      {
        run: { ...run('run-3', 'update-data', 'x = 2', 3), agentFrameId: 'root-before' },
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'stale',
      causedByRunId: 'run-3',
      names: ['x'],
      path: ['run-1', 'run-2']
    })
  })

  it('keeps dependency state isolated across kernel epochs', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-data', 'x = 1', 1),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: { ...run('run-2', 'update-data', 'x = 2', 2), kernelEpochId: 'epoch-2' },
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      }
    ])

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('keeps later results unknown after dynamic namespace code', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'dynamic', "exec('x = 1')", 1),
        facts: { state: 'unknown', reasons: ['dynamic-namespace'] }
      },
      {
        run: run('run-2', 'consume', 'y = x + 1', 2),
        facts: { state: 'available', definedNames: ['y'], usedNames: ['x'], mutatedNames: [] }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['dynamic-namespace']
    })
  })

  it('propagates definite Python aliases when either root is mutated', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-source', 'a = []', 1),
        facts: { state: 'available', definedNames: ['a'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'alias-source', 'b = a', 2),
        facts: {
          state: 'available',
          definedNames: ['b'],
          usedNames: ['a'],
          mutatedNames: [],
          aliases: [{ target: 'b', source: 'a', kind: 'reference' }]
        }
      },
      {
        run: run('run-3', 'consume-source', 'result = len(a)', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['a'],
          mutatedNames: []
        }
      },
      {
        run: run('run-4', 'mutate-alias', 'b.append(1)', 4),
        facts: { state: 'available', definedNames: [], usedNames: ['b'], mutatedNames: ['b'] }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['a']
    })
  })

  it('propagates possible R aliases as unknown instead of stale', () => {
    const projection = projectNotebookDependencies([
      {
        run: { ...run('run-1', 'define-source', 'a <- list()', 1), kernelKind: 'r' },
        facts: { state: 'available', definedNames: ['a'], usedNames: [], mutatedNames: [] }
      },
      {
        run: { ...run('run-2', 'alias-source', 'b <- a', 2), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['b'],
          usedNames: ['a'],
          mutatedNames: [],
          aliases: [{ target: 'b', source: 'a', kind: 'possible-reference' }]
        }
      },
      {
        run: { ...run('run-3', 'consume-source', 'result <- a$value', 3), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['a'],
          mutatedNames: []
        }
      },
      {
        run: { ...run('run-4', 'mutate-alias', 'b$value <- 1', 4), kernelKind: 'r' },
        facts: { state: 'available', definedNames: [], usedNames: ['b'], mutatedNames: ['b'] }
      },
      {
        run: { ...run('run-5', 'consume-after-mutation', 'later <- a$value', 5), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['later'],
          usedNames: ['a'],
          mutatedNames: []
        }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection.stalenessByRunId['run-5']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
  })

  it('does not retain an R alias for a statically known copy-on-modify value', () => {
    const projection = projectNotebookDependencies([
      {
        run: { ...run('run-1', 'define-source', 'a <- list(1, 2, 3)', 1), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['a'],
          usedNames: ['list'],
          mutatedNames: [],
          copyOnModifyNames: ['a']
        }
      },
      {
        run: { ...run('run-2', 'copy-source', 'b <- a', 2), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['b'],
          usedNames: ['a'],
          mutatedNames: [],
          aliases: [{ target: 'b', source: 'a', kind: 'possible-reference' }]
        }
      },
      {
        run: { ...run('run-3', 'consume-source', 'result <- length(a)', 3), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['a', 'length'],
          mutatedNames: []
        }
      },
      {
        run: { ...run('run-4', 'mutate-copy', 'b[[1]] <- 99', 4), kernelKind: 'r' },
        facts: { state: 'available', definedNames: [], usedNames: ['b'], mutatedNames: ['b'] }
      }
    ])

    expect(projection.stalenessByRunId).toMatchObject({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
    expect(projection.invalidatedByRunId['run-4']).toBeUndefined()
  })

  it('uses R statement order when reading an uncertain name around a local replacement', () => {
    const projection = projectNotebookDependencies([
      {
        run: { ...run('run-1', 'define', 'a <- new.env(); c <- new.env()', 1), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['a', 'c'],
          usedNames: [],
          priorUsedNames: [],
          mutatedNames: []
        }
      },
      {
        run: { ...run('run-2', 'alias', 'b <- a; d <- c', 2), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: ['b', 'd'],
          usedNames: ['a', 'c'],
          priorUsedNames: ['a', 'c'],
          mutatedNames: [],
          aliases: [
            { target: 'b', source: 'a', kind: 'possible-reference' },
            { target: 'd', source: 'c', kind: 'possible-reference' }
          ]
        }
      },
      {
        run: { ...run('run-3', 'mutate', 'b$x <- 1; d$x <- 1', 3), kernelKind: 'r' },
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['b', 'd'],
          priorUsedNames: ['b', 'd'],
          mutatedNames: ['b', 'd']
        }
      },
      {
        run: {
          ...run('run-4', 'replace-then-read', 'a <- list(1); resultA <- a[[1]]', 4),
          kernelKind: 'r'
        },
        facts: {
          state: 'available',
          definedNames: ['a', 'resultA'],
          usedNames: ['a', 'list'],
          priorUsedNames: ['list'],
          mutatedNames: [],
          copyOnModifyNames: ['a']
        }
      },
      {
        run: {
          ...run('run-5', 'read-then-replace', 'resultC <- c$x; c <- list(1)', 5),
          kernelKind: 'r'
        },
        facts: {
          state: 'available',
          definedNames: ['c', 'resultC'],
          usedNames: ['c', 'list'],
          priorUsedNames: ['c', 'list'],
          mutatedNames: [],
          copyOnModifyNames: ['c']
        }
      }
    ])

    expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-5']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
  })

  it('breaks a definite alias when its target is rebound', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-source', 'a = []', 1),
        facts: { state: 'available', definedNames: ['a'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'alias-source', 'b = a', 2),
        facts: {
          state: 'available',
          definedNames: ['b'],
          usedNames: ['a'],
          mutatedNames: [],
          aliases: [{ target: 'b', source: 'a', kind: 'reference' }]
        }
      },
      {
        run: run('run-3', 'rebind-alias', 'b = []', 3),
        facts: { state: 'available', definedNames: ['b'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-4', 'consume-source', 'result = len(a)', 4),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['a'],
          mutatedNames: []
        }
      },
      {
        run: run('run-5', 'mutate-rebound', 'b.append(1)', 5),
        facts: { state: 'available', definedNames: [], usedNames: ['b'], mutatedNames: ['b'] }
      }
    ])

    expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('uses the final simple assignment when one Python run rebinds an alias target', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-source', 'a = []', 1),
        facts: { state: 'available', definedNames: ['a'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'rebind-in-run', 'b = a\nb = []', 2),
        facts: { state: 'available', definedNames: ['b'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-3', 'consume-target', 'result = len(b)', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['b'],
          mutatedNames: []
        }
      },
      {
        run: run('run-4', 'mutate-source', 'a.append(1)', 4),
        facts: { state: 'available', definedNames: [], usedNames: ['a'], mutatedNames: ['a'] }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('treats arguments to a shadowed safe call as possible mutations', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-items', 'items = []', 1),
        facts: { state: 'available', definedNames: ['items'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'consume-items', 'size = len(items)', 2),
        facts: {
          state: 'available',
          definedNames: ['size'],
          usedNames: ['items', 'len'],
          mutatedNames: [],
          safeCallNames: ['len'],
          safeCallArgumentNames: ['items']
        }
      },
      {
        run: run('run-3', 'shadow-len', 'len = custom_len', 3),
        facts: {
          state: 'available',
          definedNames: ['len'],
          usedNames: ['custom_len'],
          mutatedNames: [],
          aliases: [{ target: 'len', source: 'custom_len', kind: 'reference' }]
        }
      },
      {
        run: run('run-4', 'call-shadow', 'value = len(items)', 4),
        facts: {
          state: 'available',
          definedNames: ['value'],
          usedNames: ['items', 'len'],
          mutatedNames: [],
          safeCallNames: ['len'],
          safeCallArgumentNames: ['items']
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
  })

  it('does not project dependency state onto non-data runs', () => {
    const controlRun = { ...run('run-1', 'shell', 'echo ok', 1), kernelKind: 'bash' as const }

    expect(
      projectNotebookDependencies([
        {
          run: controlRun,
          facts: { state: 'available', definedNames: [], usedNames: [], mutatedNames: [] }
        }
      ]).stalenessByRunId
    ).toEqual({})
    expect(unavailableNotebookDependencyProjection([controlRun]).stalenessByRunId).toEqual({})
  })

  it.each(['failed', 'timeout', 'interrupted', 'cancelled'] as const)(
    'scopes uncertainty from a %s run to variables it may have changed',
    (status) => {
      const incompleteRun = {
        ...run('run-3', 'partial-update', 'partial = 1\nx.append(2)\nraise RuntimeError()', 3),
        status
      }
      const projection = projectNotebookDependencies([
        {
          run: run('run-1', 'prepare-data', 'x = []', 1),
          facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
        },
        {
          run: run('run-2', 'consume-data', 'size = len(x)', 2),
          facts: {
            state: 'available',
            definedNames: ['size'],
            usedNames: ['x'],
            mutatedNames: []
          }
        },
        {
          run: incompleteRun,
          facts: {
            state: 'available',
            definedNames: ['partial'],
            usedNames: ['x'],
            mutatedNames: ['x']
          }
        },
        {
          run: run('run-4', 'read-partial', 'value = partial', 4),
          facts: {
            state: 'available',
            definedNames: ['value'],
            usedNames: ['partial'],
            mutatedNames: []
          }
        },
        {
          run: run('run-5', 'unrelated', 'other = 1', 5),
          facts: {
            state: 'available',
            definedNames: ['other'],
            usedNames: [],
            mutatedNames: []
          }
        }
      ])

      expect(projection.stalenessByRunId['run-2']).toEqual({
        state: 'unknown',
        reasons: ['incomplete-run']
      })
      expect(projection.stalenessByRunId['run-3']).toBeUndefined()
      expect(projection.stalenessByRunId['run-4']).toEqual({
        state: 'unknown',
        reasons: ['incomplete-run']
      })
      expect(projection.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    }
  )

  it('ignores a failed run when execution never reached the kernel', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-data', 'x = 1', 1),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'consume-data', 'result = x + 1', 2),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['x'],
          mutatedNames: []
        }
      },
      {
        run: {
          ...run('run-3', 'rejected-update', 'x = 2', 3),
          status: 'failed',
          kernelDispatched: false
        },
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-3']).toBeUndefined()
  })

  it('follows aliases when an incomplete run may mutate their shared root', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-data', 'a = []', 1),
        facts: { state: 'available', definedNames: ['a'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'consume-data', 'size = len(a)', 2),
        facts: {
          state: 'available',
          definedNames: ['size'],
          usedNames: ['a'],
          mutatedNames: []
        }
      },
      {
        run: {
          ...run('run-3', 'partial-alias-update', 'b = a\nb.append(1)\nraise RuntimeError()', 3),
          status: 'failed'
        },
        facts: {
          state: 'available',
          definedNames: ['b'],
          usedNames: ['a', 'b'],
          mutatedNames: ['b'],
          aliases: [{ target: 'b', source: 'a', kind: 'reference' }]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection.stalenessByRunId['run-3']).toBeUndefined()
  })

  it('follows statically known return aliases within an incomplete run', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-array', 'arr = np.arange(3)', 1),
        facts: {
          state: 'available',
          definedNames: ['arr'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'numpy.ndarray',
              kind: 'python-class',
              complete: true,
              fields: [],
              methods: [
                { name: 'reshape', effect: 'read', returnType: 'numpy.ndarray' },
                { name: 'sort', effect: 'mutate' }
              ]
            }
          ],
          typeBindings: [{ target: 'arr', typeName: 'numpy.ndarray' }]
        }
      },
      {
        run: run('run-2', 'consume-array', 'snapshot = arr.copy()', 2),
        facts: {
          state: 'available',
          definedNames: ['snapshot'],
          usedNames: ['arr'],
          mutatedNames: []
        }
      },
      {
        run: {
          ...run(
            'run-3',
            'failed-view-update',
            'view = arr.reshape(-1)\nview.sort()\nraise RuntimeError()',
            3
          ),
          status: 'failed'
        },
        facts: {
          state: 'available',
          definedNames: ['view'],
          usedNames: ['arr', 'view'],
          mutatedNames: [],
          receiverCalls: [
            {
              receiver: 'arr',
              member: 'reshape',
              argumentNames: [],
              resultNames: ['view'],
              keywordArguments: []
            },
            {
              receiver: 'view',
              member: 'sort',
              kind: 'mutating',
              argumentNames: [],
              resultNames: [],
              keywordArguments: []
            }
          ]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection.stalenessByRunId['run-3']).toBeUndefined()
  })

  it('keeps known read-only receiver calls clear when a later statement fails', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-data', 'df = DataFrame()', 1),
        facts: {
          state: 'available',
          definedNames: ['df'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'DataFrame',
              kind: 'python-class',
              complete: true,
              fields: [],
              methods: [{ name: 'head', effect: 'read' }]
            }
          ],
          typeBindings: [{ target: 'df', typeName: 'DataFrame' }]
        }
      },
      {
        run: run('run-2', 'consume-data', 'snapshot = df', 2),
        facts: {
          state: 'available',
          definedNames: ['snapshot'],
          usedNames: ['df'],
          mutatedNames: []
        }
      },
      {
        run: {
          ...run('run-3', 'failed-read', 'df.head()\nraise RuntimeError()', 3),
          status: 'failed'
        },
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['df'],
          mutatedNames: [],
          receiverCalls: [
            {
              receiver: 'df',
              member: 'head',
              argumentNames: [],
              resultNames: [],
              keywordArguments: []
            }
          ]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-3']).toBeUndefined()
  })

  it('keeps class behavior uncertain after an incomplete monkey patch', () => {
    const modelSummary = {
      name: 'Model',
      kind: 'python-class' as const,
      complete: true,
      fields: [],
      methods: [{ name: 'inspect', effect: 'read' as const }]
    }
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'prepare-models', 'a = Model()\nb = Model()', 1),
        facts: {
          state: 'available',
          definedNames: ['Model', 'a', 'b'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [modelSummary],
          typeBindings: [
            { target: 'a', typeName: 'Model' },
            { target: 'b', typeName: 'Model' }
          ]
        }
      },
      {
        run: run('run-2', 'inspect-model', 'result = a.inspect()', 2),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['a'],
          mutatedNames: [],
          receiverCalls: [
            {
              receiver: 'a',
              member: 'inspect',
              argumentNames: [],
              resultNames: ['result'],
              keywordArguments: []
            }
          ]
        }
      },
      {
        run: {
          ...run('run-3', 'failed-patch', 'Model.inspect = replacement\nraise RuntimeError()', 3),
          status: 'failed'
        },
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['Model', 'replacement'],
          mutatedNames: [],
          memberWrites: [{ receiver: 'Model', member: 'inspect', scope: 'type' }]
        }
      },
      {
        run: run('run-4', 'inspect-new-model', 'c = Model()\nnext_result = c.inspect()', 4),
        facts: {
          state: 'available',
          definedNames: ['c', 'next_result'],
          usedNames: ['Model', 'c'],
          mutatedNames: [],
          typeBindings: [{ target: 'c', typeName: 'Model' }],
          receiverCalls: [
            {
              receiver: 'c',
              member: 'inspect',
              argumentNames: [],
              resultNames: ['next_result'],
              keywordArguments: []
            }
          ]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']?.state).toBe('unknown')
    expect(projection.stalenessByRunId['run-3']).toBeUndefined()
    expect(projection.stalenessByRunId['run-4']?.state).toBe('unknown')
  })

  it('keeps R6 behavior uncertain after an incomplete method replacement', () => {
    const rRun = (
      runId: string,
      cellId: string,
      script: string,
      executionCount: number
    ): NotebookRunRecord => ({
      ...run(runId, cellId, script, executionCount),
      kernelKind: 'r' as const,
      environment: 'default-r'
    })
    const projection = projectNotebookDependencies([
      {
        run: rRun('run-1', 'prepare-counter', 'counter <- Counter$new()', 1),
        facts: {
          state: 'available',
          definedNames: ['Counter', 'counter'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Counter',
              kind: 'r-r6',
              complete: true,
              fields: [],
              methods: [{ name: 'get', effect: 'read' }]
            }
          ],
          typeBindings: [{ target: 'counter', typeName: 'Counter' }]
        }
      },
      {
        run: rRun('run-2', 'read-counter', 'result <- counter$get()', 2),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['counter'],
          mutatedNames: [],
          receiverCalls: [
            {
              receiver: 'counter',
              member: 'get',
              argumentNames: [],
              resultNames: ['result'],
              keywordArguments: []
            }
          ]
        }
      },
      {
        run: {
          ...rRun(
            'run-3',
            'failed-replacement',
            'Counter$set("public", "get", replacement)\nstop("failed")',
            3
          ),
          status: 'failed'
        },
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['Counter', 'replacement'],
          mutatedNames: [],
          receiverCalls: [
            {
              receiver: 'Counter',
              member: 'set',
              argumentNames: ['replacement'],
              resultNames: [],
              keywordArguments: []
            }
          ]
        }
      },
      {
        run: rRun(
          'run-4',
          'read-new-counter',
          'next_counter <- Counter$new()\nnext_result <- next_counter$get()',
          4
        ),
        facts: {
          state: 'available',
          definedNames: ['next_counter', 'next_result'],
          usedNames: ['Counter', 'next_counter'],
          mutatedNames: [],
          typeBindings: [{ target: 'next_counter', typeName: 'Counter' }],
          receiverCalls: [
            {
              receiver: 'next_counter',
              member: 'get',
              argumentNames: [],
              resultNames: ['next_result'],
              keywordArguments: []
            }
          ]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']?.state).toBe('unknown')
    expect(projection.stalenessByRunId['run-3']).toBeUndefined()
    expect(projection.stalenessByRunId['run-4']?.state).toBe('unknown')
  })

  it.each(['analysis-unavailable', 'opaque-call'])(
    'keeps the namespace unknown after %s hides possible bindings',
    (reason) => {
      const projection = projectNotebookDependencies([
        {
          run: run('run-1', 'hidden-binding', 'hidden_side_effect()', 1),
          facts: { state: 'unknown', reasons: [reason] }
        },
        {
          run: run('run-2', 'read-hidden', 'result = hidden', 2),
          facts: {
            state: 'available',
            definedNames: ['result'],
            usedNames: ['hidden'],
            mutatedNames: []
          }
        }
      ])

      expect(projection.stalenessByRunId['run-2']).toEqual({
        state: 'unknown',
        reasons: [reason]
      })
    }
  )

  it('does not retroactively mark unrelated history unknown after an opaque call', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-a', 'a = 1', 1),
        facts: { state: 'available', definedNames: ['a'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'define-b', 'b = 2', 2),
        facts: { state: 'available', definedNames: ['b'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-3', 'opaque', 'hidden_side_effect()', 3),
        facts: { state: 'unknown', reasons: ['opaque-call'] }
      },
      {
        run: run('run-4', 'read-hidden', 'result = hidden', 4),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['hidden'],
          mutatedNames: []
        }
      }
    ])

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
    expect(projection.stalenessByRunId['run-4']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
  })

  it('limits opaque mutation uncertainty to the receiver dependency chain', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'unrelated-source', 'x = 1', 1),
        facts: { state: 'available', definedNames: ['x'], usedNames: [], mutatedNames: [] }
      },
      {
        run: run('run-2', 'unrelated-result', 'y = x + 1', 2),
        facts: { state: 'available', definedNames: ['y'], usedNames: ['x'], mutatedNames: [] }
      },
      {
        run: run('run-3', 'model', 'model = make_model()', 3),
        facts: {
          state: 'available',
          definedNames: ['model'],
          usedNames: ['make_model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-4', 'model-result', 'result = model', 4),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-5', 'fit', 'model.fit(data)', 5),
        facts: {
          state: 'unknown',
          reasons: ['opaque-mutation'],
          usedNames: ['model', 'data'],
          possiblyMutatedNames: ['model']
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection.invalidatedByRunId['run-5']).toEqual([
      {
        runId: 'run-4',
        cellId: 'model-result',
        names: ['model'],
        state: 'unknown',
        reasons: ['opaque-mutation']
      }
    ])
  })

  it('persists analysis facts in a rebuildable sidecar', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-dependencies-'))
    temporaryRoots.push(storageRoot)
    const runs = [
      run('run-1', 'prepare-data', 'x = 1', 1),
      run('run-2', 'make-result', 'y = x', 2),
      run('run-3', 'new-call', 'x = 2', 3)
    ]
    const analyze = vi.fn(async (_interpreter, _language, sources: readonly string[]) =>
      sources.map((source) =>
        source.startsWith('y')
          ? {
              state: 'available' as const,
              definedNames: ['y'],
              usedNames: ['x'],
              mutatedNames: [],
              aliases: [{ target: 'y', source: 'x', kind: 'reference' as const }]
            }
          : {
              state: 'available' as const,
              definedNames: ['x'],
              usedNames: [],
              mutatedNames: []
            }
      )
    )
    const repository = { readSessionRuns: vi.fn(async () => runs) }
    const analyzer = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })

    const first = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: runs[2],
      interpreter: { command: 'python' }
    })
    expect(first.stalenessByRunId['run-2']?.state).toBe('stale')
    await expect(
      readFile(
        join(
          storageRoot,
          'notebooks',
          'default-project',
          'session-1',
          'cache',
          'dependency-analysis.json'
        ),
        'utf8'
      ).then((contents) => JSON.parse(contents) as unknown)
    ).resolves.toMatchObject({ version: 1, analyzerVersion: 1 })

    const restored = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => {
        throw new Error('cached analysis should be reused')
      })
    })
    await expect(
      restored.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toEqual(first)
  })

  it('retries a cached transient analyzer failure on the next projection', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-retry-dependencies-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'prepare-data', 'x = 1', 1)
    const analyze = vi
      .fn()
      .mockResolvedValueOnce([{ state: 'unknown' as const, reasons: ['parser-failed'] }])
      .mockResolvedValueOnce([
        { state: 'available' as const, definedNames: ['x'], usedNames: [], mutatedNames: [] }
      ])
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze
    })
    const request = {
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: analyzedRun,
      interpreter: { command: 'python' }
    }

    await expect(analyzer.project(request)).resolves.toMatchObject({
      stalenessByRunId: { 'run-1': { state: 'unknown', reasons: ['parser-failed'] } }
    })
    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      stalenessByRunId: { 'run-1': { state: 'clear' } }
    })
    expect(analyze).toHaveBeenCalledTimes(2)
  })

  it('uses the persisted external runtime identity when rebuilding facts', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-external-rebuild-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = {
      ...run('run-1', 'prepare-data', 'x = 1', 1),
      runtimeId: '/external/python'
    }
    const analyze = vi.fn(async () => [
      { state: 'available' as const, definedNames: ['x'], usedNames: [], mutatedNames: [] }
    ])
    const resolveInterpreter = vi.fn(async () => ({ command: '/external/python' }))
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze,
      resolveInterpreter
    })

    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({ stalenessByRunId: { 'run-1': { state: 'clear' } } })
    expect(resolveInterpreter).toHaveBeenCalledWith(analyzedRun)
    expect(analyze).toHaveBeenCalledWith({ command: '/external/python' }, 'python', ['x = 1'])
  })

  it('preserves external R conda activation metadata when rebuilding facts', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-external-r-rebuild-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = {
      ...run('run-1', 'prepare-data', 'x <- 1', 1),
      kernelKind: 'r' as const,
      environment: 'default-r',
      runtimeId: 'external-r'
    }
    const analyze = vi.fn(async () => [
      { state: 'available' as const, definedNames: ['x'], usedNames: [], mutatedNames: [] }
    ])
    const interpreter = {
      command: 'C:\\miniforge\\envs\\analysis\\Lib\\R\\bin\\Rscript.exe',
      condaPrefix: 'C:\\miniforge\\envs\\analysis'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze,
      resolveInterpreter: vi.fn(async () => interpreter)
    })

    await analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledWith(interpreter, 'r', ['x <- 1'])
  })

  it('does not rebuild external-runtime facts with a managed interpreter', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-runtime-rebuild-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = {
      ...run('run-1', 'prepare-data', 'x = 1', 1),
      runtimeId: '/missing/python'
    }
    const analyze = vi.fn()
    const resolveInterpreter = vi.fn(async () => undefined)
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze,
      resolveInterpreter
    })

    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      stalenessByRunId: { 'run-1': { state: 'unknown', reasons: ['parser-unavailable'] } }
    })
    expect(resolveInterpreter).toHaveBeenCalledWith(analyzedRun)
    expect(analyze).not.toHaveBeenCalled()
  })

  it('resolves each external runtime once while rebuilding a history', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-external-runtime-cache-'))
    temporaryRoots.push(storageRoot)
    const sharedRuntime = 'external-python'
    const otherRuntime = 'other-python'
    const runs = [
      { ...run('run-1', 'prepare-shared', 'x = 1', 1), runtimeId: sharedRuntime },
      { ...run('run-2', 'use-shared', 'y = x + 1', 2), runtimeId: sharedRuntime },
      { ...run('run-3', 'prepare-other', 'z = 1', 3), runtimeId: otherRuntime }
    ]
    const resolveInterpreter = vi.fn(async (candidate: NotebookRunRecord) =>
      candidate.runtimeId === sharedRuntime ? { command: sharedRuntime } : { command: otherRuntime }
    )
    const analyze = vi.fn(async (_interpreter, _language, sources: readonly string[]) =>
      sources.map(() => ({
        state: 'available' as const,
        definedNames: ['x'],
        usedNames: [],
        mutatedNames: []
      }))
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) },
      analyze,
      resolveInterpreter
    })

    await analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(resolveInterpreter).toHaveBeenCalledTimes(2)
    expect(resolveInterpreter.mock.calls.map(([candidate]) => candidate.runtimeId).sort()).toEqual([
      sharedRuntime,
      otherRuntime
    ])
  })

  it('caches an unavailable external runtime for the rest of a projection', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-runtime-cache-'))
    temporaryRoots.push(storageRoot)
    const runtimeId = 'missing-python'
    const runs = [
      { ...run('run-1', 'prepare-data', 'x = 1', 1), runtimeId },
      { ...run('run-2', 'use-data', 'y = x + 1', 2), runtimeId }
    ]
    const resolveInterpreter = vi.fn(async () => undefined)
    const analyze = vi.fn()
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) },
      analyze,
      resolveInterpreter
    })

    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      stalenessByRunId: {
        'run-1': { state: 'unknown', reasons: ['parser-unavailable'] },
        'run-2': { state: 'unknown', reasons: ['parser-unavailable'] }
      }
    })
    expect(resolveInterpreter).toHaveBeenCalledTimes(1)
    expect(analyze).not.toHaveBeenCalled()
  })

  it('does not derive a managed interpreter from an unsafe persisted environment', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-unsafe-env-rebuild-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = {
      ...run('run-1', 'prepare-data', 'x = 1', 1),
      environment: '../../project-controlled'
    }
    const analyze = vi.fn()
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze
    })

    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      stalenessByRunId: { 'run-1': { state: 'unknown', reasons: ['parser-unavailable'] } }
    })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('reuses a cached non-transient unknown analysis after restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-unknown-dependencies-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'opaque-call', 'hidden_side_effect()', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [{ state: 'unknown' as const, reasons: ['opaque-call'] }])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })

    const analyze = vi.fn(async () => {
      throw new Error('non-transient analysis should be reused')
    })
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })

    await expect(
      restored.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({
      stalenessByRunId: { 'run-1': { state: 'unknown', reasons: ['opaque-call'] } }
    })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('discards a corrupt sidecar and rebuilds it', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-corrupt-dependencies-'))
    temporaryRoots.push(storageRoot)
    const cacheRoot = join(storageRoot, 'notebooks', 'default-project', 'session-1', 'cache')
    await mkdir(cacheRoot, { recursive: true })
    await writeFile(
      join(cacheRoot, 'dependency-analysis.json'),
      JSON.stringify({
        version: 1,
        analyzerVersion: 1,
        runs: { 'run-1': { checksum: 'corrupt', facts: 'not-an-object' } }
      })
    )
    const analyzedRun = run('run-1', 'prepare', 'x = 1', 1)
    const analyze = vi.fn(async () => [
      { state: 'available' as const, definedNames: ['x'], usedNames: [], mutatedNames: [] }
    ])
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze
    })

    await analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledOnce()
  })

  it('rebuilds a matching current sidecar when available aliases are malformed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-corrupt-aliases-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'alias', 'b = a', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const facts = {
      state: 'available' as const,
      definedNames: ['b'],
      usedNames: ['a'],
      mutatedNames: [],
      aliases: [{ target: 'b', source: 'a', kind: 'reference' as const }]
    }
    const sidecarPath = join(
      storageRoot,
      'notebooks',
      'default-project',
      'session-1',
      'cache',
      'dependency-analysis.json'
    )
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [facts])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
      runs: Record<string, { facts: { aliases: unknown } }>
    }
    sidecar.runs['run-1']!.facts.aliases = [{ target: 'b', source: 42, kind: 'reference' }]
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const analyze = vi.fn(async () => [facts])
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledOnce()
  })

  it('rebuilds a matching current sidecar when built-in container metadata is malformed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-corrupt-containers-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'container', 'a = {}', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const facts = {
      state: 'available' as const,
      definedNames: ['a'],
      usedNames: [],
      mutatedNames: [],
      builtinContainerNames: ['a']
    }
    const sidecarPath = join(
      storageRoot,
      'notebooks',
      'default-project',
      'session-1',
      'cache',
      'dependency-analysis.json'
    )
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [facts])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
      runs: Record<string, { facts: { builtinContainerNames: unknown } }>
    }
    sidecar.runs['run-1']!.facts.builtinContainerNames = [42]
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const analyze = vi.fn(async () => [facts])
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledOnce()
  })

  it.each([
    'priorUsedNames',
    'possiblyUsedNames',
    'copyOnModifyNames',
    'copyOnModifyBindings',
    'copyOnModifyInvalidatedNames'
  ] as const)(
    'rebuilds a matching current sidecar when %s metadata is missing',
    async (missingField) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-copy-on-modify-'))
      temporaryRoots.push(storageRoot)
      const analyzedRun = {
        ...run('run-1', 'r-list', 'a <- list(1)', 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
      const facts = {
        state: 'available' as const,
        definedNames: ['a'],
        usedNames: ['list'],
        mutatedNames: [],
        copyOnModifyNames: ['x'],
        copyOnModifyBindings: [{ target: 'a', sourceNames: ['x'] }]
      }
      const sidecarPath = join(
        storageRoot,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      )
      const initial = new NotebookDependencyAnalyzer({
        storageRoot,
        repository,
        analyze: vi.fn(async () => [facts])
      })
      await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
        runs: Record<string, { facts: Record<string, unknown> }>
      }
      delete sidecar.runs['run-1']!.facts[missingField]
      await writeFile(sidecarPath, JSON.stringify(sidecar))

      const analyze = vi.fn(async () => [facts])
      const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
      await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

      expect(analyze).toHaveBeenCalledOnce()
    }
  )

  it('restores callable receiver facts from a current v1 sidecar without reanalysis', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-callable-sidecar-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'call', 'from numpy import sin\ny = sin(x)', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const facts = {
      state: 'available' as const,
      definedNames: ['sin', 'y'],
      usedNames: ['x'],
      mutatedNames: [],
      typeSummaries: [
        {
          name: 'python-callable:numpy.sin',
          kind: 'python-class' as const,
          fields: [],
          methods: [{ name: '__call__', effect: 'read' as const }]
        }
      ],
      receiverCalls: [
        {
          receiver: 'python-callable:numpy.sin',
          member: '__call__',
          kind: 'callable' as const,
          argumentNames: ['x'],
          resultNames: ['y'],
          keywordArguments: []
        }
      ]
    }
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [facts])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })

    const analyze = vi.fn(async () => [facts])
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).not.toHaveBeenCalled()
  })

  it('restores unpacked keyword effects from a current v1 sidecar without reanalysis', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-unpacked-keyword-sidecar-'))
    temporaryRoots.push(storageRoot)
    const runs = [
      run('run-1', 'features', 'features = [[1.0], [2.0]]', 1),
      run('run-2', 'snapshot', 'snapshot = len(features)', 2),
      run('run-3', 'import', 'import sklearn.preprocessing as preprocessing', 3),
      run('run-4', 'construct', 'model = preprocessing.StandardScaler()', 4),
      run('run-5', 'configure', 'model.set_params(**params)', 5),
      run('run-6', 'transform', 'model.transform(features)', 6)
    ]
    const typeSummaries = [
      {
        name: 'sklearn.preprocessing',
        kind: 'python-module' as const,
        fields: [],
        methods: [
          {
            name: 'StandardScaler',
            effect: 'read' as const,
            returnType: 'sklearn.preprocessing.StandardScaler'
          }
        ]
      },
      {
        name: 'sklearn.preprocessing.StandardScaler',
        kind: 'python-class' as const,
        fields: [],
        methods: [
          {
            name: 'set_params',
            effect: 'mutate' as const,
            returnType: 'sklearn.preprocessing.StandardScaler'
          },
          { name: 'transform', effect: 'read' as const, returnType: 'numpy.ndarray' }
        ]
      },
      {
        name: 'sklearn.preprocessing.StandardScaler.copy-uncertain',
        kind: 'python-class' as const,
        fields: [],
        methods: [
          {
            name: 'set_params',
            effect: 'mutate' as const,
            returnType: 'sklearn.preprocessing.StandardScaler.copy-uncertain'
          },
          { name: 'transform', effect: 'read' as const, returnType: 'numpy.ndarray' }
        ]
      }
    ]
    const facts = [
      { state: 'available' as const, definedNames: ['features'], usedNames: [], mutatedNames: [] },
      {
        state: 'available' as const,
        definedNames: ['snapshot'],
        usedNames: ['features'],
        mutatedNames: []
      },
      {
        state: 'available' as const,
        definedNames: ['preprocessing'],
        usedNames: [],
        mutatedNames: [],
        typeSummaries,
        typeBindings: [
          { target: 'preprocessing', typeName: 'sklearn.preprocessing', argumentNames: [] }
        ]
      },
      {
        state: 'available' as const,
        definedNames: ['model'],
        usedNames: ['preprocessing'],
        mutatedNames: [],
        receiverCalls: [
          {
            receiver: 'preprocessing',
            member: 'StandardScaler',
            argumentNames: [],
            resultNames: ['model'],
            keywordArguments: []
          }
        ]
      },
      {
        state: 'available' as const,
        definedNames: [],
        usedNames: ['model', 'params'],
        mutatedNames: [],
        receiverCalls: [
          {
            receiver: 'model',
            member: 'set_params',
            argumentNames: ['params'],
            resultNames: [],
            keywordArguments: [
              {
                name: '**',
                argumentNames: ['params'],
                possibleArgumentNames: [],
                staticBoolean: null,
                callableReferences: []
              }
            ]
          }
        ]
      },
      {
        state: 'available' as const,
        definedNames: [],
        usedNames: ['model', 'features'],
        mutatedNames: [],
        receiverCalls: [
          {
            receiver: 'model',
            member: 'transform',
            argumentNames: ['features'],
            positionalArgumentNames: [['features']],
            positionalStaticBooleans: [null],
            resultNames: [],
            keywordArguments: []
          }
        ]
      }
    ]
    const repository = { readSessionRuns: vi.fn(async () => runs) }
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => facts)
    })
    const first = await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
    expect(first.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })

    const analyze = vi.fn(async () => facts)
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    const second = await restored.project({
      projectId: 'default-project',
      sessionId: 'session-1'
    })

    expect(analyze).not.toHaveBeenCalled()
    expect(second.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('rebuilds a matching current sidecar when type summaries are malformed', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-corrupt-type-summary-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'class', 'class Counter: pass', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const facts = {
      state: 'available' as const,
      definedNames: ['Counter'],
      usedNames: [],
      mutatedNames: [],
      typeSummaries: [
        {
          name: 'Counter',
          kind: 'python-class' as const,
          fields: [{ name: 'value', relationship: 'value' as const }],
          methods: []
        }
      ]
    }
    const sidecarPath = join(
      storageRoot,
      'notebooks',
      'default-project',
      'session-1',
      'cache',
      'dependency-analysis.json'
    )
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [facts])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
      runs: Record<string, { facts: { typeSummaries: unknown } }>
    }
    sidecar.runs['run-1']!.facts.typeSummaries = [
      {
        name: 'Counter',
        kind: 'python-class',
        fields: [{ name: 'value', relationship: 'sometimes' }],
        methods: []
      }
    ]
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const analyze = vi.fn(async () => [facts])
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledOnce()
  })

  it.each([
    'returnType',
    'receiverChain',
    'receiverChainFirstArgumentNames',
    'receiverChainPositionalArgumentNames',
    'receiverChainPositionalStaticBooleans',
    'receiverChainKeywordArguments',
    'receiverChainMetadataLength',
    'receiverValueNames',
    'positionalArgumentNames',
    'positionalStaticBooleans',
    'positionalMetadataLength',
    'resultNames',
    'keywordArguments',
    'keywordArgumentCertainty',
    'keywordStaticBoolean',
    'keywordCallableReferences'
  ] as const)(
    'rebuilds a matching current sidecar when scientific effect %s metadata is missing',
    async (field) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-corrupt-library-effect-'))
      temporaryRoots.push(storageRoot)
      const analyzedRun = run('run-1', 'numpy', 'result = np.cos(x, out=x)', 1)
      const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
      const facts = {
        state: 'available' as const,
        definedNames: ['result'],
        usedNames: ['np', 'x'],
        mutatedNames: ['x'],
        typeSummaries: [
          {
            name: 'numpy',
            kind: 'python-module' as const,
            fields: [],
            methods: [
              {
                name: 'cos',
                effect: 'read' as const,
                returnType: 'numpy.ndarray',
                mutatesKeyword: 'out'
              }
            ]
          }
        ],
        receiverCalls: [
          {
            receiver: 'np',
            member: 'cos',
            argumentNames: ['x'],
            receiverChain: [],
            receiverChainFirstArgumentNames: [],
            receiverChainPositionalArgumentNames: [],
            receiverChainPositionalStaticBooleans: [],
            receiverChainKeywordArguments: [],
            receiverValueNames: ['np'],
            positionalArgumentNames: [],
            positionalStaticBooleans: [],
            resultNames: ['result'],
            keywordArguments: [{ name: 'out', argumentNames: ['x'] }]
          }
        ]
      }
      const sidecarPath = join(
        storageRoot,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      )
      const initial = new NotebookDependencyAnalyzer({
        storageRoot,
        repository,
        analyze: vi.fn(async () => [facts])
      })
      await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
        runs: Record<
          string,
          {
            facts: {
              typeSummaries: Array<{ methods: Array<Record<string, unknown>> }>
              receiverCalls: Array<Record<string, unknown>>
            }
          }
        >
      }
      if (field === 'returnType') {
        delete sidecar.runs['run-1']!.facts.typeSummaries[0]!.methods[0]!.returnType
      } else if (field === 'receiverChain') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverChain
      } else if (field === 'receiverChainFirstArgumentNames') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverChainFirstArgumentNames
      } else if (field === 'receiverChainPositionalArgumentNames') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverChainPositionalArgumentNames
      } else if (field === 'receiverChainPositionalStaticBooleans') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverChainPositionalStaticBooleans
      } else if (field === 'receiverChainKeywordArguments') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverChainKeywordArguments
      } else if (field === 'receiverChainMetadataLength') {
        sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverChain = ['asarray']
      } else if (field === 'receiverValueNames') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.receiverValueNames
      } else if (field === 'positionalArgumentNames') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.positionalArgumentNames
      } else if (field === 'positionalStaticBooleans') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.positionalStaticBooleans
      } else if (field === 'positionalMetadataLength') {
        sidecar.runs['run-1']!.facts.receiverCalls[0]!.positionalStaticBooleans = [true]
      } else if (field === 'resultNames') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.resultNames
      } else if (field === 'keywordArguments') {
        delete sidecar.runs['run-1']!.facts.receiverCalls[0]!.keywordArguments
      } else if (field === 'keywordArgumentCertainty') {
        const keywordArguments = sidecar.runs['run-1']!.facts.receiverCalls[0]!
          .keywordArguments as Array<Record<string, unknown>>
        delete keywordArguments[0]!.possibleArgumentNames
      } else {
        const keywordArguments = sidecar.runs['run-1']!.facts.receiverCalls[0]!
          .keywordArguments as Array<Record<string, unknown>>
        delete keywordArguments[0]![
          field === 'keywordStaticBoolean' ? 'staticBoolean' : 'callableReferences'
        ]
      }
      await writeFile(sidecarPath, JSON.stringify(sidecar))

      const analyze = vi.fn(async () => [facts])
      const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
      await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

      expect(analyze).toHaveBeenCalledOnce()
    }
  )

  it.each([
    'scientific-effects-1',
    'scientific-effects-copy-on-modify-3',
    'scientific-effects-copy-on-modify-4',
    'scientific-effects-scoped-python-calls-5',
    'scientific-effects-scoped-r-calls-6',
    'scientific-effects-r-ggplot2-7',
    'scientific-effects-static-loops-8',
    'scientific-corpus-imported-functions-9',
    'scientific-corpus-broader-workflows-10',
    'scientific-corpus-seaborn-tidyverse-11',
    'scientific-model-and-io',
    'scientific-reference-tables-and-bioconductor',
    'scientific-reference-tables-and-bioconductor-2',
    'scientific-reference-tables-and-bioconductor-3',
    'scientific-reference-tables-and-bioconductor-4',
    'scientific-reference-tables-and-bioconductor-5',
    'scientific-reference-tables-and-bioconductor-6',
    'scientific-reference-tables-and-bioconductor-7',
    'scientific-reference-tables-and-bioconductor-8',
    'scientific-python-stdlib-plotting-9',
    'scientific-file-readers-10',
    'scientific-file-readers-11',
    'scientific-file-reader-handles'
  ])('reanalyzes a valid v1 sidecar from analyzer revision %s', async (legacyRevision) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-legacy-v1-checksum-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'numpy', 'x = np.linspace(0, 1, 10)', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const facts = {
      state: 'available' as const,
      definedNames: ['x'],
      usedNames: ['np'],
      mutatedNames: []
    }
    const sidecarPath = join(
      storageRoot,
      'notebooks',
      'default-project',
      'session-1',
      'cache',
      'dependency-analysis.json'
    )
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [facts])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
      runs: Record<string, { checksum: string }>
    }
    const legacyChecksum = createHash('sha256')
      .update(
        JSON.stringify([
          1,
          legacyRevision,
          analyzedRun.kernelKind,
          analyzedRun.environment,
          analyzedRun.kernelEpochId,
          analyzedRun.script
        ])
      )
      .digest('hex')
    sidecar.runs['run-1']!.checksum = legacyChecksum
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const analyze = vi.fn(async () => [facts])
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledOnce()
    await expect(readFile(sidecarPath, 'utf8')).resolves.not.toContain(legacyChecksum)
  })

  it('rebuilds a matching current sidecar when receiver calls are missing', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-receiver-calls-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'call', 'result = model.inspect()', 1)
    const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    const facts = {
      state: 'available' as const,
      definedNames: ['result'],
      usedNames: ['model'],
      mutatedNames: [],
      receiverCalls: [{ receiver: 'model', member: 'inspect' }]
    }
    const sidecarPath = join(
      storageRoot,
      'notebooks',
      'default-project',
      'session-1',
      'cache',
      'dependency-analysis.json'
    )
    const initial = new NotebookDependencyAnalyzer({
      storageRoot,
      repository,
      analyze: vi.fn(async () => [facts])
    })
    await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
      runs: Record<string, { facts: { receiverCalls?: unknown } }>
    }
    delete sidecar.runs['run-1']!.facts.receiverCalls
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const analyze = vi.fn(async () => [facts])
    const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
    await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

    expect(analyze).toHaveBeenCalledOnce()
  })

  it.each(['usedNames', 'unknownScope', 'safeCallNames'] as const)(
    'rebuilds a matching current sidecar when method %s metadata is missing',
    async (missingField) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-method-metadata-'))
      temporaryRoots.push(storageRoot)
      const analyzedRun = run('run-1', 'class', 'class Counter: pass', 1)
      const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
      const facts = {
        state: 'available' as const,
        definedNames: ['Counter'],
        usedNames: [],
        mutatedNames: [],
        typeSummaries: [
          {
            name: 'Counter',
            kind: 'python-class' as const,
            fields: [],
            methods: [
              {
                name: 'get',
                effect: 'read' as const,
                usedNames: ['threshold'],
                safeCallNames: ['len'],
                unknownScope: 'receiver' as const
              }
            ]
          }
        ]
      }
      const sidecarPath = join(
        storageRoot,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      )
      const initial = new NotebookDependencyAnalyzer({
        storageRoot,
        repository,
        analyze: vi.fn(async () => [facts])
      })
      await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
        runs: Record<
          string,
          {
            facts: {
              typeSummaries: Array<{
                methods: Array<Record<string, unknown>>
              }>
            }
          }
        >
      }
      delete sidecar.runs['run-1']!.facts.typeSummaries[0]!.methods[0]![missingField]
      await writeFile(sidecarPath, JSON.stringify(sidecar))

      const analyze = vi.fn(async () => [facts])
      const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
      await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

      expect(analyze).toHaveBeenCalledOnce()
    }
  )

  it.each(['typeBindings', 'receiverCalls'] as const)(
    'rebuilds a matching current sidecar when %s argument names are missing',
    async (collection) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-call-arguments-'))
      temporaryRoots.push(storageRoot)
      const analyzedRun = run('run-1', 'call', 'model = Model(data)\nmodel.fit(data)', 1)
      const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
      const facts = {
        state: 'available' as const,
        definedNames: ['model'],
        usedNames: ['Model', 'data'],
        mutatedNames: [],
        typeBindings: [{ target: 'model', typeName: 'Model', argumentNames: ['data'] }],
        receiverCalls: [{ receiver: 'model', member: 'fit', argumentNames: ['data'] }]
      }
      const sidecarPath = join(
        storageRoot,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      )
      const initial = new NotebookDependencyAnalyzer({
        storageRoot,
        repository,
        analyze: vi.fn(async () => [facts])
      })
      await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
        runs: Record<
          string,
          {
            facts: Record<string, Array<Record<string, unknown>>>
          }
        >
      }
      delete sidecar.runs['run-1']!.facts[collection]![0]!.argumentNames
      await writeFile(sidecarPath, JSON.stringify(sidecar))

      const analyze = vi.fn(async () => [facts])
      const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
      await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

      expect(analyze).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['typeSummaries', 'complete'],
    ['receiverCalls', 'kind'],
    ['memberWrites', 'scope']
  ] as const)(
    'rebuilds a matching current sidecar when %s.%s metadata is missing',
    async (collection, missingField) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-missing-type-metadata-'))
      temporaryRoots.push(storageRoot)
      const analyzedRun = run('run-1', 'type', 'class Model: pass', 1)
      const repository = { readSessionRuns: vi.fn(async () => [analyzedRun]) }
      const facts = {
        state: 'available' as const,
        definedNames: ['Model'],
        usedNames: [],
        mutatedNames: [],
        typeSummaries: [
          { name: 'Model', kind: 'python-class' as const, complete: true, fields: [], methods: [] }
        ],
        receiverCalls: [
          { receiver: 'model', member: 'inspect', kind: 'receiver' as const, argumentNames: [] }
        ],
        memberWrites: [{ receiver: 'model', member: 'inspect', scope: 'instance' as const }]
      }
      const sidecarPath = join(
        storageRoot,
        'notebooks',
        'default-project',
        'session-1',
        'cache',
        'dependency-analysis.json'
      )
      const initial = new NotebookDependencyAnalyzer({
        storageRoot,
        repository,
        analyze: vi.fn(async () => [facts])
      })
      await initial.project({ projectId: 'default-project', sessionId: 'session-1' })
      const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
        runs: Record<
          string,
          {
            facts: Record<string, Array<Record<string, unknown>>>
          }
        >
      }
      delete sidecar.runs['run-1']!.facts[collection]![0]![missingField]
      await writeFile(sidecarPath, JSON.stringify(sidecar))

      const analyze = vi.fn(async () => [facts])
      const restored = new NotebookDependencyAnalyzer({ storageRoot, repository, analyze })
      await restored.project({ projectId: 'default-project', sessionId: 'session-1' })

      expect(analyze).toHaveBeenCalledOnce()
    }
  )

  it('returns the in-memory projection when the sidecar cannot be written', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-unwritable-dependencies-'))
    temporaryRoots.push(storageRoot)
    await writeFile(join(storageRoot, 'notebooks'), 'blocks the cache directory')
    const analyzedRun = run('run-1', 'prepare', 'x = 1', 1)
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) },
      analyze: vi.fn(async () => [
        { state: 'available' as const, definedNames: ['x'], usedNames: [], mutatedNames: [] }
      ])
    })

    await expect(
      analyzer.project({ projectId: 'default-project', sessionId: 'session-1' })
    ).resolves.toMatchObject({ stalenessByRunId: { 'run-1': { state: 'clear' } } })
  })

  it('analyzes Python in-process without spawning an interpreter', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-in-process-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = run('run-1', 'prepare', 'x = 1', 1)
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    })

    await expect(
      analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: analyzedRun,
        interpreter: { command: 'unused-python' }
      })
    ).resolves.toMatchObject({ stalenessByRunId: { 'run-1': { state: 'clear' } } })
  })

  it('analyzes R in-process without spawning an interpreter', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-in-process-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = {
      ...run('run-1', 'prepare', 'x <- 1', 1),
      kernelKind: 'r' as const,
      environment: 'default-r'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    })

    await expect(
      analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: analyzedRun,
        interpreter: { command: 'unused-rscript', condaPrefix: join(storageRoot, 'conda-env') }
      })
    ).resolves.toMatchObject({ stalenessByRunId: { 'run-1': { state: 'clear' } } })
  })

  it('uses Python ast to detect dependencies when Python is available', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-dependencies-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['x = 1', 'y = x + 1', 'x = 2']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']?.state).toBe('stale')
  })

  it('detects Python subscript mutation when Python is available', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-mutation-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['items = [0]', 'total = sum(items)', 'items[0] = 1']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']?.state).toBe('stale')
  })

  it('marks results unknown after an opaque Python receiver call', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-opaque-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['model = {}', 'result = model', 'model.fit(data)']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('marks results unknown after an opaque Python function mutates an argument', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-function-mutation-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['items = [0]', 'total = sum(items)', 'shuffle(items)']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call', 'opaque-mutation']
    })
  })

  it('extracts definite aliases from simple Python assignments', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a = []', 'b = a', 'result = len(a)', 'b.append(1)']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['a']
    })
  })

  it('keeps alias invalidation definite after inspecting object identities', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-identity-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'a = []',
      'b = a',
      'result = len(a)\nprint(result)',
      'b.append(1)',
      'print("a =", a)\nprint("b =", b)\nprint("a is b:", a is b)\nprint("id(a) =", id(a))\nprint("id(b) =", id(b))'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['a']
    })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('tracks a subscript alias mutation within one run without marking the run unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-subscript-alias-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'cell-1',
      'record = {"child": []}\nresult = len(record["child"])\nprint(result)\nchild = record["child"]\nchild.append(1)\nprint(record)',
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('marks opaque Python loaders without rooted arguments as unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-hidden-state-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run('run-1', 'load-data', 'data = load_data()', 1)
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
  })

  it('does not trust a safe Python call name after the notebook shadows it', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-shadowed-safe-call-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['len = custom_loader', 'data = len()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
  })

  it('drops an obsolete Python alias after a later assignment in the same run', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-alias-order-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a = []', 'b = a\nb = []', 'result = len(b)', 'a.append(1)']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('marks the namespace unknown when a Python alias source is rebound in the same run', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-source-rebind-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a = []', 'b = a\na = []', 'snapshot = len(b)', 'a.append(1)']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']?.state).toBe('unknown')
  })

  it('marks Python conditional-expression bindings unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-control-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a = []', 'b = a if flag else []', 'snapshot = len(a)', 'b.append(1)']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
      if (index === 1) {
        expect(projection.stalenessByRunId['run-2']).toMatchObject({
          state: 'unknown',
          reasons: expect.arrayContaining(['conditional-expression'])
        })
      }
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
  })

  it('marks Python loop-target bindings unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-loop-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a = []', 'for b in [a]:\n    pass']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('analyzes Python comprehension-local bindings without marking the run unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-comprehension-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'format-labels',
      'values = [1, 2, 3]\nlabels = [str(value) for value in values]',
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not confuse a comprehension-local mutation with a same-named global', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-comprehension-shadow-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'item = []',
      'seen = len(item)',
      'groups = [[]]\n[item.append(1) for item in groups]'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('maps a comprehension-local mutation back to its iterable root', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-comprehension-root-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'groups = [set()]',
      'seen = sum(len(item) for item in groups)',
      '[item.add(1) for item in groups]'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a comprehension-local NumPy out target as a possible root mutation', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-comprehension-out-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import numpy as np',
      'groups = [[0.0, 1.0]]',
      'seen = sum(len(item) for item in groups)',
      '[np.sin(item, out=item) for item in groups]'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('classifies ordinary NumPy array creation and read methods without marking the run unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-numpy-effects-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'numpy-values',
      [
        'import numpy as np',
        'x = np.linspace(-2 * np.pi, 2 * np.pi, 1000)',
        'y = np.cos(x)',
        'print(x.min(), x.max(), y.min(), y.max())'
      ].join('\n'),
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies an ordinary NumPy and Matplotlib plotting run without marking it unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-plot-effects-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'plot-cosine',
      [
        'import numpy as np',
        'import matplotlib',
        'matplotlib.use("Agg")',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(-2 * np.pi, 2 * np.pi, 1000)',
        'y = np.cos(x)',
        'fig, ax = plt.subplots(figsize=(10, 5))',
        "ax.plot(x, y, color='#d62728', linewidth=2, label='cos(x)')",
        "ax.axhline(y=0, color='gray', linewidth=0.5, linestyle='-')",
        "ax.axvline(x=0, color='gray', linewidth=0.5, linestyle='-')",
        "ax.set_title('Cosine Function: cos(x)')",
        "ax.set_xlabel('x (radians)')",
        "ax.set_ylabel('cos(x)')",
        "ax.grid(True, linestyle='--', alpha=0.6)",
        'xticks = np.arange(-2 * np.pi, 2 * np.pi + 0.1, np.pi / 2)',
        'ax.set_xticks(xticks)',
        "ax.set_xticklabels([f'{int(value / np.pi)}π' if value != 0 else '0' for value in xticks])",
        'ax.set_ylim(-1.2, 1.2)',
        "ax.legend(loc='upper right')",
        'plt.tight_layout()',
        "plt.savefig('cosine_wave.png', dpi=120, bbox_inches='tight')",
        'plt.show()',
        'print(x.min(), x.max(), y.min(), y.max())'
      ].join('\n'),
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a Matplotlib sine plot with a deterministic marker loop without marking it unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-plot-loop-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'plot-sine',
      [
        'import numpy as np',
        'import matplotlib.pyplot as plt',
        'x = np.linspace(-2 * np.pi, 2 * np.pi, 400)',
        'y = np.sin(x)',
        'fig, ax = plt.subplots(figsize=(8, 4.5))',
        'ax.plot(x, y, color="#2b6cb0", linewidth=2, label=r"$\\sin(x)$")',
        'for k in range(-2, 3):',
        '    ax.axvline(k * np.pi, color="gray", linestyle=":", alpha=0.4)',
        'ax.set_xlabel("x")',
        'ax.set_ylabel("sin(x)")',
        'ax.set_title("Sine function")',
        'ax.axhline(0, color="black", linewidth=0.8)',
        'ax.set_xticks([-2*np.pi, -np.pi, 0, np.pi, 2*np.pi])',
        'ax.set_xticklabels([r"$-2\\pi$", r"$-\\pi$", r"$0$", r"$\\pi$", r"$2\\pi$"])',
        'ax.set_ylim(-1.2, 1.2)',
        'ax.grid(True, linestyle="--", alpha=0.5)',
        'ax.legend()',
        'plt.tight_layout()',
        'plt.savefig("sin_plot.png", dpi=120)',
        'print("Saved: sin_plot.png")'
      ].join('\n'),
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    ['range', 'for value in range(3):\n    print(value)'],
    ['constant tuple', 'for label in ("control", "treated"):\n    print(label)'],
    ['enumerated constants', 'for index, value in enumerate((10, 20)):\n    print(index, value)'],
    ['zipped constants', 'for left, right in zip((1, 2), (3, 4)):\n    print(left, right)']
  ])(
    'classifies a deterministic Python %s loop without marking it unknown',
    async (_name, script) => {
      const python = await findPythonCommand()
      if (!python) return
      const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-static-loop-'))
      temporaryRoots.push(storageRoot)
      const completedRun = run('run-1', 'static-loop', script, 1)
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
      })

      const projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })

      expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    }
  )

  it('keeps Python loop-body assignments conservative even for a static range', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-static-loop-write-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'static-loop-write',
      'for value in range(3):\n    result = value',
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('keeps short-circuited Python loop effects conservative', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-static-loop-branch-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'static-loop-branch',
      'for value in range(3):\n    enabled and print(value)',
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('classifies an ordinary pandas value-count pie chart without marking it unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-pandas-pie-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run(
      'run-1',
      'pandas-pie',
      [
        'import pandas as pd',
        'import matplotlib.pyplot as plt',
        "src = '/tmp/group.csv'",
        'df = pd.read_csv(src)',
        "counts = df['group'].value_counts()",
        'print(counts.to_dict())',
        'plt.figure(figsize=(6, 6))',
        'plt.pie(',
        '    counts.values,',
        '    labels=counts.index,',
        "    autopct='%1.1f%%',",
        "    colors=['#1f77b4', '#d62728'],",
        '    startangle=90,',
        "    wedgeprops={'edgecolor': 'white', 'linewidth': 1.5},",
        "    textprops={'fontsize': 12}",
        ')',
        "plt.title('Sample Group Distribution')",
        'plt.tight_layout()',
        "plt.savefig('group_pie.png', dpi=120)",
        'plt.show()'
      ].join('\n'),
      1
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('propagates pandas return types so read-only Series calls do not invalidate consumers', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-pandas-types-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import pandas as pd',
      "df = pd.read_csv('/tmp/group.csv')",
      'counts = df.value_counts()',
      'snapshot = len(counts)',
      'plain = counts.to_dict()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
      expect(projection.stalenessByRunId, `after pandas run ${index + 1}`).toEqual(
        Object.fromEntries(runs.map(({ runId }) => [runId, { state: 'clear' }]))
      )
    }

    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('does not let a scoped file-inspection run poison a later pandas chart', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-file-then-pandas-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      [
        'import os',
        "src = '/tmp/group.csv'",
        'print(os.path.exists(src), os.path.getsize(src) if os.path.exists(src) else None)',
        'with open(src) as file:',
        '    head = [next(file) for _ in range(5)]',
        "print(''.join(head))"
      ].join('\n'),
      [
        'import pandas as pd',
        'import matplotlib.pyplot as plt',
        "src = '/tmp/group.csv'",
        'df = pd.read_csv(src)',
        "counts = df['group'].value_counts()",
        'plt.figure(figsize=(6, 6))',
        'plt.pie(counts.values, labels=counts.index)',
        "plt.savefig('group_pie.png')"
      ].join('\n')
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' }
    })
  })

  it('tracks a NumPy out parameter as a definite array mutation across runs', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-numpy-out-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import numpy as np',
      'x = np.linspace(0, 1, 10)',
      'total = sum(x)',
      'np.cos(x, out=x)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      names: ['x']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps a monkey-patched library method unknown across import aliases', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-library-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import numpy as np',
      'target = []',
      'result = len(target)',
      'np.sin = list.append',
      'import numpy as other\nother.sin(target, 1)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('marks Python writes without a root object unknown', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-rootless-write-'))
    temporaryRoots.push(storageRoot)
    const completedRun = run('run-1', 'rootless-write', 'get_obj().field = 1', 1)
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-assignment'])
    })
  })

  it('taints later Python safe calls after the builtins namespace is modified', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-builtins-mutation-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['import builtins', 'builtins.len = custom_loader', 'data = len()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['dynamic-namespace']
    })
  })

  it('taints later Python safe calls after the builtins dictionary is mutated', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-builtins-dict-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'import builtins',
      "builtins.__dict__.update({'len': custom_loader})",
      'data = len()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('propagates Python dynamic namespace identity through aliases', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-builtins-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['import builtins', 'b = builtins', 'b.len = custom_loader', 'data = len()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toEqual({
      state: 'unknown',
      reasons: ['dynamic-namespace']
    })
  })

  it('preserves Python builtins import aliases across runs', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-builtins-import-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['import builtins as bi', 'bi.len = custom_loader', 'data = len()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['dynamic-namespace']
    })
  })

  it('treats Python subscript callables as opaque calls', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-complex-callable-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['handlers = []', 'handlers[0](data)', 'result = hidden']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('tracks Python built-in container subscript aliases as definite across runs', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-field-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      "a = {'outer': {'child': []}}",
      "result = len(a['outer']['child'])",
      "b = a['outer']['child']",
      'b.append(1)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['a']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('tracks split Python subscript chains back to their root container', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-split-subscript-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      "a = {'outer': {'child': []}}",
      "result = len(a['outer']['child'])",
      "b = a['outer']",
      "c = b['child']",
      'c.append(1)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-5',
      names: ['a']
    })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps Python instance attribute extraction as a possible root alias', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-instance', 'model = existing_model', 1),
        facts: {
          state: 'available',
          definedNames: ['model'],
          usedNames: ['existing_model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-2', 'consume-field', 'result = model.child.value', 2),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-3', 'extract-field', 'child = model.child', 3),
        facts: {
          state: 'available',
          definedNames: ['child'],
          usedNames: ['model'],
          mutatedNames: [],
          aliases: [
            {
              target: 'child',
              source: 'model',
              kind: 'possible-reference',
              access: 'attribute'
            }
          ]
        }
      },
      {
        run: run('run-4', 'mutate-field', 'child.append(1)', 4),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['child'],
          mutatedNames: ['child']
        }
      },
      {
        run: run('run-5', 'consume-after-mutation', 'later = model.child.value', 5),
        facts: {
          state: 'available',
          definedNames: ['later'],
          usedNames: ['model'],
          mutatedNames: []
        }
      }
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-5']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
  })

  it('uses a local Python class summary to distinguish read-only and mutating methods', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-class', 'class Counter: ...', 1),
        facts: {
          state: 'available',
          definedNames: ['Counter'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Counter',
              kind: 'python-class',
              fields: [{ name: 'value', relationship: 'reference' }],
              methods: [
                { name: 'get', effect: 'read' },
                { name: 'increment', effect: 'mutate' }
              ]
            }
          ]
        }
      },
      {
        run: run('run-2', 'construct', 'counter = Counter()', 2),
        facts: {
          state: 'available',
          definedNames: ['counter'],
          usedNames: ['Counter'],
          mutatedNames: [],
          typeBindings: [{ target: 'counter', typeName: 'Counter' }]
        }
      },
      {
        run: run('run-3', 'read-method', 'result = counter.get()', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['counter'],
          mutatedNames: [],
          receiverCalls: [{ receiver: 'counter', member: 'get' }]
        }
      },
      {
        run: run('run-4', 'mutate-method', 'counter.increment()', 4),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['counter'],
          mutatedNames: [],
          receiverCalls: [{ receiver: 'counter', member: 'increment' }]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['counter']
    })
    expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps existing instances bound to the class summary used at construction', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-old-class', 'class Counter: ...', 1),
        facts: {
          state: 'available',
          definedNames: ['Counter'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Counter',
              kind: 'python-class',
              fields: [],
              methods: [{ name: 'inspect', effect: 'read' }]
            }
          ]
        }
      },
      {
        run: run('run-2', 'construct-old-instance', 'counter = Counter()', 2),
        facts: {
          state: 'available',
          definedNames: ['counter'],
          usedNames: [],
          mutatedNames: [],
          typeBindings: [{ target: 'counter', typeName: 'Counter' }]
        }
      },
      {
        run: run('run-3', 'redefine-class', 'class Counter: ...', 3),
        facts: {
          state: 'available',
          definedNames: ['Counter'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Counter',
              kind: 'python-class',
              fields: [],
              methods: [{ name: 'inspect', effect: 'mutate' }]
            }
          ]
        }
      },
      {
        run: run('run-4', 'inspect-old-instance', 'result = counter.inspect()', 4),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['counter'],
          mutatedNames: [],
          receiverCalls: [{ receiver: 'counter', member: 'inspect' }]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('uses summarized Python fields as definite root references', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-class', 'class Model: ...', 1),
        facts: {
          state: 'available',
          definedNames: ['Model'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Model',
              kind: 'python-class',
              fields: [{ name: 'child', relationship: 'reference' }],
              methods: []
            }
          ]
        }
      },
      {
        run: run('run-2', 'construct', 'model = Model()', 2),
        facts: {
          state: 'available',
          definedNames: ['model'],
          usedNames: ['Model'],
          mutatedNames: [],
          typeBindings: [{ target: 'model', typeName: 'Model' }]
        }
      },
      {
        run: run('run-3', 'consume', 'result = len(model.child)', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-4', 'extract', 'child = model.child', 4),
        facts: {
          state: 'available',
          definedNames: ['child'],
          usedNames: ['model'],
          mutatedNames: [],
          aliases: [
            {
              target: 'child',
              source: 'model',
              kind: 'possible-reference',
              access: 'attribute',
              member: 'child'
            }
          ]
        }
      },
      {
        run: run('run-5', 'mutate', 'child.append(1)', 5),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['child'],
          mutatedNames: ['child']
        }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-5',
      names: ['model']
    })
    expect(projection.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps unknown local class methods receiver-scoped', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-class', 'class Model: ...', 1),
        facts: {
          state: 'available',
          definedNames: ['Model'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Model',
              kind: 'python-class',
              fields: [],
              methods: [{ name: 'fit', effect: 'unknown' }]
            }
          ]
        }
      },
      {
        run: run('run-2', 'construct', 'model = Model()', 2),
        facts: {
          state: 'available',
          definedNames: ['model'],
          usedNames: ['Model'],
          mutatedNames: [],
          typeBindings: [{ target: 'model', typeName: 'Model' }]
        }
      },
      {
        run: run('run-3', 'consume', 'result = model.value', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-4', 'unknown-method', 'model.fit(data)', 4),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['model', 'data'],
          mutatedNames: [],
          receiverCalls: [{ receiver: 'model', member: 'fit' }]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
  })

  it('classifies simple local Python class methods across runs', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-class-summary-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      [
        'class Counter:',
        '    def __init__(this):',
        '        this.value = 0',
        '    def get(this):',
        '        return this.value',
        '    def update(this):',
        '        return this.value',
        '    def increment(this):',
        '        this.value += 1'
      ].join('\n'),
      'counter = Counter()',
      'result = counter.get()',
      'counter.increment()',
      'updated = counter.update()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['counter']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('binds instances of lowercase local Python classes', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-lowercase-class-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class counter:', '    def get(self):', '        return 1'].join('\n'),
      'item = counter()',
      'result = item.get()',
      'counter = print',
      'other = counter()'
    ]
    const projections: Array<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>>> = []
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projections.push(
        await analyzer.project({
          projectId: 'default-project',
          sessionId: 'session-1',
          completedRun,
          interpreter: { command: python.command, args: python.baseArgs }
        })
      )
    }

    expect(projections[2]?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projections[2]?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projections[4]?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('tracks free variables read by local Python methods', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-method-free-name-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'threshold = 1',
      [
        'class Meter:',
        '    def __init__(self):',
        '        self.value = 2',
        '    def above_threshold(self):',
        '        return self.value > threshold'
      ].join('\n'),
      'meter = Meter()',
      'result = meter.above_threshold()',
      'threshold = 3'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-5',
      names: ['threshold']
    })
  })

  it('keeps later Python reads unknown after a summarized method writes global state', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-method-global-write-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'hidden = 0',
      'snapshot = hidden',
      [
        'class Mutator:',
        '    def change(self):',
        '        global hidden',
        '        hidden = 1'
      ].join('\n'),
      'mutator = Mutator()',
      'mutator.change()',
      'result = hidden'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection?.stalenessByRunId['run-6']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('does not trust a safe call used by a local Python method after shadowing', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-method-safe-call-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Sized:', '    def measure(self):', '        return len([])'].join('\n'),
      'sized = Sized()',
      'len = custom_len',
      'result = sized.measure()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
    })
  })

  it('marks a Python method parameter that shadows a safe call as dynamic', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-local-safe-shadow-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'items = []',
      'snapshot = len(items)',
      ['class Runner:', '    def run(self, len):', '        return len(self)'].join('\n'),
      'runner = Runner()',
      'runner.run(items)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
    })
  })

  it('marks an earlier Python method safe-call result when the name is first shadowed', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-late-safe-shadow-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Sized:', '    def measure(self):', '        return len([])'].join('\n'),
      'sized = Sized()',
      'result = sized.measure()',
      'len = custom_len'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
    expect(projection?.invalidatedByRunId['run-4']).toContainEqual({
      runId: 'run-3',
      cellId: 'cell-3',
      names: ['len'],
      state: 'unknown',
      reasons: ['opaque-call']
    })
  })

  it('stops trusting a local Python method after an instance monkey patch', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-monkey-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Model:', '    def inspect(self):', '        return 1'].join('\n'),
      'model = Model()',
      'first = model.inspect()',
      'replacement = print',
      'model.inspect = replacement',
      'second = model.inspect()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-6']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation', 'opaque-call', 'dynamic-namespace']
    })
  })

  it('invalidates method summaries after a Python __dict__ monkey patch', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-dict-monkey-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'hidden = 0',
      ['class Model:', '    def inspect(self):', '        return 1'].join('\n'),
      'model = Model()',
      "member = 'inspect'",
      'model.__dict__[member] = replacement',
      'model.inspect()',
      'after = hidden'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-6']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection?.stalenessByRunId['run-7']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('invalidates all known instances after a Python class monkey patch', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-type-monkey-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Model:', '    def inspect(self):', '        return 1'].join('\n'),
      'a = Model()',
      'b = Model()',
      'before_a = a.inspect()',
      'before = b.inspect()',
      'a.__class__.inspect = replacement'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('does not trust a Python class method patched through a class alias', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-class-alias-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Model:', '    def inspect(self):', '        return 1'].join('\n'),
      'Alias = Model',
      'Alias.inspect = replacement',
      'model = Model()',
      'model.inspect()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('does not trust a same-run Python method call after patching through an alias', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-alias-monkey-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Model:', '    def inspect(self):', '        return 1'].join('\n'),
      'model = Model()',
      'alias = model\nalias.inspect = replacement\nmodel.inspect()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('tracks plain fields from a simple local Python class as root references', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-class-field-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Model:', '    def __init__(self):', '        self.child = []'].join('\n'),
      'model = Model()',
      'result = len(model.child)',
      'child = model.child',
      'child.append(1)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-5',
      names: ['model']
    })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('does not link extracted scalar fields back to a simple Python instance', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-value-field-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      ['class Counter:', '    def __init__(self):', '        self.value = 0'].join('\n'),
      'counter = Counter()',
      'snapshot = counter.value',
      'value = counter.value',
      'value += 1'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('marks only prior receiver dependents unknown for conditional Python methods', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-conditional-method-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      [
        'class MaybeCounter:',
        '    def __init__(self):',
        '        self.value = 0',
        '    def change(self, enabled):',
        '        if enabled:',
        '            self.value = 1'
      ].join('\n'),
      'counter = MaybeCounter()',
      'result = counter.value',
      'counter.change(False)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('closes possible root aliases across definite Python aliases', () => {
    const projection = projectNotebookDependencies([
      {
        run: run('run-1', 'define-instance', 'a = existing_model', 1),
        facts: {
          state: 'available',
          definedNames: ['a'],
          usedNames: ['existing_model'],
          mutatedNames: []
        }
      },
      {
        run: run('run-2', 'alias-instance', 'b = a', 2),
        facts: {
          state: 'available',
          definedNames: ['b'],
          usedNames: ['a'],
          mutatedNames: [],
          aliases: [{ target: 'b', source: 'a', kind: 'reference' }]
        }
      },
      {
        run: run('run-3', 'extract-field', 'child = b.child', 3),
        facts: {
          state: 'available',
          definedNames: ['child'],
          usedNames: ['b'],
          mutatedNames: [],
          aliases: [
            {
              target: 'child',
              source: 'b',
              kind: 'possible-reference',
              access: 'attribute'
            }
          ]
        }
      },
      {
        run: run('run-4', 'consume-root', 'result = a.child.value', 4),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['a'],
          mutatedNames: []
        }
      },
      {
        run: run('run-5', 'mutate-field', 'child.append(1)', 5),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['child'],
          mutatedNames: ['child']
        }
      },
      {
        run: run('run-6', 'consume-after-mutation', 'later = a.child.value', 6),
        facts: {
          state: 'available',
          definedNames: ['later'],
          usedNames: ['a'],
          mutatedNames: []
        }
      }
    ])

    expect(projection.stalenessByRunId['run-4']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-6']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
  })

  it('keeps Python class-body and opaque-call hidden bindings unknown for the epoch', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-hidden-bindings-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'class C:\n    global hidden\n    hidden = []',
      'mutate_globals(dummy)',
      'result = hidden'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1)
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']?.state).toBe('unknown')
  })

  it('uses R parse data to detect dependencies when R is available', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-dependencies-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['x <- 1', 'y <- x + 1', 'x <- 2']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']?.state).toBe('stale')
  })

  it('classifies an ordinary base R pie chart without marking it unknown', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-base-pie-'))
    temporaryRoots.push(storageRoot)
    const completedRun = {
      ...run(
        'run-1',
        'r-pie',
        [
          'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
          'slices <- abs(c(sin(angles), cos(angles)))',
          'labels <- c(paste0("sin θ=", round(angles, 2)),',
          '            paste0("cos θ=", round(angles, 2)))',
          'png("sin_cos_pie.png", width = 800, height = 800, res = 120)',
          'pie(slices,',
          '    labels = labels,',
          '    main = "Pie chart of |sin θ| and |cos θ| values (R)",',
          '    col = rainbow(length(slices)),',
          '    cex = 0.8)',
          'dev.off()',
          'cat("Saved:", file.exists("sin_cos_pie.png"))'
        ].join('\n'),
        1
      ),
      kernelKind: 'r' as const
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a base R plot with a deterministic marker loop without marking it unknown', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-plot-loop-'))
    temporaryRoots.push(storageRoot)
    const completedRun = {
      ...run(
        'run-1',
        'r-sine-plot',
        [
          'x <- seq(-2*pi, 2*pi, length.out = 400)',
          'y <- sin(x)',
          'png("sin_plot.png", width = 800, height = 450)',
          'plot(x, y, type = "l", main = "Sine function")',
          'for (k in -2:2) abline(v = k*pi, col = "gray", lty = 3)',
          'abline(h = 0)',
          'dev.off()',
          'cat("Saved: sin_plot.png")'
        ].join('\n'),
        1
      ),
      kernelKind: 'r' as const,
      environment: 'default-r'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    ['colon sequence', 'for (value in 1:3) print(value)'],
    ['constant vector', 'for (label in c("control", "treated")) print(label)']
  ])('classifies a deterministic R %s loop without marking it unknown', async (_name, script) => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-static-loop-'))
    temporaryRoots.push(storageRoot)
    const completedRun = {
      ...run('run-1', 'r-static-loop', script, 1),
      kernelKind: 'r' as const,
      environment: 'default-r'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps R loop-body assignments conservative even for a static sequence', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-static-loop-write-'))
    temporaryRoots.push(storageRoot)
    const completedRun = {
      ...run('run-1', 'r-static-loop-write', 'for (value in 1:3) result <- value', 1),
      kernelKind: 'r' as const,
      environment: 'default-r'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('does not treat base R math and graphics calls as mutations of their arguments', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-base-pie-effects-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
      'snapshot <- sum(angles)',
      'slices <- abs(c(sin(angles), cos(angles)))',
      'labels <- c(paste0("sin θ=", round(angles, 2)), paste0("cos θ=", round(angles, 2)))',
      [
        'png("sin_cos_pie.png")',
        'pie(slices, labels = labels, col = rainbow(length(slices)))',
        'dev.off()',
        'cat(file.exists("sin_cos_pie.png"))'
      ].join('\n')
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId).toEqual(
      Object.fromEntries(runs.map(({ runId }) => [runId, { state: 'clear' }]))
    )
  })

  it('classifies an ordinary ggplot2 pie chart without marking it unknown', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-ggplot2-pie-'))
    temporaryRoots.push(storageRoot)
    const completedRun = {
      ...run(
        'run-1',
        'r-ggplot2-pie',
        [
          'library(ggplot2)',
          'set.seed(1)',
          'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
          'df <- data.frame(',
          '  label = c(paste0("sin θ=", round(angles, 2)),',
          '            paste0("cos θ=", round(angles, 2))),',
          '  value = abs(c(sin(angles), cos(angles)))',
          ')',
          'df$frac <- df$value / sum(df$value)',
          'df$label_pos <- cumsum(df$frac) - df$frac/2',
          'p <- ggplot(df, aes(x = "", y = value, fill = label)) +',
          '  geom_bar(stat = "identity", width = 1, color = "white") +',
          '  coord_polar(theta = "y") +',
          '  geom_text(aes(x = 1.2, y = label_pos, label = paste0(round(frac*100, 1), "%")),',
          '            color = "black", size = 3.5) +',
          '  labs(title = "Pie chart of |sin θ| and |cos θ| values (R / ggplot2)",',
          '       fill = "Slice") +',
          '  theme_void() +',
          '  theme(plot.title = element_text(hjust = 0.5, size = 13, face = "bold"))',
          'ggsave("sin_cos_pie_ggplot.png", p, width = 8, height = 8, dpi = 150)',
          'cat("Saved:", file.exists("sin_cos_pie_ggplot.png"), "\\n")'
        ].join('\n'),
        1
      ),
      kernelKind: 'r' as const
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('separates ggplot2 data-mask columns from explicit environment dependencies', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-ggplot2-data-mask-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'value <- 99',
      'threshold <- 1',
      'library(ggplot2)',
      'df <- data.frame(value = 1)',
      'p <- ggplot(df, aes(y = .data$value, alpha = .env[["threshold"]]))',
      'value <- 100',
      'threshold <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
      if (index === 5) {
        expect(projection.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
      }
    }

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-7',
      names: ['threshold']
    })
  })

  it('keeps field replacement on an ordinary copied R list clear', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'a <- list(value = 1)',
      'b <- a',
      'result <- a$value',
      'b$value <- 2',
      'later <- a$value'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection?.invalidatedByRunId['run-4']).toBeUndefined()
  })

  it('keeps ordinary R list copy-on-modify assignments clear', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-list-copy-on-modify-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'a <- list(1, 2, 3)',
      'b <- a',
      'result <- length(a)\nprint(result)',
      'b[[1]] <- 99'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId).toMatchObject({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
    expect(projection?.invalidatedByRunId['run-4']).toBeUndefined()
  })

  it('propagates R copy-on-modify metadata through a cross-run list constructor', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-cross-run-value-list-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['x <- 1', 'a <- list(x)', 'b <- a', 'result <- a[[1]]', 'b[[1]] <- 99']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection?.invalidatedByRunId['run-5']).toBeUndefined()
  })

  it('drops R copy-on-modify metadata when a name is rebound to an environment', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-value-reference-rebind-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a <- list(1)\na <- new.env()', 'b <- a', 'result <- a$value', 'b$value <- 2']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('drops R copy-on-modify metadata after writing a reference member', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-reference-member-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'x <- list(1)',
      'e <- new.env()\nx[[1]] <- e\na <- list(x)',
      'b <- a',
      'result <- a[[1]]$value',
      'b[[1]]$value <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps an R list copyable after writing a previously known value member', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-value-member-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'x <- list(1)\ny <- 2',
      'x[[1]] <- y',
      'a <- x',
      'result <- x[[1]]',
      'a[[1]] <- 3'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('tracks an R callable name read after a local value assignment', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-callable-dependency-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['f <- mean', 'x <- 1\nresult <- f(x)', 'f <- sum']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-3',
      names: ['f']
    })
  })

  it('tracks the receiver of a standalone R6 member call', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-member-call-receiver-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'Counter <- R6::R6Class("Counter", public = list(value = 0, get = function() self$value, inc = function() self$value <- self$value + 1))\ncounter <- Counter$new()',
      'counter$get()',
      'counter$inc()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-3',
      names: ['counter']
    })
  })

  it('keeps an R value snapshot copy after its source is rebound later in the same run', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-value-snapshot-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'x <- 1\na <- list(x)\nx <- new.env()',
      'b <- a',
      'result <- a[[1]]',
      'b[[1]] <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('does not treat an R reference snapshot as a value after its source is rebound', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-reference-snapshot-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'x <- new.env()\na <- list(x)\nx <- 1',
      'b <- a',
      'result <- a[[1]]$value',
      'b[[1]]$value <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps R environment assignments as possible reference aliases', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-environment-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a <- new.env()', 'b <- a', 'result <- a$value', 'b$value <- 2']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps an environment nested in an R list as a possible reference', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-nested-environment-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'a <- list(new.env())',
      'b <- a',
      'result <- a[[1]]$value',
      'b[[1]]$value <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['possible-alias']
    })
  })

  it('treats an S4 object with only value slots as copy-on-modify', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-s4-copy-on-modify-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'setClass("State", slots = c(value = "numeric"))',
      'a <- new("State", value = 1)',
      'b <- a',
      'result <- a@value',
      'b@value <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.invalidatedByRunId['run-5']).toBeUndefined()
  })

  it('does not tag a completed R external read as a variable-tracking failure', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-hidden-state-'))
    temporaryRoots.push(storageRoot)
    const completedRun = {
      ...run('run-1', 'load-data', "data <- read.csv('data.csv')", 1),
      kernelKind: 'r' as const,
      environment: 'default-r'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [completedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not trust a safe R call name after the notebook shadows it', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-shadowed-safe-call-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['mean <- custom_loader', 'data <- mean()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['opaque-call']
    })
  })

  it('drops an obsolete R alias after a later assignment in the same run', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-alias-order-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a <- list()', 'b <- a\nb <- list()', 'result <- length(b)', 'a$value <- 1']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('marks the namespace unknown when an R alias source is rebound in the same run', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-source-rebind-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a <- list()', 'b <- a\na <- list()', 'snapshot <- length(b)', 'a$value <- 1']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']?.state).toBe('unknown')
  })

  it('marks R conditional-expression bindings unknown', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-control-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a <- list()', 'b <- if (flag) a else list()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('marks R loop-target bindings unknown', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-loop-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['a <- list()', 'for (b in list(a)) NULL']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('taints later R safe calls after search-path changes', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-search-path-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['library(custompkg)', 'data <- mean()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('taints later R safe calls after the global environment is modified', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-global-environment-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['.GlobalEnv$mean <- custom_loader', 'data <- mean()']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('propagates the R global environment identity through aliases', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-global-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['e <- .GlobalEnv', 'e$hidden <- value', 'result <- hidden']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['dynamic-namespace']
    })
  })

  it('tracks R field and slot extraction as possible aliases of the root', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-field-alias-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'a <- list(child = list())',
      'result <- length(a$child)',
      'b <- a$child',
      'b$value <- 1'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']?.state).toBe('unknown')
  })

  it('uses a local R6 summary to distinguish read-only and mutating methods', () => {
    const rRun = (
      runId: string,
      cellId: string,
      script: string,
      count: number
    ): NotebookRunRecord => ({
      ...run(runId, cellId, script, count),
      kernelKind: 'r' as const,
      environment: 'default-r'
    })
    const projection = projectNotebookDependencies([
      {
        run: rRun('run-1', 'define-r6', 'Counter <- R6Class(...)', 1),
        facts: {
          state: 'available',
          definedNames: ['Counter'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'Counter',
              kind: 'r-r6',
              fields: [{ name: 'value', relationship: 'value' }],
              methods: [
                { name: 'get', effect: 'read' },
                { name: 'increment', effect: 'mutate' }
              ]
            }
          ]
        }
      },
      {
        run: rRun('run-2', 'construct-r6', 'counter <- Counter$new()', 2),
        facts: {
          state: 'available',
          definedNames: ['counter'],
          usedNames: ['Counter'],
          mutatedNames: [],
          typeBindings: [{ target: 'counter', typeName: 'Counter' }]
        }
      },
      {
        run: rRun('run-3', 'read-r6', 'result <- counter$get()', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['counter'],
          mutatedNames: [],
          receiverCalls: [{ receiver: 'counter', member: 'get' }]
        }
      },
      {
        run: rRun('run-4', 'mutate-r6', 'counter$increment()', 4),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['counter'],
          mutatedNames: [],
          receiverCalls: [{ receiver: 'counter', member: 'increment' }]
        }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['counter']
    })
    expect(projection.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('uses known S4 slot value/reference semantics when projecting extracted aliases', () => {
    const rRun = (
      runId: string,
      cellId: string,
      script: string,
      count: number
    ): NotebookRunRecord => ({
      ...run(runId, cellId, script, count),
      kernelKind: 'r' as const,
      environment: 'default-r'
    })
    const projection = projectNotebookDependencies([
      {
        run: rRun('run-1', 'define-s4', 'setClass("State", ...)', 1),
        facts: {
          state: 'available',
          definedNames: ['State'],
          usedNames: [],
          mutatedNames: [],
          typeSummaries: [
            {
              name: 'State',
              kind: 'r-s4',
              fields: [
                { name: 'values', relationship: 'value' },
                { name: 'environment', relationship: 'reference' }
              ],
              methods: []
            }
          ]
        }
      },
      {
        run: rRun('run-2', 'construct-s4', 'state <- new("State")', 2),
        facts: {
          state: 'available',
          definedNames: ['state'],
          usedNames: ['State'],
          mutatedNames: [],
          typeBindings: [{ target: 'state', typeName: 'State' }]
        }
      },
      {
        run: rRun('run-3', 'consume-s4', 'result <- state@values', 3),
        facts: {
          state: 'available',
          definedNames: ['result'],
          usedNames: ['state'],
          mutatedNames: []
        }
      },
      {
        run: rRun('run-4', 'extract-value', 'values <- state@values', 4),
        facts: {
          state: 'available',
          definedNames: ['values'],
          usedNames: ['state'],
          mutatedNames: [],
          aliases: [
            {
              target: 'values',
              source: 'state',
              kind: 'possible-reference',
              access: 'attribute',
              member: 'values'
            }
          ]
        }
      },
      {
        run: rRun('run-5', 'mutate-value', 'values[[1]] <- 2', 5),
        facts: {
          state: 'available',
          definedNames: [],
          usedNames: ['values'],
          mutatedNames: ['values']
        }
      }
    ])

    expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('classifies simple local R6 methods across runs', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-summary-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'Counter <- R6::R6Class("Counter", public = list(value = 0, get = function() self$value, increment = function() { self$value <- self$value + 1 }))',
      'counter <- Counter$new()',
      'result <- counter$get()',
      'counter$increment()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-4',
      names: ['counter']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('tracks free variables read by local R6 methods', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-free-name-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'scale <- 2',
      'Meter <- R6::R6Class("Meter", public = list(value = 1, scaled = function() self$value * scale))',
      'meter <- Meter$new()',
      'result <- meter$scaled()',
      'scale <- 3'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-5',
      names: ['scale']
    })
  })

  it('keeps prior and later R reads unknown after an R6 method writes global state', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-global-write-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'hidden <- 0',
      'snapshot <- hidden',
      'Mutator <- R6::R6Class("Mutator", public = list(change = function() hidden <<- 1))',
      'mutator <- Mutator$new()',
      'mutator$change()',
      'result <- hidden'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection?.stalenessByRunId['run-6']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('does not trust a safe call used by an R6 method after shadowing', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-safe-call-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'Sized <- R6::R6Class("Sized", public = list(measure = function() mean(c(1, 2))))',
      'sized <- Sized$new()',
      'mean <- custom_mean',
      'result <- sized$measure()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
    })
  })

  it('marks an R6 method parameter that shadows a safe call as dynamic', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-local-safe-shadow-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'items <- list()',
      'snapshot <- length(items)',
      'Runner <- R6::R6Class("Runner", public = list(run = function(mean) mean(self)))',
      'runner <- Runner$new()',
      'runner$run(items)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
    })
  })

  it('invalidates R6 method summaries after a dynamic subscript patch', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-subscript-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'hidden <- 0',
      'Model <- R6::R6Class("Model", public = list(inspect = function() 1))',
      'model <- Model$new()',
      'member <- "inspect"',
      'model[[member]] <- replacement',
      'model$inspect()',
      'after <- hidden'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-6']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection?.stalenessByRunId['run-7']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('does not trust a same-run R6 method call after patching through an alias', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-alias-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'Model <- R6::R6Class("Model", public = list(inspect = function() 1))',
      'model <- Model$new()',
      'alias <- model\nalias$inspect <- replacement\nmodel$inspect()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('does not trust an R6 method patched through a possible alias across runs', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-cross-run-patch-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'Model <- R6::R6Class("Model", public = list(inspect = function() 1))',
      'model <- Model$new()',
      'alias <- model',
      'alias$inspect <- replacement',
      'model$inspect()'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('marks existing R6 instance results after a class method is replaced', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-class-set-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'Counter <- R6::R6Class("Counter", public = list(get = function() 1))',
      'counter <- Counter$new()',
      'result <- counter$get()',
      'Counter$set("public", "get", function() 2, overwrite = TRUE)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('keeps R6 active bindings outside static type summaries', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-active-binding-'))
    temporaryRoots.push(storageRoot)
    const analyzedRun = {
      ...run(
        'run-1',
        'active-r6',
        'Dynamic <- R6::R6Class("Dynamic", active = list(value = function() external_value))',
        1
      ),
      kernelKind: 'r' as const,
      environment: 'default-r'
    }
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [analyzedRun]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: analyzedRun,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('uses local S4 slot declarations to distinguish value and reference fields', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-s4-summary-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'setClass("State", slots = c(values = "numeric", environment = "environment"))',
      'state <- new("State")',
      'value_result <- state@values',
      'values <- state@values',
      'values[1] <- 2',
      'environment_result <- state@environment',
      'shared <- state@environment',
      'shared$value <- 1'
    ]
    const projections: Array<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>>> = []
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projections.push(
        await analyzer.project({
          projectId: 'default-project',
          sessionId: 'session-1',
          completedRun,
          interpreter: { command: r.command, args: r.baseArgs }
        })
      )
    }

    expect(projections[4]?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projections[7]?.stalenessByRunId['run-6']).toMatchObject({
      state: 'stale',
      causedByRunId: 'run-8',
      names: ['state']
    })
  })

  it('classifies simple local S4 methods across runs', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-s4-method-summary-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'setClass("State", slots = c(value = "numeric"))',
      'state <- new("State")',
      'setMethod("valueOf", "State", function(object) object@value)',
      'setMethod("increment", "State", function(object) { object@value <- object@value + 1 })',
      'result <- valueOf(state)',
      'increment(state)',
      'unrelated <- 1'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
    expect(projection?.invalidatedByRunId['run-6']).toContainEqual({
      runId: 'run-5',
      cellId: 'cell-5',
      names: ['state'],
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-7']).toEqual({ state: 'clear' })
  })

  it('marks existing S4 instance results when a method summary is replaced', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-s4-method-replace-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'setClass("State", slots = c(value = "numeric"))',
      'state <- new("State")',
      'setMethod("valueOf", "State", function(object) object@value)',
      'result <- valueOf(state)',
      'setMethod("valueOf", "State", function(object) object@value + 1)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('treats S4 slot writes as definite mutations of the root object', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-s4-slot-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['obj <- list(value = 1)', 'result <- obj@value', 'obj@value <- 2']
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({
      state: 'stale',
      causedByRunId: 'run-3',
      names: ['obj'],
      path: ['run-1', 'run-2']
    })
  })

  it('treats S4 slot replacement functions as definite root-object mutations', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-s4-slot-replacement-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'obj <- list(value = 1)',
      'result <- slot(obj, "value")',
      'slot(obj, "value") <- 2'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']?.state).toBe('stale')
  })

  it('limits an opaque R6 method mutation to the receiver dependency chain', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-r6-method-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'unrelated <- 1',
      'unrelated_result <- unrelated + 1',
      'counter <- list(value = 1)',
      'counter_result <- counter$value',
      'counter$increment(1)'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun,
        interpreter: { command: r.command, args: r.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.invalidatedByRunId['run-5']).toEqual([
      {
        runId: 'run-4',
        cellId: 'cell-4',
        names: ['counter'],
        state: 'unknown',
        reasons: ['opaque-mutation']
      }
    ])
  })

  it('recognizes right assignment and keeps nonlocal and assign writes unknown', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-assignment-forms-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = ['1 -> x', 'result <- x + 1', '2 ->> x', 'assign("x", 3)']
    const projections: Array<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>>> = []
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        ...run(`run-${index + 1}`, `cell-${index + 1}`, script, index + 1),
        kernelKind: 'r' as const,
        environment: 'default-r'
      }
      runs.push(completedRun)
      projections.push(
        await analyzer.project({
          projectId: 'default-project',
          sessionId: 'session-1',
          completedRun,
          interpreter: { command: r.command, args: r.baseArgs }
        })
      )
    }

    expect(projections[1]?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projections[2]?.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['nonlocal-assignment']
    })
    expect(projections[3]?.stalenessByRunId['run-1']).toEqual({
      state: 'unknown',
      reasons: ['dynamic-assignment']
    })
  })
})

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { managedEnvironmentIsReadOnly } from './managed-path-context'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('managed Notebook paths', () => {
  it.each([
    "os.environ['OPEN_SCIENCE_HANDOFF_DIR']",
    "os.environ.get('OPEN_SCIENCE_HANDOFF_DIR')",
    "os.getenv('OPEN_SCIENCE_HANDOFF_DIR')"
  ])('resolves a Python handoff input from the supplied launch context: %s', async (lookup) => {
    const handoff = join(process.cwd(), 'handoff')
    const source = `import os, json
h = ${lookup}
rows = json.load(open(os.path.join(h, 'rows.json')))
`
    expect(await managedEnvironmentIsReadOnly('python', source)).toBe(true)
    const context = {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      managedEnvironment: { OPEN_SCIENCE_HANDOFF_DIR: handoff }
    }
    expect(await analyzeNotebookSourceFileAccess('python', source, context)).toMatchObject({
      reads: [join(handoff, 'rows.json')],
      readState: 'complete'
    })
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [],
      readState: 'partial',
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it.each([
    ['python', "import os; os.environ['OPEN_SCIENCE_HANDOFF_DIR'] = '/elsewhere'"],
    ['python', 'import os; env = os.environ'],
    ['python', "import os; os.putenv('OPEN_SCIENCE_HANDOFF_DIR', '/elsewhere')"],
    ['python', 'exec(code)'],
    ['python', "import os; os.environ.update({'OPEN_SCIENCE_HANDOFF_DIR': '/elsewhere'})"],
    ['python', 'import os; os.environ.clear()'],
    ['python', "import os; os.environ.pop('OPEN_SCIENCE_HANDOFF_DIR')"],
    ['python', "import os; os.environ.setdefault('OPEN_SCIENCE_HANDOFF_DIR', '/elsewhere')"],
    ['python', "import os; os.environ.__setitem__('OPEN_SCIENCE_HANDOFF_DIR', '/elsewhere')"],
    ['python', "import os; os.environ.__delitem__('OPEN_SCIENCE_HANDOFF_DIR')"],
    [
      'python',
      "import os as envos; envos.environ.update({'OPEN_SCIENCE_HANDOFF_DIR': '/elsewhere'})"
    ],
    ['repl', "process.env.OPEN_SCIENCE_HANDOFF_DIR = '/elsewhere'"],
    ['repl', 'const env = process.env'],
    ['repl', "process.chdir('/elsewhere')"],
    ['repl', "require('child_process')"],
    ['repl', 'globalThis.process = replacement'],
    ['repl', 'eval(code)']
  ] as const)('invalidates launch assumptions for %s: %s', async (language, source) => {
    expect(await managedEnvironmentIsReadOnly(language, source)).toBe(false)
  })
})

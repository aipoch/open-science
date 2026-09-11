import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const project = async (scripts: string[]): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'xml-analysis-'))
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    kernelKind: 'python',
    kernelEpochId: 'epoch',
    environment: 'default-python',
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  }))
  try {
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: runs.at(-1)! })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const nestedXml = `import zipfile
import xml.etree.ElementTree as ET
with zipfile.ZipFile('inputs/book.xlsx') as z:
    with z.open('xl/sharedStrings.xml') as f:
        xml = f.read().decode('utf-8')
root = ET.fromstring(xml)
shared = []
for si in root.findall('si'):
    parts = []
    for t in si.iter('t'):
        parts.append(t.text or '')
    shared.append(''.join(parts))
print(shared)`

it('tracks nested XML elements back to the archive, not its member paths', async () => {
  expect((await project([nestedXml])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', nestedXml)).toMatchObject({
    reads: ['inputs/book.xlsx'],
    writes: [],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('tracks conditional scalar normalization', async () => {
  expect(
    (
      await project([
        `value = float('1')
if value.is_integer():
    value = int(value)
print(value)`
      ])
    ).stalenessByRunId['run-0']
  ).toEqual({ state: 'clear' })
})

it('analyzes an eager numerical lambda that reads a module constant', async () => {
  const script = `import numpy as np
angles = np.array([0.0, 1.0, 2.0])
partners = [j for j in range(3)]
partners.sort(key=lambda j: (angles[j] + 1) % (2 * np.pi))`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  const changed = await project([script.replace('partners.sort', 'np.pi = custom\npartners.sort')])
  expect(changed.stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('analyzes the reported archive to XML to chord image pipeline', async () => {
  const script = readFileSync(join(__dirname, 'reported-python-xml-chord.fixture.py'), 'utf8')
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('retains XML input dependencies across cells and later mutations', async () => {
  const scripts = [
    "import xml.etree.ElementTree as ET\nroot = ET.fromstring('<root><si><t>Gene1</t></si></root>')",
    "values = []\nfor si in root.findall('si'):\n    for t in si.iter('t'):\n        values.append(t.text)\nprint(values)"
  ]
  const result = await project(scripts)
  expect(result.dependenciesByRunId?.['run-1']).toContain('run-0')
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  const changed = await project([
    ...scripts,
    "child = root.find('si').find('t')\nchild.text = 'Gene2'"
  ])
  expect(changed.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([
  "import xml.etree.ElementTree as ET\nET.fromstring = custom\nroot = ET.fromstring('<root/>')\nfor child in root.findall('si'):\n    print(child.text)",
  "import xml.etree.ElementTree as ET\nroot = ET.fromstring('<root/>')\nroot.unmodeled(unknown_elements)",
  "import xml.etree.ElementTree as ET\nroot = ET.fromstring('<root/>', parser=custom_parser)",
  'value = custom\nif condition:\n    value = int(value)\nprint(value)',
  'for i in range(2):\n    def key(j):\n        external.append(j)\n        return j\n    partners = [j for j in range(3)]\n    partners.sort(key=key)',
  'import numpy as np\nvalue = np.sin(np.array([1.0]))\ndef key(j, saved=value):\n    return saved[j]\nvalue = np.array([2.0])\npartners = [j for j in range(1)]\npartners.sort(key=key)',
  'callbacks = []\nfor i in range(2):\n    def key(j):\n        return i + j\n    callbacks.append(key)\nprint(callbacks[0](1))',
  'import numpy as np\nsource = np.ones((2,2))\ndef borrow():\n    row = source[0]\n    return row\nresult = borrow()\nresult[0] = 0'
])('keeps unverified effects and escaping state conservative: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it.skipIf(process.env.RUN_KERNEL !== '1' || !process.env.OPEN_SCIENCE_TEST_PYTHON)(
  'replays the reported XML chord in two fresh Python processes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'xml-chord-replay-'))
    const python = process.env.OPEN_SCIENCE_TEST_PYTHON!
    const setup = `import os, zipfile
os.makedirs('inputs', exist_ok=True)
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
strings = ['from', 'to', 'value'] + ['Gene'+str(i) for i in range(1,7)] + ['S'+str(i) for i in range(1,11)]
shared = '<sst xmlns="'+ns+'">' + ''.join('<si><t>'+s+'</t></si>' for s in strings) + '</sst>'
rows = ['<row>'+''.join('<c t="s"><v>'+str(i)+'</v></c>' for i in range(3))+'</row>']
for i in range(6):
    for j in range(10):
        rows.append('<row><c t="s"><v>'+str(i+3)+'</v></c><c t="s"><v>'+str(j+9)+'</v></c><c><v>'+str(i+j+1)+'</v></c></row>')
sheet = '<worksheet xmlns="'+ns+'"><sheetData>'+''.join(rows)+'</sheetData></worksheet>'
with zipfile.ZipFile('inputs/edge-weights-222222222222.xlsx', 'w') as z:
    z.writestr('xl/sharedStrings.xml', shared)
    z.writestr('xl/worksheets/sheet1.xml', sheet)
`
    try {
      const script = readFileSync(join(__dirname, 'reported-python-xml-chord.fixture.py'), 'utf8')
      await writeFile(join(root, 'replay.py'), setup + script)
      const outputs: Buffer[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        await promisify(execFile)(python, ['replay.py'], {
          cwd: root,
          timeout: 60000,
          env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(root, 'matplotlib') }
        })
        outputs.push(await readFile(join(root, 'chord_diagram.png')))
      }
      expect(outputs[0].length).toBeGreaterThan(1000)
      expect(outputs[1].equals(outputs[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120000
)

it('does not erase an array view alias when replacement is conditional', async () => {
  const result = await project([
    'import numpy as np\nsource = np.ones((1, 1))\nview = source[0]',
    'print(source)',
    'if condition:\n    view = int(view)\nview += 1'
  ])
  expect(result.stalenessByRunId['run-2']?.state).not.toBe('clear')
})

it('retains a computed array default when a sort callback mutates it', async () => {
  const result = await project([
    'import numpy as np\nsource = np.sin(np.array([1.0]))',
    'print(source)',
    'def key(j, saved=source):\n    saved[j] += 1\n    return j\npartners = [j for j in range(1)]\npartners.sort(key=key)'
  ])
  expect(result.stalenessByRunId['run-2']?.state).not.toBe('clear')
})

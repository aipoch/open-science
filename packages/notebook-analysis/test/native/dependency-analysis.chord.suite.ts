import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from '../../src/index'

// Font discovery is process-independent runtime setup, not notebook input state.
// Share only this disposable cache; every script still runs in a fresh data directory.
let cacheRoot: string | undefined
beforeAll(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'native-chord-fonts-'))
  await promisify(execFile)(
    process.env.OPEN_SCIENCE_TEST_PYTHON!,
    ['-c', 'import matplotlib.font_manager'],
    {
      timeout: 90000,
      env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: cacheRoot }
    }
  )
}, 100000)
afterAll(async () => {
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true })
})

const cells = readFileSync(
  join(__dirname, '../../src', 'reported-python-chord.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const recordCells = readFileSync(
  join(__dirname, '../../src', 'reported-python-chord-records.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const polarChord = readFileSync(
  join(__dirname, '../../src', 'reported-python-polar-chord.fixture.py'),
  'utf8'
)

const arcRibbon = readFileSync(
  join(__dirname, '../../src', 'reported-python-arc-ribbon.fixture.py'),
  'utf8'
)

const cartesianChord = readFileSync(
  join(__dirname, '../../src', 'reported-python-cartesian-chord.fixture.py'),
  'utf8'
)

const workbookCells = readFileSync(
  join(__dirname, '../../src', 'reported-python-workbook-chord.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const coloredChordCells = readFileSync(
  join(__dirname, '../../src', 'reported-python-colored-chord.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const redrawCells = readFileSync(
  join(__dirname, '../../src', 'reported-python-chord-redraw.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const matrixChord = readFileSync(
  join(__dirname, '../../src', 'reported-python-matrix-chord.fixture.py'),
  'utf8'
)

const matrixInput =
  "import pandas as pd\ndf = pd.read_excel('inputs/edge-weights-222222222222.xlsx')"

const neighborChords = [0, 1].map((variant) =>
  readFileSync(
    join(__dirname, '../../src', `reported-python-neighbor-chord-${variant}.fixture.py`),
    'utf8'
  )
)

const subarcCells = readFileSync(
  join(__dirname, '../../src', 'reported-python-chord-subarcs.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

// The unused dictionary reads a loop variable after a potentially empty loop.
const independentPolarChord = polarChord.replace(/^gene_unit_rad = .*\n/m, '')

it.each([
  `${cells[0]}\n${cells[6]}`,
  recordCells.join('\n'),
  independentPolarChord,
  arcRibbon,
  cartesianChord,
  [workbookCells[5], workbookCells[6]].join('\n'),
  [coloredChordCells[2], coloredChordCells[3]].join('\n'),
  ...redrawCells,
  subarcCells[5]!,
  `${matrixInput}\n${matrixChord}`,
  ...neighborChords
])(
  'matches native Excel input and chord output for workflow %# in fresh Python processes',
  async (script) => {
    const root = await mkdtemp(join(tmpdir(), 'native-chord-'))
    const python = process.env.OPEN_SCIENCE_TEST_PYTHON!
    const hashes: string[] = []
    try {
      await mkdir(join(root, 'cache'), { recursive: true })
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name)
        const dataRoot = join(sessionRoot, 'data')
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        // Small synthetic fixture with the same schema: no user spreadsheet is loaded by the test runner.
        await promisify(execFile)(
          python,
          [
            '-c',
            'import pandas as pd\npd.DataFrame([(f"Gene{i}",f"S{j}",float(i+j)) for i in range(1,7) for j in range(1,11)], columns=["from","to","value"]).to_excel("inputs/edge-weights-222222222222.xlsx",index=False,sheet_name="Sheet 1")'
          ],
          { cwd: dataRoot, timeout: 20000 }
        )
        if (name === 'original' && redrawCells.includes(script)) {
          await writeFile(join(dataRoot, 'chord_diagram.png'), 'older published generation')
        }
        const analysis = await analyzeNotebookSourceFileAccess('python', script)
        expect(analysis).toMatchObject({ readState: 'complete', writeState: 'complete' })
        expect(analysis.reads).toContain('inputs/edge-weights-222222222222.xlsx')
        expect(analysis.writes).toContain('chord_diagram.png')
        if (redrawCells.includes(script)) expect(analysis.reads).not.toContain('chord_diagram.png')
        await promisify(execFile)(python, ['-c', script], {
          cwd: dataRoot,
          timeout: 30000,
          env: {
            ...process.env,
            MPLBACKEND: 'Agg',
            MPLCONFIGDIR: cacheRoot,
            XDG_CACHE_HOME: join(root, 'cache')
          }
        })
        const png = await readFile(join(dataRoot, 'chord_diagram.png'))
        expect(png.subarray(1, 4).toString()).toBe('PNG')
        hashes.push(createHash('sha256').update(png).digest('hex'))
      }
      expect(hashes[0]).toBe(hashes[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  90000
)

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { analyzePythonSources } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { startWorkingFileObservation } from './working-file-observer'

const reportedSine = `import numpy as np
import matplotlib.pyplot as plt
x = np.linspace(0, 2 * np.pi, 1000)
y = np.sin(x)
fig, ax = plt.subplots(figsize=(8, 4.5))
ax.plot(x, y, color='#1f77b4', linewidth=2, label='sin(x)')
ax.axhline(0, color='gray', linewidth=0.5, linestyle='--')
ax.axvline(0, color='gray', linewidth=0.5, linestyle='--')
ax.set_xlabel('x (radians)')
ax.set_ylabel('sin(x)')
ax.set_title('Sine Function')
ax.set_xticks([0, np.pi/2, np.pi, 3*np.pi/2, 2*np.pi])
ax.set_xticklabels(['0', 'π/2', 'π', '3π/2', '2π'])
ax.set_ylim(-1.2, 1.2)
ax.grid(True, alpha=0.3)
ax.legend()
plt.tight_layout()
output_path = 'sine_wave.png'
plt.savefig(output_path, dpi=120, bbox_inches='tight')
plt.close(fig)
import os
print(f"Saved: {output_path} ({os.path.getsize(output_path)} bytes)")`

it('captures the reported sine plot with its variable-path diagnostic', async () => {
  expect(await analyzeNotebookSourceFileAccess('python', reportedSine)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: [],
    writes: ['sine_wave.png']
  })
  expect((await analyzePythonSources([reportedSine]))[0]).toMatchObject({ state: 'available' })
})

it.skipIf(process.env.RUN_KERNEL !== '1' || !process.env.OPEN_SCIENCE_TEST_PYTHON)(
  'captures the actual reported PNG after executing Python',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-sine-diagnostics-'))
    const sessionRoot = join(root, 'notebook')
    const dataRoot = join(sessionRoot, 'data')
    try {
      await mkdir(dataRoot, { recursive: true })
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        code: reportedSine,
        registeredInputFiles: [],
        language: 'python',
        runId: 'native-sine'
      })
      const { stdout } = await promisify(execFile)(
        process.env.OPEN_SCIENCE_TEST_PYTHON!,
        ['-c', reportedSine],
        {
          cwd: dataRoot,
          timeout: 20000,
          env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: join(root, 'matplotlib') }
        }
      )
      const image = await readFile(join(dataRoot, 'sine_wave.png'))
      expect(image.subarray(1, 4).toString()).toBe('PNG')
      expect(stdout).toContain(`Saved: sine_wave.png (${image.length} bytes)`)
      const result = await observation.finish()
      expect(result.fileEvidence).toMatchObject({ state: 'available' })
      expect(result.workingFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'data/sine_wave.png', size: image.length })
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)

it.each([
  ['python', 'import os\npath="plot.png"\nprint(f"{path}: {os.path.getsize(path)}")'],
  [
    'python',
    'import os\nfolder="out"\npath=os.path.join(folder,"plot.png")\nalias=path\nprint(os.path.getsize(alias))'
  ],
  [
    'python',
    'from pathlib import Path\npath=Path("plot.png")\nprint(f"{path}: {path.stat().st_size}")'
  ],
  ['python', 'import os\nfolder="out"\npath=folder+"/plot.png"\nprint(os.path.getsize(path))'],
  [
    'python',
    'from pathlib import Path\nfolder=Path("out")\npath=folder / "plot.png"\nprint(path.stat().st_size)'
  ],
  ['python', 'import os\nfolder="out"\npath=f"{folder}/plot.png"\nprint(os.path.getsize(path))'],
  ['r', 'path <- "plot.png"; cat(sprintf("%s: %s",path,file.info(path)$size))'],
  [
    'r',
    'folder <- "out"; path <- glue::glue("{folder}/plot.png"); cat(sprintf("%s: %s",path,file.info(path)$size))'
  ],
  [
    'r',
    'folder <- "out"; path <- sprintf("%s/plot.png",folder); cat(paste("Saved:",path,file.size(path)))'
  ],
  [
    'r',
    'folder <- "out"; path <- file.path(folder,"plot.png"); alias <- path; message(sprintf("%s: %s",alias,file.size(alias)))'
  ]
] as const)('resolves %s path bindings in console diagnostics: %s', async (language, source) => {
  expect(await analyzeNotebookSourceFileAccess(language, source)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  ['python', 'import os\npath="plot.png"\npath=custom_path()\nprint(os.path.getsize(path))'],
  [
    'python',
    'import os\npath="plot.png"\nif flag: path=custom_path()\nprint(os.path.getsize(path))'
  ],
  [
    'python',
    'from pathlib import Path\npath=Path("plot.png")\npath.__class__.stat=custom\nprint(path.stat().st_size)'
  ],
  [
    'python',
    'from pathlib import Path\npath=Path("plot.png")\nprint(path.stat().st_size,file=open("size.txt","w"))'
  ],
  [
    'python',
    'import os\npath="plot.png"\nsize=os.path.getsize(path)\nopen("size.txt","w").write(str(size))'
  ],
  ['r', 'path <- "plot.png"; path <- custom_path(); cat(file.size(path))'],
  ['r', 'path <- "plot.png"; if(flag) path <- custom_path(); cat(file.size(path))'],
  ['r', 'path <- "plot.png"; cat(file.size(path),file="size.txt")'],
  ['r', 'path <- "plot.png"; size <- file.size(path); writeLines(as.character(size),"size.txt")']
] as const)(
  'retains %s dependencies after path rebinding or output consumption: %s',
  async (language, source) => {
    expect((await analyzeNotebookSourceFileAccess(language, source)).externalState).toBe('partial')
  }
)

it.each([
  ['r', 'message(sprintf("Saved: %s", normalizePath("plot.png")))'],
  ['r', 'print(file.info(file.path("outputs", "plot.png"))$size)'],
  ['r', 'cat("Bytes:",format(file.info("plot.png")$size,big.mark=","))'],
  ['python', 'import os\nprint(os.getcwd())'],
  ['python', 'import os\nprint(os.path.getsize("plot.png"))'],
  ['python', 'from pathlib import Path\nprint(Path("plot.png").stat().st_size)'],
  ['python', 'from pathlib import Path\nprint(Path("plot.png").resolve())'],
  ['python', 'import os as fs\nprint(fs.path.getsize(fs.path.join("out","plot.png")))'],
  ['python', 'from os import getcwd as cwd\nprint(cwd())'],
  ['python', 'from pathlib import Path\nprint(f"Saved: {Path("plot.png").resolve()}")']
] as const)('recognizes console-only %s diagnostics: %s', async (language, source) => {
  expect(await analyzeNotebookSourceFileAccess(language, source)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: [],
    writes: []
  })
})

it.each([
  ['r', 'writeLines(sprintf("Saved: %s",normalizePath("plot.png")),"report.txt")'],
  ['r', 'if (file.info("plot.png")$size > 100) writeLines("large","report.txt")'],
  ['python', 'import os\nwith open("report.txt","w") as out:\n    print(os.getcwd(),file=out)'],
  [
    'python',
    'import os\nif os.path.getsize("plot.png") > 100:\n    open("large.txt","w").write("large")'
  ],
  [
    'python',
    'from pathlib import Path\nsize=Path("plot.png").stat().st_size\nopen("size.txt","w").write(str(size))'
  ],
  ['r', 'sprintf <- custom; message(sprintf("%s",getwd()))'],
  ['r', 'file.path <- custom; print(file.info(file.path("out","plot.png")))'],
  ['r', 'sink("report.txt"); message(sprintf("%s",getwd()))'],
  ['python', 'import os\nprint = custom\nprint(os.getcwd())'],
  ['python', 'import os\nos.getcwd = custom\nprint(os.getcwd())'],
  ['python', 'from pathlib import Path\nPath.resolve = custom\nprint(Path("plot.png").resolve())'],
  ['python', 'from pathlib import Path\nprint(Path(custom()).stat().st_size)'],
  [
    'python',
    'import os\nfrom contextlib import redirect_stdout\nwith open("report.txt","w") as out, redirect_stdout(out):\n    print(os.getcwd())'
  ],
  ['python', 'import os\nimport sys\nsys.stdout = open("report.txt","w")\nprint(os.getcwd())']
] as const)('retains consumed %s filesystem observations: %s', async (language, source) => {
  expect((await analyzeNotebookSourceFileAccess(language, source)).externalState).toBe('partial')
})

it('retains the imported callable identity without treating its alias as a builtin', async () => {
  const [facts] = await analyzePythonSources(['from os import getcwd as str\nprint(str())'])
  expect(facts).toMatchObject({ state: 'available' })
  expect(facts.usedNames).toContain('str')
  expect(facts.safeCallNames).toContain('print')
  expect(facts.safeCallNames).not.toContain('str')
})

it.skipIf(process.env.RUN_KERNEL !== '1').each(['python', 'r'] as const)(
  'captures a native %s output followed by formatted filesystem diagnostics',
  async (language) => {
    const code =
      language === 'python'
        ? 'import os\nfrom pathlib import Path\nPath("summary.csv").write_text("group,n\\nCtrl,33\\nIRI,33\\n")\nprint(os.getcwd())\nprint(f"Saved: {Path(\'summary.csv\').resolve()}")\nprint(Path("summary.csv").stat().st_size)'
        : 'writeLines(c("group,n","Ctrl,33","IRI,33"),"summary.csv")\nmessage(sprintf("Saved: %s",normalizePath("summary.csv")))\ncat("Bytes:",format(file.info("summary.csv")$size,big.mark=","))'
    const root = await mkdtemp(join(tmpdir(), 'native-file-diagnostics-'))
    const sessionRoot = join(root, 'notebook')
    const dataRoot = join(sessionRoot, 'data')
    try {
      await mkdir(dataRoot, { recursive: true })
      const observation = await startWorkingFileObservation({
        dataRoot,
        notebookSessionRoot: sessionRoot,
        cwd: dataRoot,
        code,
        registeredInputFiles: [],
        language,
        runId: `native-${language}`
      })
      const command =
        language === 'python'
          ? process.env.OPEN_SCIENCE_TEST_PYTHON || 'python3'
          : process.env.OPEN_SCIENCE_TEST_R_COMMAND || 'Rscript'
      await promisify(execFile)(
        command,
        language === 'python' ? ['-c', code] : ['--vanilla', '-e', code],
        {
          cwd: dataRoot,
          timeout: 15000
        }
      )
      expect(await readFile(join(dataRoot, 'summary.csv'), 'utf8')).toBe(
        'group,n\nCtrl,33\nIRI,33\n'
      )
      const result = await observation.finish()
      expect(result.fileEvidence).toMatchObject({ state: 'available' })
      expect(result.workingFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'data/summary.csv', size: 23 })
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

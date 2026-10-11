import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import { execFile } from 'node:child_process'

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { promisify } from 'node:util'

import { expect, it } from 'vitest'

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

configureTestRuntimeMetadata()

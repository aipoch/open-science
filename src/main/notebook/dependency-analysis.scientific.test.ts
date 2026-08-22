import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { findPythonCommand } from './python-command'
import { findRCommand } from './r-command'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const completedRun = (
  runId: string,
  cellId: string,
  kernelKind: 'python' | 'r',
  script: string
): NotebookRunRecord => ({
  runId,
  cellId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind,
  kernelEpochId: 'epoch-1',
  environment: kernelKind === 'python' ? 'default-python' : 'default-r',
  script,
  status: 'completed',
  startedAt: 1,
  endedAt: 1,
  executionCount: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

const projectScripts = async (
  kernelKind: 'python' | 'r',
  scripts: string[],
  storagePrefix: string
): Promise<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined> => {
  const interpreter = kernelKind === 'python' ? await findPythonCommand() : await findRCommand()
  if (!interpreter) return undefined
  const storageRoot = await mkdtemp(join(tmpdir(), storagePrefix))
  temporaryRoots.push(storageRoot)
  const runs: NotebookRunRecord[] = []
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: vi.fn(async () => runs) }
  })
  let projection
  for (const [index, script] of scripts.entries()) {
    const run = {
      ...completedRun(`run-${index + 1}`, `cell-${index + 1}`, kernelKind, script),
      startedAt: index + 1,
      endedAt: index + 1,
      executionCount: index + 1
    }
    runs.push(run)
    projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: { command: interpreter.command, args: interpreter.baseArgs }
    })
  }
  return projection
}

describe('scientific Notebook dependency corpus', () => {
  it('classifies a common base R read-clean-aggregate workflow as clear', async () => {
    const r = await findRCommand()
    if (!r) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-r-base-analysis-'))
    temporaryRoots.push(storageRoot)
    const run = completedRun(
      'run-1',
      'r-base-analysis',
      'r',
      [
        'data <- read.csv("measurements.csv")',
        'clean <- na.omit(data)',
        'summary <- aggregate(value ~ group, data = clean, FUN = mean)',
        'summary <- summary[order(summary$value, decreasing = TRUE), ]',
        'write.csv(summary, "summary.csv", row.names = FALSE)',
        'print(summary)'
      ].join('\n')
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [run]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: { command: r.command, args: r.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps directly imported NumPy function effects across runs', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-numpy-import-runs-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'from numpy import linspace, sin, pi',
      'x = linspace(-2 * pi, 2 * pi, 400)',
      'y = sin(x)\nprint(y.min(), y.max())'
    ]
    let projection
    for (const [index, script] of scripts.entries()) {
      const run = {
        ...completedRun(`run-${index + 1}`, `cell-${index + 1}`, 'python', script),
        startedAt: index + 1,
        endedAt: index + 1,
        executionCount: index + 1
      }
      runs.push(run)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: run,
        interpreter: { command: python.command, args: python.baseArgs }
      })
    }

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' }
    })
  })

  it('freezes a direct-import call effect before a same-run rebind', async () => {
    const projection = await projectScripts(
      'python',
      ['from numpy import sin\nx = [0.0]\ny = sin(x)\nsin = abs\nprint(y)'],
      'open-science-python-import-rebind-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies direct imports of common NumPy functions as clear', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-numpy-imports-'))
    temporaryRoots.push(storageRoot)
    const run = completedRun(
      'run-1',
      'numpy-direct-imports',
      'python',
      [
        'from numpy import linspace, sin, pi',
        'x = linspace(-2 * pi, 2 * pi, 400)',
        'y = sin(x)',
        'print(x.min(), x.max(), y.min(), y.max())'
      ].join('\n')
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [run]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common pandas cleaning and grouped-summary chain as clear', async () => {
    const python = await findPythonCommand()
    if (!python) return
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-pandas-chain-'))
    temporaryRoots.push(storageRoot)
    const run = completedRun(
      'run-1',
      'pandas-summary',
      'python',
      [
        'import pandas as pd',
        'df = pd.read_csv("measurements.csv")',
        'summary = (',
        '    df.dropna(subset=["group", "value"])',
        '      .groupby("group", as_index=False)["value"]',
        '      .mean()',
        '      .sort_values("value", ascending=False)',
        ')',
        'print(summary.head())'
      ].join('\n')
    )
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => [run]) }
    })

    const projection = await analyzer.project({
      projectId: 'default-project',
      sessionId: 'session-1',
      completedRun: run,
      interpreter: { command: python.command, args: python.baseArgs }
    })

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common NumPy and Matplotlib plotting workflow as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
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
        ].join('\n')
      ],
      'open-science-python-matplotlib-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps common pyplot and stdlib CSV plotting runs clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'import matplotlib.pyplot as plt',
          'x = np.linspace(0, 2 * np.pi, 1000)',
          'y = np.sin(x)',
          'fig, ax = plt.subplots(figsize=(10, 6))',
          'ax.plot(x, y, label="sin(x)", color="blue", linewidth=2)',
          'ax.axhline(0, color="black", linewidth=0.5)',
          'ax.axvline(0, color="black", linewidth=0.5)',
          'ax.set_xlabel("x (radians)")',
          'ax.set_ylabel("sin(x)")',
          'ax.set_title("Sine Function")',
          'ax.legend()',
          'ax.grid(True, alpha=0.3)',
          'plt.tight_layout()',
          'plt.savefig("sine_plot.png", dpi=100)',
          'plt.show()',
          'print("Plot saved as sine_plot.png")'
        ].join('\n'),
        [
          'import csv',
          'import matplotlib.pyplot as plt',
          'from collections import Counter',
          'groups = []',
          'with open("groups.csv", "r") as f:',
          '    reader = csv.DictReader(f)',
          '    for row in reader:',
          '        groups.append(row["group"])',
          'counts = Counter(groups)',
          'labels = list(counts.keys())',
          'sizes = list(counts.values())',
          'fig, ax = plt.subplots(figsize=(8, 8))',
          'ax.pie(sizes, labels=labels, autopct="%1.1f%%")',
          'ax.axis("equal")',
          'plt.tight_layout()',
          'plt.savefig("group_pie_chart.png", dpi=100)',
          'plt.show()',
          'print(dict(counts))'
        ].join('\n')
      ],
      'open-science-python-common-plotting-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' }
    })
  })

  it('keeps a local collection loop scoped to that collection', async () => {
    const projection = await projectScripts(
      'python',
      ['groups = []\nfor row in rows:\n    groups.append(row["group"])\nprint(groups)'],
      'open-science-python-local-collection-loop-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies common csv and Counter construction as scoped reads', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import csv',
          'from collections import Counter',
          'with open("groups.csv", "r") as handle:',
          '    reader = csv.DictReader(handle)',
          'counts = Counter([])',
          'print(dict(counts))'
        ].join('\n')
      ],
      'open-science-python-csv-counter-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies common pandas value-file readers as data frame reads', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'from pandas import read_sas',
          'table = pd.read_table("measurements.tsv")',
          'fixed = pd.read_fwf("measurements.txt")',
          'sas = pd.read_sas("measurements.sas7bdat")',
          'spss = pd.read_spss("measurements.sav")',
          'stata = pd.read_stata("measurements.dta")',
          'orc = pd.read_orc("measurements.orc")',
          'xml = pd.read_xml("measurements.xml")',
          'query = pd.read_sql_query("select * from measurements", connection)',
          'preview = pd.read_table("preview.tsv").head()',
          'direct = read_sas("preview.sas7bdat").head()',
          'print(table.head(), fixed.head(), sas.head(), spss.head())',
          'print(stata.head(), orc.head(), xml.head(), query.head(), preview, direct)'
        ].join('\n')
      ],
      'open-science-python-pandas-value-readers-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    ['NumPy text', 'import numpy as np\ndata = np.loadtxt("matrix.tsv")'],
    [
      'NumPy missing-value text',
      'import numpy as np\ndata = np.genfromtxt("matrix.csv", delimiter=",")'
    ],
    ['NumPy binary', 'import numpy as np\ndata = np.fromfile("matrix.bin", dtype=np.float64)'],
    ['SciPy WAV', 'from scipy.io import wavfile\nsample_rate, data = wavfile.read("signal.wav")'],
    ['Matplotlib image', 'import matplotlib.image as mpimg\ndata = mpimg.imread("figure.png")'],
    ['imageio', 'import imageio.v3 as iio\ndata = iio.imread("figure.tiff")'],
    ['scikit-image', 'from skimage import io\ndata = io.imread("figure.jpg")'],
    ['OpenCV', 'import cv2\ndata = cv2.imread("figure.png")']
  ])('tracks a %s file reader as an ndarray producer', async (_label, setup) => {
    const projection = await projectScripts(
      'python',
      [setup, 'snapshot = data.mean()\nprint(snapshot)', 'data.fill(0)'],
      'open-science-python-ndarray-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['Dataset', 'dataset = xr.open_dataset("climate.nc")'],
    ['multi-file Dataset', 'dataset = xr.open_mfdataset("climate-*.nc")'],
    ['DataArray', 'dataset = xr.open_dataarray("temperature.nc")']
  ])('tracks an xarray %s reader and its loaded state', async (_label, read) => {
    const projection = await projectScripts(
      'python',
      [
        `import xarray as xr\n${read}`,
        'snapshot = dataset.mean()\nprint(snapshot)',
        'dataset.load()'
      ],
      'open-science-python-xarray-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    [
      'Pillow image',
      'from PIL import Image\nitem = Image.open("figure.png")',
      'snapshot = item.getbbox()\nprint(snapshot)',
      'item.paste((0, 0, 0), (0, 0, 1, 1))'
    ],
    [
      'AnnData',
      'import anndata as ad\nitem = ad.read_h5ad("cells.h5ad")',
      'snapshot = item.n_obs\nprint(snapshot)',
      'item.obs_names_make_unique()'
    ],
    [
      'Scanpy AnnData',
      'import scanpy as sc\nitem = sc.read_10x_mtx("matrix")',
      'snapshot = item.n_obs\nprint(snapshot)',
      'item.var_names_make_unique()'
    ],
    [
      'Nibabel image',
      'import nibabel as nib\nitem = nib.load("brain.nii.gz")',
      'snapshot = item.shape\nprint(snapshot)',
      'item.update_header()'
    ]
  ])(
    'tracks a %s file reader and its domain-object mutation',
    async (_label, setup, consume, mutate) => {
      const projection = await projectScripts(
        'python',
        [setup, consume, mutate],
        'open-science-python-domain-reader-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it.each([
    ['pickle', 'import pickle\nitem = pickle.load(handle)'],
    ['joblib', 'import joblib\nitem = joblib.load("model.joblib")'],
    ['torch', 'import torch\nitem = torch.load("model.pt")'],
    ['dill', 'import dill\nitem = dill.load(handle)'],
    ['cloudpickle', 'import cloudpickle\nitem = cloudpickle.load(handle)']
  ])('keeps %s arbitrary-object deserialization namespace-unknown', async (_label, source) => {
    const projection = await projectScripts(
      'python',
      [source],
      'open-science-python-unsafe-deserializer-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call', 'dynamic-namespace'])
    })
  })

  it('treats a variable file argument as a possible consumed handle', async () => {
    const projection = await projectScripts(
      'python',
      [
        'handle = open("matrix.bin", "rb")',
        'snapshot = handle\nprint(snapshot)',
        'import numpy as np\ndata = np.fromfile(handle, dtype=np.float64)'
      ],
      'open-science-python-consumed-file-handle-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['keyword', 'import numpy as np\ndata = np.fromfile(file=handle, dtype=np.float64)'],
    ['direct import', 'from numpy import fromfile\ndata = fromfile(handle, dtype=np.float64)'],
    ['pandas keyword', 'import pandas as pd\ndata = pd.read_csv(filepath_or_buffer=handle)'],
    ['Pillow keyword', 'from PIL import Image\ndata = Image.open(fp=handle)'],
    ['xarray keyword', 'import xarray as xr\ndata = xr.open_dataset(filename_or_obj=handle)']
  ])('tracks a file handle passed through a NumPy %s call', async (_label, read) => {
    const projection = await projectScripts(
      'python',
      ['handle = open("matrix.bin", "rb")', 'snapshot = handle\nprint(snapshot)', read],
      'open-science-python-consumed-file-handle-variant-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['positional', 'frame = pd.read_sql_query("select * from samples", connection)'],
    ['named', 'frame = pd.read_sql_query("select * from samples", con=connection)']
  ])('treats a %s pandas SQL connection as possibly consumed', async (_label, read) => {
    const projection = await projectScripts(
      'python',
      [
        'connection = {"dsn": "memory"}',
        'snapshot = connection\nprint(snapshot)',
        `import pandas as pd\n${read}`
      ],
      'open-science-python-consumed-sql-connection-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps Nibabel cached data as a possible alias of the image', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import nibabel as nib\nimage = nib.load("brain.nii.gz")',
        'snapshot = image.shape\nprint(snapshot)',
        'data = image.get_fdata()',
        'data.fill(0)'
      ],
      'open-science-python-nibabel-cache-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('tracks a pandas input through a grouped summary and later replacement', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        [
          'summary = (df.dropna(subset=["group", "value"])',
          '  .groupby("group")["value"]',
          '  .mean()',
          '  .sort_values(ascending=False))',
          'print(summary)'
        ].join('\n'),
        'df = pd.read_csv("updated-measurements.csv")'
      ],
      'open-science-python-pandas-lineage-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('classifies a common pandas value-count pie chart as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'import matplotlib.pyplot as plt',
          'df = pd.read_csv("groups.csv")',
          'counts = df["group"].value_counts()',
          'print(counts.to_dict())',
          'plt.figure(figsize=(6, 6))',
          'plt.pie(counts.values, labels=counts.index, autopct="%1.1f%%")',
          'plt.title("Sample Group Distribution")',
          'plt.tight_layout()',
          'plt.savefig("group_pie.png", dpi=120)',
          'plt.show()'
        ].join('\n')
      ],
      'open-science-python-pandas-plot-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common pandas join-reshape-export workflow as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'samples = pd.read_csv("samples.csv")',
          'measurements = pd.read_csv("measurements.csv")',
          'merged = samples.merge(measurements, on="sample_id", how="left")',
          'report = (',
          '    merged.assign(ratio=merged["value"] / merged["total"])',
          '      .pivot_table(index="group", values="ratio", aggfunc="mean")',
          '      .reset_index()',
          '      .rename(columns={"ratio": "mean_ratio"})',
          '      .sort_values("mean_ratio", ascending=False)',
          ')',
          'report.to_csv("report.csv", index=False)',
          'print(report.head())'
        ].join('\n')
      ],
      'open-science-python-pandas-reshape-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('tracks both inputs of a pandas join across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nsamples = pd.read_csv("samples.csv")\nmeasurements = pd.read_csv("measurements.csv")',
        'report = samples.merge(measurements, on="sample_id", how="left")\nprint(report.head())',
        'measurements = pd.read_csv("updated-measurements.csv")'
      ],
      'open-science-python-pandas-join-lineage-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('does not treat pandas merge configuration as aliased data', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nleft = pd.DataFrame({"id": [1], "value": [1]})\nright = pd.DataFrame({"id": [1], "other": [2]})\nkey = "id"\nmode = "left"',
        'key_snapshot = key\nprint(key_snapshot)',
        'left_snapshot = len(left)\nprint(left_snapshot)',
        'combined = pd.merge(left, right, how=mode, on=key, copy=False)\ncombined["value"] = [9]'
      ],
      'open-science-python-pandas-merge-configuration-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it.each(['shallow = frame.copy(deep=False)', 'shallow = frame.copy(False)'])(
    'keeps pandas shallow-copy relationships conservative for %s',
    async (copyExpression) => {
      const projection = await projectScripts(
        'python',
        [
          'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})',
          'snapshot = len(frame)\nprint(snapshot)',
          `${copyExpression}\nshallow["value"] = [4, 5, 6]`
        ],
        'open-science-python-pandas-shallow-copy-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it('does not invent a pandas alias for the default deep-copy path', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'snapshot = len(frame)\nprint(snapshot)',
        'copied = frame.copy()\ncopied["value"] = [4, 5, 6]'
      ],
      'open-science-python-pandas-default-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    'converted = frame.astype(float, copy=False)',
    'converted = frame.astype(float, False)'
  ])('keeps pandas no-copy conversions conservative for %s', async (copyExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'snapshot = len(frame)\nprint(snapshot)',
        `${copyExpression}\nconverted["value"] = [4, 5, 6]`
      ],
      'open-science-python-pandas-astype-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    'combined = pd.concat([left, right], copy=False)',
    'combined = pd.merge(left=left, right=right, on="id", copy=False)',
    'combined = left.merge(right, on="id", copy=False)'
  ])('keeps pandas no-copy joins conservative for %s', async (mergeExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nleft = pd.DataFrame({"id": [1], "value": [1]})\nright = pd.DataFrame({"id": [1], "other": [2]})',
        'snapshot = left["value"].sum()\nprint(snapshot)',
        `${mergeExpression}\ncombined["value"] = [9]`
      ],
      'open-science-python-pandas-no-copy-join-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic pandas callbacks unknown while literal mappings remain analyzable', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nfrom transforms import rename_column\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'literal = frame.rename(columns={"value": "measurement"})\nprint(literal.head())',
        'dynamic = frame.rename(columns=rename_column)\nprint(dynamic.head())',
        'aggregated = frame.pivot_table(values="value", aggfunc=[rename_column])\nprint(aggregated)'
      ],
      'open-science-python-pandas-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  })

  it('keeps a nested pandas callback conservative across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nfrom transforms import aggregate\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'result = frame.pivot_table(values="value", aggfunc=[aggregate])\nprint(result)'
      ],
      'open-science-python-pandas-nested-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps a registered pure NumPy callback analyzable in pandas', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nimport pandas as pd\nframe = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})\nresult = frame.pivot_table(index="group", values="value", aggfunc=np.mean)\nprint(result)'
      ],
      'open-science-python-pandas-known-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps a registered pure callback analyzable through a module alias', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nimport pandas as pd\nn = np\nframe = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})\nresult = frame.pivot_table(index="group", values="value", aggfunc=n.mean)\nprint(result)'
      ],
      'open-science-python-pandas-aliased-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not treat values inside a pandas rename mapping as callbacks', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nnew_name = "measurement"\nmapping = {"value": new_name}\nframe = pd.DataFrame({"value": [1, 2, 3]})\nrenamed = frame.rename(columns=mapping)\nprint(renamed.head())'
      ],
      'open-science-python-pandas-mapping-value-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not treat a plain pandas assign value as a callback', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nlabel = "control"\nframe = pd.DataFrame({"value": [1, 2, 3]})\nassigned = frame.assign(group=label)\nprint(assigned.head())'
      ],
      'open-science-python-pandas-assign-value-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    {
      setup: 'from custom import build_value\ncallback = build_value',
      callback: 'callback'
    },
    { setup: 'import custom', callback: 'custom.build_value' }
  ])('keeps imported pandas assign callbacks conservative for $callback', async (scenario) => {
    const projection = await projectScripts(
      'python',
      [
        `import pandas as pd\n${scenario.setup}\nframe = pd.DataFrame({"value": [1, 2, 3]})\nassigned = frame.assign(result=${scenario.callback})\nprint(assigned.head())`
      ],
      'open-science-python-pandas-imported-assign-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it.each([
    'summary = frame.groupby("group").sum()',
    'summary = frame.groupby("group")["value"].sum()',
    'reshaped = np.asarray(frame["value"]).reshape(1, -1)'
  ])('resolves common chained scientific return types for %s', async (expression) => {
    const projection = await projectScripts(
      'python',
      [
        `import numpy as np\nimport pandas as pd\nframe = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})\n${expression}\nprint(frame.head())`
      ],
      'open-science-python-scientific-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps a chained NumPy view linked to its data input', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = [1, 2, 3]\nderived = np.asarray(values).reshape(-1)',
        'snapshot = len(values)\nprint(snapshot)',
        'derived.fill(0)'
      ],
      'open-science-python-numpy-chained-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks an inline chained NumPy mutation back to its data input', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = [1, 2, 3]',
        'snapshot = len(values)\nprint(snapshot)',
        'np.asarray(values).reshape(-1).fill(0)'
      ],
      'open-science-python-numpy-inline-chain-mutation-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each(['np.asarray(a=values).reshape(-1).fill(0)', 'values.astype(float, copy=False).fill(0)'])(
    'tracks conditional and keyword NumPy chain provenance for %s',
    async (expression) => {
      const projection = await projectScripts(
        'python',
        [
          'import numpy as np\nvalues = np.asarray([1, 2, 3])',
          'snapshot = values.sum()\nprint(snapshot)',
          expression
        ],
        'open-science-python-numpy-chain-arguments-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it.each(['values.copy().fill(0)', 'frame.copy().fillna(0, inplace=True)'])(
    'does not link a fresh chained copy back to its source for %s',
    async (expression) => {
      const projection = await projectScripts(
        'python',
        [
          'import numpy as np\nimport pandas as pd\nvalues = np.asarray([1, 2, 3])\nframe = pd.DataFrame({"value": [1, None]})',
          'values_snapshot = values.sum()\nframe_snapshot = len(frame)\nprint(values_snapshot, frame_snapshot)',
          expression
        ],
        'open-science-python-fresh-chain-copy-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it('resolves a direct-import scientific call chain', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import asarray\nvalues = [1, 2, 3]\nderived = asarray(values).reshape(-1)\nprint(derived)'
      ],
      'open-science-python-direct-import-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps chained pandas no-copy inputs linked through instance methods', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nleft = pd.DataFrame({"id": [1], "value": [1]})\nright = pd.DataFrame({"id": [1], "other": [2]})\nderived = left.merge(right, on="id", copy=False).astype(float, copy=False)',
        'snapshot = len(right)\nprint(snapshot)',
        'derived["other"] = [9]'
      ],
      'open-science-python-pandas-chained-no-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a callback container variable conservative across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nfrom transforms import aggregate\ncallbacks = [aggregate]\nframe = pd.DataFrame({"value": [1, 2, 3]})',
        'result = frame.pivot_table(values="value", aggfunc=callbacks)\nprint(result)'
      ],
      'open-science-python-pandas-callback-container-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('does not apply pandas copy rules to an unrelated same-named method', async () => {
    const projection = await projectScripts(
      'python',
      [
        'class Box:\n    def copy(self, deep=False):\n        return []\nbox = Box()',
        'snapshot = id(box)\nprint(snapshot)',
        'copied = box.copy(deep=False)\ncopied.append(1)'
      ],
      'open-science-python-method-identity-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('tracks a mutable file-like output target without tagging the writer run', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"value": [1, 2, 3]})\nsink = []',
        'snapshot = len(sink)\nprint(snapshot)',
        'frame.to_csv(path_or_buf=sink, index=False)'
      ],
      'open-science-python-pandas-file-like-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks a direct-import scientific writer across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import savetxt\nsink = []\nvalues = [1, 2, 3]',
        'snapshot = len(sink)\nprint(snapshot)',
        'savetxt(fname=sink, X=values)'
      ],
      'open-science-python-direct-writer-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('does not treat a scientific writer data argument as its output target', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import savetxt\nsink = []',
        'values = [1, 2, 3]',
        'sink_snapshot = len(sink)\nprint(sink_snapshot)',
        'values_snapshot = sum(values)\nprint(values_snapshot)',
        'savetxt(sink, values)'
      ],
      'open-science-python-writer-positional-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('classifies common NumPy reshape and reduction operations as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'values = np.asarray([1, 2, 3, 4, 5, 6])',
          'matrix = values.reshape(2, 3)',
          'centered = matrix - matrix.mean(axis=0)',
          'bounds = np.concatenate([centered.min(axis=0), centered.max(axis=0)])',
          'summary = np.mean(bounds) + np.std(bounds) + np.min(bounds) + np.max(bounds)',
          'np.savetxt("bounds.csv", bounds, delimiter=",")',
          'print(bounds.tolist(), summary)'
        ].join('\n')
      ],
      'open-science-python-numpy-transform-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    'derived = np.asarray(values)',
    'derived = values.reshape(2, 3)',
    'derived = values.ravel()'
  ])('keeps a possible NumPy view relationship conservative for %s', async (viewExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([[1, 2, 3], [4, 5, 6]])',
        'snapshot = values.sum()\nprint(snapshot)',
        `${viewExpression}\nderived.fill(0)`
      ],
      'open-science-python-numpy-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a directly imported NumPy view-producing function conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from numpy import array, asarray\nvalues = array([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = asarray(values)\nderived.fill(0)'
      ],
      'open-science-python-numpy-imported-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks the first positional argument of a NumPy view independently from keyword roots', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = np.asarray(dtype=np.float64, a=values)\nderived.fill(0)'
      ],
      'open-science-python-numpy-view-keyword-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks only the first positional argument of a NumPy view', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([1, 2, 3])',
        'dtype_spec = "float64"',
        'values_snapshot = values.sum()\nprint(values_snapshot)',
        'dtype_snapshot = str(dtype_spec)\nprint(dtype_snapshot)',
        'derived = np.asarray(values, dtype_spec)\nderived.fill(0)'
      ],
      'open-science-python-numpy-positional-view-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('tracks explicit NumPy output buffers as definite mutations', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\ntarget = np.zeros(4)',
        'snapshot = target.sum()\nprint(snapshot)',
        'np.concatenate([np.ones(2), np.ones(2)], out=target)'
      ],
      'open-science-python-numpy-output-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['np.concatenate([values[:1], values[1:]], 0, target)', 'target = np.zeros(2)'],
    ['np.stack([values, values], 0, target)', 'target = np.zeros((2, 2))'],
    ['np.sin(values, target)', 'target = np.zeros(2)']
  ])('tracks positional NumPy output buffers for %s', async (expression, targetSetup) => {
    const projection = await projectScripts(
      'python',
      [
        `import numpy as np\nvalues = np.asarray([1, 2])\n${targetSetup}`,
        'snapshot = target.sum()\nprint(snapshot)',
        expression
      ],
      'open-science-python-numpy-general-positional-output-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks NumPy reduction output buffers as definite mutations', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])\ntarget = np.zeros(1)',
        'snapshot = target.sum()\nprint(snapshot)',
        'np.mean(values, out=target)'
      ],
      'open-science-python-numpy-reduction-output-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each(['np.mean(values, None, None, target)', 'values.mean(None, None, target)'])(
    'tracks positional NumPy reduction output buffers for %s',
    async (expression) => {
      const projection = await projectScripts(
        'python',
        [
          'import numpy as np\nvalues = np.asarray([1, 2, 3])\ntarget = np.zeros(())',
          'snapshot = target.sum()\nprint(snapshot)',
          expression
        ],
        'open-science-python-numpy-positional-output-corpus-'
      )

      expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
      expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    }
  )

  it('does not invent a NumPy alias for the default copy path', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = np.array(values)\nderived.fill(0)'
      ],
      'open-science-python-numpy-default-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    'derived = np.array(values, copy=False)',
    'derived = values.astype(float, copy=False)',
    'derived = values.astype(float, "K", "unsafe", True, False)'
  ])('keeps explicit NumPy no-copy paths conservative for %s', async (copyExpression) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        `${copyExpression}\nderived.fill(0)`
      ],
      'open-science-python-numpy-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps runtime NumPy copy flags conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.asarray([1, 2, 3])\ncopy_data = False',
        'snapshot = values.sum()\nprint(snapshot)',
        'derived = np.array(values, copy=copy_data)\nderived.fill(0)'
      ],
      'open-science-python-numpy-runtime-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('marks a prior NumPy result after a definite ndarray mutation', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.array([1, 2, 3])',
        'snapshot = values.sum()\nprint(snapshot)',
        'values.fill(0)'
      ],
      'open-science-python-numpy-mutation-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks a direct SciPy statistic across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'from scipy.stats import ttest_ind\ngroup_a = [1.0, 2.0, 3.0]\ngroup_b = [2.0, 3.0, 4.0]',
        'result = ttest_ind(group_a, group_b)\nprint(result.statistic, result.pvalue)',
        'group_a = [10.0, 20.0, 30.0]'
      ],
      'open-science-python-scipy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('marks a prior pandas result after an explicit inplace mutation', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        'row_count = len(df)\nprint(row_count)',
        'df.dropna(inplace=True)'
      ],
      'open-science-python-pandas-inplace-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('marks a prior pandas result unknown when inplace is dynamic', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        'row_count = len(df)\nprint(row_count)',
        'flag = True\ndf.dropna(inplace=flag)'
      ],
      'open-science-python-pandas-possible-inplace-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an unknown method at the end of a pandas chain conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\ndf = pd.read_csv("measurements.csv")',
        'row_count = len(df)\nprint(row_count)',
        'df.dropna().custom_mutator()'
      ],
      'open-science-python-pandas-opaque-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an unknown Python callback conservative', async () => {
    const projection = await projectScripts(
      'python',
      ['baseline = 1\nprint(baseline)', 'custom_pipeline()'],
      'open-science-python-dynamic-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('classifies common base R plotting and file output as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
          'slices <- abs(c(sin(angles), cos(angles)))',
          'labels <- c(paste0("sin theta=", round(angles, 2)), paste0("cos theta=", round(angles, 2)))',
          'png("sin_cos_pie.png", width = 800, height = 800, res = 120)',
          'pie(slices, labels = labels, main = "Pie chart", col = rainbow(length(slices)))',
          'dev.off()',
          'cat("Saved:", file.exists("sin_cos_pie.png"), "\\n")'
        ].join('\n')
      ],
      'open-science-r-base-plot-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common dplyr and ggplot2 workflow as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(dplyr)',
          'library(ggplot2)',
          'df <- data.frame(group = c("A", "A", "B"), value = c(1, 2, 3))',
          'summary <- df |>',
          '  filter(!is.na(value)) |>',
          '  mutate(centered = value - mean(value)) |>',
          '  group_by(group) |>',
          '  summarise(mean_value = mean(value), .groups = "drop") |>',
          '  arrange(desc(mean_value))',
          'p <- ggplot(summary, aes(x = group, y = mean_value)) +',
          '  geom_col() +',
          '  labs(title = "Mean by group") +',
          '  theme_minimal()',
          'ggsave("summary.png", p, width = 8, height = 5, dpi = 150)'
        ].join('\n')
      ],
      'open-science-r-tidyverse-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each(['%>%', '|>'])('classifies a common dplyr %s pipeline as clear', async (pipe) => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(dplyr)',
          'df <- data.frame(group = c("A", "A", "B"), value = c(1, 2, 3))',
          `summary <- df ${pipe} mutate(double = value * 2) ${pipe} group_by(group) ${pipe} summarise(total = sum(double))`,
          'print(summary)'
        ].join('\n')
      ],
      'open-science-r-dplyr-pipe-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('does not trust a lookalike qualified transform in an R pipe', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(value = c(1, 2, 3))\nresult <- df %>% custompkg::mutate(double = value * 2)\nprint(result)'
      ],
      'open-science-r-qualified-pipe-boundary-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('tracks a dplyr data-mask summary across data replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(group = c("A", "B"), value = c(1, 2))',
        'summary <- df |> group_by(group) |> summarise(mean_value = mean(value), .groups = "drop")\nprint(summary)',
        'df <- data.frame(group = c("A", "B"), value = c(10, 20))'
      ],
      'open-science-r-dplyr-lineage-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('marks a dplyr data-mask result unknown when an ambiguous environment name changes', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(value = c(1, 2, 3))',
        'threshold <- 1',
        'summary <- filter(df, value > threshold)\nprint(summary)',
        'threshold <- 2'
      ],
      'open-science-r-data-mask-environment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('classifies namespace-qualified dplyr, ggplot2, and stats calls', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'df <- data.frame(group = c("A", "B"), value = c(1, 2))',
          'summary <- dplyr::filter(df, !is.na(value))',
          'model <- stats::lm(value ~ group, data = summary)',
          'p <- ggplot2::ggplot(summary, ggplot2::aes(x = group, y = value)) + ggplot2::geom_col()',
          'ggplot2::ggsave("qualified.png", p)'
        ].join('\n')
      ],
      'open-science-r-qualified-calls-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic data-mask pronoun keys conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(ggplot2)\ncolumn_name <- "value"\ndf <- data.frame(value = 1)\np <- ggplot(df, aes(y = .data[[column_name]]))'
      ],
      'open-science-r-dynamic-data-mask-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('tracks data-mask environment callbacks and rejects unknown qualified callbacks', async () => {
    const environmentProjection = await projectScripts(
      'r',
      [
        'library(dplyr)\npredicate <- function(value) value > 0\ndf <- data.frame(value = 1)',
        'summary <- filter(df, .env$predicate(value))'
      ],
      'open-science-r-data-mask-callback-corpus-'
    )
    const qualifiedProjection = await projectScripts(
      'r',
      [
        'library(dplyr)\ndf <- data.frame(value = 1)\nsummary <- filter(df, custompkg::predicate(value))'
      ],
      'open-science-r-qualified-callback-corpus-'
    )

    expect(environmentProjection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(qualifiedProjection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('marks a ggplot bare-name result unknown when the possible environment value changes', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(ggplot2)\ndf <- data.frame(value = 1)\nthreshold <- 1',
        'p <- ggplot(df, aes(y = threshold))',
        'threshold <- 2'
      ],
      'open-science-r-ggplot-environment-fallback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps namespace-qualified tabular reads copy-on-modify', async () => {
    const projection = await projectScripts(
      'r',
      [
        'a <- utils::read.csv("data.csv")',
        'b <- a',
        'result <- nrow(a)\nprint(result)',
        'b[[1]] <- 99'
      ],
      'open-science-r-qualified-read-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('classifies base-qualified pure calls while keeping readRDS references conservative', async () => {
    const pureProjection = await projectScripts(
      'r',
      ['x <- c(1, 2, 3)\nresult <- base::mean(x) + base::sum(x)\nprint(result)'],
      'open-science-r-base-qualified-corpus-'
    )
    const referenceProjection = await projectScripts(
      'r',
      ['a <- base::readRDS("object.rds")', 'b <- a', 'snapshot <- a$x', 'b$x <- 1'],
      'open-science-r-base-read-rds-corpus-'
    )

    expect(pureProjection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(referenceProjection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('classifies a common ggplot2 pie-chart workflow as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(ggplot2)',
          'set.seed(1)',
          'angles <- seq(0, 2*pi, length.out = 9)[1:8]',
          'df <- data.frame(label = c(paste0("sin theta=", round(angles, 2)), paste0("cos theta=", round(angles, 2))), value = abs(c(sin(angles), cos(angles))))',
          'df$frac <- df$value / sum(df$value)',
          'df$label_pos <- cumsum(df$frac) - df$frac/2',
          'p <- ggplot(df, aes(x = "", y = value, fill = label)) +',
          '  geom_bar(stat = "identity", width = 1, color = "white") +',
          '  coord_polar(theta = "y") +',
          '  geom_text(aes(x = 1.2, y = label_pos, label = paste0(round(frac*100, 1), "%"))) +',
          '  labs(title = "Pie chart", fill = "Slice") +',
          '  theme_void()',
          'ggsave("sin_cos_pie_ggplot.png", p, width = 8, height = 8, dpi = 150)',
          'cat("Saved:", file.exists("sin_cos_pie_ggplot.png"), "\\n")'
        ].join('\n')
      ],
      'open-science-r-ggplot-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('classifies a common dplyr and tidyr reshape workflow as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(dplyr)',
          'library(tidyr)',
          'wide <- data.frame(sample = c("A", "B"), before = c(1, 2), after = c(3, 4))',
          'report <- wide |>',
          '  pivot_longer(cols = c(before, after), names_to = "time", values_to = "value") |>',
          '  mutate(centered = value - mean(value)) |>',
          '  group_by(sample, time) |>',
          '  summarise(mean_value = mean(centered), .groups = "drop") |>',
          '  pivot_wider(names_from = time, values_from = mean_value)',
          'write.csv(report, "tidy-report.csv", row.names = FALSE)',
          'print(report)'
        ].join('\n')
      ],
      'open-science-r-tidyr-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('tracks a tidyr reshape across source replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(tidyr)\nwide <- data.frame(sample = c("A", "B"), before = c(1, 2), after = c(3, 4))',
        'long <- pivot_longer(wide, cols = c(before, after), names_to = "time", values_to = "value")\nprint(long)',
        'wide <- data.frame(sample = "C", before = 10, after = 20)'
      ],
      'open-science-r-tidyr-lineage-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('keeps a proven tidyr data-frame result copy-on-modify', async () => {
    const projection = await projectScripts(
      'r',
      [
        'wide <- data.frame(sample = c("A", "B"), before = c(1, 2), after = c(3, 4))',
        'long <- tidyr::pivot_longer(wide, cols = c(before, after), names_to = "time", values_to = "value")',
        'alias <- long',
        'result <- nrow(long)\nprint(result)',
        'alias[[1]] <- c("X", "Y", "X", "Y")'
      ],
      'open-science-r-tidyr-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' },
      'run-5': { state: 'clear' }
    })
  })

  it('keeps a dplyr result with a reference-bearing list column conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(dplyr)\nsource <- data.frame(id = 1)\nenv <- new.env()\nenv$value <- 1',
        'report <- mutate(source, ref = list(env))',
        'alias <- report',
        'snapshot <- report$ref[[1]]$value\nprint(snapshot)',
        'alias$ref[[1]]$value <- 2'
      ],
      'open-science-r-dplyr-reference-column-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps ordinary R list copy-on-modify runs clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        'a <- list(1, 2, 3)',
        'b <- a',
        'result <- length(a)\nprint(result)',
        'b[[1]] <- 99\nprint(b)\nprint(a)'
      ],
      'open-science-r-copy-on-modify-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('keeps readRDS results conservative because they may restore reference objects', async () => {
    const projection = await projectScripts(
      'r',
      ['a <- readRDS("object.rds")', 'b <- a', 'snapshot <- a$x\nprint(snapshot)', 'b$x <- 1'],
      'open-science-r-read-rds-reference-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('tracks a common base R model across data replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'df <- data.frame(group = c("A", "A", "B"), value = c(1, 2, 3))',
        'model <- lm(value ~ group, data = df)\nreport <- summary(model)\nprint(report)',
        'df <- data.frame(group = c("A", "B"), value = c(10, 20))'
      ],
      'open-science-r-model-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('keeps dynamic R namespace access conservative', async () => {
    const projection = await projectScripts(
      'r',
      ['baseline <- 1\nprint(baseline)', 'assign("hidden", 1, envir = .GlobalEnv)'],
      'open-science-r-dynamic-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('classifies common NumPy transforms and distribution summaries as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nvalues = np.linspace(0, 10, 101)',
        'baseline = np.sum(values)\nprint(baseline)',
        [
          'scaled = np.clip(np.log1p(np.abs(values)), 0, 2)',
          'finite = np.isfinite(scaled)',
          'quartiles = np.percentile(scaled, [25, 50, 75])',
          'selected = np.where(finite, scaled, 0)',
          'print(quartiles, selected.mean())'
        ].join('\n')
      ],
      'open-science-python-numpy-transforms-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' }
    })
  })

  it('classifies a common Seaborn plot and tracks its explicit axes mutation', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import pandas as pd',
          'import matplotlib.pyplot as plt',
          'import seaborn as sns',
          'frame = pd.DataFrame({"x": [1, 2], "y": [2, 4], "group": ["a", "b"]})',
          'fig, ax = plt.subplots()'
        ].join('\n'),
        'print(ax)',
        'plot_ax = sns.scatterplot(data=frame, x="x", y="y", hue="group", ax=ax)\nfig.savefig("scatter.png")',
        'print(ax)',
        'plot_ax.set_title("Updated")'
      ],
      'open-science-python-seaborn-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic Seaborn estimators conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'from analysis_callbacks import estimator',
          'import pandas as pd',
          'import seaborn as sns',
          'frame = pd.DataFrame({"group": ["a", "a"], "value": [1, 2]})',
          'plot_ax = sns.barplot(data=frame, x="group", y="value", estimator=estimator)'
        ].join('\n')
      ],
      'open-science-python-seaborn-callback-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('classifies common readr and tibble workflows as clear', async () => {
    const projection = await projectScripts(
      'r',
      [
        [
          'library(readr)',
          'library(tibble)',
          'library(dplyr)',
          'data <- read_csv("measurements.csv", show_col_types = FALSE)',
          'labels <- tibble(group = c("a", "b"), label = c("A", "B"))',
          'summary <- data |> mutate(ratio = value / sum(value))',
          'write_csv(summary, "summary.csv")',
          'print(labels)',
          'print(summary)'
        ].join('\n')
      ],
      'open-science-r-readr-tibble-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('keeps an attached readr table copy-on-modify across aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(readr)\ndata <- read_csv("measurements.csv", show_col_types = FALSE)',
        'alias <- data',
        'snapshot <- nrow(data)\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-attached-readr-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('recognizes tribble column declarations and preserves value-copy semantics', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(tibble)\ndata <- tribble(~group, ~value, "a", 1, "b", 2)',
        'alias <- data',
        'snapshot <- data$value\nprint(snapshot)',
        'alias$value <- c(3, 4)'
      ],
      'open-science-r-tribble-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('classifies qualified readr and tibble calls without trusting serialized references', async () => {
    const valueProjection = await projectScripts(
      'r',
      [
        [
          'data <- readr::read_csv("measurements.csv", show_col_types = FALSE)',
          'labels <- tibble::tibble(group = c("a", "b"))',
          'readr::write_csv(data, "summary.csv")',
          'print(labels)'
        ].join('\n')
      ],
      'open-science-r-qualified-readr-corpus-'
    )
    const referenceProjection = await projectScripts(
      'r',
      ['a <- readr::read_rds("object.rds")', 'b <- a', 'snapshot <- a$x', 'b$x <- 1'],
      'open-science-r-readr-rds-corpus-'
    )

    expect(valueProjection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(referenceProjection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('classifies a common scikit-learn preprocessing and regression workflow', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0], [3.0, 6.0]])\ntarget = np.array([1.0, 2.0, 3.0])',
        [
          'from sklearn.preprocessing import StandardScaler',
          'scaler = StandardScaler()',
          'scaled = scaler.fit_transform(features)'
        ].join('\n'),
        'scaled_mean = scaled.mean()\nprint(scaled_mean)',
        [
          'from sklearn.linear_model import LinearRegression',
          'model = LinearRegression()',
          'model.fit(scaled, target)',
          'predictions = model.predict(scaled)',
          'print(predictions)'
        ].join('\n'),
        'features = np.array([[10.0, 20.0], [20.0, 40.0]])'
      ],
      'open-science-python-sklearn-workflow-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('does not trust an unrelated estimator with scikit-learn-style method names', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'from custom_models import Estimator',
          'features = [[1.0], [2.0]]',
          'target = [1.0, 2.0]',
          'model = Estimator()',
          'model.fit(features, target)',
          'predictions = model.predict(features)'
        ].join('\n')
      ],
      'open-science-python-custom-estimator-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('marks a prior model consumer after a scikit-learn refit', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0], [2.0]])\ntarget = np.array([1.0, 2.0])',
        'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()',
        'fitted = model.fit(features, target)',
        'print(model)',
        'fitted.fit(features, target)'
      ],
      'open-science-python-sklearn-refit-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('classifies a common scikit-learn PCA transform as clear', async () => {
    const projection = await projectScripts(
      'python',
      [
        [
          'import numpy as np',
          'from sklearn.decomposition import PCA',
          'features = np.array([[1.0, 2.0], [2.0, 4.0], [3.0, 7.0]])',
          'reducer = PCA(n_components=2)',
          'reduced = reducer.fit_transform(features)',
          'restored = reducer.inverse_transform(reduced)',
          'print(restored)'
        ].join('\n')
      ],
      'open-science-python-sklearn-pca-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it.each([
    [
      'StandardScaler(copy=False)',
      'from sklearn.preprocessing import StandardScaler\nmodel = StandardScaler(copy=False)\nmodel.fit_transform(features)'
    ],
    [
      'PCA(copy=False)',
      'from sklearn.decomposition import PCA\nmodel = PCA(copy=False)\nmodel.fit(features)'
    ],
    [
      'LinearRegression(copy_X=False)',
      'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression(copy_X=False)\nmodel.fit(features, target)'
    ],
    [
      'StandardScaler(copy=runtime_flag)',
      'from sklearn.preprocessing import StandardScaler\nruntime_flag = bool(target[0])\nmodel = StandardScaler(copy=runtime_flag)\nmodel.fit_transform(features)'
    ]
  ])('keeps %s input mutation conservative', async (_label, modelScript) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0]])\ntarget = np.array([1.0, 2.0])',
        'snapshot = features.mean()\nprint(snapshot)',
        modelScript
      ],
      'open-science-python-sklearn-copy-false-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    [
      'a StandardScaler copy field write',
      'from sklearn.preprocessing import StandardScaler\nmodel = StandardScaler()\nmodel.copy = False\nmodel.transform(features)'
    ],
    [
      'PCA.set_params(copy=False)',
      'from sklearn.decomposition import PCA\nmodel = PCA()\nmodel.set_params(copy=False)\nmodel.fit(features)'
    ],
    [
      'LinearRegression.set_params(copy_X=False)',
      'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()\nmodel.set_params(copy_X=False)\nmodel.fit(features, target)'
    ]
  ])('keeps input mutation conservative after %s', async (_label, modelScript) => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0]])\ntarget = np.array([1.0, 2.0])',
        'snapshot = features.mean()\nprint(snapshot)',
        modelScript
      ],
      'open-science-python-sklearn-copy-reconfigure-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps a later StandardScaler copy reconfiguration across runs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([[1.0, 2.0], [2.0, 4.0]])',
        'snapshot = features.mean()\nprint(snapshot)',
        'from sklearn.preprocessing import StandardScaler\nmodel = StandardScaler()',
        'params = {"copy": False}\nmodel.set_params(**params)',
        'model.transform(features)'
      ],
      'open-science-python-sklearn-copy-reconfigure-runs-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('classifies a statsmodels OLS workflow and tracks its inputs', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import numpy as np\nfeatures = np.array([1.0, 2.0, 3.0])\ntarget = np.array([2.0, 4.0, 6.0])',
        [
          'import statsmodels.api as sm',
          'design = sm.add_constant(features)',
          'model = sm.OLS(target, design)'
        ].join('\n'),
        [
          'results = model.fit()',
          'predictions = results.predict(design)',
          'print(predictions)',
          'print(results.summary())'
        ].join('\n'),
        'target = np.array([3.0, 6.0, 9.0])'
      ],
      'open-science-python-statsmodels-ols-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('classifies a statsmodels formula workflow and tracks its data frame', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"x": [1.0, 2.0, 3.0], "y": [2.0, 4.0, 6.0]})',
        [
          'import statsmodels.formula.api as smf',
          'model = smf.ols("y ~ x", data=frame)',
          'results = model.fit()',
          'print(results.summary())'
        ].join('\n'),
        'frame = pd.DataFrame({"x": [10.0, 20.0], "y": [30.0, 60.0]})'
      ],
      'open-science-python-statsmodels-formula-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps dynamic statsmodels formula evaluation conservative', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"x": [1.0, 2.0], "y": [2.0, 4.0]})',
        [
          'import statsmodels.formula.api as smf',
          'model = smf.ols("y ~ custom_transform(x)", data=frame)',
          'print(model)'
        ].join('\n')
      ],
      'open-science-python-statsmodels-dynamic-formula-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('tracks simple statsmodels formula names as possible environment lookups', async () => {
    const projection = await projectScripts(
      'python',
      [
        'import pandas as pd\nframe = pd.DataFrame({"x": [1.0, 2.0], "y": [2.0, 4.0]})',
        'import statsmodels.formula.api as smf\nmodel = smf.ols("y ~ x", data=frame)',
        'x = [10.0, 20.0]'
      ],
      'open-science-python-statsmodels-formula-environment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps an attached readxl table copy-on-modify across aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(readxl)\ndata <- read_excel("measurements.xlsx")',
        'alias <- data',
        'snapshot <- nrow(data)\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-readxl-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it.each([
    ['base fixed-width data', 'item <- read.fwf("measurements.txt", widths = c(4, 8))'],
    ['base text lines', 'item <- readLines("measurements.txt")'],
    ['jsonlite JSON', 'item <- jsonlite::fromJSON("measurements.json")'],
    ['yaml YAML', 'item <- yaml::read_yaml("config.yaml")'],
    ['vroom table', 'item <- vroom::vroom("measurements.csv")'],
    ['sf vector data', 'item <- sf::st_read("regions.gpkg")'],
    ['Matrix Market data', 'item <- Matrix::readMM("matrix.mtx")']
  ])('keeps a %s reader copy-on-modify across aliases', async (_label, read) => {
    const projection = await projectScripts(
      'r',
      [read, 'alias <- item', 'snapshot <- length(item)\nprint(snapshot)', 'alias[1] <- 99'],
      'open-science-r-value-file-reader-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('keeps dynamic YAML evaluation namespace-unknown', async () => {
    const projection = await projectScripts(
      'r',
      ['item <- yaml::yaml.load_file("config.yaml", eval.expr = TRUE)'],
      'open-science-r-dynamic-yaml-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it.each(['NULL', 'list()'])(
    'keeps a static empty YAML handlers=%s read clear',
    async (handlers) => {
      const projection = await projectScripts(
        'r',
        [`item <- yaml::yaml.load_file("config.yaml", handlers = ${handlers})`],
        'open-science-r-static-yaml-reader-corpus-'
      )

      expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    }
  )

  it.each([
    ['base con', 'values <- readBin(what = "integer", con = handle)'],
    ['YAML input', 'value <- yaml::yaml.load_file(input = handle)'],
    ['sf dsn', 'value <- sf::st_read(dsn = handle)'],
    ['jsonlite txt', 'value <- jsonlite::fromJSON(txt = handle)']
  ])('treats a variable R %s argument as a possible consumed connection', async (_label, read) => {
    const projection = await projectScripts(
      'r',
      ['handle <- new.env()\nhandle$value <- 1', 'snapshot <- handle$value\nprint(snapshot)', read],
      'open-science-r-consumed-file-handle-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it.each([
    ['Arrow table', 'item <- arrow::read_parquet("measurements.parquet", as_data_frame = FALSE)'],
    ['terra raster', 'item <- terra::rast("elevation.tif")'],
    ['rio import', 'item <- rio::import("measurements.rds")']
  ])('recognizes a %s reader while preserving possible reference aliases', async (_label, read) => {
    const projection = await projectScripts(
      'r',
      [read, 'alias <- item', 'snapshot <- length(item)\nprint(snapshot)', 'alias[1] <- 99'],
      'open-science-r-reference-file-reader-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('classifies qualified haven reads and writes as value-table I/O', async () => {
    const projection = await projectScripts(
      'r',
      [
        'data <- haven::read_sav("survey.sav")',
        'alias <- data',
        'snapshot <- nrow(data)\nhaven::write_sav(data, "survey-copy.sav")\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-haven-copy-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' },
      'run-4': { state: 'clear' }
    })
  })

  it('tracks data.table aliases and := updates by reference', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'alias[, value := value + 1]'
      ],
      'open-science-r-data-table-reference-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps data.table reference identity through multiple aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'first_alias <- table',
        'second_alias <- first_alias',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'second_alias[, value := value + 1]'
      ],
      'open-science-r-data-table-alias-chain-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('detaches a data.table alias on ordinary R member replacement', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'alias$value <- c(4, 5, 6)'
      ],
      'open-science-r-data-table-copy-on-member-write-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('preserves the remaining R copy alias class after one name detaches', async () => {
    const projection = await projectScripts(
      'r',
      [
        'first <- data.frame(value = c(1, 2, 3))',
        'second <- first',
        'third <- first',
        'first$value <- c(4, 5, 6)',
        'snapshot <- sum(third$value)\nprint(snapshot)',
        'data.table::setDT(second)'
      ],
      'open-science-r-copy-alias-equivalence-corpus-'
    )

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('keeps mixed same-run copy and reference updates conservative', async () => {
    const projection = await projectScripts(
      'r',
      [
        'first <- data.frame(value = c(1, 2, 3))',
        'second <- first',
        'second$value <- c(4, 5, 6)\ndata.table::setDT(first)',
        'alias <- second',
        'snapshot <- sum(second$value)\nprint(snapshot)',
        'alias$value <- c(7, 8, 9)'
      ],
      'open-science-r-copy-reference-order-corpus-'
    )

    expect(projection?.stalenessByRunId['run-5']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('tracks data.table set helpers as definite alias mutations', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- names(table)\nprint(snapshot)',
        'setnames(alias, "value", "measurement")'
      ],
      'open-science-r-data-table-set-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('does not treat a data.frame set helper as a data.table conversion', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'data.table::setnames(frame, "value", "measurement")',
        'holder <- list(frame)',
        'alias <- holder',
        'snapshot <- sum(holder[[1]]$measurement)\nprint(snapshot)',
        'alias[[1]]$measurement <- c(4, 5, 6)'
      ],
      'open-science-r-data-frame-set-helper-corpus-'
    )

    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('keeps same-run ordinary and reference updates uncertain for detached aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(value = c(1, 2, 3))',
        'alias <- table',
        'snapshot <- sum(alias$value)\nprint(snapshot)',
        'table$value <- c(4, 5, 6)\ntable[, doubled := value * 2]'
      ],
      'open-science-r-data-table-same-receiver-order-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps a same-run reference update and receiver rebind uncertain for old aliases', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'alias <- frame',
        'snapshot <- sum(alias$value)\nprint(snapshot)',
        'data.table::setDT(frame)\nframe <- data.frame(value = c(4, 5, 6))'
      ],
      'open-science-r-reference-update-rebind-order-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({
      state: 'unknown',
      reasons: ['opaque-mutation']
    })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('does not trust a shadowed unqualified data.table mutator', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'snapshot <- sum(frame$value)\nprint(snapshot)',
        'setnames <- function(...) NULL',
        'setnames(frame, "value", "measurement")'
      ],
      'open-science-r-shadowed-set-helper-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  })

  it('does not keep a type conversion from a shadowed setDT call', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'setDT <- function(x) x',
        'setDT(frame)',
        'holder <- list(frame)',
        'alias <- holder',
        'snapshot <- sum(holder[[1]]$value)\nprint(snapshot)',
        'alias[[1]]$value <- c(4, 5, 6)'
      ],
      'open-science-r-shadowed-set-dt-type-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-6']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-7']).toMatchObject({ state: 'unknown' })
    expect(projection?.invalidatedByRunId['run-7']).toBeUndefined()
  })

  it('keeps a qualified data.table mutator definite beside a shadowed call', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'alias <- frame',
        'snapshot <- sum(alias$value)\nprint(snapshot)',
        'setDT <- function(x) x',
        'setDT(frame)\ndata.table::setDT(frame)'
      ],
      'open-science-r-mixed-qualified-set-dt-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toMatchObject({ state: 'unknown' })
  })

  it('keeps an attached data.table copy independent from later reference updates', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(value = c(1, 2, 3))',
        'clone <- copy(table)',
        'snapshot <- sum(table$value)\nprint(snapshot)',
        'clone[, value := value + 1]'
      ],
      'open-science-r-data-table-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('classifies a common data.table grouped aggregation as a read', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(data.table)\ntable <- data.table(group = c("a", "a", "b"), value = c(1, 2, 3))',
        'summary <- table[, .(total = sum(value)), by = group]\nprint(summary)'
      ],
      'open-science-r-data-table-aggregation-corpus-'
    )

    expect(projection?.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' }
    })
  })

  it('classifies qualified data.table I/O and tracks setkey by reference', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::fread("measurements.csv")',
        'snapshot <- nrow(table)\ndata.table::fwrite(table, "measurements-copy.csv")\nprint(snapshot)',
        'data.table::setkey(table, id)'
      ],
      'open-science-r-data-table-io-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks setDT and setnafill as definite data.table mutations', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, NA, 3))',
        'data.table::setDT(frame)',
        'alias <- frame',
        'snapshot <- sum(is.na(frame$value))\nprint(snapshot)',
        'data.table::setnafill(alias, fill = 0)'
      ],
      'open-science-r-data-table-conversion-corpus-'
    )

    expect(projection?.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it('propagates setDT through aliases created before conversion', async () => {
    const projection = await projectScripts(
      'r',
      [
        'frame <- data.frame(value = c(1, 2, 3))',
        'alias <- frame',
        'snapshot <- nrow(alias)\nprint(snapshot)',
        'data.table::setDT(frame)'
      ],
      'open-science-r-data-table-pre-conversion-alias-corpus-'
    )

    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('restores copy-on-modify semantics after data.table::setDF', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(value = c(1, 2, 3))',
        'existing_alias <- table',
        'data.table::setDF(table)',
        'alias <- existing_alias',
        'snapshot <- sum(existing_alias$value)\nprint(snapshot)',
        'alias[[1]] <- 99'
      ],
      'open-science-r-data-table-set-df-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  })

  it('tracks data.table::setindexv as a definite root mutation', async () => {
    const projection = await projectScripts(
      'r',
      [
        'table <- data.table::data.table(id = c(2, 1), value = c(10, 20))',
        'snapshot <- table$value\nprint(snapshot)',
        'data.table::setindexv(table, "id")'
      ],
      'open-science-r-data-table-set-index-v-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks SummarizedExperiment assay reads and replacement accessors', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SummarizedExperiment)\ncounts <- matrix(c(1, 2, 3, 4), nrow = 2)\nse <- SummarizedExperiment(assays = list(counts = counts))',
        'snapshot <- sum(assay(se))\nprint(snapshot)',
        'assay(se) <- matrix(c(10, 20, 30, 40), nrow = 2)',
        'latest <- sum(assay(se))\nprint(latest)'
      ],
      'open-science-r-summarized-experiment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps a possibly delayed extracted assay linked conservatively', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SummarizedExperiment)\nse <- SummarizedExperiment(assays = list(counts = matrix(c(1, 2), nrow = 1)))',
        'counts <- assay(se)',
        'snapshot <- sum(assay(se))\nprint(snapshot)',
        'counts[[1]] <- 99'
      ],
      'open-science-r-summarized-experiment-copy-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })

  it('keeps an accessor on an unsummarized S4 receiver dynamic', async () => {
    const projection = await projectScripts(
      'r',
      ['custom <- external_container', 'values <- assay(custom)\nprint(values)'],
      'open-science-r-bioconductor-dynamic-dispatch-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('keeps a replacement accessor on an unsummarized S4 receiver dynamic', async () => {
    const projection = await projectScripts(
      'r',
      ['custom <- external_container', 'assay(custom) <- replacement'],
      'open-science-r-bioconductor-dynamic-replacement-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it('tracks SingleCellExperiment reducedDim replacement accessors', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SingleCellExperiment)\nsce <- SingleCellExperiment(assays = list(counts = matrix(1:4, nrow = 2)))',
        'embedding <- reducedDim(sce, "PCA")\nprint(embedding)',
        'reducedDim(sce, "PCA") <- matrix(c(1, 0, 0, 1), nrow = 2)'
      ],
      'open-science-r-single-cell-experiment-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('tracks nested rowData replacement on a SummarizedExperiment root', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(SummarizedExperiment)\nse <- SummarizedExperiment(assays = list(counts = matrix(1:4, nrow = 2)))',
        'snapshot <- nrow(rowData(se))\nprint(snapshot)',
        'rowData(se)$batch <- c("a", "b")'
      ],
      'open-science-r-summarized-experiment-row-data-corpus-'
    )

    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    expect(projection?.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  })

  it('keeps extracted ExpressionSet assay data linked conservatively', async () => {
    const projection = await projectScripts(
      'r',
      [
        'library(Biobase)\nset <- ExpressionSet(assayData = matrix(1:4, nrow = 2))',
        'values <- exprs(set)',
        'snapshot <- sum(exprs(set))\nprint(snapshot)',
        'values[[1]] <- 99'
      ],
      'open-science-r-expression-set-corpus-'
    )

    expect(projection?.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection?.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection?.stalenessByRunId['run-4']).toEqual({ state: 'clear' })
  })
})

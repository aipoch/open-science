import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookSerializedValue } from './dependency-analysis-types'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

type Case = {
  name: string
  language: 'r' | 'python'
  writer: string
  reader: string
  value: NotebookSerializedValue
}
const cases: Case[] = [
  {
    name: 'NumPy NPY with automatic extension',
    language: 'python',
    writer: 'import numpy as np\nd=np.array([1,2,3])\nnp.save("middle",d)',
    reader: 'import numpy as np\nd=np.load("middle.npy")\nnp.savetxt("out.csv",d*2)',
    value: { path: 'middle.npy', format: 'npy', valueType: 'numpy.ndarray' }
  },
  {
    name: 'readr RDS',
    language: 'r',
    writer: 'library(readr); d<-data.frame(x=1:3); write_rds(d,"middle.bin")',
    reader: 'library(readr); d<-read_rds("middle.bin"); d<-subset(d,x>1); write.csv(d,"out.csv")',
    value: { path: 'middle.bin', format: 'rds', valueType: 'r-value' }
  },
  {
    name: 'QS',
    language: 'r',
    writer: 'd<-data.frame(x=1:3); qs::qsave(d,"middle.bin")',
    reader: 'd<-qs::qread("middle.bin"); d<-subset(d,x>1); write.csv(d,"out.csv")',
    value: { path: 'middle.bin', format: 'qs', valueType: 'r-value' }
  },
  {
    name: 'pandas DataFrame pickle',
    language: 'python',
    writer:
      'import pandas as pd\nd=pd.DataFrame({"x":[1,2,3]})\npath="middle.bin"\nd.to_pickle(path)',
    reader:
      'import pandas as pd\npath="middle.bin"\nd=pd.read_pickle(path)\nd=d[d["x"]>1]\nd.to_csv("out.csv",index=False)',
    value: { path: 'middle.bin', format: 'python-pickle', valueType: 'pandas.DataFrame' }
  },
  {
    name: 'pandas Series pickle',
    language: 'python',
    writer: 'import pandas as pd\nd=pd.Series([1,2,3])\nd.to_pickle("middle.bin")',
    reader:
      'from pandas import read_pickle\nd=read_pickle("middle.bin")\nd=d[d>1]\nd.to_csv("out.csv")',
    value: { path: 'middle.bin', format: 'python-pickle', valueType: 'pandas.Series' }
  },
  {
    name: 'pandas function pickle',
    language: 'python',
    writer:
      'import pandas as pd\nd=pd.DataFrame({"x":[1,2,3]})\npd.to_pickle(d,filepath_or_buffer="middle.bin")',
    reader:
      'import pandas as pd\nd=pd.read_pickle(filepath_or_buffer="middle.bin")\nd.to_csv("out.csv")',
    value: { path: 'middle.bin', format: 'python-pickle', valueType: 'pandas.DataFrame' }
  },
  {
    name: 'pickle file handles',
    language: 'python',
    writer:
      'import pandas as pd\nimport pickle\nd=pd.DataFrame({"x":[1,2,3]})\nwith open("middle.bin","wb") as f:\n    pickle.dump(d,f)',
    reader:
      'import pickle\nwith open("middle.bin","rb") as f:\n    d=pickle.load(f)\nd.to_csv("out.csv")',
    value: { path: 'middle.bin', format: 'python-pickle', valueType: 'pandas.DataFrame' }
  },
  {
    name: 'joblib NumPy array',
    language: 'python',
    writer: 'import numpy as np\nimport joblib\nd=np.array([1,2,3])\njoblib.dump(d,"middle.bin")',
    reader:
      'import numpy as np\nfrom joblib import load\nd=load("middle.bin")\nnp.savetxt("out.csv",d*2)',
    value: { path: 'middle.bin', format: 'joblib', valueType: 'numpy.ndarray' }
  }
]

it.each(cases)(
  'preserves verified types for $name',
  async ({ language, writer, reader, value }) => {
    const analyze = language === 'r' ? analyzeRNotebookSource : analyzePythonNotebookSource
    const producer = await analyze(writer)
    expect((await analyzeNotebookSourceFileAccess(language, writer)).externalState).toBe('complete')
    expect(producer.facts.serializedValueWrites).toEqual([value])
    expect((await analyzeNotebookSourceFileAccess(language, writer)).writes).toEqual([value.path])
    if (value.format !== 'npy')
      expect((await analyzeNotebookSourceFileAccess(language, reader)).externalState).toBe(
        'partial'
      )
    const result = await analyzeNotebookSourceFileAccess(language, reader, {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      verifiedSerializedValues: [value]
    })
    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [value.path],
      writes: ['out.csv']
    })
  }
)

it.each(cases)(
  'rebuilds $name across fresh kernels using file generations',
  async ({ language, writer, reader, value }) => {
    const root = await mkdtemp(join(tmpdir(), 'intermediate-generation-'))
    const run = (script: string, index: number): NotebookRunRecord => ({
      runId: String(index),
      cellId: String(index),
      kernelKind: language,
      kernelEpochId: `epoch-${index}`,
      environment: language,
      source: 'agent',
      status: 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      script,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    })
    const runs = [run(writer, 0), run(reader, 1)]
    try {
      for (const [index, activity] of runs.entries()) {
        const key = `evidence/${index}/evidence.json`
        const json = JSON.stringify({
          schemaVersion: 1,
          evidenceId: `e-${index}`,
          activityId: activity.runId,
          activityKind: 'notebook-run',
          relations: [
            {
              relation: index === 0 ? 'created' : 'present-before',
              relativePath: `data/${value.path}`,
              generation: { relativePath: `data/${value.path}`, checksum: 'a'.repeat(64) }
            }
          ]
        })
        await mkdir(join(root, 'evidence', String(index)), { recursive: true })
        await writeFile(join(root, key), json)
        activity.fileEvidence = {
          schemaVersion: 1,
          activityId: activity.runId,
          activityKind: 'notebook-run',
          evidenceId: `e-${index}`,
          storageKey: key,
          checksum: createHash('sha256').update(json).digest('hex'),
          state: 'available',
          initialViewState: 'complete',
          managedRootsFinalState: 'complete',
          scientificOutputAnalysis: 'complete',
          scientificOutputCount: 0,
          fileReads: 'complete',
          externalPaths: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        }
      }
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const projection = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: '1'
      })
      expect(projection.stalenessByRunId['1'], JSON.stringify(projection.stalenessByRunId)).toEqual(
        { state: 'clear' }
      )
      expect(projection.dependenciesByRunId?.['1']).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  'import pandas as pd\nd=unknown\nd.to_pickle("middle.bin")',
  'import pandas as pd\nd=pd.DataFrame({"x":[1]})\nd.to_pickle("middle.bin")\nd.to_csv("./middle.bin")',
  'import pandas as pd\nd=pd.DataFrame({"x":[1]})\nif flag:\n    d.to_pickle("middle.bin")',
  'import pandas as pd\nd=pd.DataFrame({"x":[1]})\nd.to_pickle("middle.bin")\nwith open("middle.bin","wb") as f:\n    f.write(b"bad")'
])('does not certify unknown, conditional, or overwritten Python values', async (source) => {
  expect((await analyzePythonNotebookSource(source)).facts.serializedValueWrites ?? []).toEqual([])
})

it.each(['rds', 'qs', 'joblib'] as const)(
  'rejects incompatible %s bytes for a Python pickle reader',
  async (format) => {
    const result = await analyzeNotebookSourceFileAccess('python', cases[3].reader, {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      verifiedSerializedValues: [
        {
          path: 'middle.bin',
          format,
          valueType: format === 'joblib' ? 'pandas.DataFrame' : 'r-value'
        }
      ]
    })
    expect(result.externalState).toBe('partial')
  }
)

it('does not reuse a read-site certificate for a later call on the same line', async () => {
  const source =
    'import pandas as pd\na=pd.read_pickle("middle.bin"); pd.DataFrame({"x":[1]}).to_csv("middle.bin"); b=pd.read_pickle("middle.bin")\nb.to_csv("out.csv")'
  const result = await analyzeNotebookSourceFileAccess('python', source, {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    verifiedSerializedValues: [cases[3].value]
  })
  expect(result.externalState).toBe('partial')
})

it.each(['read_parquet', 'read_feather', 'read_ipc_file'])(
  'retains the default data-frame result of arrow::%s',
  async (reader) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `d<-arrow::${reader}("middle.bin"); d<-subset(d,x>1); write.csv(d,"out.csv")`
    )
    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['middle.bin'],
      writes: ['out.csv']
    })
  }
)

it.each(['as_data_frame=FALSE', 'as_data_frame=flag', 'NULL,FALSE', 'as_data=FALSE'])(
  'keeps reference or unknown Arrow return modes conservative (%s)',
  async (args) => {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `d<-arrow::read_parquet("middle.bin",${args}); d<-subset(d,x>1); write.csv(d,"out.csv")`
    )
    expect(result.externalState).toBe('partial')
  }
)

it.each([
  'import pandas as pd\npd.read_pickle=custom\nd=pd.read_pickle("middle.bin")\nd.to_csv("out.csv")',
  'import joblib\nd=joblib.load("middle.bin",mmap_mode="r")\nd[0]=4',
  'import pandas as pd\nwith open("middle.bin","wb") as f:\n    f.write(b"replaced")\nd=pd.read_pickle("middle.bin")\nd.to_csv("out.csv")'
])('keeps replaced callables, memory maps, and replaced files conservative', async (source) => {
  const result = await analyzeNotebookSourceFileAccess('python', source, {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    verifiedSerializedValues: [cases[3].value, cases[7].value]
  })
  expect(result.externalState).toBe('partial')
})

it.each(['save', 'savez', 'savez_compressed'])(
  'captures NumPy %s automatic filename suffixes',
  async (writer) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import numpy as np\nd=np.array([1,2,3])\nnp.${writer}("middle",d)`
    )
    expect(result.writes).toEqual([writer === 'save' ? 'middle.npy' : 'middle.npz'])
    expect(result.externalState).toBe('complete')
  }
)

it('keeps the filename of a NumPy output handle unchanged', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'import numpy as np\nd=np.array([1,2,3])\nwith open("middle.bin","wb") as f:\n    np.save(f,d)'
  )
  expect(result.writes).toEqual(['middle.bin'])
  expect(result.externalState).toBe('complete')
})

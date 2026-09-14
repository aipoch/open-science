import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

describe('input path expressions', () => {
  it.each([
    [
      'multiple Path segments',
      'python',
      'from pathlib import Path\nimport pandas as pd\npd.read_csv(Path("inputs", "groups.csv"))',
      'inputs/groups.csv'
    ],
    [
      'absolute Path segment',
      'python',
      'from pathlib import Path\nimport pandas as pd\npd.read_csv(Path("inputs") / "/data/groups.csv")',
      '/data/groups.csv'
    ],
    [
      'absolute joinpath segment',
      'python',
      'from pathlib import Path\nimport pandas as pd\npd.read_csv(Path("inputs").joinpath("/data", "groups.csv"))',
      '/data/groups.csv'
    ],
    [
      'absolute os.path.join segment',
      'python',
      'import os\nimport pandas as pd\npd.read_csv(os.path.join("inputs", "/data", "groups.csv"))',
      '/data/groups.csv'
    ],
    [
      'suffix removal',
      'python',
      'from pathlib import Path\nimport pandas as pd\npd.read_csv(Path("inputs/groups.csv.bak").with_suffix(""))',
      'inputs/groups.csv'
    ],
    [
      'R named path list',
      'r',
      'files <- list(groups = "inputs/groups.csv")\npath <- files[["groups"]]\ndf <- read.csv(path)',
      'inputs/groups.csv'
    ],
    [
      'R named path member',
      'r',
      'files <- list(groups = "inputs/groups.csv")\ndf <- read.csv(files$groups)',
      'inputs/groups.csv'
    ],
    [
      'R positional path',
      'r',
      'files <- c("inputs/groups.csv", "inputs/unused.csv")\ndf <- read.csv(files[[1]])',
      'inputs/groups.csv'
    ]
  ] as const)('captures %s', async (_label, language, source, path) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      readState: 'complete',
      externalState: 'complete',
      reads: [language === 'python' ? analyzedPythonPath(path) : path],
      reasonCodes: []
    })
  })

  it.each([
    [
      'unknown Path segment',
      'python',
      'from pathlib import Path\nimport pandas as pd\npd.read_csv(Path("inputs", filename))'
    ],
    [
      'rebound R member',
      'r',
      'files <- list(groups = "inputs/groups.csv")\nfiles$groups <- unknown\ndf <- read.csv(files$groups)'
    ],
    [
      'conditionally rebound R list',
      'r',
      'files <- list(groups = "inputs/groups.csv")\nif (flag) files <- unknown\ndf <- read.csv(files[["groups"]])'
    ],
    [
      'unknown R index',
      'r',
      'files <- c("inputs/groups.csv", "inputs/other.csv")\ndf <- read.csv(files[[index]])'
    ],
    ['out of bounds R index', 'r', 'files <- c("inputs/groups.csv")\ndf <- read.csv(files[[2]])'],
    [
      'partial R member name',
      'r',
      'files <- list(groups = "inputs/groups.csv")\ndf <- read.csv(files$gro)'
    ]
  ] as const)('keeps %s unresolved', async (_label, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })

  it('uses a captured R path collection from an earlier cell', async () => {
    await expect(
      analyzeNotebookSourceFileAccess('r', 'path <- files[["groups"]]\ndf <- read.csv(path)', {
        staticStrings: [],
        staticCollections: [
          {
            name: 'files',
            values: ['inputs/groups.csv', 'inputs/unused.csv'],
            entries: [
              { key: 'groups', value: 'inputs/groups.csv' },
              { key: 'unused', value: 'inputs/unused.csv' }
            ]
          }
        ],
        localFileWrappers: []
      })
    ).resolves.toMatchObject({
      readState: 'complete',
      externalState: 'complete',
      reads: ['inputs/groups.csv'],
      reasonCodes: []
    })
  })
})

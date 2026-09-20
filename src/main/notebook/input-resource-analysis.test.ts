import { describe, expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

describe('documented input resource forms', () => {
  it.each([
    [
      'bound R compressed handle',
      'r',
      'con <- gzcon(file("inputs/a.csv.gz", "rb"), text=TRUE)\nx <- read.csv(con)\nclose(con)',
      ['inputs/a.csv.gz']
    ],
    [
      'numpy generator keyword',
      'python',
      'import numpy as np\nx = np.genfromtxt(delimiter=",", fname="inputs/a.csv")',
      ['inputs/a.csv']
    ],
    [
      'Path list with alias',
      'python',
      'from pathlib import Path as P\nimport xarray as xr\nfiles = [P("inputs/a.nc"), P("inputs/b.nc")]\nx = xr.open_mfdataset(paths=files)',
      ['inputs/a.nc', 'inputs/b.nc']
    ],
    [
      'str Path alias',
      'python',
      'from pathlib import Path as P\nimport pandas as pd\nx = pd.read_csv(str(P("inputs/a.csv")))',
      ['inputs/a.csv']
    ],
    [
      'os.path import',
      'python',
      'import os.path\nimport pandas as pd\nx = pd.read_csv(os.path.join("inputs", "a.csv"))',
      ['inputs/a.csv']
    ],
    [
      'Seurat H5',
      'r',
      'x <- Seurat::Read10X_h5(use.names=TRUE, filename="inputs/a.h5")',
      ['inputs/a.h5']
    ],
    [
      'Scanpy H5',
      'python',
      'import scanpy as sc\nx = sc.read_10x_h5(filename="inputs/a.h5")',
      ['inputs/a.h5']
    ],
    [
      'numpy keyword',
      'python',
      'import numpy as np\nx = np.loadtxt(fname="inputs/a.csv")',
      ['inputs/a.csv']
    ],
    [
      'scipy keyword',
      'python',
      'from scipy.io import loadmat\nx = loadmat(file_name="inputs/a.mat")',
      ['inputs/a.mat']
    ],
    [
      'Path alias',
      'python',
      'from pathlib import Path as P\nimport pandas as pd\nx = pd.read_csv(P("inputs/a.csv"))',
      ['inputs/a.csv']
    ],
    [
      'fspath',
      'python',
      'import os\nfrom pathlib import Path\nimport pandas as pd\nx = pd.read_csv(os.fspath(Path("inputs/a.csv")))',
      ['inputs/a.csv']
    ],
    [
      'dict path',
      'python',
      'import pandas as pd\nfiles = {"data":"inputs/a.csv", "unused":"inputs/unused.csv"}\nx = pd.read_csv(files["data"])',
      ['inputs/a.csv']
    ],
    [
      'ExcelFile',
      'python',
      'import pandas as pd\nbook = pd.ExcelFile("inputs/a.xlsx")\nx = book.parse("Sheet1")',
      ['inputs/a.xlsx']
    ],
    [
      'ExcelFile with',
      'python',
      'import pandas as pd\nwith pd.ExcelFile("inputs/a.xlsx") as book:\n    x = pd.read_excel(book, "Sheet1")',
      ['inputs/a.xlsx']
    ],
    [
      'xarray list',
      'python',
      'import xarray as xr\nx = xr.open_mfdataset(["inputs/a.nc", "inputs/b.nc"])',
      ['inputs/a.nc', 'inputs/b.nc']
    ],
    ['numpy data lines', 'python', 'import numpy as np\nx = np.loadtxt(["1 2", "3 4"])', []],
    [
      'ZIP member',
      'python',
      'from zipfile import ZipFile\nimport pandas as pd\nwith ZipFile("inputs/a.zip") as archive:\n    with archive.open("a.csv") as stream:\n        x = pd.read_csv(stream)',
      ['inputs/a.zip']
    ],
    [
      'R reordered filepath',
      'r',
      'x <- Biostrings::readDNAStringSet(format="fasta", filepath="inputs/a.fa")',
      ['inputs/a.fa']
    ],
    [
      'R positional after named',
      'r',
      'x <- read.csv(header=TRUE, "inputs/a.csv")',
      ['inputs/a.csv']
    ],
    [
      'R readr vector',
      'r',
      'x <- readr::read_csv(c("inputs/a.csv", "inputs/b.csv"))',
      ['inputs/a.csv', 'inputs/b.csv']
    ],
    [
      'R vroom vector',
      'r',
      'x <- vroom::vroom(c("inputs/a.csv", "inputs/b.csv"))',
      ['inputs/a.csv', 'inputs/b.csv']
    ],
    [
      'R Biostrings vector',
      'r',
      'paths <- c("inputs/a.fa", "inputs/b.fa")\nx <- Biostrings::readDNAStringSet(filepath=paths)',
      ['inputs/a.fa', 'inputs/b.fa']
    ],
    ['R gzcon', 'r', 'x <- readLines(gzcon(file("inputs/a.txt.gz", "rb")))', ['inputs/a.txt.gz']],
    [
      'R connection list',
      'r',
      'x <- readr::read_csv(list(file("inputs/a.csv"), file("inputs/b.csv")))',
      ['inputs/a.csv', 'inputs/b.csv']
    ]
  ] as const)('captures %s', async (_name, language, source, reads) => {
    const expectedReads =
      language === 'python' && /Path\(|os\.path\.join|pathlib/u.test(source)
        ? reads.map(analyzedPythonPath)
        : [...reads]
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      readState: 'complete',
      externalState: 'complete',
      reads: expectedReads,
      reasonCodes: []
    })
  })

  it.each([
    ['numpy unknown data generator', 'python', 'import numpy as np\nx = np.loadtxt(lines)'],
    [
      'xarray unknown list item',
      'python',
      'import xarray as xr\nx = xr.open_mfdataset(["inputs/a.nc", other])'
    ],
    [
      'ExcelFile unknown path',
      'python',
      'import pandas as pd\nbook = pd.ExcelFile(other)\nx = book.parse("Sheet1")'
    ],
    [
      'Python unknown mapper',
      'python',
      'import fsspec\nmapper = fsspec.get_mapper("s3://bucket/data")'
    ],
    ['scanpy directory', 'python', 'import scanpy as sc\nx = sc.read_10x_mtx("inputs/matrix")'],
    ['xarray glob', 'python', 'import xarray as xr\nx = xr.open_mfdataset("inputs/*.nc")'],
    [
      'dynamic Path alias',
      'python',
      'from pathlib import Path as P\nimport pandas as pd\nP = custom_path\nx = pd.read_csv(P("inputs/a.csv"))'
    ],
    [
      'changed dict',
      'python',
      'import pandas as pd\nfiles = {"data":"inputs/a.csv"}\nfiles["data"] = unknown\nx = pd.read_csv(files["data"])'
    ],
    ['R missing path', 'r', 'x <- Biostrings::readDNAStringSet(format="fasta")'],
    ['R unknown collection member', 'r', 'x <- readr::read_csv(c("inputs/a.csv", unknown))'],
    ['R dynamic connection', 'r', 'x <- readLines(gzcon(other))']
  ] as const)('does not silently certify %s', async (_name, language, source) => {
    await expect(analyzeNotebookSourceFileAccess(language, source)).resolves.toMatchObject({
      readState: 'partial'
    })
  })
})

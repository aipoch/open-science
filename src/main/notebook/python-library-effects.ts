import type { NotebookFileCallEffect } from './notebook-call-effects'

export type PythonArgumentShape = 'none' | 'list' | 'scalar' | 'unknown'

export type PythonLibraryMethodEffect = {
  effect: 'read' | 'mutate' | 'unknown'
  // A library call's namespace effect and file arguments are independent facts.
  // Keep them together when known so variable and file analysis cannot diverge.
  file?: NotebookFileCallEffect
  unknownScope?: 'receiver' | 'namespace'
  unsafeNamespace?: boolean
  scopedOpaque?: boolean
  externalState?: boolean
  plottingState?: 'read' | 'write' | 'style'
  globalRandomState?: true
  returnType?: string
  scalarInputReturnType?: string
  preservesPandasType?: true
  // Allocates its result unless an explicit output argument is supplied.
  returnsFreshValue?: boolean
  returnTypeByArgumentShape?: {
    keyword: string
    position: number
    types: Partial<Record<PythonArgumentShape, string>>
  }
  destructuredReturnTypes?: string[]
  mutatesReceiverUnlessKeywordFalse?: string
  mutatesKeyword?: string
  mutatesPositionalArgument?: number
  callbackKeywords?: string[]
  callbackPositionalKeywords?: Record<number, string>
  callbackContainerKeywords?: string[]
  callbackStringValues?: Record<string, readonly string[]>
  callbackAllKeywords?: boolean
  possiblyMutatesFirstArgument?: boolean
  possiblyMutatesPositionalArgument?: number
  possiblyMutatesKeyword?: string
  returnsPossibleAliasOf?: 'receiver' | 'firstArgument'
  returnsAliasOfReceiver?: boolean
  returnsAliasOfKeyword?: string
  preservesIterationTypesFrom?: 'receiver' | 'firstArgument'
  returnTypeWhenKeywordNotTrue?: {
    keyword: string
    returnType: string
  }
  receiverTypeWhenKeywordNotTrue?: {
    keyword: string
    typeName: string
  }
  formulaArgument?: {
    positionalArgument: number
    keyword: string
  }
  firstArgumentKeyword?: string
  secondArgumentKeyword?: string
  returnsPossibleAliasWhenKeywordFalse?: {
    keyword: string
    positionalArgument?: number
    sources: Array<'receiver' | 'firstArgument' | 'secondArgument' | 'arguments'>
  }
}

type PythonLibraryObjectSummary = {
  kind: 'module' | 'type'
  methods: Record<string, PythonLibraryMethodEffect>
  iterationTypes?: string[]
  typeWhenMembersWritten?: Record<string, string>
  // Resource handles may inspect or mutate external state through unmodeled methods.
  unknownMethodsHaveExternalState?: boolean
}

type PythonLibraryEffects = Record<string, PythonLibraryObjectSummary>

const annDataFileReaders: Record<string, PythonLibraryMethodEffect> = Object.fromEntries(
  ['read_csv', 'read_h5ad', 'read_loom', 'read_mtx', 'read_text'].map((name) => [
    name,
    {
      effect: 'read',
      returnType: 'anndata.AnnData',
      file: { kind: 'read', position: 0, keywords: ['filename'] }
    }
  ])
)

const medicalSingleFileSuffixes = [
  '.nii',
  '.nii.gz',
  '.dcm',
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.tif',
  '.tiff'
]

// Static effects are deliberately limited to stable, documented behavior used by ordinary
// scientific Notebook code. Unknown methods continue through the conservative receiver-call path.
const containerMethods: Record<string, PythonLibraryMethodEffect> = {
  union: { effect: 'read', returnType: 'python.container' },
  intersection: { effect: 'read', returnType: 'python.container' },
  difference: { effect: 'read', returnType: 'python.container' },
  symmetric_difference: { effect: 'read', returnType: 'python.container' },
  sort: { effect: 'mutate', callbackKeywords: ['key'] }
}

// Both Excel entry points share sheet selection and converter callback semantics.
const excelReadResult = (sheetPosition: number): Partial<PythonLibraryMethodEffect> => ({
  returnType: 'pandas.DataFrame',
  callbackContainerKeywords: ['converters'],
  returnTypeByArgumentShape: {
    keyword: 'sheet_name',
    position: sheetPosition,
    types: {
      none: 'pandas.ExcelSheets',
      list: 'pandas.ExcelSheets',
      scalar: 'pandas.DataFrame'
    }
  }
})

const PYTHON_LIBRARY_EFFECTS: PythonLibraryEffects = {
  'pycirclize.Circos': {
    kind: 'module',
    methods: Object.fromEntries(
      ['chord_diagram', 'initialize_from_matrix'].map((name) => [
        name,
        {
          effect: 'read',
          returnType: 'pycirclize.circos.Circos',
          callbackKeywords: ['link_kws_handler'],
          plottingState: 'read',
          file: {
            kind: 'read',
            position: 0,
            keywords: ['matrix'],
            inMemoryTypes: ['pandas.DataFrame']
          }
        }
      ])
    )
  },
  'pycirclize.circos.Circos': {
    kind: 'type',
    unknownMethodsHaveExternalState: true,
    methods: {
      plotfig: {
        effect: 'mutate',
        returnType: 'matplotlib.figure.Figure',
        plottingState: 'read',
        possiblyMutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax'
      },
      savefig: {
        effect: 'mutate',
        plottingState: 'read',
        file: { kind: 'write', position: 0, keywords: ['savefile'] }
      }
    }
  },
  pathlib: {
    kind: 'module',
    methods: Object.fromEntries(
      ['Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'WindowsPath', 'PureWindowsPath'].map(
        (name) => [name, { effect: 'read', returnType: 'pathlib.PurePath' }]
      )
    )
  },
  'pathlib.PurePath': {
    kind: 'type',
    unknownMethodsHaveExternalState: true,
    // Constructing and transforming a path does not access the filesystem. Concrete
    // Path I/O (resolve, glob, open, unlink, etc.) must retain separate evidence.
    methods: {
      joinpath: { effect: 'read', returnType: 'pathlib.PurePath' },
      with_name: { effect: 'read', returnType: 'pathlib.PurePath' },
      with_suffix: { effect: 'read', returnType: 'pathlib.PurePath' },
      with_stem: { effect: 'read', returnType: 'pathlib.PurePath' },
      as_posix: { effect: 'read' },
      is_absolute: { effect: 'read' },
      is_relative_to: { effect: 'read' },
      relative_to: { effect: 'read', returnType: 'pathlib.PurePath' },
      // These do not mutate the path object. The file parser captures their receiver path.
      read_text: { effect: 'read' },
      read_bytes: { effect: 'read' },
      write_text: { effect: 'read' },
      write_bytes: { effect: 'read' }
    }
  },
  importlib: {
    kind: 'module',
    methods: {
      import_module: {
        effect: 'unknown',
        unknownScope: 'receiver',
        scopedOpaque: true,
        externalState: true
      }
    }
  },
  pickle: {
    kind: 'module',
    methods: {
      dump: { effect: 'read' },
      load: { effect: 'read', unsafeNamespace: true },
      loads: { effect: 'read', unsafeNamespace: true }
    }
  },
  cloudpickle: {
    kind: 'module',
    methods: {
      load: { effect: 'read', unsafeNamespace: true },
      loads: { effect: 'read', unsafeNamespace: true }
    }
  },
  dill: {
    kind: 'module',
    methods: {
      load: { effect: 'read', unsafeNamespace: true },
      loads: { effect: 'read', unsafeNamespace: true }
    }
  },
  joblib: {
    kind: 'module',
    methods: {
      dump: { effect: 'read' },
      load: { effect: 'read', unsafeNamespace: true }
    }
  },
  torch: {
    kind: 'module',
    methods: {
      load: { effect: 'read', unsafeNamespace: true },
      save: { effect: 'read', file: { kind: 'write', position: 1, keywords: ['f'] } }
    }
  },
  h5py: {
    kind: 'module',
    methods: {
      File: {
        effect: 'read',
        returnType: 'h5py.File',
        file: { kind: 'read', position: 0, keywords: ['name'] }
      }
    }
  },
  'dask.dataframe': {
    kind: 'module',
    methods: {
      read_csv: {
        effect: 'read',
        returnType: 'dask.DataFrame',
        file: { kind: 'read', position: 0, keywords: ['urlpath'] }
      },
      read_parquet: {
        effect: 'read',
        returnType: 'dask.DataFrame',
        file: { kind: 'read', position: 0, keywords: ['path'] }
      }
    }
  },
  muon: {
    kind: 'module',
    methods: {
      read_10x_h5: {
        effect: 'read',
        returnType: 'muon.MuData',
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      },
      read_h5mu: {
        effect: 'read',
        returnType: 'muon.MuData',
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      },
      read_10x_mtx: {
        effect: 'read',
        returnType: 'muon.MuData',
        file: { kind: 'read', position: 0, keywords: ['path'] }
      }
    }
  },
  mudata: {
    kind: 'module',
    methods: {
      MuData: { effect: 'read', returnType: 'mudata.MuData' }
    }
  },
  'mudata.MuData': {
    kind: 'type',
    methods: {
      write: { effect: 'read', file: { kind: 'write', position: 0, keywords: ['filename'] } },
      write_h5mu: { effect: 'read', file: { kind: 'write', position: 0, keywords: ['filename'] } }
    }
  },
  'muon.MuData': {
    kind: 'type',
    methods: {
      write: { effect: 'read', file: { kind: 'write', position: 0, keywords: ['filename'] } },
      write_h5mu: { effect: 'read', file: { kind: 'write', position: 0, keywords: ['filename'] } }
    }
  },
  wfdb: {
    kind: 'module',
    methods: {
      rdrecord: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['record_name'] }
      },
      rdann: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['record_name'] }
      },
      wrsamp: {
        effect: 'read',
        externalState: true,
        file: { kind: 'write', position: 0, keywords: ['record_name'] }
      }
    }
  },
  'dask.DataFrame': {
    kind: 'type',
    methods: {
      to_parquet: { effect: 'read', file: { kind: 'write', position: 0, keywords: ['path'] } }
    }
  },
  collections: {
    kind: 'module',
    methods: {
      Counter: { effect: 'read', returnType: 'collections.Counter' }
    }
  },
  'collections.Counter': {
    kind: 'type',
    methods: {
      elements: { effect: 'read' },
      items: { effect: 'read' },
      keys: { effect: 'read' },
      most_common: { effect: 'read' },
      subtract: { effect: 'mutate' },
      total: { effect: 'read' },
      update: { effect: 'mutate' },
      values: { effect: 'read' }
    }
  },
  csv: {
    kind: 'module',
    methods: {
      DictReader: {
        effect: 'read',
        returnType: 'csv.DictReader',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'f'
      },
      reader: {
        effect: 'read',
        returnType: 'csv.reader',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'csvfile'
      }
    }
  },
  'csv.DictReader': { kind: 'type', methods: {} },
  'csv.reader': { kind: 'type', methods: {} },
  io: {
    kind: 'module',
    methods: {
      BytesIO: { effect: 'read', returnType: 'io.BytesIO' },
      StringIO: { effect: 'read', returnType: 'io.StringIO' }
    }
  },
  'io.BytesIO': {
    kind: 'type',
    methods: {
      getvalue: { effect: 'read' },
      read: { effect: 'mutate' },
      seek: { effect: 'mutate' },
      tell: { effect: 'read' },
      truncate: { effect: 'mutate' },
      write: { effect: 'mutate' }
    }
  },
  'io.StringIO': {
    kind: 'type',
    methods: {
      getvalue: { effect: 'read' },
      read: { effect: 'mutate' },
      seek: { effect: 'mutate' },
      tell: { effect: 'read' },
      truncate: { effect: 'mutate' },
      write: { effect: 'mutate' }
    }
  },
  random: {
    kind: 'module',
    methods: {
      ...Object.fromEntries(
        [
          'random',
          'uniform',
          'triangular',
          'randint',
          'randrange',
          'getrandbits',
          'gauss',
          'normalvariate',
          'lognormvariate',
          'expovariate',
          'vonmisesvariate',
          'gammavariate',
          'betavariate',
          'paretovariate',
          'weibullvariate'
        ].map((name) => [
          name,
          { effect: 'read' as const, globalRandomState: true as const, returnType: 'python.scalar' }
        ])
      ),
      seed: { effect: 'read', globalRandomState: true },
      shuffle: {
        effect: 'read',
        globalRandomState: true,
        mutatesPositionalArgument: 0,
        mutatesKeyword: 'x'
      },
      sample: {
        effect: 'read',
        globalRandomState: true,
        returnType: 'python.container',
        returnsPossibleAliasOf: 'firstArgument'
      },
      choices: {
        effect: 'read',
        globalRandomState: true,
        returnType: 'python.container',
        returnsPossibleAliasOf: 'firstArgument'
      },
      choice: { effect: 'read', globalRandomState: true, returnsPossibleAliasOf: 'firstArgument' }
    }
  },
  'numpy.random': {
    kind: 'module',
    methods: {
      ...Object.fromEntries(
        [
          'random',
          'random_sample',
          'sample',
          'ranf',
          'rand',
          'randn',
          'randint',
          'normal',
          'standard_normal',
          'uniform',
          'poisson',
          'binomial',
          'multinomial',
          'multivariate_normal',
          'beta',
          'gamma',
          'exponential',
          'lognormal',
          'chisquare',
          'standard_t',
          'dirichlet',
          'permutation',
          'choice'
        ].map((name) => [
          name,
          {
            effect: 'read' as const,
            globalRandomState: true as const,
            returnType: 'numpy.ndarray',
            returnsFreshValue: true
          }
        ])
      ),
      seed: { effect: 'read', globalRandomState: true },
      shuffle: {
        effect: 'read',
        globalRandomState: true,
        mutatesPositionalArgument: 0,
        mutatesKeyword: 'x'
      }
    }
  },
  numpy: {
    kind: 'module',
    methods: {
      save: { effect: 'read' },
      load: { effect: 'read', unsafeNamespace: true },
      '@random': { effect: 'read', returnType: 'numpy.random' },
      '@pi': { effect: 'read', returnType: 'python.scalar' },
      ...Object.fromEntries(
        [
          'floor',
          'ceil',
          'log10',
          'degrees',
          'radians',
          'rad2deg',
          'deg2rad',
          'sin',
          'cos',
          'tan',
          'sqrt',
          'exp',
          'expm1',
          'log',
          'log1p',
          'log2',
          'abs',
          'absolute',
          'fabs'
        ].map((name) => [
          name,
          {
            effect: 'read',
            returnType: 'numpy.ndarray',
            scalarInputReturnType: 'python.scalar',
            preservesPandasType: true,
            returnsFreshValue: true,
            mutatesKeyword: 'out',
            mutatesPositionalArgument: 1
          }
        ])
      ),
      cumsum: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 3
      },
      arange: { effect: 'read', returnType: 'numpy.ndarray' },
      atleast_1d: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        preservesIterationTypesFrom: 'firstArgument',
        returnsPossibleAliasOf: 'firstArgument'
      },
      absolute: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      array: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        firstArgumentKeyword: 'object',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'copy',
          sources: ['firstArgument']
        }
      },
      asarray: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        firstArgumentKeyword: 'a',
        preservesIterationTypesFrom: 'firstArgument',
        returnsPossibleAliasOf: 'firstArgument'
      },
      column_stack: { effect: 'read', returnType: 'numpy.ndarray' },
      concatenate: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 2
      },
      clip: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 3
      },
      diff: { effect: 'read', returnType: 'numpy.ndarray' },
      full: { effect: 'read', returnType: 'numpy.ndarray' },
      full_like: { effect: 'read', returnType: 'numpy.ndarray' },
      fromfile: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'file'
      },
      genfromtxt: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'fname'
      },
      hstack: { effect: 'read', returnType: 'numpy.ndarray' },
      linspace: { effect: 'read', returnType: 'numpy.ndarray' },
      loadtxt: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'fname'
      },
      isfinite: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      isnan: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      max: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 2 },
      mean: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 3 },
      min: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 2 },
      ones: { effect: 'read', returnType: 'numpy.ndarray' },
      percentile: {
        effect: 'read',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 3
      },
      ravel: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        firstArgumentKeyword: 'a',
        preservesIterationTypesFrom: 'firstArgument',
        returnsPossibleAliasOf: 'firstArgument'
      },
      savetxt: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'fname'
      },
      stack: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 2
      },
      std: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 3 },
      sum: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 3 },
      vstack: { effect: 'read', returnType: 'numpy.ndarray' },
      where: { effect: 'read' },
      zeros: { effect: 'read', returnType: 'numpy.ndarray' }
    }
  },
  'numpy.ndarray': {
    kind: 'type',
    iterationTypes: ['numpy.ndarray'],
    methods: {
      astype: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'copy',
          positionalArgument: 4,
          sources: ['receiver']
        }
      },
      copy: { effect: 'read', returnType: 'numpy.ndarray' },
      fill: { effect: 'mutate' },
      flatten: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        preservesIterationTypesFrom: 'receiver'
      },
      max: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 1 },
      mean: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 2 },
      min: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 1 },
      ravel: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        preservesIterationTypesFrom: 'receiver',
        returnsPossibleAliasOf: 'receiver'
      },
      reshape: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        preservesIterationTypesFrom: 'receiver',
        returnsPossibleAliasOf: 'receiver'
      },
      resize: { effect: 'mutate' },
      sort: { effect: 'mutate' },
      std: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 2 },
      sum: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 2 },
      tolist: { effect: 'read', returnType: 'python.container', returnsPossibleAliasOf: 'receiver' }
    }
  },
  pandas: {
    kind: 'module',
    methods: {
      concat: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        firstArgumentKeyword: 'objs',
        returnsPossibleAliasWhenKeywordFalse: { keyword: 'copy', sources: ['firstArgument'] }
      },
      crosstab: { effect: 'read', returnType: 'pandas.DataFrame' },
      DataFrame: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        firstArgumentKeyword: 'data',
        returnsPossibleAliasOf: 'firstArgument'
      },
      merge: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        firstArgumentKeyword: 'left',
        secondArgumentKeyword: 'right',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'copy',
          positionalArgument: 10,
          sources: ['firstArgument', 'secondArgument']
        }
      },
      read_csv: {
        effect: 'read',
        callbackContainerKeywords: ['converters'],
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filepath_or_buffer'
      },
      ExcelFile: {
        effect: 'read',
        returnType: 'pandas.ExcelFile',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path_or_buffer'
      },
      read_excel: {
        effect: 'read',
        ...excelReadResult(1),
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'io'
      },
      read_feather: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path'
      },
      read_fwf: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filepath_or_buffer'
      },
      read_iceberg: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path'
      },
      read_json: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path_or_buf'
      },
      read_orc: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path'
      },
      read_parquet: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path'
      },
      to_pickle: { effect: 'read' },
      read_pickle: { effect: 'read', unsafeNamespace: true },
      read_sas: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filepath_or_buffer'
      },
      read_spss: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path'
      },
      read_sql: {
        effect: 'read',
        externalState: true,
        returnType: 'pandas.DataFrame',
        possiblyMutatesPositionalArgument: 1,
        possiblyMutatesKeyword: 'con'
      },
      read_sql_query: {
        effect: 'read',
        externalState: true,
        returnType: 'pandas.DataFrame',
        possiblyMutatesPositionalArgument: 1,
        possiblyMutatesKeyword: 'con'
      },
      read_sql_table: {
        effect: 'read',
        externalState: true,
        returnType: 'pandas.DataFrame',
        possiblyMutatesPositionalArgument: 1,
        possiblyMutatesKeyword: 'con'
      },
      read_stata: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filepath_or_buffer'
      },
      read_table: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filepath_or_buffer'
      },
      read_xml: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'path_or_buffer'
      },
      Series: {
        effect: 'read',
        returnType: 'pandas.Series',
        firstArgumentKeyword: 'data',
        returnsPossibleAliasOf: 'firstArgument'
      }
    }
  },
  pyreadstat: {
    kind: 'module',
    methods: {
      // Readers return (data, metadata); output_format can change the data type.
      ...Object.fromEntries(
        ['read_dta', 'read_sas7bdat', 'read_sav', 'read_xport'].map((name) => [
          name,
          {
            effect: 'read' as const,
            file: { kind: 'read' as const, position: 0, keywords: ['filename_path'] }
          }
        ])
      ),
      write_sav: { effect: 'read', file: { kind: 'write', position: 1, keywords: ['dst_path'] } },
      write_dta: { effect: 'read', file: { kind: 'write', position: 1, keywords: ['dst_path'] } },
      write_xport: { effect: 'read', file: { kind: 'write', position: 1, keywords: ['dst_path'] } }
    }
  },
  'pyarrow.parquet': {
    kind: 'module',
    methods: {
      read_table: {
        effect: 'read',
        returnType: 'pyarrow.Table',
        file: { kind: 'read', position: 0, keywords: ['source'] }
      },
      write_table: {
        effect: 'read',
        file: { kind: 'write', position: 1, keywords: ['where'] }
      }
    }
  },
  pyfaidx: {
    kind: 'module',
    methods: {
      Fasta: {
        effect: 'read',
        returnType: 'pyfaidx.Fasta',
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      }
    }
  },
  pyranges: {
    kind: 'module',
    methods: {
      read_bed: { effect: 'read', file: { kind: 'read', position: 0, keywords: ['f'] } },
      read_gtf: { effect: 'read', file: { kind: 'read', position: 0, keywords: ['f'] } }
    }
  },
  'scipy.stats': {
    kind: 'module',
    methods: {
      chi2_contingency: { effect: 'read' },
      mannwhitneyu: { effect: 'read' },
      pearsonr: { effect: 'read' },
      spearmanr: { effect: 'read' },
      ttest_1samp: { effect: 'read' },
      ttest_ind: { effect: 'read' },
      ttest_rel: { effect: 'read' }
    }
  },
  'scipy.io.wavfile': {
    kind: 'module',
    methods: {
      read: {
        effect: 'read',
        destructuredReturnTypes: ['python.scalar', 'numpy.ndarray'],
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filename'
      }
    }
  },
  'python.numeric-tuple': { kind: 'type', methods: {}, iterationTypes: ['python.scalar'] },
  'python.numbers': { kind: 'type', methods: containerMethods, iterationTypes: ['python.scalar'] },
  colorsys: {
    kind: 'module',
    methods: Object.fromEntries(
      ['rgb_to_hls', 'hls_to_rgb', 'rgb_to_hsv', 'hsv_to_rgb', 'rgb_to_yiq', 'yiq_to_rgb'].map(
        (name) => [name, { effect: 'read', returnType: 'python.numeric-tuple' }]
      )
    )
  },
  'matplotlib.colors': {
    kind: 'module',
    methods: {
      '@LinearSegmentedColormap': {
        effect: 'read',
        returnType: 'matplotlib.colors.LinearSegmentedColormap'
      },
      to_rgba: { effect: 'read', returnType: 'python.numeric-tuple' },
      to_rgb: { effect: 'read', returnType: 'python.numeric-tuple' },
      to_hex: { effect: 'read', returnType: 'python.string' }
    }
  },
  // Static factory namespace; the resulting colormap is a separate value.
  'matplotlib.colors.LinearSegmentedColormap': {
    kind: 'module',
    methods: {
      from_list: { effect: 'read', returnType: 'matplotlib.colors.Colormap' }
    }
  },
  'matplotlib.colors.Colormap': {
    kind: 'type',
    methods: {
      reversed: { effect: 'read', returnType: 'matplotlib.colors.Colormap' },
      set_bad: { effect: 'mutate' },
      set_under: { effect: 'mutate' },
      set_over: { effect: 'mutate' }
    }
  },
  'python.scalar': {
    kind: 'type',
    methods: {
      is_integer: { effect: 'read', returnType: 'python.scalar' },
      startswith: { effect: 'read', returnType: 'python.scalar' },
      endswith: { effect: 'read', returnType: 'python.scalar' },
      replace: { effect: 'read', returnType: 'python.string' }
    }
  },
  'xml.etree.ElementTree': {
    kind: 'module',
    methods: {
      fromstring: {
        effect: 'read',
        returnType: 'xml.etree.ElementTree.Element',
        callbackKeywords: ['parser'],
        callbackPositionalKeywords: { 1: 'parser' }
      }
    }
  },
  'xml.etree.ElementTree.Element': {
    kind: 'type',
    unknownMethodsHaveExternalState: true,
    iterationTypes: ['xml.etree.ElementTree.Element'],
    methods: {
      find: {
        effect: 'read',
        returnType: 'xml.etree.ElementTree.Element',
        returnsPossibleAliasOf: 'receiver'
      },
      findall: {
        effect: 'read',
        returnType: 'python.xml-elements',
        returnsPossibleAliasOf: 'receiver'
      },
      iter: {
        effect: 'read',
        returnType: 'python.xml-elements',
        returnsPossibleAliasOf: 'receiver'
      },
      iterfind: {
        effect: 'read',
        returnType: 'python.xml-elements',
        returnsPossibleAliasOf: 'receiver'
      },
      get: { effect: 'read', returnType: 'python.string' },
      '@text': { effect: 'read', returnType: 'python.string' },
      '@tag': { effect: 'read', returnType: 'python.string' },
      '@tail': { effect: 'read', returnType: 'python.string' }
    }
  },
  'python.xml-elements': {
    kind: 'type',
    methods: {},
    iterationTypes: ['xml.etree.ElementTree.Element']
  },
  'python.string': {
    kind: 'type',
    methods: {
      startswith: { effect: 'read', returnType: 'python.scalar' },
      endswith: { effect: 'read', returnType: 'python.scalar' },
      ...Object.fromEntries(
        [
          'capitalize',
          'casefold',
          'lower',
          'upper',
          'title',
          'strip',
          'lstrip',
          'rstrip',
          'replace',
          'format'
        ].map((name) => [name, { effect: 'read', returnType: 'python.string' }])
      )
    }
  },
  'python.strings': { kind: 'type', methods: containerMethods, iterationTypes: ['python.string'] },
  'pandas.unique-values': {
    kind: 'type',
    iterationTypes: ['python.scalar'],
    methods: {
      tolist: { effect: 'read', returnType: 'python.container', returnsPossibleAliasOf: 'receiver' }
    }
  },
  'python.calculated-sequence': { kind: 'type', methods: {} },
  'python.container': {
    kind: 'type',
    methods: containerMethods,
    iterationTypes: ['python.object']
  },
  'pandas.ExcelFile': {
    kind: 'type',
    unknownMethodsHaveExternalState: true,
    methods: {
      '@sheet_names': { effect: 'read', returnType: 'python.strings' },
      parse: {
        effect: 'mutate',
        ...excelReadResult(0)
      },
      close: { effect: 'mutate' }
    }
  },
  'pandas.ExcelSheets': {
    kind: 'type',
    methods: {
      keys: { effect: 'read', returnType: 'python.container' },
      values: {
        effect: 'read',
        returnType: 'pandas.ExcelSheets.values',
        returnsPossibleAliasOf: 'receiver'
      },
      items: {
        effect: 'read',
        returnType: 'pandas.ExcelSheets.items',
        returnsPossibleAliasOf: 'receiver'
      }
    }
  },
  'pandas.ExcelSheets.values': { kind: 'type', iterationTypes: ['pandas.DataFrame'], methods: {} },
  'pandas.ExcelSheets.items': {
    kind: 'type',
    iterationTypes: ['python.scalar', 'pandas.DataFrame'],
    methods: {}
  },
  'pandas.Index': {
    kind: 'type',
    iterationTypes: ['python.scalar'],
    methods: {
      tolist: {
        effect: 'read',
        returnType: 'pandas.unique-values',
        returnsPossibleAliasOf: 'receiver'
      },
      to_list: {
        effect: 'read',
        returnType: 'pandas.unique-values',
        returnsPossibleAliasOf: 'receiver'
      }
    }
  },
  'pandas.DataFrame': {
    kind: 'type',
    methods: {
      to_numpy: { effect: 'read', returnType: 'numpy.ndarray', returnsPossibleAliasOf: 'receiver' },
      ...Object.fromEntries(
        ['div', 'divide', 'truediv', 'sub', 'subtract'].map((name) => [
          name,
          { effect: 'read', returnType: 'pandas.DataFrame', returnsFreshValue: true }
        ])
      ),
      '@column': {
        effect: 'read',
        returnType: 'pandas.Series',
        returnsPossibleAliasOf: 'receiver'
      },
      '@columns': {
        effect: 'read',
        returnType: 'pandas.Index',
        returnsPossibleAliasOf: 'receiver'
      },
      '@index': { effect: 'read', returnType: 'pandas.Index', returnsPossibleAliasOf: 'receiver' },
      describe: { effect: 'read', returnType: 'pandas.DataFrame' },
      '@values': {
        effect: 'read',
        returnType: 'numpy.ndarray',
        returnsPossibleAliasOf: 'receiver'
      },
      assign: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackAllKeywords: true
      },
      astype: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'copy',
          positionalArgument: 1,
          sources: ['receiver']
        }
      },
      copy: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'deep',
          positionalArgument: 0,
          sources: ['receiver']
        }
      },
      drop: { effect: 'read', returnType: 'pandas.DataFrame' },
      drop_duplicates: { effect: 'read', returnType: 'pandas.DataFrame' },
      dropna: { effect: 'read', returnType: 'pandas.DataFrame' },
      fillna: { effect: 'read', returnType: 'pandas.DataFrame' },
      // In-place and unknown in-place flags use the shared pandas mutation path.
      ffill: { effect: 'read', returnType: 'pandas.DataFrame' },
      bfill: { effect: 'read', returnType: 'pandas.DataFrame' },
      groupby: { effect: 'read', returnType: 'pandas.core.groupby.DataFrameGroupBy' },
      reindex: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        returnsPossibleAliasWhenKeywordFalse: { keyword: 'copy', sources: ['receiver'] }
      },
      to_dict: {
        effect: 'read',
        callbackKeywords: ['into'],
        callbackPositionalKeywords: { 1: 'into' }
      },
      head: { effect: 'read', returnType: 'pandas.DataFrame' },
      iterrows: { effect: 'read', returnType: 'pandas.DataFrame.iterrows' },
      to_string: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'buf',
        callbackKeywords: ['float_format'],
        callbackContainerKeywords: ['formatters'],
        file: { kind: 'write', position: 0, keywords: ['buf'], pathOptional: true }
      },
      join: { effect: 'read', returnType: 'pandas.DataFrame' },
      max: { effect: 'read', returnType: 'pandas.Series' },
      mean: { effect: 'read', returnType: 'pandas.Series' },
      min: { effect: 'read', returnType: 'pandas.Series' },
      notna: { effect: 'read', returnType: 'pandas.DataFrame' },
      isna: { effect: 'read', returnType: 'pandas.DataFrame' },
      melt: { effect: 'read', returnType: 'pandas.DataFrame' },
      merge: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        firstArgumentKeyword: 'right',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'copy',
          positionalArgument: 9,
          sources: ['receiver', 'firstArgument']
        }
      },
      pivot: { effect: 'read', returnType: 'pandas.DataFrame' },
      pivot_table: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackKeywords: ['aggfunc'],
        callbackContainerKeywords: ['aggfunc'],
        callbackStringValues: {
          aggfunc: [
            'sum',
            'mean',
            'min',
            'max',
            'count',
            'size',
            'std',
            'var',
            'median',
            'first',
            'last',
            'prod',
            'nunique',
            'any',
            'all'
          ]
        }
      },
      rename: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackKeywords: ['mapper', 'index', 'columns']
      },
      reset_index: { effect: 'read', returnType: 'pandas.DataFrame' },
      round: { effect: 'read', returnType: 'pandas.DataFrame' },
      set_index: { effect: 'read', returnType: 'pandas.DataFrame' },
      sort_index: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackKeywords: ['key']
      },
      sort_values: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackKeywords: ['key']
      },
      sum: { effect: 'read', returnType: 'pandas.Series' },
      to_csv: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'path_or_buf'
      },
      to_excel: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'excel_writer'
      },
      to_feather: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'path'
      },
      to_json: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'path_or_buf'
      },
      to_html: { effect: 'read' },
      to_latex: { effect: 'read' },
      to_markdown: { effect: 'read' },
      to_parquet: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'path'
      },
      value_counts: { effect: 'read', returnType: 'pandas.Series' }
    }
  },
  'pandas.StringMethods': {
    kind: 'type',
    methods: Object.fromEntries(
      ['strip', 'lstrip', 'rstrip', 'lower', 'upper', 'capitalize', 'title', 'casefold'].map(
        (name) => [name, { effect: 'read', returnType: 'pandas.Series' }]
      )
    )
  },
  'pandas.DataFrame.iterrows': {
    kind: 'type',
    iterationTypes: ['python.scalar', 'pandas.Series'],
    methods: {}
  },
  'pandas.core.groupby.DataFrameGroupBy': {
    kind: 'type',
    iterationTypes: ['python.scalar', 'pandas.DataFrame'],
    methods: {
      agg: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackKeywords: ['func'],
        callbackContainerKeywords: ['func'],
        callbackPositionalKeywords: { 0: 'func' }
      },
      aggregate: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        callbackKeywords: ['func'],
        callbackContainerKeywords: ['func'],
        callbackPositionalKeywords: { 0: 'func' }
      },
      mean: { effect: 'read', returnType: 'pandas.DataFrame' },
      sum: { effect: 'read', returnType: 'pandas.DataFrame' }
    }
  },
  'pandas.Series': {
    kind: 'type',
    methods: {
      to_numpy: { effect: 'read', returnType: 'numpy.ndarray', returnsPossibleAliasOf: 'receiver' },
      ...Object.fromEntries(
        ['div', 'divide', 'truediv', 'sub', 'subtract'].map((name) => [
          name,
          { effect: 'read', returnType: 'pandas.Series', returnsFreshValue: true }
        ])
      ),
      '@str': {
        effect: 'read',
        returnType: 'pandas.StringMethods',
        returnsPossibleAliasOf: 'receiver'
      },
      describe: { effect: 'read', returnType: 'pandas.Series' },
      tolist: {
        effect: 'read',
        returnType: 'python.container',
        returnsPossibleAliasOf: 'receiver'
      },
      to_list: {
        effect: 'read',
        returnType: 'python.container',
        returnsPossibleAliasOf: 'receiver'
      },
      '@values': {
        effect: 'read',
        returnType: 'numpy.ndarray',
        returnsPossibleAliasOf: 'receiver'
      },
      astype: {
        effect: 'read',
        returnType: 'pandas.Series',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'copy',
          positionalArgument: 1,
          sources: ['receiver']
        }
      },
      copy: {
        effect: 'read',
        returnType: 'pandas.Series',
        returnsPossibleAliasWhenKeywordFalse: {
          keyword: 'deep',
          positionalArgument: 0,
          sources: ['receiver']
        }
      },
      dropna: { effect: 'read', returnType: 'pandas.Series' },
      drop_duplicates: { effect: 'read', returnType: 'pandas.Series' },
      fillna: { effect: 'read', returnType: 'pandas.Series' },
      ffill: { effect: 'read', returnType: 'pandas.Series' },
      bfill: { effect: 'read', returnType: 'pandas.Series' },
      head: { effect: 'read', returnType: 'pandas.Series' },
      reindex: {
        effect: 'read',
        returnType: 'pandas.Series',
        returnsPossibleAliasWhenKeywordFalse: { keyword: 'copy', sources: ['receiver'] }
      },
      unique: {
        effect: 'read',
        returnType: 'pandas.unique-values',
        returnsPossibleAliasOf: 'receiver'
      },
      max: { effect: 'read' },
      mean: { effect: 'read' },
      min: { effect: 'read' },
      rename: {
        effect: 'read',
        returnType: 'pandas.Series',
        callbackKeywords: ['index']
      },
      reset_index: { effect: 'read', returnType: 'pandas.DataFrame' },
      round: { effect: 'read', returnType: 'pandas.Series' },
      notna: { effect: 'read', returnType: 'pandas.Series' },
      isna: { effect: 'read', returnType: 'pandas.Series' },
      sort_index: {
        effect: 'read',
        returnType: 'pandas.Series',
        callbackKeywords: ['key']
      },
      sort_values: {
        effect: 'read',
        returnType: 'pandas.Series',
        callbackKeywords: ['key']
      },
      sum: { effect: 'read' },
      to_csv: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        possiblyMutatesKeyword: 'path_or_buf'
      },
      to_dict: {
        effect: 'read',
        callbackKeywords: ['into'],
        callbackPositionalKeywords: { 0: 'into' }
      },
      to_frame: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        returnsPossibleAliasOf: 'receiver'
      },
      value_counts: { effect: 'read', returnType: 'pandas.Series' }
    }
  },
  matplotlib: {
    kind: 'module',
    methods: {
      // @ entries describe property access in a receiver chain, not method invocation.
      '@colors': { effect: 'read', returnType: 'matplotlib.colors' },
      '@rcParams': { effect: 'read', returnType: 'matplotlib.RcParams' },
      '@style': { effect: 'read', returnType: 'matplotlib.style' },
      rc: { effect: 'read', plottingState: 'write' },
      rcdefaults: { effect: 'read', plottingState: 'write' },
      use: { effect: 'read', plottingState: 'write' }
    }
  },
  'matplotlib.RcParams': {
    kind: 'type',
    methods: {
      update: { effect: 'read', plottingState: 'write' },
      get: { effect: 'read', plottingState: 'read' },
      copy: { effect: 'read', returnType: 'python.container', plottingState: 'read' }
    }
  },
  'matplotlib.style': {
    kind: 'module',
    methods: { use: { effect: 'read', plottingState: 'style' } }
  },
  'matplotlib.image': {
    kind: 'module',
    methods: {
      imread: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'fname'
      }
    }
  },
  'imageio.v3': {
    kind: 'module',
    methods: {
      imread: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'uri'
      }
    }
  },
  'skimage.io': {
    kind: 'module',
    methods: {
      imread: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'fname'
      }
    }
  },
  cv2: {
    kind: 'module',
    methods: {
      imread: { effect: 'read', returnType: 'numpy.ndarray' }
    }
  },
  'PIL.Image': {
    kind: 'module',
    methods: {
      open: {
        effect: 'read',
        returnType: 'PIL.Image.Image',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'fp'
      }
    }
  },
  'PIL.Image.Image': {
    kind: 'type',
    methods: {
      close: { effect: 'mutate' },
      convert: { effect: 'read', returnType: 'PIL.Image.Image' },
      copy: { effect: 'read', returnType: 'PIL.Image.Image' },
      crop: { effect: 'read', returnType: 'PIL.Image.Image' },
      getbbox: { effect: 'read' },
      paste: { effect: 'mutate' },
      resize: { effect: 'read', returnType: 'PIL.Image.Image' },
      rotate: { effect: 'read', returnType: 'PIL.Image.Image' },
      save: { effect: 'read' }
    }
  },
  anndata: {
    kind: 'module',
    methods: annDataFileReaders
  },
  'anndata.io': {
    kind: 'module',
    methods: annDataFileReaders
  },
  scanpy: {
    kind: 'module',
    methods: {
      ...annDataFileReaders,
      read_10x_h5: { effect: 'read', returnType: 'anndata.AnnData' },
      read_10x_mtx: { effect: 'read', returnType: 'anndata.AnnData' }
    }
  },
  'anndata.AnnData': {
    kind: 'type',
    methods: {
      copy: { effect: 'read', returnType: 'anndata.AnnData' },
      obs_names_make_unique: { effect: 'mutate' },
      var_names_make_unique: { effect: 'mutate' },
      write: {
        effect: 'read',
        mutatesReceiverUnlessKeywordFalse: 'convert_strings_to_categoricals'
      },
      write_csvs: { effect: 'read' },
      write_h5ad: {
        effect: 'read',
        mutatesReceiverUnlessKeywordFalse: 'convert_strings_to_categoricals'
      },
      write_loom: { effect: 'read' },
      write_zarr: { effect: 'read' }
    }
  },
  openslide: {
    kind: 'module',
    methods: {
      OpenSlide: {
        effect: 'read',
        returnType: 'openslide.OpenSlide',
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      },
      open_slide: {
        effect: 'read',
        returnType: 'openslide.OpenSlide',
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      }
    }
  },
  cyvcf2: {
    kind: 'module',
    methods: {
      // HTS modes and non-file streams are checked by file analysis. Readers
      // retain cursor/index state; naming their VCF is not complete evidence.
      VCF: { effect: 'read', returnType: 'cyvcf2.VCF', externalState: true },
      Writer: {
        effect: 'read',
        returnType: 'cyvcf2.Writer',
        possiblyMutatesPositionalArgument: 1,
        possiblyMutatesKeyword: 'tmpl'
      }
    }
  },
  'cyvcf2.VCF': {
    kind: 'type',
    methods: {
      set_index: {
        effect: 'mutate',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['index_path'] }
      },
      __call__: { effect: 'mutate', externalState: true },
      close: { effect: 'mutate' },
      set_samples: { effect: 'mutate' },
      add_info_to_header: { effect: 'mutate' },
      add_format_to_header: { effect: 'mutate' },
      add_filter_to_header: { effect: 'mutate' },
      add_to_header: { effect: 'mutate' }
    }
  },
  'cyvcf2.Writer': {
    kind: 'type',
    methods: {
      from_string: {
        effect: 'read',
        returnType: 'cyvcf2.Writer',
        file: { kind: 'write', position: 0, keywords: ['fname'] }
      },
      write_record: { effect: 'mutate' },
      write_header: { effect: 'mutate' },
      close: { effect: 'mutate' }
    }
  },
  pysam: {
    kind: 'module',
    methods: {
      // File mode and explicit index/reference paths are handled together by
      // file analysis. Implicit HTS indexes, reference caches and options remain external.
      AlignmentFile: { effect: 'read', externalState: true },
      VariantFile: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      },
      TabixFile: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['filename'] }
      }
    }
  },
  'pyteomics.mgf': {
    kind: 'module',
    methods: {
      MGF: {
        effect: 'read',
        file: { kind: 'read', position: 0, keywords: ['source'] }
      },
      IndexedMGF: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['source'] }
      },
      read: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['source'] }
      },
      write: {
        effect: 'read',
        possiblyMutatesFirstArgument: true,
        callbackContainerKeywords: ['param_formatters'],
        file: { kind: 'write', position: 1, keywords: ['output'] }
      }
    }
  },
  'pyteomics.mzml': {
    kind: 'module',
    methods: {
      MzML: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['source'] }
      },
      read: {
        effect: 'read',
        externalState: true,
        file: { kind: 'read', position: 0, keywords: ['source'] }
      }
    }
  },
  ...Object.fromEntries(
    ['pyteomics.mgf.IndexedMGF', 'pyteomics.mzml.MzML'].map((name) => [
      name,
      {
        kind: 'type' as const,
        methods: {
          prebuild_byte_offset_file: { effect: 'read' as const, externalState: true }
        }
      }
    ])
  ),
  'openslide.OpenSlide': {
    kind: 'type',
    methods: {
      read_region: { effect: 'read', returnType: 'PIL.Image.Image' },
      get_thumbnail: { effect: 'read', returnType: 'PIL.Image.Image' },
      close: { effect: 'mutate' }
    }
  },
  'radiomics.featureextractor': {
    kind: 'module',
    methods: {
      RadiomicsFeatureExtractor: {
        effect: 'read',
        returnType: 'radiomics.featureextractor.RadiomicsFeatureExtractor',
        file: { kind: 'read', position: 0, keywords: [], pathOptional: true }
      }
    }
  },
  'radiomics.featureextractor.RadiomicsFeatureExtractor': {
    kind: 'type',
    methods: {
      execute: {
        effect: 'mutate',
        file: {
          kind: 'read',
          position: 0,
          keywords: ['imageFilepath'],
          additionalPaths: [{ position: 1, keywords: ['maskFilepath'] }]
        }
      },
      loadParams: {
        effect: 'mutate',
        file: { kind: 'read', position: 0, keywords: ['paramsFile'] }
      }
    }
  },
  SimpleITK: {
    kind: 'module',
    methods: {
      ReadImage: {
        effect: 'read',
        returnType: 'SimpleITK.Image',
        file: {
          kind: 'read',
          position: 0,
          keywords: ['fileName'],
          inputForm: 'paths',
          singleFileSuffixes: medicalSingleFileSuffixes
        }
      },
      WriteTransform: {
        effect: 'read',
        file: { kind: 'write', position: 1, keywords: ['transformFileName'] }
      },
      WriteImage: {
        effect: 'read',
        file: {
          kind: 'write',
          position: 1,
          keywords: ['fileName'],
          inputForm: 'paths',
          singleFileSuffixes: medicalSingleFileSuffixes
        }
      },
      GetArrayFromImage: { effect: 'read', returnType: 'numpy.ndarray' },
      GetArrayViewFromImage: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        returnsPossibleAliasOf: 'firstArgument'
      },
      GetImageFromArray: { effect: 'read', returnType: 'SimpleITK.Image' }
    }
  },
  'SimpleITK.Image': {
    kind: 'type',
    methods: {
      GetSize: { effect: 'read' },
      GetSpacing: { effect: 'read' },
      GetOrigin: { effect: 'read' },
      GetDirection: { effect: 'read' },
      GetDimension: { effect: 'read' },
      GetNumberOfComponentsPerPixel: { effect: 'read' },
      GetPixelID: { effect: 'read' },
      SetSpacing: { effect: 'mutate' },
      SetOrigin: { effect: 'mutate' },
      SetDirection: { effect: 'mutate' },
      SetPixel: { effect: 'mutate' },
      SetMetaData: { effect: 'mutate' },
      CopyInformation: { effect: 'mutate' }
    }
  },
  nibabel: {
    kind: 'module',
    methods: {
      load: { effect: 'read', returnType: 'nibabel.spatialimages.SpatialImage' },
      save: { effect: 'read' }
    }
  },
  'nibabel.spatialimages.SpatialImage': {
    kind: 'type',
    methods: {
      get_fdata: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        returnsPossibleAliasOf: 'receiver'
      },
      set_data_dtype: { effect: 'mutate' },
      to_filename: { effect: 'read' },
      update_header: { effect: 'mutate' }
    }
  },
  xarray: {
    kind: 'module',
    methods: {
      load_dataarray: {
        effect: 'read',
        returnType: 'xarray.DataArray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filename_or_obj'
      },
      load_dataset: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filename_or_obj'
      },
      open_dataarray: {
        effect: 'read',
        returnType: 'xarray.DataArray',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filename_or_obj'
      },
      open_dataset: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filename_or_obj'
      },
      open_mfdataset: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'paths'
      },
      open_zarr: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'store'
      }
    }
  },
  'xarray.Dataset': {
    kind: 'type',
    methods: {
      close: { effect: 'mutate' },
      compute: { effect: 'read', returnType: 'xarray.Dataset' },
      copy: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        returnsPossibleAliasOf: 'receiver'
      },
      isel: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        returnsPossibleAliasOf: 'receiver'
      },
      load: {
        effect: 'mutate',
        returnType: 'xarray.Dataset',
        returnsAliasOfReceiver: true
      },
      mean: { effect: 'read', returnType: 'xarray.Dataset' },
      sel: {
        effect: 'read',
        returnType: 'xarray.Dataset',
        returnsPossibleAliasOf: 'receiver'
      },
      to_netcdf: { effect: 'read' },
      to_zarr: { effect: 'read' }
    }
  },
  'xarray.DataArray': {
    kind: 'type',
    methods: {
      close: { effect: 'mutate' },
      compute: { effect: 'read', returnType: 'xarray.DataArray' },
      copy: {
        effect: 'read',
        returnType: 'xarray.DataArray',
        returnsPossibleAliasOf: 'receiver'
      },
      isel: {
        effect: 'read',
        returnType: 'xarray.DataArray',
        returnsPossibleAliasOf: 'receiver'
      },
      load: {
        effect: 'mutate',
        returnType: 'xarray.DataArray',
        returnsAliasOfReceiver: true
      },
      mean: { effect: 'read', returnType: 'xarray.DataArray' },
      sel: {
        effect: 'read',
        returnType: 'xarray.DataArray',
        returnsPossibleAliasOf: 'receiver'
      },
      to_netcdf: { effect: 'read' }
    }
  },
  'matplotlib.pyplot': {
    kind: 'module',
    methods: {
      close: { effect: 'read' },
      '@rcParams': { effect: 'read', returnType: 'matplotlib.RcParams' },
      '@style': { effect: 'read', returnType: 'matplotlib.style' },
      rc: { effect: 'read', plottingState: 'write' },
      rcdefaults: { effect: 'read', plottingState: 'write' },
      figure: { effect: 'read', returnType: 'matplotlib.figure.Figure' },
      pie: {
        effect: 'read',
        callbackKeywords: ['autopct'],
        destructuredReturnTypes: [
          'matplotlib.patches.Wedge',
          'matplotlib.text.Text',
          'matplotlib.text.Text'
        ]
      },
      savefig: { effect: 'read' },
      show: { effect: 'read' },
      subplots: {
        effect: 'read',
        destructuredReturnTypes: ['matplotlib.figure.Figure', 'matplotlib.axes.Axes']
      },
      tight_layout: { effect: 'read' },
      title: { effect: 'read' },
      use: { effect: 'read' }
    }
  },
  'matplotlib.figure.Figure': {
    kind: 'type',
    methods: {
      '@patch': {
        effect: 'read',
        returnType: 'matplotlib.patches.Patch',
        returnsAliasOfReceiver: true
      },
      set_facecolor: { effect: 'mutate' },
      add_gridspec: { effect: 'mutate', returnType: 'matplotlib.gridspec.GridSpec' },
      add_subplot: { effect: 'mutate', returnType: 'matplotlib.axes.Axes' },
      clear: { effect: 'mutate' },
      savefig: { effect: 'read' },
      suptitle: { effect: 'mutate', returnType: 'matplotlib.text.Text' },
      tight_layout: { effect: 'mutate' }
    }
  },
  'matplotlib.gridspec.GridSpec': {
    kind: 'type',
    methods: {}
  },
  'matplotlib.axes.Axes': {
    kind: 'type',
    iterationTypes: ['matplotlib.axes.Axes'],
    methods: {
      fill: { effect: 'mutate' },
      set_facecolor: { effect: 'mutate' },
      axis: { effect: 'mutate' },
      add_patch: { effect: 'mutate', possiblyMutatesFirstArgument: true },
      fill_between: { effect: 'mutate' },
      set_axis_off: { effect: 'mutate' },
      set_theta_zero_location: { effect: 'mutate' },
      set_theta_direction: { effect: 'mutate' },
      axhline: { effect: 'mutate' },
      axvline: { effect: 'mutate' },
      bar: { effect: 'mutate', returnType: 'matplotlib.container.BarContainer' },
      barh: { effect: 'mutate', returnType: 'matplotlib.container.BarContainer' },
      bar_label: {
        effect: 'mutate',
        returnType: 'matplotlib.text.Text',
        callbackKeywords: ['fmt']
      },
      flatten: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        preservesIterationTypesFrom: 'receiver'
      },
      grid: { effect: 'mutate' },
      hlines: { effect: 'mutate' },
      hist: { effect: 'mutate' },
      legend: { effect: 'mutate' },
      pie: {
        effect: 'mutate',
        callbackKeywords: ['autopct'],
        destructuredReturnTypes: [
          'matplotlib.patches.Wedge',
          'matplotlib.text.Text',
          'matplotlib.text.Text'
        ]
      },
      plot: { effect: 'mutate', returnType: 'matplotlib.lines.Line2DList' },
      ravel: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        preservesIterationTypesFrom: 'receiver'
      },
      reshape: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        preservesIterationTypesFrom: 'receiver'
      },
      scatter: { effect: 'mutate' },
      set_aspect: { effect: 'mutate' },
      set_axisbelow: { effect: 'mutate' },
      set_title: { effect: 'mutate' },
      set_xlabel: { effect: 'mutate' },
      set_xlim: { effect: 'mutate' },
      set_xticklabels: { effect: 'mutate' },
      set_xticks: { effect: 'mutate' },
      set_ylabel: { effect: 'mutate' },
      set_ylim: { effect: 'mutate' },
      set_yticks: { effect: 'mutate' },
      set_yticklabels: { effect: 'mutate' },
      tick_params: { effect: 'mutate' },
      text: { effect: 'mutate', returnType: 'matplotlib.text.Text' }
    }
  },
  'matplotlib.container.BarContainer': {
    kind: 'type',
    iterationTypes: ['matplotlib.patches.Rectangle'],
    methods: {}
  },
  'matplotlib.path': {
    kind: 'module',
    methods: { Path: { effect: 'read', returnType: 'matplotlib.path.Path' } }
  },
  'matplotlib.path.Path': { kind: 'type', methods: {} },
  'matplotlib.patches': {
    kind: 'module',
    methods: {
      Patch: { effect: 'read', returnType: 'matplotlib.patches.Patch' },
      PathPatch: { effect: 'read', returnType: 'matplotlib.patches.Patch' },
      Wedge: { effect: 'read', returnType: 'matplotlib.patches.Wedge' },
      Circle: { effect: 'read', returnType: 'matplotlib.patches.Patch' },
      FancyBboxPatch: { effect: 'read', returnType: 'matplotlib.patches.Patch' }
    }
  },
  'matplotlib.patches.Patch': {
    kind: 'type',
    methods: {
      set_alpha: { effect: 'mutate' },
      set_color: { effect: 'mutate' },
      set_edgecolor: { effect: 'mutate' },
      set_facecolor: { effect: 'mutate' },
      set_linewidth: { effect: 'mutate' },
      set_visible: { effect: 'mutate' }
    }
  },
  'matplotlib.patches.Rectangle': {
    kind: 'type',
    methods: {
      get_height: { effect: 'read' },
      get_width: { effect: 'read' },
      get_x: { effect: 'read' },
      get_y: { effect: 'read' },
      set_alpha: { effect: 'mutate' },
      set_color: { effect: 'mutate' },
      set_edgecolor: { effect: 'mutate' },
      set_facecolor: { effect: 'mutate' },
      set_height: { effect: 'mutate' },
      set_linewidth: { effect: 'mutate' },
      set_visible: { effect: 'mutate' },
      set_width: { effect: 'mutate' },
      set_x: { effect: 'mutate' },
      set_y: { effect: 'mutate' }
    }
  },
  'matplotlib.patches.Wedge': {
    kind: 'type',
    iterationTypes: ['matplotlib.patches.Wedge'],
    methods: {
      set_alpha: { effect: 'mutate' },
      set_edgecolor: { effect: 'mutate' },
      set_facecolor: { effect: 'mutate' },
      set_linewidth: { effect: 'mutate' },
      set_visible: { effect: 'mutate' }
    }
  },
  'matplotlib.text.Text': {
    kind: 'type',
    iterationTypes: ['matplotlib.text.Text'],
    methods: {
      set_alpha: { effect: 'mutate' },
      set_color: { effect: 'mutate' },
      set_fontsize: { effect: 'mutate' },
      set_fontweight: { effect: 'mutate' },
      set_horizontalalignment: { effect: 'mutate' },
      set_rotation: { effect: 'mutate' },
      set_text: { effect: 'mutate' },
      set_verticalalignment: { effect: 'mutate' },
      set_visible: { effect: 'mutate' }
    }
  },
  'matplotlib.lines.Line2DList': {
    kind: 'type',
    iterationTypes: ['matplotlib.lines.Line2D'],
    methods: {}
  },
  'matplotlib.lines.Line2D': {
    kind: 'type',
    methods: {
      set_alpha: { effect: 'mutate' },
      set_color: { effect: 'mutate' },
      set_linestyle: { effect: 'mutate' },
      set_linewidth: { effect: 'mutate' },
      set_marker: { effect: 'mutate' },
      set_visible: { effect: 'mutate' }
    }
  },
  'seaborn.matrix.ClusterGrid': {
    kind: 'type',
    methods: {
      ...Object.fromEntries(
        [
          'ax_heatmap',
          'ax_row_dendrogram',
          'ax_col_dendrogram',
          'ax_row_colors',
          'ax_col_colors',
          'ax_cbar',
          'cax'
        ].map((name) => [
          `@${name}`,
          {
            effect: 'read' as const,
            returnType: 'matplotlib.axes.Axes',
            returnsAliasOfReceiver: true
          }
        ])
      ),
      '@fig': {
        effect: 'read',
        returnType: 'matplotlib.figure.Figure',
        returnsAliasOfReceiver: true
      },
      '@figure': {
        effect: 'read',
        returnType: 'matplotlib.figure.Figure',
        returnsAliasOfReceiver: true
      },
      savefig: { effect: 'read', file: { kind: 'write', position: 0, keywords: ['fname'] } },
      tight_layout: { effect: 'mutate' }
    }
  },
  seaborn: {
    kind: 'module',
    methods: {
      clustermap: {
        effect: 'read',
        returnType: 'seaborn.matrix.ClusterGrid',
        callbackKeywords: ['metric']
      },
      ...Object.fromEntries(
        [
          'set',
          'set_theme',
          'set_style',
          'set_context',
          'set_palette',
          'reset_defaults',
          'reset_orig'
        ].map((name) => [name, { effect: 'read' as const, plottingState: 'write' as const }])
      ),
      barplot: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax',
        callbackKeywords: ['estimator', 'errorbar']
      },
      boxplot: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax'
      },
      heatmap: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax'
      },
      histplot: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax'
      },
      lineplot: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax',
        callbackKeywords: ['estimator', 'errorbar']
      },
      scatterplot: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax'
      },
      violinplot: {
        effect: 'read',
        returnType: 'matplotlib.axes.Axes',
        mutatesKeyword: 'ax',
        returnsAliasOfKeyword: 'ax'
      }
    }
  },
  'sklearn.preprocessing': {
    kind: 'module',
    methods: {
      StandardScaler: {
        effect: 'read',
        returnType: 'sklearn.preprocessing.StandardScaler',
        returnTypeWhenKeywordNotTrue: {
          keyword: 'copy',
          returnType: 'sklearn.preprocessing.StandardScaler.copy-uncertain'
        }
      }
    }
  },
  'sklearn.preprocessing.StandardScaler.copy-uncertain': {
    kind: 'type',
    typeWhenMembersWritten: {
      copy: 'sklearn.preprocessing.StandardScaler.copy-uncertain'
    },
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'sklearn.preprocessing.StandardScaler.copy-uncertain',
        returnsAliasOfReceiver: true
      },
      fit_transform: {
        effect: 'mutate',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true
      },
      inverse_transform: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true
      },
      partial_fit: {
        effect: 'mutate',
        returnType: 'sklearn.preprocessing.StandardScaler.copy-uncertain',
        returnsAliasOfReceiver: true
      },
      set_params: {
        effect: 'mutate',
        returnType: 'sklearn.preprocessing.StandardScaler.copy-uncertain',
        returnsAliasOfReceiver: true
      },
      transform: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true
      }
    }
  },
  'sklearn.preprocessing.StandardScaler': {
    kind: 'type',
    typeWhenMembersWritten: {
      copy: 'sklearn.preprocessing.StandardScaler.copy-uncertain'
    },
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'sklearn.preprocessing.StandardScaler',
        returnsAliasOfReceiver: true
      },
      fit_transform: { effect: 'mutate', returnType: 'numpy.ndarray' },
      inverse_transform: { effect: 'read', returnType: 'numpy.ndarray' },
      partial_fit: {
        effect: 'mutate',
        returnType: 'sklearn.preprocessing.StandardScaler',
        returnsAliasOfReceiver: true
      },
      set_params: {
        effect: 'mutate',
        returnType: 'sklearn.preprocessing.StandardScaler',
        returnTypeWhenKeywordNotTrue: {
          keyword: 'copy',
          returnType: 'sklearn.preprocessing.StandardScaler.copy-uncertain'
        },
        receiverTypeWhenKeywordNotTrue: {
          keyword: 'copy',
          typeName: 'sklearn.preprocessing.StandardScaler.copy-uncertain'
        },
        returnsAliasOfReceiver: true
      },
      transform: { effect: 'read', returnType: 'numpy.ndarray' }
    }
  },
  'sklearn.decomposition': {
    kind: 'module',
    methods: {
      PCA: {
        effect: 'read',
        returnType: 'sklearn.decomposition.PCA',
        returnTypeWhenKeywordNotTrue: {
          keyword: 'copy',
          returnType: 'sklearn.decomposition.PCA.copy-uncertain'
        }
      }
    }
  },
  'sklearn.decomposition.PCA.copy-uncertain': {
    kind: 'type',
    typeWhenMembersWritten: { copy: 'sklearn.decomposition.PCA.copy-uncertain' },
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'sklearn.decomposition.PCA.copy-uncertain',
        returnsAliasOfReceiver: true,
        possiblyMutatesFirstArgument: true
      },
      fit_transform: {
        effect: 'mutate',
        returnType: 'numpy.ndarray',
        possiblyMutatesFirstArgument: true
      },
      inverse_transform: { effect: 'read', returnType: 'numpy.ndarray' },
      score: { effect: 'read' },
      set_params: {
        effect: 'mutate',
        returnType: 'sklearn.decomposition.PCA.copy-uncertain',
        returnsAliasOfReceiver: true
      },
      transform: { effect: 'read', returnType: 'numpy.ndarray' }
    }
  },
  'sklearn.decomposition.PCA': {
    kind: 'type',
    typeWhenMembersWritten: { copy: 'sklearn.decomposition.PCA.copy-uncertain' },
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'sklearn.decomposition.PCA',
        returnsAliasOfReceiver: true
      },
      fit_transform: { effect: 'mutate', returnType: 'numpy.ndarray' },
      inverse_transform: { effect: 'read', returnType: 'numpy.ndarray' },
      score: { effect: 'read' },
      set_params: {
        effect: 'mutate',
        returnType: 'sklearn.decomposition.PCA',
        returnTypeWhenKeywordNotTrue: {
          keyword: 'copy',
          returnType: 'sklearn.decomposition.PCA.copy-uncertain'
        },
        receiverTypeWhenKeywordNotTrue: {
          keyword: 'copy',
          typeName: 'sklearn.decomposition.PCA.copy-uncertain'
        },
        returnsAliasOfReceiver: true
      },
      transform: { effect: 'read', returnType: 'numpy.ndarray' }
    }
  },
  'sklearn.linear_model': {
    kind: 'module',
    methods: {
      LinearRegression: {
        effect: 'read',
        returnType: 'sklearn.linear_model.LinearRegression',
        returnTypeWhenKeywordNotTrue: {
          keyword: 'copy_X',
          returnType: 'sklearn.linear_model.LinearRegression.copy-uncertain'
        }
      }
    }
  },
  'sklearn.linear_model.LinearRegression.copy-uncertain': {
    kind: 'type',
    typeWhenMembersWritten: {
      copy_X: 'sklearn.linear_model.LinearRegression.copy-uncertain'
    },
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'sklearn.linear_model.LinearRegression.copy-uncertain',
        returnsAliasOfReceiver: true,
        possiblyMutatesFirstArgument: true
      },
      predict: { effect: 'read', returnType: 'numpy.ndarray' },
      score: { effect: 'read' },
      set_params: {
        effect: 'mutate',
        returnType: 'sklearn.linear_model.LinearRegression.copy-uncertain',
        returnsAliasOfReceiver: true
      }
    }
  },
  'sklearn.linear_model.LinearRegression': {
    kind: 'type',
    typeWhenMembersWritten: {
      copy_X: 'sklearn.linear_model.LinearRegression.copy-uncertain'
    },
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'sklearn.linear_model.LinearRegression',
        returnsAliasOfReceiver: true
      },
      predict: { effect: 'read', returnType: 'numpy.ndarray' },
      score: { effect: 'read' },
      set_params: {
        effect: 'mutate',
        returnType: 'sklearn.linear_model.LinearRegression',
        returnTypeWhenKeywordNotTrue: {
          keyword: 'copy_X',
          returnType: 'sklearn.linear_model.LinearRegression.copy-uncertain'
        },
        receiverTypeWhenKeywordNotTrue: {
          keyword: 'copy_X',
          typeName: 'sklearn.linear_model.LinearRegression.copy-uncertain'
        },
        returnsAliasOfReceiver: true
      }
    }
  },
  'statsmodels.api': {
    kind: 'module',
    methods: {
      add_constant: { effect: 'read' },
      OLS: {
        effect: 'read',
        returnType: 'statsmodels.regression.linear_model.OLS'
      }
    }
  },
  'statsmodels.formula.api': {
    kind: 'module',
    methods: {
      ols: {
        effect: 'read',
        returnType: 'statsmodels.regression.linear_model.OLS',
        formulaArgument: { positionalArgument: 0, keyword: 'formula' }
      }
    }
  },
  'statsmodels.regression.linear_model.OLS': {
    kind: 'type',
    methods: {
      fit: {
        effect: 'mutate',
        returnType: 'statsmodels.regression.linear_model.RegressionResults'
      }
    }
  },
  'statsmodels.regression.linear_model.RegressionResults': {
    kind: 'type',
    methods: {
      conf_int: { effect: 'read' },
      predict: { effect: 'read' },
      summary: { effect: 'read' }
    }
  }
}

const pythonLibraryMethodEffect = (
  typeName: string,
  member: string
): PythonLibraryMethodEffect | undefined => {
  let resolvedType = typeName
  if (!PYTHON_LIBRARY_EFFECTS[resolvedType]) {
    const parts = typeName.split('.')
    for (let index = parts.length - 1; index > 0; index--) {
      let owner = parts.slice(0, index).join('.')
      if (!PYTHON_LIBRARY_EFFECTS[owner]) continue
      for (const property of parts.slice(index))
        owner = PYTHON_LIBRARY_EFFECTS[owner]?.methods[`@${property}`]?.returnType ?? ''
      resolvedType = owner
      break
    }
  }
  const summary = PYTHON_LIBRARY_EFFECTS[resolvedType]
  const method = summary?.methods[member]
  if (
    method &&
    !method.plottingState &&
    !member.startsWith('@') &&
    (resolvedType.startsWith('matplotlib.') ||
      resolvedType === 'matplotlib' ||
      resolvedType === 'seaborn')
  )
    return { ...method, plottingState: 'read' }
  return (
    method ??
    (summary?.unknownMethodsHaveExternalState
      ? { effect: 'unknown', externalState: true, scopedOpaque: true }
      : undefined)
  )
}

// Follow tuple positions, then the library's known iterable element types.
// An unmodeled element stays unknown; never flatten nested targets into return slots.
const pythonUnpackedReturnType = (
  returnedTypes: readonly string[],
  path: readonly number[]
): string | undefined => {
  let typeName: string | undefined = returnedTypes[path[0]!]
  for (const index of path.slice(1)) {
    const elements: readonly string[] | undefined =
      PYTHON_LIBRARY_EFFECTS[typeName ?? '']?.iterationTypes
    typeName = elements?.[index] ?? (elements?.length === 1 ? elements[0] : undefined)
  }
  return typeName
}

export { PYTHON_LIBRARY_EFFECTS, pythonLibraryMethodEffect, pythonUnpackedReturnType }

// Unknown selectors cannot be assumed to return either a table or a collection.
export const pythonArgumentShapeReturnType = (
  effect: PythonLibraryMethodEffect,
  positionalShapes: PythonArgumentShape[] | undefined,
  keywords: Array<{ name: string; staticShape?: PythonArgumentShape }> | undefined
): string | undefined => {
  const rule = effect.returnTypeByArgumentShape
  if (!rule) return effect.returnType
  const keyword = keywords?.find((value) => value.name === rule.keyword)
  if (keywords?.some((value) => value.name === '**')) return undefined
  const shape = keyword ? (keyword.staticShape ?? 'unknown') : positionalShapes?.[rule.position]
  return shape === undefined ? effect.returnType : rule.types[shape]
}

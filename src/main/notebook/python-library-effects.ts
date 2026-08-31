import type { NotebookFileCallEffect } from './notebook-call-effects'

export type PythonLibraryMethodEffect = {
  effect: 'read' | 'mutate' | 'unknown'
  // A library call's namespace effect and file arguments are independent facts.
  // Keep them together when known so variable and file analysis cannot diverge.
  file?: NotebookFileCallEffect
  unknownScope?: 'receiver' | 'namespace'
  unsafeNamespace?: boolean
  scopedOpaque?: boolean
  externalState?: boolean
  returnType?: string
  destructuredReturnTypes?: string[]
  mutatesReceiverUnlessKeywordFalse?: string
  mutatesKeyword?: string
  mutatesPositionalArgument?: number
  callbackKeywords?: string[]
  callbackContainerKeywords?: string[]
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
const PYTHON_LIBRARY_EFFECTS: PythonLibraryEffects = {
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
      load: { effect: 'read', unsafeNamespace: true }
    }
  },
  torch: {
    kind: 'module',
    methods: {
      load: { effect: 'read', unsafeNamespace: true }
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
  numpy: {
    kind: 'module',
    methods: {
      arange: { effect: 'read', returnType: 'numpy.ndarray' },
      atleast_1d: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        preservesIterationTypesFrom: 'firstArgument',
        returnsPossibleAliasOf: 'firstArgument'
      },
      abs: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
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
      cos: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      clip: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 3
      },
      diff: { effect: 'read', returnType: 'numpy.ndarray' },
      exp: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      full: { effect: 'read', returnType: 'numpy.ndarray' },
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
      log: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      log1p: {
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
      sin: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
      },
      sqrt: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        mutatesKeyword: 'out',
        mutatesPositionalArgument: 1
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
      tolist: { effect: 'read' }
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
        returnType: 'pandas.DataFrame',
        possiblyMutatesFirstArgument: true,
        firstArgumentKeyword: 'filepath_or_buffer'
      },
      read_excel: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
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
  'python.scalar': { kind: 'type', methods: {} },
  'pandas.DataFrame': {
    kind: 'type',
    methods: {
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
      head: { effect: 'read', returnType: 'pandas.DataFrame' },
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
        callbackContainerKeywords: ['aggfunc']
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
  'pandas.core.groupby.DataFrameGroupBy': {
    kind: 'type',
    iterationTypes: ['python.scalar', 'pandas.DataFrame'],
    methods: {
      mean: { effect: 'read', returnType: 'pandas.DataFrame' },
      sum: { effect: 'read', returnType: 'pandas.DataFrame' }
    }
  },
  'pandas.Series': {
    kind: 'type',
    methods: {
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
      to_dict: { effect: 'read' },
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
      use: { effect: 'read' }
    }
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
      AlignmentFile: { effect: 'read', externalState: true }
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
      add_gridspec: { effect: 'mutate', returnType: 'matplotlib.gridspec.GridSpec' },
      add_subplot: { effect: 'mutate', returnType: 'matplotlib.axes.Axes' },
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
      axis: { effect: 'mutate' },
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
  'matplotlib.patches': {
    kind: 'module',
    methods: {
      Patch: { effect: 'read', returnType: 'matplotlib.patches.Patch' }
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
  seaborn: {
    kind: 'module',
    methods: {
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
  const summary = PYTHON_LIBRARY_EFFECTS[typeName]
  return (
    summary?.methods[member] ??
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

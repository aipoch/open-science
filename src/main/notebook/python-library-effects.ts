export type PythonLibraryMethodEffect = {
  effect: 'read' | 'mutate'
  unsafeNamespace?: boolean
  returnType?: string
  destructuredReturnTypes?: string[]
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
  typeWhenMembersWritten?: Record<string, string>
}

type PythonLibraryEffects = Record<string, PythonLibraryObjectSummary>

// Static effects are deliberately limited to stable, documented behavior used by ordinary
// scientific Notebook code. Unknown methods continue through the conservative receiver-call path.
const PYTHON_LIBRARY_EFFECTS: PythonLibraryEffects = {
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
  numpy: {
    kind: 'module',
    methods: {
      arange: { effect: 'read', returnType: 'numpy.ndarray' },
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
      flatten: { effect: 'read', returnType: 'numpy.ndarray' },
      max: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 1 },
      mean: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 2 },
      min: { effect: 'read', mutatesKeyword: 'out', mutatesPositionalArgument: 1 },
      ravel: {
        effect: 'read',
        returnType: 'numpy.ndarray',
        returnsPossibleAliasOf: 'receiver'
      },
      reshape: {
        effect: 'read',
        returnType: 'numpy.ndarray',
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
        returnType: 'pandas.DataFrame',
        possiblyMutatesPositionalArgument: 1,
        possiblyMutatesKeyword: 'con'
      },
      read_sql_query: {
        effect: 'read',
        returnType: 'pandas.DataFrame',
        possiblyMutatesPositionalArgument: 1,
        possiblyMutatesKeyword: 'con'
      },
      read_sql_table: {
        effect: 'read',
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
      dropna: { effect: 'read', returnType: 'pandas.DataFrame' },
      fillna: { effect: 'read', returnType: 'pandas.DataFrame' },
      groupby: { effect: 'read', returnType: 'pandas.core.groupby.DataFrameGroupBy' },
      head: { effect: 'read', returnType: 'pandas.DataFrame' },
      join: { effect: 'read', returnType: 'pandas.DataFrame' },
      max: { effect: 'read', returnType: 'pandas.Series' },
      mean: { effect: 'read', returnType: 'pandas.Series' },
      min: { effect: 'read', returnType: 'pandas.Series' },
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
      set_index: { effect: 'read', returnType: 'pandas.DataFrame' },
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
      fillna: { effect: 'read', returnType: 'pandas.Series' },
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
    methods: {
      read_csv: { effect: 'read', returnType: 'anndata.AnnData' },
      read_h5ad: { effect: 'read', returnType: 'anndata.AnnData' },
      read_loom: { effect: 'read', returnType: 'anndata.AnnData' },
      read_mtx: { effect: 'read', returnType: 'anndata.AnnData' },
      read_text: { effect: 'read', returnType: 'anndata.AnnData' }
    }
  },
  scanpy: {
    kind: 'module',
    methods: {
      read_10x_h5: { effect: 'read', returnType: 'anndata.AnnData' },
      read_10x_mtx: { effect: 'read', returnType: 'anndata.AnnData' },
      read_csv: { effect: 'read', returnType: 'anndata.AnnData' },
      read_h5ad: { effect: 'read', returnType: 'anndata.AnnData' },
      read_loom: { effect: 'read', returnType: 'anndata.AnnData' },
      read_mtx: { effect: 'read', returnType: 'anndata.AnnData' },
      read_text: { effect: 'read', returnType: 'anndata.AnnData' }
    }
  },
  'anndata.AnnData': {
    kind: 'type',
    methods: {
      copy: { effect: 'read', returnType: 'anndata.AnnData' },
      obs_names_make_unique: { effect: 'mutate' },
      var_names_make_unique: { effect: 'mutate' },
      write: { effect: 'read' },
      write_csvs: { effect: 'read' },
      write_h5ad: { effect: 'read' },
      write_loom: { effect: 'read' },
      write_zarr: { effect: 'read' }
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
      pie: { effect: 'read' },
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
      savefig: { effect: 'read' },
      tight_layout: { effect: 'mutate' }
    }
  },
  'matplotlib.axes.Axes': {
    kind: 'type',
    methods: {
      axhline: { effect: 'mutate' },
      axvline: { effect: 'mutate' },
      grid: { effect: 'mutate' },
      legend: { effect: 'mutate' },
      plot: { effect: 'mutate' },
      set_title: { effect: 'mutate' },
      set_xlabel: { effect: 'mutate' },
      set_xlim: { effect: 'mutate' },
      set_xticklabels: { effect: 'mutate' },
      set_xticks: { effect: 'mutate' },
      set_ylabel: { effect: 'mutate' },
      set_ylim: { effect: 'mutate' }
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

export { PYTHON_LIBRARY_EFFECTS }

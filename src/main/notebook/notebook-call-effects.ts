type NotebookFileCallEffect = {
  kind: 'read' | 'write'
  position: number
  keywords: readonly string[]
  additionalPaths?: readonly { position: number; keywords: readonly string[] }[]
  // Formats whose conventional representation is one file; other formats need
  // header/companion evidence before a single path can represent the whole input.
  singleFileSuffixes?: readonly string[]
  pathOptional?: boolean
  inputForm?: 'paths' | 'lines'
}

const PYTHON_FILE_CALL_EFFECTS: ReadonlyMap<string, NotebookFileCallEffect> = new Map<
  string,
  NotebookFileCallEffect
>([
  ...['numpy.loadtxt', 'numpy.genfromtxt', 'loadtxt', 'genfromtxt'].map(
    (name) =>
      [name, { kind: 'read', position: 0, keywords: ['fname'], inputForm: 'lines' }] as const
  ),
  ['scipy.io.loadmat', { kind: 'read', position: 0, keywords: ['file_name'] }],
  ...['xarray.open_mfdataset', 'open_mfdataset'].map(
    (name) =>
      [name, { kind: 'read', position: 0, keywords: ['paths'], inputForm: 'paths' }] as const
  ),
  ['pandas.ExcelFile', { kind: 'read', position: 0, keywords: ['path_or_buffer'] }],
  ['scanpy.read_10x_h5', { kind: 'read', position: 0, keywords: ['filename'] }],
  ...[
    'dcmread',
    'fromfile',
    'imread',
    'load',
    'load_file',
    'load_pickle',
    'load_workbook',
    'loadmat',
    'load_npz',
    'mmread',
    'open_dataarray',
    'open_dataset',
    'open_zarr',
    'read_csv',
    'read_excel',
    'read_feather',
    'read_file',
    'read_fwf',
    'read_hdf',
    'read_h5ad',
    'read_html',
    'read_json',
    'read_orc',
    'read_parquet',
    'read_pickle',
    'read_sas',
    'read_spss',
    'read_stata',
    'read_table',
    'read_xml',
    'scan_csv',
    'scan_ipc',
    'scan_ndjson',
    'scan_parquet'
  ].map(
    (name) =>
      [
        name,
        {
          kind: 'read',
          position: 0,
          keywords: [
            'file',
            'filename',
            'path',
            'path_or_buffer',
            'filepath_or_buffer',
            'io',
            'source'
          ]
        }
      ] as const
  ),
  ...[
    'savefig',
    'sink_csv',
    'sink_ipc',
    'sink_ndjson',
    'sink_parquet',
    'to_csv',
    'to_excel',
    'to_feather',
    'to_hdf',
    'to_json',
    'to_orc',
    'to_parquet',
    'to_pickle',
    'to_file',
    'tofile',
    'write_csv',
    'write_excel',
    'write_feather',
    'write_ipc',
    'write_json',
    'write_parquet'
  ].map(
    (name) =>
      [
        name,
        {
          kind: 'write',
          position: 0,
          keywords: ['fname', 'filename', 'path', 'path_or_buf', 'file']
        }
      ] as const
  ),
  ['dump', { kind: 'write', position: 1, keywords: ['file', 'filename', 'fp'] }],
  ['dcmwrite', { kind: 'write', position: 0, keywords: ['filename'] }],
  ['imwrite', { kind: 'write', position: 0, keywords: ['filename'] }],
  ['imsave', { kind: 'write', position: 0, keywords: ['fname'] }],
  ['save', { kind: 'write', position: 0, keywords: ['file', 'filename', 'fp'] }],
  ['save_pickle', { kind: 'write', position: 1, keywords: ['fname', 'filename'] }],
  ['save_file', { kind: 'write', position: 1, keywords: ['filename'] }],
  ['save_npz', { kind: 'write', position: 0, keywords: ['file'] }],
  ['savez', { kind: 'write', position: 0, keywords: ['file'] }],
  ['savez_compressed', { kind: 'write', position: 0, keywords: ['file'] }],
  ['savemat', { kind: 'write', position: 0, keywords: ['file_name'] }],
  ['savetxt', { kind: 'write', position: 0, keywords: ['fname'] }],
  ['print_png', { kind: 'write', position: 0, keywords: ['filename'] }],
  ['to_netcdf', { kind: 'write', position: 0, keywords: ['path'], pathOptional: true }],
  ['to_html', { kind: 'write', position: 0, keywords: ['buf'], pathOptional: true }],
  ['to_latex', { kind: 'write', position: 0, keywords: ['buf'], pathOptional: true }],
  ['to_markdown', { kind: 'write', position: 0, keywords: ['buf'], pathOptional: true }],
  ['write_h5ad', { kind: 'write', position: 0, keywords: ['filename'] }],
  ['write_html', { kind: 'write', position: 1, keywords: ['file'] }],
  ['write_image', { kind: 'write', position: 1, keywords: ['file'] }]
])

const PYTHON_POTENTIAL_FILE_WRITE_CALLS = new Set([
  'save_pretrained',
  'to_file',
  'to_zarr',
  'write_dataset'
])

const PYTHON_FILE_HANDLE_WRITE_CALLS = new Set(['write', 'writeheader', 'writerow', 'writerows'])

const isPotentialPythonFileWriteCall = (name: string): boolean =>
  PYTHON_POTENTIAL_FILE_WRITE_CALLS.has(name) ||
  (!PYTHON_FILE_HANDLE_WRITE_CALLS.has(name) && /^(?:export|persist|save|write)/u.test(name))

const PYTHON_UNSUPPORTED_EXTERNAL_STATE_NAMESPACES = [
  'boto3',
  'botocore',
  'duckdb',
  'ftplib',
  'gcsfs',
  'httpx',
  'numpy.random',
  // Slide containers, radiomics settings and WFDB records may access implicit
  // companions, native process state, or remote resources beyond an entry path.
  'openslide',
  'radiomics',
  'wfdb',
  'paramiko',
  'psycopg',
  'psycopg2',
  // HTS resources can also read indexes/reference files; a constructor path alone is
  // insufficient to claim complete input coverage (including extensionless files).
  'pysam',
  'requests',
  'random',
  's3fs',
  'secrets',
  'socket',
  'sqlite3',
  'sqlalchemy',
  'subprocess',
  'tempfile',
  'urllib'
] as const

const PYTHON_UNSUPPORTED_EXTERNAL_STATE_CALLS = new Set([
  'datetime.datetime.now',
  'datetime.datetime.today',
  'datetime.date.today',
  'os.getenv',
  'os.getlogin',
  'os.urandom',
  'time.time',
  'uuid.uuid4'
])

// File-producing grDevices entry points share identity between dependency and
// file analysis. Device copying/printing accepts callbacks and is not covered here.
const R_GRAPHICS_FILE_DEVICES = new Set([
  'bmp',
  'cairo_pdf',
  'cairo_ps',
  'jpeg',
  'pdf',
  'pictex',
  'png',
  'postscript',
  'svg',
  'tiff',
  'xfig'
])

const R_FILE_CALL_EFFECTS: ReadonlyMap<string, NotebookFileCallEffect> = new Map<
  string,
  NotebookFileCallEffect
>([
  ['read.FCS', { kind: 'read', position: 0, keywords: ['filename'] }],
  ['read.flowSet', { kind: 'read', position: 0, keywords: ['files'], inputForm: 'paths' }],
  ['write.FCS', { kind: 'write', position: 1, keywords: ['filename'] }],
  ['tximport', { kind: 'read', position: 0, keywords: ['files'], inputForm: 'paths' }],
  ['readMSData', { kind: 'read', position: 0, keywords: ['files'], inputForm: 'paths' }],
  ['Spectra', { kind: 'read', position: 0, keywords: ['object'], inputForm: 'paths' }],
  ...[
    'dget',
    'fread',
    'fromJSON',
    'image_read',
    'import',
    'load',
    'loadWorkbook',
    'nc_open',
    'qread',
    'rast',
    'readBin',
    'readChar',
    'readLines',
    'readMM',
    'readDNAStringSet',
    'readMat',
    'read.csv',
    'read.csv2',
    'read.delim',
    'read.delim2',
    'read.dta',
    'read.fwf',
    'read.sas7bdat',
    'read.table',
    'read.xlsx',
    'readRDS',
    'read_csv',
    'read_csv2',
    'read_csv_arrow',
    'read_delim',
    'read_delim_arrow',
    'read_excel',
    'read_feather',
    'read_fst',
    'read_fwf',
    'read_ipc_file',
    'read_ipc_stream',
    'read_json_arrow',
    'read_json',
    'read_file',
    'read_lines',
    'read_ods',
    'read_parquet',
    'read_por',
    'read_rds',
    'read_sav',
    'read_sas',
    'read_table',
    'read_tsv',
    'read_xls',
    'read_xlsx',
    'read_xpt',
    'read_yaml',
    'read_xml',
    'h5read',
    'scan',
    'st_read',
    'vect',
    'vroom',
    'vroom_fwf',
    'vroom_lines',
    'wb_load',
    'yaml.load_file'
  ].map(
    (name) => [name, { kind: 'read', position: 0, keywords: ['file', 'path', 'input'] }] as const
  ),
  ...[
    'export',
    'fwrite',
    'ggsave',
    'qsave',
    'saveRDS',
    'saveWorkbook',
    'wb_save',
    'write.csv',
    'write.csv2',
    'write.table',
    'write.xlsx',
    'write_csv',
    'write_csv_arrow',
    'write_dataset',
    'write_delim',
    'write_dta',
    'write_feather',
    'write_fst',
    'write_ipc_file',
    'write_ipc_stream',
    'write_parquet',
    'write_sas',
    'write_sav',
    'write_tsv',
    'write_xlsx',
    'write_xpt'
  ].map(
    (name) =>
      [
        name,
        {
          kind: 'write',
          position: name === 'ggsave' ? 0 : 1,
          keywords: ['file', 'filename', 'path']
        }
      ] as const
  ),
  ...[...R_GRAPHICS_FILE_DEVICES].map(
    (name) => [name, { kind: 'write', position: 0, keywords: ['file', 'filename'] }] as const
  ),
  ...['agg_jpeg', 'agg_png', 'agg_tiff'].map(
    (name) => [name, { kind: 'write', position: 0, keywords: ['filename'] }] as const
  ),
  ['svglite', { kind: 'write', position: 0, keywords: ['file'] }],
  ...['CairoJPEG', 'CairoPDF', 'CairoPNG', 'CairoSVG', 'CairoTIFF'].map(
    (name) => [name, { kind: 'write', position: 0, keywords: ['filename'] }] as const
  ),
  ['capture.output', { kind: 'write', position: -1, keywords: ['file'], pathOptional: true }],
  ['dput', { kind: 'write', position: 1, keywords: ['file'], pathOptional: true }],
  ['h5write', { kind: 'write', position: 1, keywords: ['file'] }],
  ['image_write', { kind: 'write', position: 1, keywords: ['path'] }],
  ['nc_create', { kind: 'write', position: 0, keywords: ['filename'] }],
  ['save', { kind: 'write', position: -1, keywords: ['file'] }],
  ['save.image', { kind: 'write', position: 0, keywords: ['file'] }],
  ['saveWidget', { kind: 'write', position: 1, keywords: ['file'] }],
  ['sink', { kind: 'write', position: 0, keywords: ['file'], pathOptional: true }],
  ['write_file', { kind: 'write', position: 1, keywords: ['file'] }],
  ['write_json', { kind: 'write', position: 1, keywords: ['path'] }],
  ['write_lines', { kind: 'write', position: 1, keywords: ['file'] }],
  ['write_ods', { kind: 'write', position: 1, keywords: ['path'] }],
  ['write_rds', { kind: 'write', position: 1, keywords: ['file'] }],
  ['write_xml', { kind: 'write', position: 1, keywords: ['file'] }],
  ['write_yaml', { kind: 'write', position: 1, keywords: ['file'] }],
  ['writeMM', { kind: 'write', position: 1, keywords: ['file'] }],
  ['writeMat', { kind: 'write', position: 0, keywords: ['con'] }],
  ['writeXStringSet', { kind: 'write', position: 1, keywords: ['filepath'] }],
  ['writeBin', { kind: 'write', position: 1, keywords: ['con'] }],
  ['writeLines', { kind: 'write', position: 1, keywords: ['con'], pathOptional: true }],
  ['readDNAStringSet', { kind: 'read', position: 0, keywords: ['filepath'], inputForm: 'paths' }],
  [
    'ReadMtx',
    {
      kind: 'read',
      position: 0,
      keywords: ['mtx'],
      additionalPaths: [
        { position: 1, keywords: ['cells'] },
        { position: 2, keywords: ['features'] }
      ]
    }
  ],
  ['read_exposure_data', { kind: 'read', position: 0, keywords: ['filename'] }],
  ['read_outcome_data', { kind: 'read', position: 0, keywords: ['filename'] }],
  ['getGEO', { kind: 'read', position: 1, keywords: ['filename'] }],
  ['Read10X_h5', { kind: 'read', position: 0, keywords: ['filename'] }],
  ...[
    'read_csv',
    'read_csv2',
    'read_tsv',
    'read_delim',
    'read_fwf',
    'read_lines',
    'vroom',
    'vroom_fwf',
    'vroom_lines'
  ].map(
    (name) => [name, { kind: 'read', position: 0, keywords: ['file'], inputForm: 'paths' }] as const
  ),
  ...['readLines', 'readBin', 'readChar', 'readMat'].map(
    (name) => [name, { kind: 'read', position: 0, keywords: ['con'] }] as const
  ),
  ['fromJSON', { kind: 'read', position: 0, keywords: ['txt'] }],
  ['st_read', { kind: 'read', position: 0, keywords: ['dsn'] }],
  ['nc_open', { kind: 'read', position: 0, keywords: ['filename'] }],
  ...['rast', 'vect'].map((name) => [name, { kind: 'read', position: 0, keywords: ['x'] }] as const)
])

const R_POTENTIAL_FILE_WRITE_CALLS = new Set(['st_write', 'writeRaster'])

const isPotentialRFileWriteCall = (name: string): boolean =>
  R_POTENTIAL_FILE_WRITE_CALLS.has(name) ||
  (name !== 'write' && /^(?:export|save|write)/u.test(name))

export {
  PYTHON_FILE_CALL_EFFECTS,
  isPotentialPythonFileWriteCall,
  PYTHON_UNSUPPORTED_EXTERNAL_STATE_CALLS,
  PYTHON_UNSUPPORTED_EXTERNAL_STATE_NAMESPACES,
  R_FILE_CALL_EFFECTS,
  R_GRAPHICS_FILE_DEVICES,
  isPotentialRFileWriteCall
}
export type { NotebookFileCallEffect }

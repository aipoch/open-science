// File writers can preserve existing bytes without an explicit reader in the source.
// Keep option semantics shared by Python/R analysis and local-wrapper inference.
type WriteOption = {
  keyword: 'mode' | 'append' | 'file_mode'
  position?: number
  precedingArguments?: readonly string[]
  defaultValue: string | boolean
}
type WriteDisposition = 'replace' | 'update' | 'unknown'

const writeOptions: Record<'python' | 'r', ReadonlyMap<string, WriteOption>> = {
  python: new Map([
    // Pyteomics changed the default from append to replace in 4.6. Without
    // version-aware source analysis, only an explicit mode establishes it.
    ['pyteomics.mgf.write', { keyword: 'file_mode', defaultValue: 'unknown' }],
    ['to_csv', { keyword: 'mode', position: 8, defaultValue: 'w' }],
    ['to_json', { keyword: 'mode', defaultValue: 'w' }],
    ['to_hdf', { keyword: 'mode', defaultValue: 'a' }],
    ['to_zarr', { keyword: 'mode', position: 2, defaultValue: 'w-' }],
    ['to_netcdf', { keyword: 'mode', position: 1, defaultValue: 'w' }]
  ]),
  r: new Map<string, WriteOption>([
    ['write.table', { keyword: 'append', precedingArguments: ['x', 'file'], defaultValue: false }],
    ['fwrite', { keyword: 'append', defaultValue: false }],
    ...['write_csv', 'write_csv2', 'write_tsv'].map(
      (name) =>
        [
          name,
          { keyword: 'append', precedingArguments: ['x', 'file', 'na'], defaultValue: false }
        ] as const
    ),
    [
      'write_lines',
      { keyword: 'append', precedingArguments: ['x', 'file', 'sep', 'na'], defaultValue: false }
    ],
    ['write_file', { keyword: 'append', precedingArguments: ['x', 'file'], defaultValue: false }],
    [
      'write_delim',
      { keyword: 'append', precedingArguments: ['x', 'file', 'delim', 'na'], defaultValue: false }
    ]
    // utils::write.csv/write.csv2 deliberately ignore append; they replace the file.
  ])
}

export const notebookWriteOption = (
  language: 'python' | 'r',
  name: string
): WriteOption | undefined => writeOptions[language].get(name)

export const notebookWriteDisposition = (option: WriteOption, value: unknown): WriteDisposition => {
  if (option.keyword === 'append') {
    return value === true ? 'update' : value === false ? 'replace' : 'unknown'
  }
  if (value === 'w-') return 'replace'
  if (value === 'a-') return 'update'
  if (typeof value !== 'string' || !/^[rwax](?:[bt]?\+?|\+[bt]?)$/u.test(value)) return 'unknown'
  return value.startsWith('w') || value.startsWith('x') ? 'replace' : 'update'
}

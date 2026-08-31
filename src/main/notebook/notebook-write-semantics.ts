// File writers can preserve existing bytes without an explicit reader in the source.
// Keep option semantics shared by Python/R analysis and local-wrapper inference.
type WriteOption = {
  keyword: 'mode' | 'append' | 'file_mode'
  position?: number
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
  r: new Map([
    ['write.table', { keyword: 'append', position: 2, defaultValue: false }],
    ['fwrite', { keyword: 'append', defaultValue: false }],
    ['write_csv', { keyword: 'append', defaultValue: false }],
    ['write_tsv', { keyword: 'append', defaultValue: false }],
    ['write_delim', { keyword: 'append', defaultValue: false }]
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

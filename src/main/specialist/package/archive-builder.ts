import { zipSync, type Zippable } from 'fflate'
export const buildDeterministicSpecialistZip = (
  files: Readonly<Record<string, Uint8Array>>
): Uint8Array => {
  const zipOptions = { mtime: new Date(1980, 0, 1) }
  const entries: Zippable = {}
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    entries[path] = [bytes, zipOptions]
  }
  return zipSync(entries, { level: 6 })
}

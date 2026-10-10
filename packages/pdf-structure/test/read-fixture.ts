import { readFileSync } from 'node:fs'

// Each JSONL record is [path, value]. Containers precede their children; array
// items (tokens, source lines, cells and grid rows) remain one compact record each.
// Read afresh so tests that mutate a fixture cannot affect subsequent cases.
export const readPdfFixture = (path: string): ReturnType<typeof JSON.parse> => {
  const records = readFileSync(path, 'utf8').trim().split(/\r?\n/)
  const [rootPath, root] = JSON.parse(records[0])
  if (!Array.isArray(rootPath) || rootPath.length !== 0) {
    throw new Error(`Missing fixture root: ${path}`)
  }
  for (const record of records.slice(1)) {
    const [keys, value]: [(string | number)[], unknown] = JSON.parse(record)
    const parent = keys
      .slice(0, -1)
      .reduce<ReturnType<typeof JSON.parse>>((node, key) => node[key], root)
    parent[keys.at(-1)!] = value
  }
  return root
}

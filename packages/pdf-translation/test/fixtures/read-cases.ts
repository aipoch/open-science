import { readFileSync } from 'node:fs'
export function readPdfTranslationCases<T>(filename: string): T[] {
  return readFileSync(new URL(filename, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

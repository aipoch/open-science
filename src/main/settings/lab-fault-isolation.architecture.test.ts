import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Fault isolation is the core safety property of the optional Lab provider: a broken Lab connection
// may only surface inside its own settings panel and its own provider. These checks keep a future
// change from reintroducing a blocking dialog, a second HTTP client, or a renderer-side credential.

const SETTINGS_DIR = join(process.cwd(), 'src/main/settings')
const RENDERER_DIR = join(process.cwd(), 'src/renderer/src')

const labSources = (): Array<{ file: string; source: string }> =>
  readdirSync(SETTINGS_DIR)
    .filter((file) => file.startsWith('lab-') && file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(SETTINGS_DIR, file), 'utf8') }))

const rendererSources = (): string[] => {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.(ts|tsx)$/u.test(entry.name)) files.push(readFileSync(path, 'utf8'))
    }
  }
  visit(RENDERER_DIR)
  return files
}

describe('Lab provider fault isolation', () => {
  it('never opens a blocking dialog or a browser prompt from the Lab owner modules', () => {
    for (const { file, source } of labSources()) {
      expect(source, file).not.toMatch(/\bshowMessageBox\b|\bshowErrorBox\b|\bdialog\.show/u)
      expect(source, file).not.toMatch(/\bwindow\.alert\b|(^|[^.\w])alert\(/u)
    }
  })

  it('keeps every Lab HTTP request inside lab-api.ts', () => {
    for (const { file, source } of labSources()) {
      if (file === 'lab-api.ts') continue
      expect(source, file).not.toMatch(
        /\bfetchProviderRequest\b|\bnetFetchStandard\b|(^|[^.\w])fetch\(/u
      )
    }
  })

  it('never imports the Lab owner modules from the renderer', () => {
    const sources = rendererSources()
    for (const source of sources) {
      expect(source).not.toMatch(/from ['"][^'"]*settings\/lab-/u)
      expect(source).not.toMatch(/from ['"][^'"]*main\/settings\/lab-/u)
    }
  })

  it('keeps the Lab OAuth callback on an explicit 127.0.0.1 port', () => {
    const oauth = labSources().find(({ file }) => file === 'lab-oauth.ts')
    expect(oauth?.source).toContain("server.listen(0, '127.0.0.1'")
    expect(oauth?.source).toContain('http://127.0.0.1:${address.port}')
    expect(oauth?.source).not.toContain("server.listen(0, '0.0.0.0'")
  })
})

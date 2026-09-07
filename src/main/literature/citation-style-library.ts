import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SaxesParser } from 'saxes'
import { createEngine } from 'citeme-engine-wasm'

import {
  LITERATURE_CITATION_STYLES,
  LITERATURE_CSL_MAX_BYTES,
  type LiteratureCitationStyleView
} from '../../shared/literature'

const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))
const CSL_NAMESPACE = 'http://purl.org/net/xbiblio/csl'
const CUSTOM_STYLE_ID = /^custom:([a-f0-9]{64})$/u
const require = createRequire(import.meta.url)

type CitationStyleSource = LiteratureCitationStyleView & Readonly<{ content: string }>

const citationResourceDirectory = (): string => {
  const resourcesPath = process.resourcesPath
  const candidates = [
    join(here, '../../../resources/citation'),
    join(here, '../../resources/citation'),
    join(process.cwd(), 'resources/citation'),
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'resources', 'citation') : undefined,
    resourcesPath ? join(resourcesPath, 'resources', 'citation') : undefined
  ]
  const found = candidates.find((candidate) => candidate && existsSync(join(candidate, 'apa.csl')))
  if (!found) throw new Error('Citation resources are unavailable.')
  return found
}

const normalizeXmlText = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const parseCitationStyle = (
  content: string,
  id: string,
  source: LiteratureCitationStyleView['source']
): CitationStyleSource => {
  if (Buffer.byteLength(content, 'utf8') > LITERATURE_CSL_MAX_BYTES) {
    throw new Error('The CSL file must be 1 MB or smaller.')
  }

  let depth = 0
  let infoDepth = -1
  let rootSeen = false
  let dependent = false
  let capture: 'id' | 'rights' | 'summary' | 'title' | undefined
  const captured = { id: '', rights: '', summary: '', title: '' }
  const parser = new SaxesParser({ xmlns: true })

  parser.on('error', () => {
    throw new Error('The selected file is not valid CSL XML.')
  })
  parser.on('doctype', () => {
    throw new Error('CSL files with a document type declaration are not supported.')
  })
  parser.on('opentag', (tag) => {
    depth += 1
    if (depth === 1) {
      const version = Object.values(tag.attributes).find(
        (attribute) => attribute.local === 'version' && attribute.prefix === ''
      )?.value
      if (
        tag.local !== 'style' ||
        tag.uri !== CSL_NAMESPACE ||
        !/^1\.0(?:\.\d+)?$/u.test(version ?? '')
      ) {
        throw new Error('The selected file must be an independent CSL 1.0 style.')
      }
      rootSeen = true
      return
    }
    if (tag.local === 'info' && depth === 2) {
      infoDepth = depth
      return
    }
    if (infoDepth < 0 || depth !== infoDepth + 1) return
    if (tag.local === 'link') {
      const relation = Object.values(tag.attributes).find(
        (attribute) => attribute.local === 'rel' && attribute.prefix === ''
      )?.value
      if (relation === 'independent-parent') dependent = true
      return
    }
    if (
      tag.local === 'title' ||
      tag.local === 'id' ||
      tag.local === 'summary' ||
      tag.local === 'rights'
    ) {
      capture = tag.local
    }
  })
  parser.on('text', (text) => {
    if (capture) captured[capture] += text
  })
  parser.on('closetag', () => {
    if (capture && depth === infoDepth + 1) capture = undefined
    if (depth === infoDepth) infoDepth = -1
    depth -= 1
  })

  try {
    parser.write(content).close()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The selected file')) throw error
    if (error instanceof Error && error.message.startsWith('CSL files')) throw error
    throw new Error('The selected file is not valid CSL XML.')
  }

  const title = normalizeXmlText(captured.title)
  const canonicalId = normalizeXmlText(captured.id)
  if (!rootSeen || !title || !canonicalId) {
    throw new Error('The CSL style must include a title and an id.')
  }
  if (dependent) {
    throw new Error('Dependent CSL styles are not supported yet. Import an independent style.')
  }

  return {
    id,
    title,
    source,
    ...(normalizeXmlText(captured.summary) ? { summary: normalizeXmlText(captured.summary) } : {}),
    ...(normalizeXmlText(captured.rights) ? { rights: normalizeXmlText(captured.rights) } : {}),
    content
  }
}

class LiteratureCitationStyleLibrary {
  private builtInSourcesPromise: Promise<CitationStyleSource[]> | undefined

  constructor(private readonly customDirectory: string) {}

  private customPath(styleId: string): string {
    const digest = CUSTOM_STYLE_ID.exec(styleId)?.[1]
    if (!digest) throw new Error('Only imported CSL styles can be deleted.')
    return join(this.customDirectory, `${digest}.csl`)
  }

  private async builtInSources(): Promise<CitationStyleSource[]> {
    const directory = citationResourceDirectory()
    this.builtInSourcesPromise ??= Promise.all(
      LITERATURE_CITATION_STYLES.map(async (styleId) =>
        parseCitationStyle(
          await readFile(join(directory, `${styleId}.csl`), 'utf8'),
          styleId,
          'built-in'
        )
      )
    ).catch((error) => {
      this.builtInSourcesPromise = undefined
      throw error
    })
    return this.builtInSourcesPromise
  }

  private async customSources(): Promise<CitationStyleSource[]> {
    const entries = await readdir(this.customDirectory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    const styles = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.csl$/u.test(entry.name))
        .map(async (entry) => {
          const digest = entry.name.slice(0, -4)
          try {
            return parseCitationStyle(
              await readFile(join(this.customDirectory, entry.name), 'utf8'),
              `custom:${digest}`,
              'custom'
            )
          } catch {
            return undefined
          }
        })
    )
    return styles.filter((style): style is CitationStyleSource => style !== undefined)
  }

  async sources(): Promise<CitationStyleSource[]> {
    const [builtIn, custom] = await Promise.all([this.builtInSources(), this.customSources()])
    return [...builtIn, ...custom.sort((a, b) => a.title.localeCompare(b.title))]
  }

  async list(): Promise<LiteratureCitationStyleView[]> {
    return (await this.sources()).map(({ id, rights, source, summary, title }) => ({
      id,
      rights,
      source,
      summary,
      title
    }))
  }

  async import(content: string): Promise<string> {
    const digest = createHash('sha256').update(content).digest('hex')
    const styleId = `custom:${digest}`
    parseCitationStyle(content, styleId, 'custom')
    const engine = await createEngine(
      await readFile(require.resolve('citeme-engine-wasm/pkg/citeme_engine_wasm_bg.wasm'))
    )
    try {
      engine.loadStyle(styleId, content)
    } catch {
      throw new Error('The selected file is not valid CSL XML.')
    } finally {
      engine.free()
    }
    await mkdir(this.customDirectory, { recursive: true })
    await writeFile(this.customPath(styleId), content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    return styleId
  }

  async delete(styleId: string): Promise<void> {
    await unlink(this.customPath(styleId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export { LiteratureCitationStyleLibrary, citationResourceDirectory, parseCitationStyle }
export type { CitationStyleSource }

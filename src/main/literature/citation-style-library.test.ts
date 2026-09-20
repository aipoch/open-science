import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

import { LiteratureCitationFormatter } from './citation-formatter'

import { LiteratureCitationStyleLibrary } from './citation-style-library'

const roots: string[] = []

const independentStyle = (title = 'A compact journal style'): string => `<?xml version="1.0"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info>
    <title>${title}</title>
    <id>https://example.test/styles/compact</id>
    <summary>A test style.</summary>
    <rights>CC BY-SA 3.0</rights>
  </info>
  <citation><layout><text variable="title"/></layout></citation>
  <bibliography><layout><text variable="title"/></layout></bibliography>
</style>`

const createLibrary = async (): Promise<{
  library: LiteratureCitationStyleLibrary
  stylesDirectory: string
}> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-csl-'))
  roots.push(root)
  const stylesDirectory = join(root, 'styles')
  return { library: new LiteratureCitationStyleLibrary(stylesDirectory), stylesDirectory }
}

afterEach(async () => {
  vi.mocked(readFile).mockClear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LiteratureCitationStyleLibrary', () => {
  it('reuses built-in CSL reads across concurrent lists while refreshing imported styles', async () => {
    const { library } = await createLibrary()
    const [first, concurrent] = await Promise.all([library.list(), library.list()])
    const builtInCount = first.filter(({ source }) => source === 'built-in').length
    expect(concurrent).toEqual(first)
    expect(readFile).toHaveBeenCalledTimes(builtInCount)
    await library.list()
    expect(readFile).toHaveBeenCalledTimes(builtInCount)
    const styleId = await library.import(independentStyle())
    expect((await library.list()).some(({ id }) => id === styleId)).toBe(true)
    await library.delete(styleId)
    expect((await library.list()).some(({ id }) => id === styleId)).toBe(false)
  })

  it('retries a failed built-in read instead of caching the failure', async () => {
    const { library } = await createLibrary()
    vi.mocked(readFile).mockRejectedValueOnce(new Error('temporary read failure'))
    await expect(library.list()).rejects.toThrow('temporary read failure')
    expect((await library.list()).some(({ id }) => id === 'apa')).toBe(true)
  })

  it('imports, deduplicates, lists, and deletes independent CSL styles', async () => {
    const { library, stylesDirectory } = await createLibrary()
    const content = independentStyle()

    const firstId = await library.import(content)
    const secondId = await library.import(content)

    expect(secondId).toBe(firstId)
    expect(await library.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstId,
          title: 'A compact journal style',
          source: 'custom',
          summary: 'A test style.',
          rights: 'CC BY-SA 3.0'
        })
      ])
    )
    expect(await readFile(join(stylesDirectory, `${firstId.slice(7)}.csl`), 'utf8')).toBe(content)

    await library.delete(firstId)

    expect((await library.list()).some(({ id }) => id === firstId)).toBe(false)
  })

  it('rejects dependent styles and XML with a document type declaration', async () => {
    const { library } = await createLibrary()
    const dependent = independentStyle().replace(
      '</info>',
      '<link rel="independent-parent" href="https://example.test/styles/parent"/></info>'
    )

    await expect(library.import(dependent)).rejects.toThrow('Dependent CSL styles')
    await expect(
      library.import(
        `<!DOCTYPE style [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${independentStyle()}`
      )
    ).rejects.toThrow('document type declaration')
  })

  it('rejects malformed CSL before persisting it', async () => {
    const { library } = await createLibrary()
    const malformed = independentStyle().replace(
      '<text variable="title"/>',
      '<text variable="not-a-csl-variable"/>'
    )

    await expect(library.import(malformed)).rejects.toThrow('not valid CSL XML')

    expect((await library.list()).filter(({ source }) => source === 'custom')).toEqual([])
  })
})

const macroStyle = (): string =>
  independentStyle()
    .replace(
      '</info>',
      '</info><macro name="journal-format"><text value="REQUIRED JOURNAL FORMAT"/></macro>'
    )
    .replaceAll('<text variable="title"/>', '<text macro="journal-format"/>')

it('CS-01 rejects undefined macro references instead of accepting generic fallback output', async () => {
  const { library } = await createLibrary()
  const valid = macroStyle()
  const styleId = await library.import(valid)
  expect(await new LiteratureCitationFormatter(library).formatStyleExample(styleId)).toEqual({
    inText: 'REQUIRED JOURNAL FORMAT',
    reference: 'REQUIRED JOURNAL FORMAT'
  })
  await expect(
    library.import(valid.replace('name="journal-format"', 'name="renamed-format"'))
  ).rejects.toThrow(/undefined macro/i)
  expect((await library.list()).filter(({ source }) => source === 'custom')).toHaveLength(1)
})

it('CS-01 rejects a citation-only style with an application-support explanation', async () => {
  const { library } = await createLibrary()
  const content = independentStyle().replace(/<bibliography>.*?<\/bibliography>/u, '')
  await expect(library.import(content)).rejects.toThrow(/bibliography/i)
  expect((await library.list()).filter(({ source }) => source === 'custom')).toEqual([])
})

it.each([
  ['truncated XML', '<style>truncated'],
  [
    'valid replacement',
    independentStyle('Changed style').replaceAll(
      '<text variable="title"/>',
      '<text value="CHANGED OUTPUT"/>'
    )
  ]
])('CS-02 restores the original bytes by reimporting over %s', async (_kind, damaged) => {
  const { library, stylesDirectory } = await createLibrary()
  const original = macroStyle()
  const styleId = await library.import(original)
  const path = join(stylesDirectory, `${styleId.slice(7)}.csl`)
  await writeFile(path, damaged)
  expect(await library.import(original)).toBe(styleId)
  expect(await readFile(path, 'utf8')).toBe(original)
  expect((await library.list()).find(({ id }) => id === styleId)?.title).toBe(
    'A compact journal style'
  )
  expect(await new LiteratureCitationFormatter(library).formatStyleExample(styleId)).toEqual({
    inText: 'REQUIRED JOURNAL FORMAT',
    reference: 'REQUIRED JOURNAL FORMAT'
  })
})

it('CS-02 excludes valid replacement content under the original digest from listing and formatting', async () => {
  const { library, stylesDirectory } = await createLibrary()
  const styleId = await library.import(macroStyle())
  await writeFile(
    join(stylesDirectory, `${styleId.slice(7)}.csl`),
    independentStyle('Changed style')
  )
  expect((await library.list()).some(({ id }) => id === styleId)).toBe(false)
  await expect(
    new LiteratureCitationFormatter(library).formatStyleExample(styleId)
  ).rejects.toThrow()
})

it('CS-05 imports CDATA metadata just like ordinary XML text', async () => {
  const { library } = await createLibrary()
  const styleId = await library.import(independentStyle('<![CDATA[A compact journal style]]>'))
  expect((await library.list()).find(({ id }) => id === styleId)?.title).toBe(
    'A compact journal style'
  )
  expect(await new LiteratureCitationFormatter(library).formatStyleExample(styleId)).toMatchObject({
    reference: 'Genome Editing in Human Cells'
  })
})

it('CS-02 checks and restores stored bytes even when UTF-8 decoding masks corruption', async () => {
  const { library, stylesDirectory } = await createLibrary()
  const content = independentStyle('A \uFFFD journal style')
  const styleId = await library.import(content)
  const path = join(stylesDirectory, `${styleId.slice(7)}.csl`)
  const original = Buffer.from(content, 'utf8')
  const offset = original.indexOf(Buffer.from('\uFFFD'))
  const damaged = Buffer.concat([
    original.subarray(0, offset),
    Buffer.from([0xff]),
    original.subarray(offset + 3)
  ])
  expect(damaged.toString('utf8')).toBe(content)
  await writeFile(path, damaged)
  expect.soft((await library.list()).some(({ id }) => id === styleId)).toBe(false)
  expect(await library.import(content)).toBe(styleId)
  expect(await readFile(path)).toEqual(original)
})

it.each([
  ['csl-file-too-large', 'x'.repeat(1024 * 1024 + 1)],
  ['csl-invalid-xml', '<'],
  [
    'csl-unsupported-doctype',
    '<!DOCTYPE style>' + independentStyle().replace('<?xml version="1.0"?>', '')
  ],
  ['csl-unsupported-style', '<style/>'],
  ['csl-missing-metadata', independentStyle().replace(/<title>.*?<\/title>/u, '')],
  [
    'csl-dependent-style',
    independentStyle().replace(
      '<info>',
      '<info><link rel="independent-parent" href="https://example.test/parent"/>'
    )
  ],
  [
    'csl-undefined-macro',
    independentStyle().replace('<text variable="title"/>', '<text macro="author-原名"/>')
  ],
  ['csl-missing-sections', independentStyle().replace(/<bibliography>.*?<\/bibliography>/u, '')]
])('rejects imports with the stable code %s before writing files', async (code, content) => {
  const { library, stylesDirectory } = await createLibrary()
  await expect(library.import(content)).rejects.toMatchObject({
    code,
    ...(code === 'csl-undefined-macro' ? { parameters: { macro: 'author-原名' } } : {})
  })
  await expect(readdir(stylesDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
})

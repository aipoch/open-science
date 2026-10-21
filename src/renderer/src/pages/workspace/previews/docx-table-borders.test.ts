// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { parseAsync, renderAsync, renderDocument } from 'docx-preview'
import {
  createDocxTableFixture,
  docxTableCases,
  readTableBorderColors
} from '../../../../../../test/fixtures/docx-table-borders'

afterEach(() => document.body.replaceChildren())

describe('DOCX dependency patch regression', () => {
  it.each(docxTableCases)('$name', async (scenario) => {
    const container = document.createElement('div')
    document.body.append(container)
    await renderAsync(createDocxTableFixture(scenario), container, container, {
      className: `table-${scenario.name.replaceAll(' ', '-')}`
    })
    expect(readTableBorderColors(container)).toEqual(scenario.expected)
  })

  it('keeps borders when rendering a parsed model more than once', async () => {
    const scenario = docxTableCases.find((item) => item.name === 'child first')!
    const model = await parseAsync(createDocxTableFixture(scenario))
    for (let attempt = 0; attempt < 2; attempt++) {
      const container = document.createElement('div')
      container.append(...(await renderDocument(model, { className: `repeat-${attempt}` })))
      document.body.replaceChildren(container)
      expect(readTableBorderColors(container)).toEqual(scenario.expected)
    }
  })

  it.each(['child first', 'distinct edges'])('patches the CommonJS export: %s', async (name) => {
    const commonjs = createRequire(import.meta.url)('docx-preview') as typeof import('docx-preview')
    const scenario = docxTableCases.find((item) => item.name === name)!
    const container = document.createElement('div')
    document.body.append(container)
    await commonjs.renderAsync(createDocxTableFixture(scenario), container, container, {
      className: `commonjs-${name.replaceAll(' ', '-')}`
    })
    expect(readTableBorderColors(container)).toEqual(scenario.expected)
  })

  it.each(['missing', 'cycle'])('terminates with a %s base style', async (kind) => {
    const scenario = {
      ...docxTableCases[0],
      styles: `<w:style w:type="table" w:styleId="A"><w:basedOn w:val="${kind === 'cycle' ? 'A' : 'Missing'}"/></w:style>`
    }
    const container = document.createElement('div')
    document.body.append(container)
    await renderAsync(createDocxTableFixture(scenario), container)
    expect(readTableBorderColors(container)).toEqual(scenario.expected)
  })
})

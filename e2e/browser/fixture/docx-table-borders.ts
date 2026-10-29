import '@/assets/main.css'
import '@/office-preview/office-preview.css'
import { initI18n } from '@/i18n'
import { renderOfficeFile } from '@/pages/workspace/previews/office-renderers'
import {
  createDocxTableFixture,
  docxTableCases,
  readTableBorderColors
} from '../../../test/fixtures/docx-table-borders'

import reportFontUrl from '../../../packages/pdf-translation/resources/NotoSansSC-Regular.otf?url'
import reportUrl from '../../../test/fixtures/docx-report.docx?url'
import { createDocxStyleFixture } from '../../../test/fixtures/docx-table-styles'

const container = document.getElementById('office-preview-root') as HTMLDivElement
const scenario = docxTableCases.find(
  (item) => item.name === new URLSearchParams(location.search).get('case')
)!

// Exercise the production preview, including fit/zoom controls and application CSS.
void (async () => {
  await initI18n('en')
  if (new URLSearchParams(location.search).has('report')) {
    // Pin the report's requested font families, including CJK fallback, across runner images.
    for (const family of ['Arial', 'PingFang SC']) {
      document.fonts.add(await new FontFace(family, `url(${reportFontUrl})`).load())
    }
  }
  const dispose = await renderOfficeFile({
    bytes: new URLSearchParams(location.search).has('report')
      ? new Uint8Array(await (await fetch(reportUrl)).arrayBuffer())
      : new URLSearchParams(location.search).has('styles')
        ? createDocxStyleFixture({ defaultStyle: true, banding: true, nested: true, direct: true })
        : createDocxTableFixture(scenario),
    extension: 'docx',
    name: 'table.docx',
    container,
    signal: new AbortController().signal
  })
  Object.assign(window, { readTableBorders: () => readTableBorderColors(container) })
  container.dataset.officePreviewReady = 'true'
  window.addEventListener('pagehide', () => void dispose(), { once: true })
})()

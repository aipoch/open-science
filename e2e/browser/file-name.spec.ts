import { expect, test } from '@playwright/test'

test('narrow Chinese names retain their identity in ordinary and compact surfaces', async ({
  page
}) => {
  await page.goto('/file-name.html')
  for (const mode of ['normal', 'compact']) {
    const label = page.locator(`[data-layout="${mode}"]`)
    await expect(label.getByTestId('file-name-ellipsis')).toBeVisible()
    await expect(label.getByTestId('file-name-head')).toContainText('示例文')
    const prefixIsVisible = await label.getByTestId('file-name-head').evaluate((head) => {
      const range = document.createRange()
      range.setStart(head.firstChild!, 0)
      range.setEnd(head.firstChild!, 3)
      return range.getBoundingClientRect().width <= head.getBoundingClientRect().width
    })
    expect(prefixIsVisible).toBe(true)
    await expect(label.getByTestId('file-name-extension')).toHaveText('.md')
  }
})

const names = [
  'example_document_sample_records_summary_final_2025.md',
  'beispiel_dokument_testdaten_zusammenfassung_endfassung_2025.md',
  'exemple_document_données_de_test_résumé_final_2025.md',
  'ejemplo_documento_datos_de_prueba_resumen_final_2025.md',
  '範例文件_測試記錄_階段彙總_最終版本.md',
  'サンプル文書_テスト記録_集計結果_最終版.md',
  '예제_문서_테스트_기록_요약_최종본.md',
  'пример_документа_тестовые_записи_итоговая_версия_2025.md',
  'مثال_مستند_سجلات_اختبار_ملخص_نهائي_٢٠٢٥.md',
  'דוגמה_מסמך_רשומות_בדיקה_סיכום_סופי_2025.md',
  'experiment_results_👨‍👩‍👧‍👦_🇨🇳_e\u0301.md',
  'long_filename_without_any_extension_2025',
  'sample.unusuallylongcustomextension'
]

for (const name of names) {
  test(`fits and restores ${name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/file-name.html?${new URLSearchParams({ name })}`)
    for (const mode of ['normal', 'compact']) {
      const host = page.locator(`[data-layout="${mode}"]`)
      const label = host.getByTestId('file-name-root')
      await expect(label).toHaveAttribute('aria-label', name)
      await expect(host.getByTestId('file-name-ellipsis')).toBeVisible()
      const head = host.getByTestId('file-name-head')
      await expect(head).not.toBeEmpty()
      const chunks = await label
        .locator('bdi, [data-testid="file-name-ellipsis"], [data-testid="file-name-extension"]')
        .evaluateAll((elements) =>
          elements.map((el) => {
            const bounds = el.getBoundingClientRect()
            const parent = el.parentElement!.getBoundingClientRect()
            return {
              left: bounds.left >= parent.left - 0.5,
              right: bounds.right <= parent.right + 0.5
            }
          })
        )
      expect(chunks.every(({ left, right }) => left && right)).toBe(true)
      // The same component must recover the entire original name, without sticky abbreviation.
      await host.evaluate((el) => {
        el.style.width = '1000px'
      })
      await expect(host.getByTestId('file-name-ellipsis')).toHaveCount(0)
      await expect(label).toHaveText(name)
      await host.evaluate((el) => {
        el.style.width = '96px'
      })
      await expect(host.getByTestId('file-name-ellipsis')).toBeVisible()
    }
    expect(errors).toEqual([])
  })
}

test('keeps short basenames and their longer extensions complete when the full name fits', async ({
  page
}) => {
  await page.goto('/file-name.html?name=a.json')
  for (const mode of ['normal', 'compact']) {
    const host = page.locator(`[data-layout="${mode}"]`)
    await expect(host.getByTestId('file-name-ellipsis')).toHaveCount(0)
    const extension = host.getByTestId('file-name-extension')
    await expect
      .poll(() => extension.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      .toBe(true)
  }
})

for (const [name, ending] of [
  ['示例文档_测试记录_阶段汇总_最终版本.md', '最终版本'],
  ['example_document_sample_records_summary_final_2025.md', '2025']
]) {
  test(`preserves a recognizable ending at preview-tab width: ${name}`, async ({ page }) => {
    await page.goto(`/file-name.html?${new URLSearchParams({ name, width: '160' })}`)
    for (const mode of ['normal', 'compact']) {
      const host = page.locator(`[data-layout="${mode}"]`)
      await expect(host.getByTestId('file-name-head')).toContainText(name.slice(0, 3))
      await expect(host.getByTestId('file-name-tail')).toContainText(ending)
      await expect(host.getByTestId('file-name-ellipsis')).toBeVisible()
      for (const part of ['head', 'tail']) {
        await expect
          .poll(() =>
            host
              .getByTestId(`file-name-${part}`)
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
          )
          .toBe(true)
      }
    }
  })
}

test('uses the beginning when complete fragments cannot fit in a very narrow label', async ({
  page
}) => {
  await page.goto('/file-name.html?width=64')
  for (const mode of ['normal', 'compact']) {
    const host = page.locator(`[data-layout="${mode}"]`)
    await expect(host.getByTestId('file-name-head')).toContainText('示例')
    await expect(host.getByTestId('file-name-tail')).toHaveCount(0)
    await expect(host.getByTestId('file-name-extension')).toHaveText('.md')
    await expect(host.getByTestId('file-name-ellipsis')).toBeVisible()
  }
})

for (const name of [
  'report_analysis_results.csv',
  'report-analysis-results.csv',
  'report analysis results.csv',
  'résumé_überblick_final.csv'
]) {
  test(`keeps complete words in a compact tab: ${name}`, async ({ page }) => {
    await page.goto(`/file-name.html?${new URLSearchParams({ name, width: '116' })}`)
    for (const mode of ['normal', 'compact']) {
      const host = page.locator(`[data-layout="${mode}"]`)
      await expect(host.getByTestId('file-name-head')).toHaveText(
        name.startsWith('résumé') ? 'résumé' : 'report'
      )
      await expect(host.getByTestId('file-name-tail')).toHaveText(
        name.startsWith('résumé') ? 'final' : 'results'
      )
    }
  })
}

test('falls back to a grapheme prefix only when a single word cannot fit', async ({ page }) => {
  const name = 'Supercalifragilisticexpialidocious.csv'
  await page.goto(`/file-name.html?${new URLSearchParams({ name, width: '96' })}`)
  for (const mode of ['normal', 'compact']) {
    const host = page.locator(`[data-layout="${mode}"]`)
    await expect(host.getByTestId('file-name-head')).toContainText('Super')
    await expect(host.getByTestId('file-name-tail')).toHaveCount(0)
    await expect(host.getByTestId('file-name-ellipsis')).toBeVisible()
  }
})

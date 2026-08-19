// @vitest-environment jsdom
// Covers what a plain string swap gets wrong in this view: the candidate count and the skipped note
// are plurals (en has _one/_other, zh only _other), the "Import selected (n)" count rides a named
// placeholder rather than i18next's reserved `count` (which would look up a plural key that does not
// exist), and the per-file error frames interpolate a file name that must never be translated.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { SkillUploadView } from './SkillUploadView'

let container: HTMLDivElement
let root: Root

// The bundle path chains a FileReader (resolves on a task, not a microtask), then the mocked
// previewSkillZip promise, then React's commit — so a single timer yield lands mid-chain and leaves
// the view still showing "Reading…". Drain a few passes instead of guessing one.
const flush = async (): Promise<void> => {
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

const md = (name: string): File =>
  new File([`---\nname: ${name}\ndescription: ${name} description\n---\n\nbody`], `${name}.md`, {
    type: 'text/markdown'
  })

// Drives the real file input, which is the only way into the parse → checklist path.
const upload = async (files: File[]): Promise<void> => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

const setup = (previewSkillZip?: unknown): void => {
  useSettingsStore.setState({
    skills: [],
    createSkill: vi.fn().mockResolvedValue(undefined),
    importSkillZipBatch: vi.fn().mockResolvedValue({ results: [] }),
    previewSkillZip: previewSkillZip ?? vi.fn().mockResolvedValue({ previews: [], skipped: [] })
  } as never)
}

const render = (): void => {
  act(() => {
    root.render(<SkillUploadView onUploaded={vi.fn()} onWriteInstead={vi.fn()} />)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('SkillUploadView copy', () => {
  it('translates the landing page prompt', () => {
    setup()
    render()
    expect(container.textContent).toContain('Upload skills')
    expect(container.textContent).toContain('Drag and drop or click to upload')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('上传技能')
    expect(container.textContent).toContain('拖放文件或点击上传')
    expect(container.textContent).not.toContain('Upload skills')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('上傳技能')
    expect(container.textContent).toContain('拖放檔案或點按上傳')
  })

  it('selects the plural form for the candidate count in each language', async () => {
    setup()
    render()
    await upload([md('alpha')])
    // en has a dedicated _one form.
    expect(container.textContent).toContain('Found 1 skill')
    expect(container.textContent).not.toContain('Found 1 skills')

    // zh has no singular/plural distinction — one _other form covers both counts.
    switchTo('zh-Hant')
    expect(container.textContent).toContain('找到 1 個技能')
    switchTo('zh-Hans')
    expect(container.textContent).toContain('找到 1 个技能')
  })

  it('uses the plural form for counts above one', async () => {
    setup()
    render()
    await upload([md('alpha'), md('beta')])
    expect(container.textContent).toContain('Found 2 skills')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('找到 2 个技能')
  })

  it('keeps the selected count inside the translated import button', async () => {
    setup()
    render()
    await upload([md('alpha'), md('beta')])
    const selectAll = container.querySelector(
      'input[type="checkbox"][aria-label="Select all"]'
    ) as HTMLInputElement
    await act(async () => {
      selectAll.click()
    })
    expect(container.textContent).toContain('Import selected (2)')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('导入所选（2）')
    // The placeholder is named `selected`, so a stray `{{count}}` would surface here.
    expect(container.textContent).not.toContain('{{')
  })

  it('translates the per-file error frame but never the file name', async () => {
    setup()
    render()
    await upload([new File(['x'], 'notes.txt', { type: 'text/plain' })])
    expect(container.textContent).toContain(
      'notes.txt: unsupported file — upload a .md file or a .zip / .skill bundle.'
    )

    switchTo('zh-Hant')
    expect(container.textContent).toContain(
      'notes.txt：不支援的檔案，請上傳 .md 檔案或 .zip / .skill 壓縮檔。'
    )
    expect(container.textContent).not.toContain('unsupported file')
  })

  it('pluralizes the skipped note and keeps backend reasons verbatim', async () => {
    setup(
      vi.fn().mockResolvedValue({
        previews: [],
        skipped: [{ source: 'pack/one', reason: 'no SKILL.md' }]
      })
    )
    render()
    await upload([new File(['zip'], 'pack.zip', { type: 'application/zip' })])
    expect(container.textContent).toContain('Skipped 1 skill')
    expect(container.textContent).not.toContain('Skipped 1 skills')
    // The reason comes from the main process and passes through untranslated.
    expect(container.textContent).toContain('pack/one — no SKILL.md')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('已跳过 1 个技能')
    expect(container.textContent).toContain('pack/one — no SKILL.md')
  })

  it('translates the import summary counts', async () => {
    setup()
    render()
    await upload([md('alpha')])
    const row = container.querySelector(
      'input[type="checkbox"][aria-label="Select alpha"]'
    ) as HTMLInputElement
    await act(async () => {
      row.click()
    })
    const button = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Import selected')
    ) as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()
    expect(container.textContent).toContain('Imported 1 · skipped 0 · failed 0')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('已匯入 1 個 · 略過 0 個 · 失敗 0 個')
  })
})

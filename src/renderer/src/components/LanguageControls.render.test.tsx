// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { useLocaleStore } from '@/stores/locale-store'
import { clickRadixMenuItem, openRadixMenu } from '@/pages/settings/test-utils'
import { LanguagePreferenceMenu, LanguageSelect } from './LanguageControls'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root

const render = (element: React.JSX.Element): void => {
  act(() => {
    root.render(element)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
  useLocaleStore.setState({ preference: 'system', locale: 'en' })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  localStorage.clear()
  useLocaleStore.setState({ preference: 'system', locale: 'en' })
  act(() => {
    void i18next.changeLanguage('en')
  })
})

describe('LanguageSelect', () => {
  it('lists System plus every locale, each written in its own language', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const options = Array.from(document.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent
    )

    // Language names are never translated — a reader stranded in the wrong language must still be
    // able to recognize their own.
    expect(options).toEqual([
      'System',
      'English',
      '简体中文',
      '繁體中文',
      '日本語',
      '한국어',
      'Français',
      'Русский',
      'Español'
    ])
  })

  it('switches the interface language and persists the choice', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const traditional = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('繁體中文')
    )
    clickRadixMenuItem(traditional as HTMLElement)

    expect(useLocaleStore.getState().preference).toBe('zh-Hant')
    expect(useLocaleStore.getState().locale).toBe('zh-Hant')
    expect(i18next.language).toBe('zh-Hant')
    expect(document.documentElement.lang).toBe('zh-Hant')
    expect(localStorage.getItem('open-science-language')).toBe('zh-Hant')
  })

  it('renders its own label in the newly selected language', () => {
    render(<LanguageSelect />)
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Interface language')

    act(() => {
      useLocaleStore.getState().setPreference('zh-Hans')
    })

    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('界面语言')
  })

  it('switches to Japanese copy from the language picker', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const japanese = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('日本語')
    )
    clickRadixMenuItem(japanese as HTMLElement)

    expect(useLocaleStore.getState().preference).toBe('ja')
    expect(useLocaleStore.getState().locale).toBe('ja')
    expect(i18next.language).toBe('ja')
    expect(document.documentElement.lang).toBe('ja')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('表示言語')
  })

  it('switches to Korean copy from the language picker', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const korean = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('한국어')
    )
    clickRadixMenuItem(korean as HTMLElement)

    expect(useLocaleStore.getState().preference).toBe('ko')
    expect(useLocaleStore.getState().locale).toBe('ko')
    expect(i18next.language).toBe('ko')
    expect(document.documentElement.lang).toBe('ko')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('인터페이스 언어')
  })

  it('switches to Russian copy from the language picker', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const russian = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('Русский')
    )
    clickRadixMenuItem(russian as HTMLElement)

    expect(useLocaleStore.getState().preference).toBe('ru')
    expect(useLocaleStore.getState().locale).toBe('ru')
    expect(i18next.language).toBe('ru')
    expect(document.documentElement.lang).toBe('ru')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Язык интерфейса')
  })

  it('switches to French copy from the language picker', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const french = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('Français')
    )
    clickRadixMenuItem(french as HTMLElement)

    expect(useLocaleStore.getState().preference).toBe('fr')
    expect(useLocaleStore.getState().locale).toBe('fr')
    expect(i18next.language).toBe('fr')
    expect(document.documentElement.lang).toBe('fr')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      "Langue de l'interface"
    )
  })

  it('switches to Spanish copy from the language picker', () => {
    render(<LanguageSelect />)
    openRadixMenu(container.querySelector('button'))

    const spanish = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('Español')
    )
    clickRadixMenuItem(spanish as HTMLElement)

    expect(useLocaleStore.getState().preference).toBe('es')
    expect(useLocaleStore.getState().locale).toBe('es')
    expect(i18next.language).toBe('es')
    expect(document.documentElement.lang).toBe('es')
    expect(localStorage.getItem('open-science-language')).toBe('es')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Idioma de la interfaz'
    )
  })
})

describe('LanguagePreferenceMenu', () => {
  it('names the active choice in its trigger', () => {
    render(<LanguagePreferenceMenu />)
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Language: System')

    act(() => {
      useLocaleStore.getState().setPreference('zh-Hant')
    })

    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('語言: 繁體中文')
  })

  it('marks only the active choice', () => {
    act(() => {
      useLocaleStore.getState().setPreference('zh-Hans')
    })
    render(<LanguagePreferenceMenu />)
    openRadixMenu(container.querySelector('button'))

    const active = Array.from(document.querySelectorAll('[role="menuitem"]')).filter((item) =>
      item.querySelector('svg:last-child')
    )

    expect(active).toHaveLength(1)
    expect(active[0]?.textContent).toContain('简体中文')
  })
})

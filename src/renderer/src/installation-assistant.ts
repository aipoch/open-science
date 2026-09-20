import './assets/installation-assistant.css'

import darkAppIconUrl from './assets/logo-dark.png'
import lightAppIconUrl from './assets/logo.png'
import { initI18n, prepareI18nLocale } from './i18n'
import { applyHtmlLang, resolveInitialLocale } from './lib/locale-preference'

const requiredElement = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Installation assistant element is missing: ${selector}`)
  return element
}

const locale = resolveInitialLocale()
const reason = new URL(window.location.href).searchParams.get('reason')
const appIconUrl = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? darkAppIconUrl
  : lightAppIconUrl

const start = (): void => {
  const i18n = initI18n(locale)
  const t = i18n.t.bind(i18n)
  applyHtmlLang(locale)

  const title = requiredElement<HTMLHeadingElement>('#title')
  const description = requiredElement<HTMLParagraphElement>('#description')
  const status = requiredElement<HTMLParagraphElement>('#status')
  const motionStage = requiredElement<HTMLDivElement>('#motion-stage')
  const sourceIcon = requiredElement<HTMLDivElement>('#source-icon')
  const targetItem = requiredElement<HTMLDivElement>('#target-item')
  const applicationsLabel = requiredElement<HTMLSpanElement>('#applications-label')
  const continueButton = requiredElement<HTMLButtonElement>('#continue-button')
  const installButton = requiredElement<HTMLButtonElement>('#install-button')

  for (const image of document.querySelectorAll<HTMLImageElement>('.open-science-icon')) {
    image.src = appIconUrl
  }

  title.textContent =
    reason === 'update'
      ? t('Install Open-Science before updating')
      : t('Finish installing Open-Science')
  description.textContent = t(
    'Drag Open-Science to Applications. You can continue using this copy without installing.'
  )
  applicationsLabel.textContent = t('Applications')
  continueButton.textContent = t('Continue using')
  installButton.textContent = t('Install in Applications')
  sourceIcon.setAttribute('aria-label', t('Drag Open-Science to Applications'))
  targetItem.setAttribute('aria-label', t('Applications'))
  let primaryAction: 'install' | 'reveal' | 'restart' = 'install'

  const install = async (): Promise<void> => {
    if (installButton.disabled) return
    installButton.disabled = true
    installButton.textContent = t('Installing…')
    status.textContent = ''

    const result = await window.installationAssistant.install()
    if (result.status === 'installed') {
      motionStage.classList.add('is-installed')
      title.textContent = t('Open-Science is installed')
      description.textContent = t(
        'Quit this copy and reopen Open-Science from Applications to enable updates.'
      )
      status.textContent = t('Installed in Applications')
      installButton.disabled = false
      installButton.textContent = t('Restart')
      primaryAction = 'restart'
      return
    }

    status.textContent = t(
      'Open-Science could not be installed in Applications. Drag it there in Finder, or continue using this copy.'
    )
    status.dataset.tone = 'error'
    installButton.disabled = false
    installButton.textContent = t('Show in Finder')
    primaryAction = 'reveal'
  }

  continueButton.addEventListener('click', () => window.installationAssistant.continueUsing())
  installButton.addEventListener('click', () => {
    if (primaryAction === 'restart') {
      window.installationAssistant.restart()
      return
    }
    if (primaryAction === 'reveal') window.installationAssistant.showInFinder()
    else void install()
  })
  sourceIcon.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', 'Open-Science')
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
  })
  targetItem.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  targetItem.addEventListener('drop', (event) => {
    event.preventDefault()
    if (primaryAction === 'install') void install()
  })
}

const preparing = prepareI18nLocale(locale)
if (preparing) void preparing.then(start).catch(start)
else start()

import openScienceLogoSvg from '../remote-access/open-science-logo.svg?raw'

const BRAND_TITLE_PREFIX = 'Open-Science | '
const FALLBACK_TITLE = `${BRAND_TITLE_PREFIX}HTML Preview`

const faviconDataUrl = (logoSvg: string): string =>
  `data:image/svg+xml,${encodeURIComponent(logoSvg)}`

const brandingHead = (logoSvg: string): string =>
  `<link rel="icon" type="image/svg+xml" data-open-science-favicon="true" href="${faviconDataUrl(logoSvg)}">`

export const brandHtmlPreviewDocument = (
  html: string,
  options: { logoSvg?: string } = {}
): string => {
  if (!/(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b)/iu.test(html)) {
    return html
  }
  const logoSvg = options.logoSvg ?? openScienceLogoSvg
  const titlePattern = /(<title\b[^>]*>)([\s\S]*?)(<\/title>)/iu
  const hasBrandedFavicon = /data-open-science-favicon=["']true["']/iu.test(html)
  let branded = html.replace(titlePattern, (match, opening, title, closing) =>
    title.trimStart().startsWith(BRAND_TITLE_PREFIX)
      ? match
      : `${opening}${BRAND_TITLE_PREFIX}${title}${closing}`
  )
  const hasTitle = titlePattern.test(branded)
  const headContent = `${hasTitle ? '' : `<title>${FALLBACK_TITLE}</title>`}${hasBrandedFavicon ? '' : brandingHead(logoSvg)}`
  if (headContent.length === 0) return branded

  const headPattern = /<head\b[^>]*>/iu
  if (headPattern.test(branded)) {
    return branded.replace(headPattern, (match) => `${match}${headContent}`)
  }
  const htmlPattern = /<html\b[^>]*>/iu
  if (htmlPattern.test(branded)) {
    return branded.replace(htmlPattern, (match) => `${match}<head>${headContent}</head>`)
  }
  branded = `<head>${headContent}</head>${branded}`
  return branded
}

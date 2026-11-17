/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vendored standalone browser runtime. */
/* Official brand, project title and optional article or source-backed figures. */
;(() => {
  'use strict'

  const partsByNode = new WeakMap()
  const clamp = (value) => Math.max(0, Math.min(1, value))
  const progress = (time, start, end) => clamp((time - start) / Math.max(0.0001, end - start))
  const easeOut = (value) => 1 - Math.pow(1 - value, 3)
  const easeIn = (value) => value * value * value
  const easeOutBack = (value) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2)
  }
  const safeAsset = (value) =>
    typeof value === 'string' && !/^\s*(?:javascript|vbscript):/i.test(value) ? value : ''

  function titleLine(h, value) {
    const content = String(value)
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part) =>
        part.startsWith('**') && part.endsWith('**') ? h('em', {}, part.slice(2, -2)) : part
      )
    return h('span', { class: 'dv-opening-title-line' }, ...content)
  }

  function create({ K, paper = {}, title = '', results = [], showArticle = true }) {
    const { h } = K
    const figures = results.filter((result) => safeAsset(result.src)).slice(0, 6)
    const lines = String(title)
      .split('|')
      .map((line) => titleLine(h, line.trim()))
    let article = null
    if (showArticle) {
      const image = paper.screenshot
        ? h('img', {
            class: 'dv-opening-paper-image',
            src: safeAsset(paper.screenshot),
            alt: paper.title || 'Article title'
          })
        : h('div', { class: 'dv-opening-paper-title' }, paper.title || '')
      const citation = [paper.title, paper.doi].filter(Boolean).join(' · ')
      article = h(
        'section',
        { class: 'dv-opening-article' },
        h(
          'div',
          { class: 'dv-opening-paper-card' },
          image,
          citation ? h('div', { class: 'dv-opening-citation' }, citation) : null
        )
      )
    }
    const brand = h(
      'div',
      { class: 'dv-opening-brand' },
      h('img', {
        class: 'dv-opening-aipoch',
        src: 'brand/logos/aipoch-logo-primary.svg',
        alt: 'AIPOCH'
      }),
      h('i', { class: 'dv-opening-brand-separator', 'aria-hidden': 'true' }),
      h('img', {
        class: 'dv-opening-open-science',
        src: 'brand/logos/open-science-lockup-black.svg',
        alt: 'Open-Science'
      })
    )
    const heading = h('h1', { class: 'dv-opening-title' }, ...lines)
    const titlePanel = h('div', { class: 'dv-opening-title-stack' }, brand, heading)
    const rowWidth = figures.length * 280 + Math.max(0, figures.length - 1) * 24
    const rowScale = Math.min(1, 1192 / Math.max(1, rowWidth))
    const cards = figures.map((result) =>
      h(
        'div',
        {
          class: 'dv-opening-figure-card',
          'data-result-id': result.id || ''
        },
        h('img', {
          src: safeAsset(result.src),
          alt: result.caption || result.name || result.id || ''
        })
      )
    )
    const row = h(
      'div',
      {
        class: 'dv-opening-figure-row',
        style: {
          width: rowWidth + 'px',
          transform: 'scale(' + rowScale + ')'
        }
      },
      ...cards
    )
    const band = h('div', { class: 'dv-opening-figure-band' }, row)
    const showcase = h('section', { class: 'dv-opening-showcase' }, titlePanel, band)
    const node = h(
      'div',
      { class: 'dv-operation-opening', 'data-opening-phase': article ? 'article' : 'brand' },
      article,
      showcase
    )

    partsByNode.set(node, { article, brand, heading, lines, titlePanel, band, cards, showcase })
    return node
  }

  function panelPose(node, amount) {
    node.style.transform = `translateY(${((1 - amount) * 30).toFixed(3)}px) scale(${(0.97 + 0.03 * amount).toFixed(6)})`
  }

  function update(node, { local = 0, showcaseAt, duration = Infinity }) {
    const parts = partsByNode.get(node)
    if (!parts) return
    const cue = showcaseAt == null ? (parts.article ? Infinity : 0) : Number(showcaseAt)
    const hasShowcase = parts.cards.length > 0 && Number.isFinite(cue)
    const showFigures = hasShowcase && local >= cue
    const sceneOut = Number.isFinite(duration)
      ? 1 - easeIn(progress(local, duration - 0.35, duration))
      : 1
    const showTitle = !parts.article || showFigures
    parts.showcase.hidden = !showTitle
    parts.band.style.display = showFigures ? '' : 'none'
    node.dataset.openingPhase = showFigures ? 'showcase' : parts.article ? 'article' : 'brand'

    if (parts.article) {
      parts.article.hidden = showFigures
      const articleEntrance = easeOut(progress(local, 0, 0.5))
      const articleExit = hasShowcase ? 1 - easeIn(progress(local, cue - 0.35, cue)) : sceneOut
      parts.article.style.opacity = Math.min(
        easeOut(progress(local, 0, 0.45)),
        articleExit
      ).toFixed(6)
      panelPose(parts.article.firstElementChild, articleEntrance)
      if (!hasShowcase) return
    }

    const titleAt = parts.article ? cue : 0
    const figureAt = hasShowcase ? cue : titleAt
    const entrance = easeOut(progress(local, titleAt, titleAt + 0.5))
    const panelOpacity = Math.min(easeOut(progress(local, titleAt, titleAt + 0.45)), sceneOut)
    parts.titlePanel.style.opacity = panelOpacity.toFixed(6)
    parts.band.style.opacity = Math.min(
      easeOut(progress(local, figureAt, figureAt + 0.45)),
      sceneOut
    ).toFixed(6)
    panelPose(parts.titlePanel, entrance)
    panelPose(parts.band, easeOut(progress(local, figureAt, figureAt + 0.5)))
    parts.brand.style.opacity = easeOut(progress(local, titleAt, titleAt + 0.3)).toFixed(6)

    parts.heading.style.setProperty('--dv-opening-title-size', '88px')
    const lineWidth = Math.max(1, ...parts.lines.map((line) => line.scrollWidth))
    parts.heading.style.setProperty(
      '--dv-opening-title-size',
      Math.min(88, (88 * 1600) / lineWidth).toFixed(3) + 'px'
    )
    parts.lines.forEach((line, index) => {
      const amount = easeOutBack(
        progress(local, titleAt + 0.05 + index * 0.12, titleAt + 0.45 + index * 0.12)
      )
      line.style.opacity = clamp(amount).toFixed(6)
      line.style.transform = `translateY(${((1 - amount) * 36).toFixed(3)}px)`
    })
    const settle = easeOut(progress(local, figureAt, figureAt + 0.8))
    parts.cards.forEach((card) => {
      card.style.transform = `translateY(${((1 - settle) * 12).toFixed(3)}px)`
    })
  }

  window.OperationOpening = Object.freeze({ create, update })
})()

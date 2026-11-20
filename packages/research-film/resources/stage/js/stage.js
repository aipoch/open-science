/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
// Case demo video stage: the real session as background (native Open-Science UI kit), camera + highlight per scene,
// veil, typed panels, captions. Every frame is a pure function of t; all times come from data.js (resolved in Python).
;(() => {
  const { h, seg, ease, lerp } = window.A
  const D = window.DATA,
    TL = D.timeline,
    M = D.meta
  const qs = new URLSearchParams(location.search)
  const AR = qs.get('ar') === '9x16' ? '9x16' : '16x9'
  const TALL = AR === '9x16'
  const W = TALL ? 1080 : 1920,
    H = TALL ? 1920 : 1080
  const RENDER = qs.has('render')

  document.body.classList.add(RENDER ? 'render' : 'preview')
  const stage = h('div', { class: `stage ar-${AR}`, style: { width: `${W}px`, height: `${H}px` } })
  const bgWrap = h('div', { class: 'bg-wrap' })
  const veil = h('div', { class: 'veil' })
  const ovLayer = h('div', { class: 'ov-layer' })
  const capLayer = h('div', { class: 'cap-layer' })
  const tag = h(
    'div',
    { class: 'top-tag', 'data-box': 'tag' },
    h('img', { src: 'brand/logos/open-science-symbol-black.svg' }),
    h(
      'span',
      {},
      h('b', {}, 'Open-Science'),
      M.profile === 'user' ? ' · Research video' : ' · Use case'
    )
  )
  const disc = h(
    'div',
    { class: 'disclaimer', 'data-box': 'disclaimer' },
    h('i', {}, 'i'),
    h('span', {}, M.disclaimer || '')
  )
  const fly = h('img', {
    class: 'brand-fly',
    src: 'brand/logos/open-science-lockup-black.svg',
    alt: ''
  })
  stage.append(bgWrap, veil, ovLayer, tag, disc, fly, capLayer)
  document.getElementById('root').append(stage)

  // ---- background: the session in the app's own UI ----
  const appScale = TALL ? 1.5 : 1.25
  const PV = D.preview
  const fileNode = (f) =>
    PV.files[f].kind === 'img'
      ? h('img', { class: 'osk-preview-img', src: PV.files[f].src })
      : PV.files[f].text
  if (PV) {
    PV.tabs = PV.order.map((f) => ({ title: f, icon: 'file' }))
    PV.node = fileNode(PV.order[0])
  }
  const S = window.Session.build(bgWrap, D, TALL)
  S.app.style.transform = `scale(${appScale})`
  const fileOf = TL.scenes.map((_, k) => {
    for (let j = k; j >= 0; j--) if (TL.scenes[j].file) return TL.scenes[j].file
    return PV ? PV.order[0] : null
  })
  let shownFile = PV ? PV.order[0] : null
  const setFile = (f) => {
    const pn = S.ws.panelEl
    if (!pn || !f || f === shownFile) return
    shownFile = f
    const k = PV.order.indexOf(f)
    S.ws.panel.select(k, { title: f, body: fileNode(f) })
  }
  const marks = TL.scenes.map((sc) =>
    sc.highlight ? window.Session.mark(S.thread, sc.msg, sc.highlight) : null
  )
  const missingMarks = TL.scenes.filter((sc, k) => sc.highlight && !marks[k]).map((sc) => sc.id)

  let msgTop = []
  const offsetWithin = (node, anc) => {
    let y = 0
    for (let n = node; n && n !== anc; n = n.offsetParent) y += n.offsetTop
    return y
  }
  const measure = () => {
    msgTop = TL.scenes.map((sc, k) => {
      const anchor = marks[k] || S.thread.querySelector(`.osk-msg[data-i="${sc.msg}"]`) || S.thread
      return offsetWithin(anchor, S.scroller) - S.thread.offsetTop
    })
  }
  const viewH = () => S.scroller.clientHeight

  // ---- panels ----
  const scenesOv = TL.scenes.map((sc) => {
    const root = h('div', { class: `ov ov-${sc.id} layout-${sc.layout}` })
    const side = sc.layout === 'side' && !TALL
    const main = h('div', {
      class: `ov-main ${sc.layout === 'row' && !TALL ? 'row' : side ? 'side' : 'stack'}`
    })
    const col = side ? h('div', { class: 'ov-col' }) : null
    const foot = h('div', { class: 'ov-foot' })
    const group = h('div', { class: 'ov-group' })
    group.append(main, foot)
    root.append(group)
    ovLayer.append(root)
    let placed = 0
    const ctx = {
      tall: TALL,
      W,
      H,
      scene: sc,
      layout: sc.layout,
      n: sc.panels.filter((p) => !window.Panels.FOOT.has(p.type)).length
    }
    const panels = sc.panels.map((p, k) => {
      const box = h('div', {
        class: `pn pn-${p.type} ${p.box === 'plain' || window.Panels.PLAIN.has(p.type) ? 'plain' : 'card'}`,
        'data-box': `panel:${sc.id}:${k}:${p.type}`
      })
      if (window.Panels.FOOT.has(p.type)) foot.append(box)
      else if (side && placed++ > 0) {
        if (!col.parentNode) main.append(col)
        col.append(box)
      } else main.append(box)
      const update = window.Panels.make(p.type, box, p, ctx)
      return { p, box, update }
    })
    return { sc, root, group, panels, occupancy: null }
  })

  // ---- captions: chunks resolved in Python ----
  const chunks = TL.captions[AR]
  const capBox = h('div', { class: 'caption', 'data-box': 'caption' })
  capLayer.append(capBox)
  let lastChunk = null
  function drawCaption(t) {
    const c = chunks.find((c) => t >= c.words[0][1] - 0.05 && t < c.end)
    if (c !== lastChunk) {
      capBox.replaceChildren(...(c ? c.words : []).map((x) => h('span', { class: 'w' }, x[0])))
      lastChunk = c
    }
    capBox.style.opacity = c ? 1 : 0
    if (c)
      capBox
        .querySelectorAll('.w')
        .forEach((s, i) => s.classList.toggle('on', t >= c.words[i][1] - 0.03))
  }

  // ---- seek ----
  const sceneAt = (t) =>
    Math.max(
      0,
      TL.scenes.findIndex(
        (s, i) => t >= s.start && (i === TL.scenes.length - 1 || t < TL.scenes[i + 1].start)
      )
    )
  let BRAND = null
  let current = 0
  function seek(t) {
    const i = sceneAt(t),
      sc = TL.scenes[i],
      lt = t - sc.start,
      prev = TL.scenes[i - 1]
    current = t
    // camera: the source passage settles ~22% down the view (30% in 9:16), then drifts slowly
    const target = (k) => Math.max(0, msgTop[k] - viewH() * (TALL ? 0.3 : 0.22))
    const from = prev ? target(i - 1) + prev.dur * 6 : target(i) - 40
    const y = lerp(from, target(i), seg(lt, 0, 0.9, ease.inOut)) + lt * 6
    S.thread.style.transform = `translateY(${-y}px)`
    marks.forEach((m, k) => {
      if (!m) return
      const s = TL.scenes[k]
      m.style.setProperty('--p', t < s.start ? 0 : seg(t - s.start, 0.45, 1.1, ease.inOut))
    })
    // veil: light while the camera lands on the source, then the scene's level
    const lvl = (k) => TL.scenes[k].veil,
      landing = i === 0 ? 0 : 0.12
    const v = lerp(
      prev ? lerp(lvl(i - 1), landing, seg(lt, 0, 0.35)) : landing,
      lvl(i),
      seg(lt, i === 0 ? 0 : 0.85, i === 0 ? 0.35 : 1.4, ease.inOut)
    )
    bgWrap.style.filter =
      v > 0.01 ? `blur(${(v * 6).toFixed(2)}px) saturate(${(1 - v * 0.5).toFixed(3)})` : 'none'
    veil.style.opacity = (v * 0.72).toFixed(3)
    // panels of the active scene
    scenesOv.forEach((o, k) => {
      if (k !== i) {
        o.root.style.display = 'none'
        return
      }
      o.root.style.display = ''
      const sceneOut = 1 - seg(lt, sc.dur - 0.35, sc.dur, ease.in)
      let occupancy = ''
      for (const { p, box, update } of o.panels) {
        const occupied = lt >= p.occ_from && (p.t_out == null || lt < p.t_out)
        occupancy += occupied ? '1' : '0'
        box.style.display = occupied ? '' : 'none'
        if (!occupied) continue
        const vis = Math.min(
          seg(lt, p.t_in, p.t_in + 0.45),
          p.t_out == null ? sceneOut : 1 - seg(lt, p.t_out - 0.35, p.t_out, ease.in)
        )
        box.style.visibility = vis > 0 ? 'visible' : 'hidden'
        box.style.opacity = vis.toFixed(3)
        box.style.transform = `translateY(${((1 - seg(lt, p.t_in, p.t_in + 0.5)) * 30).toFixed(1)}px) scale(${lerp(0.97, 1, seg(lt, p.t_in, p.t_in + 0.5)).toFixed(4)})`
        if (vis > 0) update(lt)
      }
      if (occupancy !== o.occupancy) {
        // Work in stage pixels so preview zoom and capture resolution agree.
        // Measure the whole group, including the gap above any verdict.
        const style = getComputedStyle(o.root)
        const width = W - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        const height = H - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        const scale = Math.min(1, width / o.group.offsetWidth, height / o.group.offsetHeight)
        o.group.style.transform = `scale(${scale})`
        o.occupancy = occupancy
      }
    })
    // brand hand-off: the opening shows AIPOCH | Open-Science; as it ends, AIPOCH fades and the Open-Science logo glides
    // into the corner, where the badge takes over for the rest of the video
    const tagOut = TL.scenes.at(-1).panels.some((p) => p.type === 'end_card')
      ? 1 - seg(t, TL.duration - 6, TL.duration - 5)
      : 1
    let tagIn = 1
    if (BRAND) {
      const q = seg(t, BRAND.h0, BRAND.h1, ease.inOut)
      tagIn = seg(q, 0.75, 1)
      BRAND.ai.forEach((n) => (n.style.opacity = (1 - seg(t, BRAND.h0, BRAND.h0 + 0.3)).toFixed(3)))
      BRAND.os.style.visibility = t >= BRAND.h0 ? 'hidden' : 'visible'
      const on = t >= BRAND.h0 && t < BRAND.h1
      fly.style.opacity = on ? (1 - seg(q, 0.8, 1)).toFixed(3) : 0
      if (on) {
        const [x0, y0, , h0] = BRAND.from,
          [x1, y1, , h1] = BRAND.to,
          hh = lerp(h0, h1, q)
        fly.style.height = `${h0}px`
        fly.style.transform = `translate(${lerp(x0, x1, q).toFixed(1)}px, ${(lerp(y0, y1, q) - Math.sin(q * Math.PI) * 40).toFixed(1)}px) scale(${(hh / h0).toFixed(4)})`
      }
    }
    tag.style.opacity = Math.min(tagIn, tagOut).toFixed(3)
    setFile(fileOf[i])
    const dOn = (k) => !!(TL.scenes[k] && TL.scenes[k].disclaimer && M.disclaimer)
    disc.style.opacity = !dOn(i)
      ? 0
      : Math.min(
          dOn(i - 1) ? 1 : seg(lt, 0.4, 0.9),
          dOn(i + 1) ? 1 : 1 - seg(lt, sc.dur - 0.4, sc.dur)
        )
    drawCaption(t)
  }

  // ---- checks: boxes of everything on screen right now (read by sv/check.py) ----
  const rectOf = (el) => {
    const r = el.getBoundingClientRect(),
      s = stage.getBoundingClientRect(),
      k = W / s.width
    return [(r.left - s.left) * k, (r.top - s.top) * k, r.width * k, r.height * k].map(
      (x) => +x.toFixed(1)
    )
  }
  // Measure every phrase with the same words, font and box as live playback.
  window.__checkCaptions = () => {
    const issues = []
    const keep = [...capBox.childNodes]
    try {
      for (const chunk of chunks) {
        capBox.replaceChildren(...chunk.words.map(([word]) => h('span', { class: 'w on' }, word)))
        const [x, y, w, height] = rectOf(capBox)
        const rows = new Set([...capBox.children].map((span) => span.offsetTop))
        // A readable wrap or a narrow margin alone should not spend a repair attempt.
        const clipped =
          x < 0 ||
          y < 0 ||
          x + w > W ||
          y + height > H ||
          capBox.scrollWidth > capBox.clientWidth + 2 ||
          capBox.scrollHeight > capBox.clientHeight + 2
        if (clipped || rows.size > 1 || x < 24 || y < 24 || x + w > W - 24 || y + height > H - 24) {
          const time = chunk.words[0][1]
          const sc = TL.scenes[sceneAt(time)]
          issues.push({
            scene: sc.id,
            textLayout: clipped,
            line: sc.lines.findIndex((line) => time <= sc.start + line.t1 + 0.001),
            message:
              'This caption does not fit on one row inside the safe area: "' +
              chunk.words.map(([word]) => word).join(' ') +
              '". Rephrase the line and keep its evidence.'
          })
        }
      }
    } finally {
      capBox.replaceChildren(...keep)
    }
    return issues
  }
  // Only measure glyph ranges when two visible panel boxes intersect.
  window.__filmTextOverlaps = (first, second) => {
    const textRects = (id) => {
      const el = stage.querySelector('[data-box="' + CSS.escape(id) + '"]')
      if (!el) return []
      const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      const rects = []
      while (nodes.nextNode()) {
        if (
          !nodes.currentNode.textContent.trim() ||
          !nodes.currentNode.parentElement.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true
          })
        )
          continue
        range.selectNodeContents(nodes.currentNode)
        rects.push(...range.getClientRects())
      }
      return rects
    }
    const a = textRects(first)
    const b = textRects(second)
    return a.some((r) =>
      b.some((s) => {
        const w = Math.min(r.right, s.right) - Math.max(r.left, s.left)
        const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top)
        return w > 0 && h > 0 && w * h > 0.15 * Math.min(r.width * r.height, s.width * s.height)
      })
    )
  }
  window.__layout = () => {
    const out = []
    stage.querySelectorAll('[data-box]').forEach((el) => {
      const cs = getComputedStyle(el)
      if (el.closest('.ov') && el.closest('.ov').style.display === 'none') return
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.5) return
      const over = [...el.querySelectorAll('.fit, b, span, div')]
        .filter(
          (n) =>
            n.children.length === 0 &&
            n.textContent.trim() &&
            ((n.scrollWidth > n.clientWidth + 2 && getComputedStyle(n).overflowX !== 'visible') ||
              (n.scrollHeight > n.clientHeight + 2 && getComputedStyle(n).overflowY !== 'visible'))
        )
        .map((n) => n.textContent.trim().slice(0, 40))
      out.push({ id: el.dataset.box, rect: rectOf(el), overflow: over })
    })
    return { t: current, W, H, boxes: out, missingMarks }
  }

  // ---- boot ----
  window.__ready = (async () => {
    await document.fonts.ready
    // the case's image assets, decoded before the first frame (k.image(name))
    window.__assetImages = window.__assetImages || {}
    await Promise.all(
      (window.DATA.assets || [])
        .filter((a) => /\.(png|jpe?g|webp|gif|avif)$/i.test(a))
        .map(
          (a) =>
            new Promise((r) => {
              const im = new Image()
              im.onload = async () => {
                try {
                  await im.decode()
                } catch {
                  /* drawn anyway */
                }
                window.__assetImages[a] = im
                r()
              }
              im.onerror = r
              im.src = `assets/${a}`
            })
        )
    )
    await Promise.all(
      [...document.images].map((im) =>
        im.complete ? 0 : new Promise((r) => (im.onload = im.onerror = r))
      )
    )
    window.Panels.afterFonts()
    measure()
    // where the brand hand-off starts and lands: measured once on a settled frame of the opening (deterministic)
    const hook = scenesOv[0],
      os = hook && hook.root.querySelector('.cobrand .cb-os')
    if (os) {
      const hd = TL.scenes[0].dur,
        h0 = Math.max(1.2, hd - 0.7),
        h1 = hd + 0.3
      seek(Math.min(h0 - 0.05, Math.max(1.0, hd - 1.0)))
      const from = rectOf(os),
        to = rectOf(tag.querySelector('img'))
      BRAND = {
        h0,
        h1,
        os,
        ai: [...hook.root.querySelectorAll('.cobrand .cb-ai, .cobrand .cb-bar')],
        from,
        to
      }
    }
    seek(+qs.get('t') || 0)
    return { duration: TL.duration, fps: TL.fps, frames: TL.frames, W, H }
  })()
  window.__seek = (t) => seek(t)
  if (RENDER) return
  parent.postMessage({ type: 'open-science-research-video-ready', duration: TL.duration }, '*')

  // ---- preview player ----
  const fit = () => {
    const s = Math.min((innerWidth - 40) / W, (innerHeight - 110) / H)
    stage.style.transform = `scale(${s})`
    document.getElementById('root').style.height = `${H * s}px`
    document.getElementById('root').style.width = `${W * s}px`
  }
  addEventListener('resize', fit)
  fit()
  const audio = new Audio(window.VIDEO_ASSETS?.['mix.wav'] ?? 'mix.wav')
  const bar = h('input', { type: 'range', min: 0, max: TL.duration, step: 1 / TL.fps, value: 0 })
  const play = h('button', {}, 'Play')
  const time = h('span', { class: 'mono' }, '0.00')
  const nav = TL.scenes.map((s) => {
    const b = h('button', { class: 'sc' }, s.id)
    b.onclick = () => go(s.start + 0.01)
    return b
  })
  const other = h('a', { href: `?ar=${TALL ? '16x9' : '9x16'}` }, TALL ? '→ 16:9' : '→ 9:16')
  document.getElementById('controls').append(play, bar, time, ...nav, other)
  let frame = 0,
    requested = false
  const status = h('span', { role: 'status' })
  document.getElementById('controls').append(status)
  bar.setAttribute('aria-label', 'Playback position')
  const clock = new window.ResearchVideoPlaybackClock(audio, TL.duration, (t) => {
    seek(t)
    bar.value = t
    time.textContent = t.toFixed(2)
  })
  const draw = () => clock.tick()
  const stop = () => {
    requested = false
    clock.pause()
    cancelAnimationFrame(frame)
    play.textContent = 'Play'
  }
  const go = (x) => clock.seek(x)
  bar.oninput = () => go(+bar.value)
  const loop = () => {
    draw()
    if (!audio.paused && !audio.ended) frame = requestAnimationFrame(loop)
  }
  const toggle = async () => {
    if (requested) {
      stop()
      return
    }
    requested = true
    status.textContent = ''
    try {
      await window.__ready
      if (!requested) return
      if (audio.ended || audio.currentTime >= TL.duration) go(0)
      await clock.play()
      if (!requested) {
        audio.pause()
        return
      }
      play.textContent = 'Pause'
      cancelAnimationFrame(frame)
      loop()
    } catch (error) {
      stop()
      status.textContent = 'Audio could not play: ' + error.message
    }
  }
  play.onclick = toggle
  audio.addEventListener('ended', stop)
  audio.addEventListener('error', () => {
    stop()
    status.textContent = 'Audio could not be loaded'
  })
  addEventListener('pagehide', () => {
    stop()
    clock.dispose()
  })
  addEventListener('keydown', (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLButtonElement ||
      event.target instanceof HTMLAnchorElement
    )
      return
    if (event.code === 'Space') {
      event.preventDefault()
      void toggle()
    }
    if (event.code === 'ArrowRight') go(audio.currentTime + (event.shiftKey ? 1 : 1 / TL.fps))
    if (event.code === 'ArrowLeft') go(audio.currentTime - (event.shiftKey ? 1 : 1 / TL.fps))
  })
})()

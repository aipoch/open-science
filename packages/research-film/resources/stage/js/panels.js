/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
// Typed panel library. Each maker(box, p, ctx) builds DOM once and returns update(t), t = scene-local seconds.
// p carries resolved times (t_in, items[].t_in, note_t ...) from Python; makers never invent timing of their own.
;(() => {
  const { h, seg, ease, lerp, clamp } = window.A
  const TK = { ...window.TOKENS.color, ...window.TOKENS.videoExtensions }
  const TONE = {
    ink: TK.ink,
    gold: TK.gold,
    good: TK.good,
    bad: TK.bad,
    muted: TK.badgeBorder,
    blue: TK.blue
  }
  const TEXT_ON = {
    ink: '#fff',
    gold: '#111',
    good: '#fff',
    bad: '#fff',
    muted: '#111',
    blue: '#fff'
  }
  const el = (cls, ...k) => h('div', { class: cls }, ...k)
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const md = (s) =>
    esc(s || '')
      .replace(/\*\*([^*]+)\*\*/g, '<b class="x">$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  const rich = (cls, s) => h('div', { class: cls, html: md(s) })
  const show = (node, p, dy = 18, sc = 1) => {
    node.style.opacity = p.toFixed(3)
    node.style.transform = `translateY(${((1 - p) * dy).toFixed(1)}px) scale(${lerp(sc, 1, p).toFixed(4)})`
  }
  const pop = (node, t, t0, dy = 14) => show(node, seg(t, t0, t0 + 0.45, ease.outBack), dy, 0.92)
  const put = (node, ...k) => node.append(...k.flat().filter((x) => x != null))
  const eyebrow = (s) => (s ? rich('eyebrow', s) : null)
  const MARK = { pass: '✓', fail: '✕', open: '?' }

  // numbers count up from 0 to their shown value, keeping its format ("1,800", "3.37", "97.9%")
  function counter(node, shown) {
    const m = String(shown).match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/)
    if (!m) return () => {}
    const [, pre, num, post] = m,
      dec = (num.split('.')[1] || '').length,
      comma = num.includes(','),
      v = parseFloat(num.replace(/,/g, ''))
    return (p) => {
      const x = v * p
      node.textContent =
        pre +
        (comma
          ? x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
          : x.toFixed(dec)) +
        post
    }
  }

  // shrink a headline until it fits its box (deterministic: same fonts -> same result)
  function fitText(node, maxW, maxH) {
    let fs = parseFloat(getComputedStyle(node).fontSize)
    for (let k = 0; k < 30 && (node.scrollWidth > maxW + 1 || node.scrollHeight > maxH + 1); k++) {
      fs *= 0.95
      node.style.fontSize = `${fs.toFixed(1)}px`
    }
  }

  const F = {},
    AFTER_FONTS = []

  F.title = (box, p, ctx) => {
    const lines = p.text.split('|').map((s) => h('span', { html: md(s.trim()) }))
    const head = el('display title-q', ...lines),
      eb = eyebrow(p.eyebrow),
      note = p.note ? rich('pill-note', p.note) : null
    put(box, el('title-stack', eb, head, note))
    AFTER_FONTS.push(() => fitText(head, ctx.tall ? 960 : 1600, ctx.tall ? 700 : 520))
    return (t) => {
      // the opening's title is in by about 0.75 s (fast); section titles take their time
      const [d0, st, dur] = p.fast ? [0.05, 0.12, 0.4] : [0.1, 0.25, 0.65]
      if (eb) show(eb, seg(t, p.t_in, p.t_in + (p.fast ? 0.3 : 0.45)))
      lines.forEach((s, i) =>
        show(s, seg(t, p.t_in + d0 + i * st, p.t_in + d0 + dur + i * st, ease.outBack), 36)
      )
      if (note) show(note, seg(t, p.note_t, p.note_t + 0.5, ease.outBack), 20, 0.9)
    }
  }

  F.stats = (box, p) => {
    const split = p.layout === 'split'
    const parts = p.items.map((it) => {
      const tone = it.tone || (split ? 'ink' : 'gold')
      const num = h('b', {}, it.value),
        unit = it.unit ? h('small', {}, ` ${it.unit}`) : null
      const node = el(
        `st-item tone-${tone}`,
        h('div', { class: 'st-val' }, num, unit),
        rich('st-lbl', it.label)
      )
      if (split) {
        node.style.flex = String(it.weight ?? parseFloat(String(it.value).replace(/,/g, '')) ?? 1)
        node.style.background = TONE[tone]
        node.style.color = TEXT_ON[tone]
      }
      return { it, node, count: counter(num, it.value) }
    })
    const row = el(
      `st-row ${split ? 'split' : 'chips'}`,
      parts.map((x) => x.node)
    )
    const total = p.total ? rich('st-total mono', p.total) : null
    put(box, eyebrow(p.eyebrow), row, total)
    return (t) => {
      parts.forEach(({ it, node, count }) => {
        pop(node, t, it.t_in)
        count(seg(t, it.t_in, it.t_in + 0.7, ease.out))
      })
      if (total) show(total, seg(t, p.total_t, p.total_t + 0.45), 10)
    }
  }

  F.bars = (box, p) => {
    const max = p.max || Math.max(...p.items.map((i) => i.value))
    const bars = p.items.map((it) => {
      const fill = el('bar-fill')
      fill.style.background = TONE[it.tone || 'gold']
      const node = el(
        'bar',
        fill,
        el('bar-lbl', h('b', {}, it.display || String(it.value)), rich('bar-txt', it.label))
      )
      return { it, node, fill }
    })
    const badge = p.badge ? rich('ratio-badge', p.badge) : null,
      note = p.note ? rich('chip-line mono', p.note) : null
    put(
      box,
      eyebrow(p.eyebrow),
      el(
        'bars',
        bars.map((b) => b.node)
      ),
      badge || note ? el('bar-foot', badge, note) : null
    )
    return (t) => {
      bars.forEach(({ it, node, fill }) => {
        show(node, seg(t, it.t_in - 0.3, it.t_in), 12)
        fill.style.width = `${(it.value / max) * 100 * seg(t, it.t_in, it.t_in + 0.9, ease.out)}%`
      })
      if (badge) show(badge, seg(t, p.badge_t, p.badge_t + 0.45, ease.outBack), 12, 0.85)
      if (note) show(note, seg(t, p.note_t, p.note_t + 0.45), 10)
    }
  }

  // nice axis ticks
  const ticks = (a, b, n = 4) => {
    const s = Math.pow(10, Math.floor(Math.log10((b - a) / n)))
    const st = [1, 2, 2.5, 5, 10].map((k) => k * s).find((k) => (b - a) / k <= n + 0.5)
    const out = []
    for (let v = Math.ceil(a / st) * st; v <= b + 1e-9; v += st) out.push(+v.toFixed(10))
    return out
  }
  const fmtTick = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(+v.toFixed(3)))

  F.line_chart = (box, p, ctx) => {
    const d = p.data,
      tall = ctx.tall
    const cw = tall ? 900 : ctx.layout === 'row' ? 680 : ctx.layout === 'side' ? 880 : 1100
    const ch = tall ? (ctx.n > 1 ? 400 : 560) : ctx.n > 1 && ctx.layout !== 'row' ? 320 : 500
    const dpr = window.devicePixelRatio || 1
    const cv = h('canvas', {
      width: cw * dpr,
      height: ch * dpr,
      style: { width: `${cw}px`, height: `${ch}px` }
    })
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    put(box, p.title ? rich('chart-title', p.title) : null, cv)
    const xr = p.x_range || [Math.min(...d.x), Math.max(...d.x)]
    let ylo = Infinity,
      yhi = -Infinity
    d.ys.forEach((ys) =>
      ys.forEach((v) => {
        ylo = Math.min(ylo, v)
        yhi = Math.max(yhi, v)
      })
    )
    ;(p.refs || []).forEach((r) => {
      ylo = Math.min(ylo, r.y)
      yhi = Math.max(yhi, r.y)
    })
    const yr = p.y_range || [Math.min(0, ylo), yhi + (yhi - Math.min(0, ylo)) * 0.08]
    const fs = tall ? 22 : 18
    const bx = { x: 92, y: 18, w: cw - 120, h: ch - 70 }
    const X = (x) => bx.x + ((x - xr[0]) / (xr[1] - xr[0])) * bx.w,
      Y = (y) => bx.y + bx.h - ((y - yr[0]) / (yr[1] - yr[0])) * bx.h
    const at = (x, ys) => {
      const xs = d.x
      if (x <= xs[0]) return ys[0]
      for (let k = 1; k < xs.length; k++)
        if (xs[k] >= x) {
          const f = (x - xs[k - 1]) / (xs[k] - xs[k - 1] || 1)
          return lerp(ys[k - 1], ys[k], f)
        }
      return ys.at(-1)
    }
    const draw = p.draw || 2.5
    return (t) => {
      g.clearRect(0, 0, cw, ch)
      g.font = `500 ${fs}px "Roboto Mono"`
      g.fillStyle = TK.text2
      g.strokeStyle = TK.border
      g.lineWidth = 1.5
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      ticks(yr[0], yr[1]).forEach((v) => {
        g.beginPath()
        g.moveTo(bx.x, Y(v))
        g.lineTo(bx.x + bx.w, Y(v))
        g.stroke()
        g.fillText(fmtTick(v) + (p.y_label ? ` ${p.y_label}` : ''), bx.x - 12, Y(v))
      })
      g.textAlign = 'center'
      g.textBaseline = 'top'
      ticks(xr[0], xr[1], tall ? 4 : 5).forEach((v) =>
        g.fillText(fmtTick(v) + (p.x_label ? ` ${p.x_label}` : ''), X(v), bx.y + bx.h + 12)
      )
      g.strokeStyle = '#111'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(bx.x, bx.y)
      g.lineTo(bx.x, bx.y + bx.h)
      g.lineTo(bx.x + bx.w, bx.y + bx.h)
      g.stroke()
      if (p.band) {
        const b = seg(t, p.band.t_in, p.band.t_in + 0.8),
          c = TONE[p.band.tone || 'good']
        if (b > 0) {
          g.globalAlpha = 0.16 * b
          g.fillStyle = c
          if (p.band.x0 != null) g.fillRect(X(p.band.x0), bx.y, X(p.band.x1) - X(p.band.x0), bx.h)
          else g.fillRect(bx.x, Y(p.band.y1), bx.w, Y(p.band.y0) - Y(p.band.y1))
          g.globalAlpha = b
          g.fillStyle = c
          g.font = `700 ${fs + 2}px Inter`
          g.textAlign = 'center'
          g.textBaseline = 'top'
          if (p.band.label)
            g.fillText(
              p.band.label,
              p.band.x0 != null ? (X(p.band.x0) + X(p.band.x1)) / 2 : bx.x + bx.w / 2,
              (p.band.x0 != null ? bx.y : Y(p.band.y1)) + 10
            )
          g.globalAlpha = 1
        }
      }
      ;(p.refs || []).forEach((r) => {
        const c = TONE[r.tone || 'bad']
        g.save()
        g.setLineDash([10, 8])
        g.strokeStyle = c
        g.lineWidth = 2.5
        g.beginPath()
        g.moveTo(bx.x, Y(r.y))
        g.lineTo(bx.x + bx.w, Y(r.y))
        g.stroke()
        g.restore()
        if (r.label) {
          g.fillStyle = c
          g.font = `600 ${fs}px "Roboto Mono"`
          g.textAlign = 'left'
          g.textBaseline = 'bottom'
          g.fillText(r.label, bx.x + 12, Y(r.y) - 6)
        }
      })
      const pr = seg(t, p.t_in + 0.2, p.t_in + 0.2 + draw, ease.linear),
        xEnd = lerp(xr[0], xr[1], pr)
      d.ys.forEach((ys, si) => {
        const c = TONE[p.series[si].tone || ['gold', 'blue', 'ink'][si]]
        g.strokeStyle = c
        g.lineWidth = 5
        g.lineJoin = 'round'
        g.beginPath()
        let started = false
        for (let k = 0; k < d.x.length && d.x[k] <= xEnd; k++) {
          const px = X(d.x[k]),
            py = Y(ys[k])
          if (started) g.lineTo(px, py)
          else {
            g.moveTo(px, py)
            started = true
          }
        }
        if (started && pr < 1) g.lineTo(X(xEnd), Y(at(xEnd, ys)))
        g.stroke()
        if (pr > 0) {
          g.fillStyle = c
          g.beginPath()
          g.arc(X(xEnd), Y(at(xEnd, ys)), 8, 0, 7)
          g.fill()
        }
        if (p.series[si].label && pr >= 1) {
          g.fillStyle = c
          g.font = `600 ${fs}px Inter`
          g.textAlign = 'left'
          g.textBaseline = 'bottom'
          g.fillText(p.series[si].label, X(xr[0]) + 12, Y(ys.at(-1)) - 10)
        }
      })
      ;(p.marks || []).forEach((m) => {
        const k = seg(t, m.t_in, m.t_in + 0.5)
        if (k <= 0) return
        const y = at(m.x, d.ys[0])
        g.globalAlpha = k
        g.fillStyle = '#111'
        g.beginPath()
        g.arc(X(m.x), Y(y), 10, 0, 7)
        g.fill()
        g.font = `700 ${fs + 2}px Inter`
        g.textBaseline = 'bottom'
        const right = X(m.x) > bx.x + bx.w * 0.7
        g.textAlign = right ? 'right' : 'left'
        g.fillText(m.label, X(m.x) + (right ? -16 : 16), Y(y) - 10)
        g.globalAlpha = 1
      })
    }
  }

  F.criteria = (box, p) => {
    const cards = p.items.map((it, i) => ({
      it,
      node: el(
        'crit-card',
        el('crit-num', String(i + 1)),
        rich('crit-title', it.title),
        el(
          'crit-chips',
          (it.chips || []).map((c) => rich('tchip mono', c))
        )
      )
    }))
    const foot = p.foot ? rich('crit-foot mono', p.foot) : null
    put(
      box,
      eyebrow(p.eyebrow),
      el(
        'crit-row',
        cards.map((c) => c.node)
      ),
      foot
    )
    return (t) => {
      cards.forEach(({ it, node }) => pop(node, t, it.t_in, 30))
      if (foot) show(foot, seg(t, p.foot_t, p.foot_t + 0.45), 10)
    }
  }

  F.checklist = (box, p) => {
    const rows = p.items.map((it) => {
      const mk = h('i', { class: `ck-mk ${it.state || 'pass'}` }, MARK[it.state || 'pass'])
      return { it, mk, node: el('ck-row', mk, rich('ck-txt', it.text)) }
    })
    const foot = p.foot ? rich('ck-foot mono', p.foot) : null
    put(
      box,
      eyebrow(p.eyebrow),
      el(
        'ck-list',
        rows.map((r) => r.node)
      ),
      foot
    )
    return (t) => {
      rows.forEach(({ it, node, mk }) => {
        pop(node, t, it.t_in, 10)
        mk.style.transform = `scale(${lerp(2, 1, seg(t, it.t_in + 0.1, it.t_in + 0.4, ease.outBack)).toFixed(3)})`
      })
      if (foot) show(foot, seg(t, p.foot_t, p.foot_t + 0.45), 8)
    }
  }

  F.formula = (box, p) => {
    const eqs = p.lines.map((l) => rich('eq mono', l))
    const note = p.note ? rich('eq-note mono', p.note) : null
    put(box, eyebrow(p.eyebrow), el('eqs', eqs), note)
    return (t) => {
      eqs.forEach((e, i) => show(e, seg(t, p.t_in + 0.2 + i * 0.5, p.t_in + 0.7 + i * 0.5), 14))
      if (note) show(note, seg(t, p.note_t, p.note_t + 0.45), 10)
    }
  }

  F.progress = (box, p) => {
    const short = p.value < p.target,
      tone = p.tone || (short ? 'bad' : 'good'),
      share = clamp(p.value / p.target)
    const fill = el('pg-fill'),
      gap = el('pg-short'),
      cut = el(
        `pg-cut ${short ? 'bad' : 'good'}`,
        h('b', {}, short ? '✕' : '✓'),
        h('span', { class: 'mono' }, p.stop_label || `${p.value} ${p.unit || ''}`)
      )
    fill.style.background = short ? TONE.gold : TONE[tone]
    const tk = []
    if (p.ticks)
      for (let v = 0; v <= p.target + 1e-9; v += p.ticks)
        tk.push(
          h(
            'span',
            { style: { left: `${(v / p.target) * 100}%` } },
            `${+v.toFixed(2)}${p.unit ? ` ${p.unit}` : ''}`
          )
        )
    put(
      box,
      eyebrow(p.eyebrow),
      el('pg-track', fill, gap, cut),
      tk.length ? el('pg-ticks mono', tk) : null
    )
    const d = p.draw || 3.0,
      a = p.t_in + 0.2
    return (t) => {
      fill.style.width = `${share * 100 * seg(t, a, a + d, ease.linear)}%`
      cut.style.left = `${share * 100}%`
      show(cut, seg(t, a + d, a + d + 0.3), -10, 1.6)
      gap.style.left = `${share * 100}%`
      gap.style.width = short ? `${(1 - share) * 100 * seg(t, a + d + 0.3, a + d + 1.0)}%` : '0%'
    }
  }

  F.quote = (box, p) => {
    const q = rich('qt', `“${p.text.replace(/^[“"]|[”"]$/g, '')}”`),
      by = rich('qt-by mono', `— ${p.by}`)
    put(box, q, by)
    return (t) => {
      show(q, seg(t, p.t_in, p.t_in + 0.5, ease.outBack), 16, 0.95)
      show(by, seg(t, p.t_in + 0.4, p.t_in + 0.8), 8)
    }
  }

  F.steps = (box, p) => {
    const steps = p.items.map((it, i) => ({
      it,
      node: el(
        'step',
        el('step-n', String(i + 1)),
        el('step-body', rich('step-t', it.title), it.text ? rich('step-x', it.text) : null)
      )
    }))
    const row = el('steps-row')
    steps.forEach((s, i) => {
      if (i) row.append(el('step-arrow', '→'))
      row.append(s.node)
    })
    put(box, eyebrow(p.eyebrow), row)
    const arrows = [...row.querySelectorAll('.step-arrow')]
    return (t) => {
      steps.forEach(({ it, node }, i) => {
        pop(node, t, it.t_in, 20)
        if (i) show(arrows[i - 1], seg(t, it.t_in - 0.2, it.t_in + 0.1), 0)
      })
    }
  }

  F.compare = (box, p) => {
    const side = (s, cls) => {
      const v = s.value ? h('b', { class: `cmp-val tone-${s.tone || 'ink'}` }, s.value) : null
      return {
        s,
        v,
        node: el(
          `cmp-side ${cls}`,
          rich('cmp-title', s.title),
          v,
          s.label ? rich('cmp-lbl', s.label) : null
        ),
        count: v ? counter(v, s.value) : () => {}
      }
    }
    const L = side(p.left, 'l'),
      R = side(p.right, 'r'),
      vs = el('cmp-vs', 'vs'),
      verdict = p.verdict ? rich('cmp-verdict', p.verdict) : null
    put(box, eyebrow(p.eyebrow), el('cmp-row', L.node, vs, R.node), verdict)
    return (t) => {
      const a = p.left.t_in ?? p.t_in + 0.2,
        b = p.right.t_in
      pop(L.node, t, a)
      L.count(seg(t, a, a + 0.7))
      show(vs, seg(t, b - 0.2, b), 0)
      pop(R.node, t, b)
      R.count(seg(t, b, b + 0.7))
      if (verdict) {
        const end = Math.max(a, b)
        show(verdict, seg(t, end + 0.9, end + 1.3, ease.outBack), 10, 0.9)
      }
    }
  }

  F.figure = (box, p, ctx) => {
    const img = h('img', { class: 'fig-img', src: `files/${p.file}` })
    img.style.maxHeight = `${p.max_height || (ctx.tall ? 760 : ctx.n > 1 ? 420 : 620)}px`
    const cap = p.caption ? rich('fig-cap', p.caption) : null
    put(box, img, cap)
    return (t) => {
      if (cap) show(cap, seg(t, p.t_in + 0.4, p.t_in + 0.8), 8)
      img.style.transform = `scale(${lerp(1, 1.03, seg(t, p.t_in, p.t_in + 8, ease.linear)).toFixed(4)})`
    }
  }

  F.report = (box, p) => {
    const rows = p.rows.map((r) => ({
      r,
      node: el(
        `rep-row ${r.state}`,
        el('rep-mk', MARK[r.state]),
        el(
          'rep-what',
          h('b', { html: md(r.title) }),
          r.result ? h('span', { html: md(r.result) }) : null
        ),
        r.file ? el('rep-file mono', r.file) : null
      )
    }))
    put(box, eyebrow(p.eyebrow), ...rows.map((x) => x.node))
    return (t) => rows.forEach(({ r, node }) => pop(node, t, r.t_in, 12))
  }

  F.verdict = (box, p) => {
    const v = el(
      `verdict ${p.tone}`,
      `${p.tone === 'good' ? '✓' : p.tone === 'bad' ? '✕' : '•'} `,
      h('span', { html: md(p.text) })
    )
    put(box, v)
    return (t) => show(v, seg(t, p.t_in, p.t_in + 0.45, ease.outBack), 10, 1.4)
  }

  F.illustration = (box, p) => {
    const palette = {
      ink: TK.ink,
      paper: TK.paper,
      sky: TK.sky,
      gold: TK.gold,
      teal: TK.good,
      muted: TK.badgeBorder,
      none: 'none'
    }
    const svg = (tag, attributes = {}) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
      return node
    }
    const canvas = svg('svg', { viewBox: '0 0 1000 320', role: 'img', 'aria-label': p.description })
    const nodes = p.elements.map((element, index) => {
      const group = svg('g')
      const node = svg(element.kind, {
        fill: palette[element.fill || 'paper'],
        stroke: palette[element.stroke || 'ink'],
        'stroke-width': element.strokeWidth ?? 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
      })
      const fields = {
        rect: ['x', 'y', 'width', 'height'],
        ellipse: ['rx', 'ry'],
        line: ['x2'],
        path: ['d'],
        text: ['x', 'y']
      }[element.kind]
      for (const key of fields) node.setAttribute(key, element[key])
      if (element.kind === 'rect') node.setAttribute('rx', element.radius ?? 0)
      if (element.kind === 'ellipse') {
        node.setAttribute('cx', element.x)
        node.setAttribute('cy', element.y)
      }
      if (element.kind === 'line') {
        node.setAttribute('x1', element.x)
        node.setAttribute('y1', element.y)
        node.setAttribute('y2', element.y2 ?? element.y)
      }
      if (element.kind === 'text') {
        node.textContent = element.text
        node.setAttribute('font-size', element.fontSize ?? 18)
        node.setAttribute('text-anchor', 'middle')
        node.setAttribute('fill', palette[element.fill || 'ink'])
        node.setAttribute('stroke', 'none')
      }
      const drawn = element.motion === 'draw' && element.kind !== 'text'
      if (drawn) {
        node.setAttribute('pathLength', '1')
        node.setAttribute('stroke-dasharray', '1')
      }
      group.append(node)
      canvas.append(group)
      return { element, group, node, index, drawn }
    })
    box.append(canvas)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    return (t) => {
      for (const { element, group, node, index, drawn } of nodes) {
        const since = t - element.t_in
        const entrance = seg(t, element.t_in, element.t_in + 0.55, ease.out)
        let y = reduced?.matches ? 0 : (1 - entrance) * 12
        let opacity = entrance
        if (since >= 0 && !reduced?.matches) {
          if (element.motion === 'float') y += Math.sin(since * 1.4) * 5
          if (element.motion === 'pulse') opacity *= 0.75 + 0.25 * Math.cos(since * 2.4)
          if (element.motion === 'fall') {
            const phase = (since / 1.3 + index * 0.173) % 1
            y += phase * 42
            opacity *= Math.sin(phase * Math.PI)
          }
        }
        group.setAttribute('transform', `translate(0 ${y.toFixed(3)})`)
        group.setAttribute('opacity', opacity.toFixed(3))
        if (drawn)
          node.setAttribute(
            'stroke-dashoffset',
            reduced?.matches ? '0' : String(1 - seg(t, element.t_in, element.t_in + 1.2))
          )
      }
    }
  }

  F.animation = (box, p, ctx) => {
    const a = window.Kit.create(box, p, ctx, (window.DATA.codes || {})[p.code || p.script] || '')
    ;(window.__anims = window.__anims || []).push({
      id: `${ctx.scene.id}:${p.script}`,
      scene: ctx.scene.id,
      box,
      ...a
    })
    return (t) => a.draw(t)
  }

  // Open-Science logo motion (design system "OpenScience loading" package), ported to the frame clock:
  // a 3D particle field gathers into the symbol, then the official lockup artwork takes over (the logo itself is never rebuilt).
  const LOGO_DOTS = [
    { x: -0.012924, y: 0.472892, radius: 0.007784 },
    { x: 0.131586, y: 0.466715, radius: 0.012465 },
    { x: -0.16191, y: 0.448989, radius: 0.012465 },
    { x: 0.062366, y: 0.432197, radius: 0.01001 },
    { x: -0.071564, y: 0.427665, radius: 0.010452 },
    { x: 0.26355, y: 0.406139, radius: 0.007964 },
    { x: 0.192444, y: 0.394296, radius: 0.010934 },
    { x: -0.198676, y: 0.381144, radius: 0.009742 },
    { x: -0.035226, y: 0.371028, radius: 0.009845 },
    { x: -0.294712, y: 0.372418, radius: 0.007964 },
    { x: 0.093762, y: 0.363983, radius: 0.010916 },
    { x: -0.159346, y: 0.333163, radius: 0.008288 },
    { x: 0.304653, y: 0.31767, radius: 0.011835 },
    { x: 0.21201, y: 0.312884, radius: 0.011323 },
    { x: 0.379275, y: 0.305679, radius: 0.012465 },
    { x: 0.03661, y: 0.31467, radius: 0.006839 },
    { x: -0.302793, y: 0.297186, radius: 0.01174 },
    { x: -0.06186, y: 0.308778, radius: 0.005888 },
    { x: 0.130926, y: 0.289632, radius: 0.006601 },
    { x: -0.152828, y: 0.272535, radius: 0.005886 },
    { x: -0.389103, y: 0.259271, radius: 0.012465 },
    { x: -0.263001, y: 0.254961, radius: 0.007069 },
    { x: 0.08035, y: 0.240144, radius: 0.005697 },
    { x: 0.214012, y: 0.236114, radius: 0.007386 },
    { x: 0.301842, y: 0.223886, radius: 0.007543 },
    { x: 0.38527, y: 0.209823, radius: 0.009834 },
    { x: -0.226909, y: 0.209488, radius: 0.007331 },
    { x: -0.379551, y: 0.184014, radius: 0.010332 },
    { x: -0.163488, y: 0.185753, radius: 0.005194 },
    { x: 0.450166, y: 0.175169, radius: 0.007964 },
    { x: 0.277134, y: 0.159357, radius: 0.00851 },
    { x: -0.332208, y: 0.145845, radius: 0.007841 },
    { x: -0.280971, y: 0.125806, radius: 0.005886 },
    { x: -0.453117, y: 0.120612, radius: 0.007964 },
    { x: 0.361206, y: 0.107731, radius: 0.008965 },
    { x: 0.431057, y: 0.08131, radius: 0.009861 },
    { x: 0.311279, y: 0.066881, radius: 0.006979 },
    { x: -0.416624, y: 0.052698, radius: 0.010546 },
    { x: 0.247861, y: 0.053097, radius: 0.005194 },
    { x: 0.486554, y: 0.027388, radius: 0.012467 },
    { x: -0.304731, y: 0.029684, radius: 0.00677 },
    { x: -0.358303, y: 0.018986, radius: 0.010834 },
    { x: 0.379703, y: -0.021576, radius: 0.012119 },
    { x: -0.463213, y: -0.029978, radius: 0.012465 },
    { x: 0.316038, y: -0.032274, radius: 0.005925 },
    { x: 0.434801, y: -0.055291, radius: 0.009139 },
    { x: -0.238767, y: -0.05569, radius: 0.005252 },
    { x: -0.298784, y: -0.069468, radius: 0.006924 },
    { x: -0.413682, y: -0.0839, radius: 0.009003 },
    { x: -0.347098, y: -0.110321, radius: 0.006579 },
    { x: 0.467602, y: -0.123205, radius: 0.007964 },
    { x: 0.292335, y: -0.128399, radius: 0.006867 },
    { x: 0.345213, y: -0.148438, radius: 0.006579 },
    { x: -0.263741, y: -0.16195, radius: 0.006306 },
    { x: -0.43568, y: -0.177762, radius: 0.007964 },
    { x: 0.398485, y: -0.186604, radius: 0.010116 },
    { x: 0.172523, y: -0.188343, radius: 0.005194 },
    { x: -0.365454, y: -0.212416, radius: 0.011512 },
    { x: 0.240177, y: -0.21208, radius: 0.00736 },
    { x: -0.284853, y: -0.226479, radius: 0.010929 },
    { x: -0.202139, y: -0.238706, radius: 0.005886 },
    { x: -0.070817, y: -0.242737, radius: 0.005194 },
    { x: 0.412444, y: -0.261862, radius: 0.012465 },
    { x: 0.277432, y: -0.257553, radius: 0.008802 },
    { x: 0.163226, y: -0.275125, radius: 0.005886 },
    { x: 0.323191, y: -0.299778, radius: 0.010197 },
    { x: -0.119564, y: -0.292222, radius: 0.006152 },
    { x: -0.355934, y: -0.308269, radius: 0.012465 },
    { x: -0.192941, y: -0.315476, radius: 0.009262 },
    { x: 0.073337, y: -0.311369, radius: 0.006979 },
    { x: -0.283451, y: -0.320261, radius: 0.010921 },
    { x: -0.024542, y: -0.317261, radius: 0.006629 },
    { x: 0.176721, y: -0.335756, radius: 0.010578 },
    { x: -0.072535, y: -0.366576, radius: 0.011863 },
    { x: 0.054493, y: -0.37362, radius: 0.010942 },
    { x: 0.309199, y: -0.375011, radius: 0.007964 },
    { x: 0.217238, y: -0.383735, radius: 0.010331 },
    { x: -0.172561, y: -0.396888, radius: 0.010479 },
    { x: -0.249061, y: -0.408731, radius: 0.007964 },
    { x: 0.091052, y: -0.430256, radius: 0.01056 },
    { x: -0.042089, y: -0.434789, radius: 0.011807 },
    { x: 0.185251, y: -0.45158, radius: 0.012465 },
    { x: -0.108245, y: -0.469307, radius: 0.012465 },
    { x: 0.035458, y: -0.484072, radius: 0.007964 }
  ]
  function logoParticles(lockH) {
    const S = lockH * 4.2,
      dpr = window.devicePixelRatio || 1,
      logoSize = lockH * 1.0
    const cv = h('canvas', {
      class: 'logo-particles',
      width: Math.round(S * dpr),
      height: Math.round(S * dpr),
      style: {
        width: `${S}px`,
        height: `${S}px`,
        left: `${(75.5 / 149) * lockH - S / 2}px`,
        top: `${(74.5 / 149) * lockH - S / 2}px`
      }
    })
    const g = cv.getContext('2d'),
      rnd = window.A.rng(20261028),
      rand = (a, b) => a + rnd() * (b - a)
    const ps = []
    for (let i = 0; i < LOGO_DOTS.length * 18; i++) {
      const dot = LOGO_DOTS[i % LOGO_DOTS.length],
        ang = i * 2.399963 + rand(-0.18, 0.18),
        rad = Math.sqrt(rnd()) * dot.radius
      const tx = (dot.x + Math.cos(ang) * rad) * logoSize,
        ty = (dot.y + Math.sin(ang) * rad) * logoSize
      const sph = S * rand(0.2, 0.3),
        lon = i * 2.399963 + rand(-0.18, 0.18),
        lat = Math.asin(rand(-0.92, 0.92)),
        vol = Math.pow(rand(0.58, 1), 0.38) * sph
      ps.push({
        tx,
        ty,
        sx: Math.cos(lat) * Math.cos(lon) * vol,
        sy: Math.sin(lat) * vol * 0.92,
        sz: Math.cos(lat) * Math.sin(lon) * vol,
        sph,
        r: rand(0.9, 1.7),
        phase: rand(0, 6.283),
        delay: rand(-0.035, 0.05),
        alpha: rand(0.5, 1)
      })
    }
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    // gather: 0→1 progress of the particles into the symbol; fade: 0→1 hand-over to the artwork
    const draw = (time, gather, fade) => {
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, S, S)
      if (fade >= 1) return
      const ms = time * 1000,
        c = S / 2,
        T = ease(clamp(gather, 0, 1))
      g.fillStyle = '#111111'
      for (const q of ps) {
        const lt = clamp(T + q.delay, 0, 1),
          settle = lt * lt * lt,
          travel = Math.sin(lt * Math.PI)
        const yaw = ms * 0.00034 + q.phase * 0.03,
          pitch = Math.sin(ms * 0.00022 + q.phase) * 0.16
        const x1 = q.sx * Math.cos(yaw) - q.sz * Math.sin(yaw),
          z1 = q.sx * Math.sin(yaw) + q.sz * Math.cos(yaw)
        const ry = q.sy * Math.cos(pitch) - z1 * Math.sin(pitch),
          rz = q.sy * Math.sin(pitch) + z1 * Math.cos(pitch)
        const persp = 1 + rz / (S * 1.6),
          depth = clamp((rz / (S * 0.36) + 1) / 2, 0, 1)
        const x =
          c +
          x1 * persp +
          (q.tx - x1 * persp) * lt +
          Math.cos(q.phase + ms * 0.0011) * travel * (1 - settle) * 8
        const y =
          c +
          ry * persp +
          (q.ty - ry * persp) * lt +
          Math.sin(q.phase + ms * 0.0013) * travel * (1 - settle) * 5.5
        const op = (0.22 + depth * 0.56 + lt * 0.16) * q.alpha * (1 - fade)
        if (op < 0.01) continue
        g.globalAlpha = op
        g.beginPath()
        g.arc(x, y, q.r * (0.68 + depth * 0.74) * (0.84 + lt * 0.1), 0, 6.283)
        g.fill()
      }
      g.globalAlpha = 1
    }
    return { cv, draw }
  }

  F.end_card = (box, p, ctx) => {
    const user = window.DATA.meta.profile === 'user'
    const lockH = ctx.tall ? 110 : 120
    const lock = h('img', { class: 'lockup', src: 'brand/logos/open-science-lockup-black.svg' })
    const LP = logoParticles(lockH)
    const lockWrap = el('lockup-wrap', LP.cv, lock)
    const tag = el('display small', user ? 'Made with Open-Science' : 'Science, Open to All')
    const chips = el(
      'feature-chips',
      ['Open source', 'Model-agnostic', 'Local-first', 'Apache-2.0'].map((x) => el('fchip', x))
    )
    const cta = el('cta mono', 'aipoch.com/open-science')
    const by = h('img', { class: 'aipoch', src: 'brand/logos/aipoch-logo-primary.svg' })
    put(box, el('brand-block', lockWrap, tag, chips, cta, by))
    return (t) => {
      const a = p.t_in,
        G = 1.7
      LP.draw(t, seg(t, a, a + G, ease.linear), seg(t, a + G - 0.15, a + G + 0.25, ease.linear))
      lock.style.opacity = seg(t, a + G - 0.15, a + G + 0.35, ease.linear).toFixed(3)
      show(tag, seg(t, a + G + 0.3, a + G + 0.9), 20)
      chips
        .querySelectorAll('.fchip')
        .forEach((c, i) =>
          show(c, seg(t, a + G + 0.8 + i * 0.12, a + G + 1.2 + i * 0.12, ease.outBack), 12, 0.8)
        )
      show(cta, seg(t, a + G + 1.5, a + G + 2.0), 10)
      show(by, seg(t, a + G + 1.9, a + G + 2.4), 10)
    }
  }

  window.Panels = {
    FOOT: new Set(['verdict']),
    PLAIN: new Set(['title', 'end_card', 'verdict', 'illustration']),
    make: (type, box, p, ctx) => F[type](box, p, ctx),
    afterFonts: () => AFTER_FONTS.forEach((f) => f())
  }
})()

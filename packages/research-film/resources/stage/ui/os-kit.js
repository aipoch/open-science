/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
// Native Open-Science UI kit for videos.
// Rendered with the app's own compiled stylesheet (os-app.css = out/renderer/assets/select-*.css from Open-Science 0.35.1)
// and the exact Tailwind class names of the real React components (WorkspacePage, FilePreviewDialog, index, SessionReplayPreview,
// AgentMarkdown chunks — see references/open-science-app/). Only layout glue that the app computes at runtime lives in os-kit.css.
;(() => {
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'html') el.innerHTML = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else el.setAttribute(k, k === 'src' ? (window.VIDEO_ASSETS?.[v] ?? v) : v)
    }
    for (const c of kids.flat())
      if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c))
    return el
  }

  // lucide icons (ISC) — the icon set the app uses
  const P = {
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    files:
      '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
    toolbox:
      '<path d="M16 12v4"/><path d="M16 6a2 2 0 0 1 1.414.586l4 4A2 2 0 0 1 22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 .586-1.414l4-4A2 2 0 0 1 8 6z"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M2 14h20"/><path d="M8 12v4"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    packageOpen:
      '<path d="M12 22v-9"/><path d="M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.655 1.655 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z"/><path d="M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13"/><path d="M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.2a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.636 1.636 0 0 0 1.63 0z"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    settings:
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    fileJson:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    packagePlus:
      '<path d="M16 16h6"/><path d="M19 13v6"/><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/>'
  }
  const icon = (n, cls = 'size-4', sw = 2) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    s.setAttribute('viewBox', '0 0 24 24')
    s.setAttribute('fill', 'none')
    s.setAttribute('stroke', 'currentColor')
    s.setAttribute('stroke-width', sw)
    s.setAttribute('stroke-linecap', 'round')
    s.setAttribute('stroke-linejoin', 'round')
    s.setAttribute('class', cls)
    s.setAttribute('aria-hidden', 'true')
    s.innerHTML = P[n]
    return s
  }

  // ---- markdown -> elements, rendered inside the app's markdown wrapper (Tailwind Typography "prose prose-sm") ----
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const attr = (s) => esc(s).replace(/"/g, '&quot;')
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="#">$1</a>')
  function mdHtml(src) {
    const out = [],
      lines = src.split('\n')
    for (let i = 0; i < lines.length;) {
      const l = lines[i]
      if (l.startsWith('```')) {
        const b = []
        for (i++; i < lines.length && !lines[i].startsWith('```'); i++) b.push(esc(lines[i]))
        out.push(`<pre><code>${b.join('\n')}</code></pre>`)
        i++
      } else if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(l)) {
        const m = l.match(/^!\[([^\]]*)\]\(([^)]+)\)/)
        const src = window.VIDEO_ASSETS?.[m[2]] ?? m[2]
        out.push(`<p><img src="${attr(src)}" alt="${attr(m[1])}" class="osk-md-img"></p>`)
        i++
      } else if (l.startsWith('### ')) {
        out.push(`<h4>${inline(l.slice(4))}</h4>`)
        i++
      } else if (l.startsWith('## ')) {
        out.push(`<h3>${inline(l.slice(3))}</h3>`)
        i++
      } else if (/^\d+\. /.test(l)) {
        const it = []
        for (; i < lines.length && /^\d+\. /.test(lines[i]); i++)
          it.push(`<li>${inline(lines[i].replace(/^\d+\. /, ''))}</li>`)
        out.push(`<ol>${it.join('')}</ol>`)
      } else if (l.startsWith('- ')) {
        const it = []
        for (; i < lines.length && lines[i].startsWith('- '); i++)
          it.push(`<li>${inline(lines[i].slice(2))}</li>`)
        out.push(`<ul>${it.join('')}</ul>`)
      } else if (l.startsWith('|')) {
        const rows = []
        for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i])
        const cells = (r) =>
          r
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim())
        out.push(
          `<div data-streamdown="table-wrapper"><div><table data-streamdown="table"><thead><tr>${cells(
            rows[0]
          )
            .map((c) => `<th>${inline(c)}</th>`)
            .join('')}</tr></thead><tbody>${rows
            .slice(2)
            .map(
              (r) =>
                `<tr>${cells(r)
                  .map((c) => `<td>${inline(c)}</td>`)
                  .join('')}</tr>`
            )
            .join('')}</tbody></table></div></div>`
        )
      } else if (!l.trim()) i++
      else {
        const b = [inline(lines[i++])]
        for (
          ;
          i < lines.length && lines[i].trim() && !/^(## |### |- |\||```|\d+\. |!\[)/.test(lines[i]);
          i++
        )
          b.push(inline(lines[i]))
        out.push(`<p>${b.join(' ')}</p>`)
      }
    }
    return out.join('')
  }
  const markdown = (src) =>
    h(
      'div',
      { class: 'agent-markdown-root max-w-full min-w-0' },
      h('div', {
        class:
          'agent-markdown prose prose-sm prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2',
        html: mdHtml(src)
      })
    )

  // ---- buttons (buttonVariants from the app) ----
  const BTN =
    'group/button inline-flex shrink-0 touch-manipulation items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap'
  const VAR = {
    default: 'bg-primary text-primary-foreground',
    outline: 'border-border bg-card text-foreground',
    ghost: '',
    secondary: 'bg-secondary text-secondary-foreground'
  }
  const SIZE = {
    default: 'h-8 gap-1.5 px-2.5',
    sm: 'h-7 gap-1 px-2.5 text-[0.8rem]',
    'icon-sm': 'size-7',
    icon: 'size-8'
  }
  const button = (label, variant = 'default', size = 'default', extra = '') =>
    h(
      'button',
      {
        type: 'button',
        'data-slot': 'button',
        'data-variant': variant,
        class: `${BTN} ${VAR[variant]} ${SIZE[size]} ${extra}`
      },
      label
    )

  // ---- workspace pieces ----
  function sidebar(o) {
    const navRow = (ic, label, pressed) =>
      h(
        'div',
        { class: 'flex h-9 items-center gap-1 px-1.5' },
        h(
          'button',
          {
            type: 'button',
            class: `flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 ${pressed ? 'bg-bg-300' : ''}`
          },
          h(
            'span',
            { class: 'flex size-3.5 shrink-0 items-center justify-center' },
            icon(ic, 'size-3.5')
          ),
          h('span', {}, label)
        )
      )
    const sections = []
    for (const sec of o.sections) {
      sections.push(h('div', { class: 'osk-section-label' }, sec.label))
      for (const s of sec.items) {
        const row = h(
          'div',
          {
            class: `osk-session-row group relative flex items-center rounded-md px-2.5 text-sm ${s.active ? 'bg-bg-300 text-text-000' : 'text-text-100'}`
          },
          h(
            'button',
            {
              type: 'button',
              'data-slot': 'session-open-button',
              class: 'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left'
            },
            h(
              'span',
              { class: 'inline-flex size-3 shrink-0 items-center justify-center' },
              h('span', { class: `size-[7px] shrink-0 rounded-full osk-dot-${s.status || 'idle'}` })
            ),
            h('span', { class: 'min-w-0 flex-1 truncate' }, s.title),
            s.imported
              ? h(
                  'span',
                  {
                    role: 'img',
                    class:
                      'relative z-[2] inline-flex size-4 shrink-0 items-center justify-center text-text-200'
                  },
                  icon('lock', 'size-3.5', 1.75)
                )
              : null
          )
        )
        s.el = row
        sections.push(row)
      }
    }
    return h(
      'aside',
      { class: 'osk-sidebar' },
      h(
        'div',
        { class: 'm-[0.7px] flex min-h-0 flex-1 flex-col rounded-lg bg-rail-card-bg shadow-card' },
        h(
          'div',
          { class: 'px-3 pt-3' },
          h(
            'div',
            { class: 'flex items-center' },
            h(
              'button',
              {
                type: 'button',
                class:
                  'grid h-7 w-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground'
              },
              icon('chevronLeft', 'size-4')
            ),
            h(
              'button',
              {
                type: 'button',
                class:
                  'osk-project flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-lg py-1 pl-1 pr-2 text-left font-serif text-[15px] font-bold tracking-[-0.02em] text-text-000'
              },
              h('span', { class: 'min-w-0 flex-1 truncate' }, o.project),
              icon('chevronDown', 'size-3.5 shrink-0 text-text-100')
            )
          )
        ),
        h(
          'nav',
          { class: 'flex min-h-0 flex-1 flex-col osk-nav' },
          navRow('plus', 'New'),
          navRow('toolbox', 'Customize'),
          navRow('files', 'Files', o.filesOpen),
          navRow('cpu', 'Compute'),
          h('div', { class: 'osk-sessions' }, sections)
        ),
        h(
          'div',
          { class: 'osk-rail-foot flex items-center gap-2 px-3 pb-3 text-text-300' },
          icon('settings', 'size-4')
        )
      )
    )
  }

  function toolGroup(g) {
    const rows = (g.rows || []).map((r) =>
      h(
        'div',
        {
          class:
            'osk-tool-row flex w-full items-start gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px]'
        },
        h(
          'span',
          { class: 'mt-0.5 inline-flex shrink-0 items-center md:mt-0 text-text-100' },
          icon(r.icon || 'book', 'size-3.5')
        ),
        h(
          'span',
          { class: 'min-w-0 flex-1 text-left md:flex md:items-center md:gap-2' },
          h('span', { class: 'block min-w-0 truncate text-text-000' }, r.label),
          r.detail ? h('span', { class: 'hidden shrink-0 text-text-300 md:inline' }, '·') : null,
          r.detail
            ? h(
                'span',
                { class: 'mt-0.5 block min-w-0 truncate font-normal text-text-100 md:mt-0' },
                r.detail
              )
            : null
        ),
        r.meta
          ? h(
              'span',
              {
                class:
                  'mt-0.5 shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-100 md:mt-0'
              },
              r.meta
            )
          : null
      )
    )
    return h(
      'div',
      {
        class: 'w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1',
        'data-testid': 'tool-group'
      },
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': g.expanded ? 'true' : 'false',
          class: 'flex w-full items-center gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px]'
        },
        h(
          'span',
          {
            class: `inline-flex w-4 shrink-0 items-center justify-center text-text-100 ${g.expanded ? 'rotate-90' : ''}`
          },
          icon('chevronRight', 'size-3.5', 2.2)
        ),
        h('span', { class: 'min-w-0 truncate text-left font-medium text-text-000' }, g.title),
        h(
          'span',
          { class: 'ml-auto shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-000' },
          g.meta
        )
      ),
      g.expanded ? h('div', { class: 'pb-0.5' }, rows) : null
    )
  }

  function generated(list) {
    return h(
      'div',
      { class: 'mt-3 border-t border-border-200 pt-3' },
      h(
        'div',
        { class: 'mb-2 text-[11px] font-medium uppercase text-text-300' },
        `Generated · ${list.length}`
      ),
      h(
        'div',
        { class: 'osk-art-grid' },
        list
          .slice(0, 5)
          .map((a) =>
            h(
              'div',
              { class: 'osk-art-card rounded-lg border border-border-200 bg-bg-000' },
              h(
                'div',
                { class: 'osk-art-thumb bg-bg-200 text-text-300' },
                a.kind === 'json'
                  ? h('span', { class: 'font-mono text-[10px]' }, '{ … }')
                  : h('span', { class: 'text-[10px] font-medium uppercase' }, a.ext || 'file')
              ),
              h(
                'div',
                { class: 'flex items-baseline gap-1 px-2 py-1.5' },
                h('span', { class: 'min-w-0 flex-1 truncate text-[12px] text-text-000' }, a.name),
                h('span', { class: 'shrink-0 text-[11px] tabular-nums text-text-300' }, a.size)
              )
            )
          ),
        list.length > 5
          ? h(
              'div',
              {
                class:
                  'osk-art-card osk-art-more rounded-lg border border-border-200 bg-bg-000 flex items-center justify-center text-[13px] font-semibold'
              },
              `+${list.length - 5} more`
            )
          : null
      )
    )
  }

  function message(m) {
    if (m.role === 'user') {
      return h(
        'div',
        { class: 'osk-msg msg flex w-full flex-col items-end', 'data-i': m.i },
        h(
          'div',
          {
            'data-slot': 'user-message-bubble',
            class:
              'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'
          },
          markdown(m.md)
        )
      )
    }
    return h(
      'div',
      { class: 'osk-msg msg w-full', 'data-i': m.i },
      h(
        'div',
        {
          class:
            'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'
        },
        m.md ? markdown(m.md) : null,
        m.steps ? h('div', { class: 'osk-group-wrap' }, toolGroup(m.steps)) : null,
        m.generated ? generated(m.generated) : null,
        m.completed
          ? h(
              'div',
              {
                class:
                  'mt-3 flex items-center gap-x-3 whitespace-nowrap text-[11px] leading-4 text-text-000/70 tabular-nums'
              },
              h('span', { class: 'flex items-center gap-0.5' }, icon('check', 'size-3')),
              h('span', {}, m.completed)
            )
          : null
      )
    )
  }

  function composer(compact, host) {
    return h(
      'div',
      { class: 'osk-composer' },
      h(
        'div',
        { class: 'osk-composer-card rounded-2xl border border-border bg-bg-000 shadow-card' },
        h(
          'div',
          { class: 'osk-composer-input text-text-300' },
          compact
            ? 'Ask anything'
            : 'Ask anything — / skills · @ files · # sessions · ⌘K search · ↑↓ history'
        ),
        h(
          'div',
          { class: '@container/composer flex items-center gap-1' },
          h(
            'span',
            {
              class:
                'relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-text-300'
            },
            icon('plus', 'size-4')
          ),
          h(
            'span',
            {
              class:
                'relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-text-300 text-[13px]'
            },
            icon('shield', 'size-4'),
            compact ? 'Ask' : 'Ask for approval',
            icon('chevronDown', 'size-3')
          ),
          h(
            'span',
            {
              class:
                'ml-auto relative flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-text-300 text-[13px]'
            },
            icon('cpu', 'size-4'),
            host || 'remote-gpu-box',
            icon('chevronDown', 'size-3')
          ),
          h(
            'span',
            {
              class:
                'osk-send grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground opacity-50'
            },
            icon('arrowUp', 'size-4')
          )
        )
      )
    )
  }

  // right panel: tab bar + file preview (as in the app's preview panel)
  function previewPanel(o) {
    const tabs = o.tabs.map((t, k) =>
      h(
        'span',
        {
          class: `osk-tab flex min-w-0 items-center gap-1 self-stretch rounded-md px-1 text-left ${k === o.active ? 'osk-tab-active bg-bg-300 text-text-000' : 'text-text-300'}`
        },
        icon(t.icon || 'file', 'size-3.5 shrink-0'),
        h('span', { class: 'min-w-0 truncate' }, t.title),
        k === o.active ? icon('x', 'size-3 shrink-0') : null
      )
    )
    const body = o.body
    return h(
      'section',
      { class: `osk-panel ${o.custom ? 'osk-panel-custom' : ''}` },
      h(
        'div',
        { class: 'osk-tabbar flex items-center gap-1' },
        tabs,
        h(
          'span',
          { class: 'ml-auto grid size-7 place-items-center rounded-md text-text-300' },
          icon('panelRight', 'size-4')
        )
      ),
      h(
        'div',
        { class: 'osk-file-head flex items-center gap-2 text-[13px] text-text-000' },
        h('span', { class: 'min-w-0 flex-1 truncate' }, o.tabs[o.active].title),
        icon('download', 'size-3.5 text-text-300'),
        icon('more', 'size-3.5 text-text-300'),
        icon('x', 'size-3.5 text-text-300')
      ),
      h(
        'div',
        { class: 'osk-file-ver flex items-center gap-2 text-[12px] text-text-300' },
        icon('chevronLeft', 'size-3'),
        'v1',
        icon('chevronRight', 'size-3')
      ),
      h('div', { class: 'osk-file-body' }, body)
    )
  }

  // Full workspace window. o = { compact, project, sections, title, messages, panel, composer: true|false }
  function workspace(o) {
    const thread = h('div', { class: 'osk-thread' }, o.messages.map(message))
    const scroller = h('div', { class: 'osk-scroller' }, thread)
    const header = h(
      'div',
      { class: 'osk-header flex items-center gap-2', 'data-testid': 'conversation-header' },
      o.compact
        ? h(
            'span',
            { class: 'grid size-9 shrink-0 place-items-center rounded-lg text-text-300' },
            icon('menu', 'size-5')
          )
        : null,
      h(
        'h1',
        { class: 'min-w-0 flex-1 text-[13px] font-semibold text-text-000' },
        h('span', { class: 'block truncate' }, o.title)
      ),
      !o.compact
        ? h(
            'span',
            { class: 'grid size-8 shrink-0 place-items-center rounded-lg text-text-300' },
            icon('panelRight', 'size-4')
          )
        : null
    )
    const conv = h(
      'div',
      { class: 'osk-conv relative flex h-full min-w-0 flex-col overflow-hidden bg-bg-10' },
      header,
      scroller,
      o.bottom || (o.composer === false ? null : composer(o.compact, o.host))
    )
    const side = o.compact ? null : sidebar(o)
    const panel = !o.compact && o.panel ? previewPanel(o.panel) : null
    const win = h(
      'div',
      { class: `osk-window ${o.compact ? 'osk-compact' : 'osk-wide'}` },
      h(
        'div',
        { class: 'osk-titlebar' },
        h('span', { class: 'osk-lights' }, h('i'), h('i'), h('i'))
      ),
      h('div', { class: 'osk-body' }, side, conv, panel)
    )
    return {
      el: win,
      thread,
      scroller,
      conv,
      side,
      panelEl: panel,
      msg: (i) => thread.querySelector(`.osk-msg[data-i="${i}"]`)
    }
  }

  // wrap first occurrence of text inside node in <mark class="osk-hl">
  function mark(root, text) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode());) {
      const k = n.data.indexOf(text)
      if (k < 0) continue
      const a = n.splitText(k)
      a.splitText(text.length)
      const m = document.createElement('mark')
      m.className = 'osk-hl'
      a.replaceWith(m)
      m.append(a)
      return m
    }
    console.warn('osk mark not found:', text)
    return null
  }

  // ---- project actions menu (WorkspaceSidebar project dropdown) ----
  function projectMenu() {
    const ITEM =
      'relative flex min-h-8 cursor-pointer items-center rounded-lg px-2 py-1.5 text-sm outline-none select-none gap-2'
    const item = (ic, label) =>
      h(
        'div',
        { role: 'menuitem', class: ITEM },
        h(
          'span',
          { class: 'flex size-4 shrink-0 items-center justify-center' },
          icon(ic, 'size-4')
        ),
        label
      )
    const imp = item('packagePlus', 'Import Session package…')
    const el = h(
      'div',
      {
        role: 'menu',
        class:
          'z-50 min-w-[8rem] overflow-hidden overscroll-contain rounded-[15px] border border-border bg-popover p-1.5 text-popover-foreground shadow-menu osk-menu'
      },
      item('settings', 'Project settings'),
      item('download', 'Download artifacts…'),
      imp
    )
    return { el, importItem: imp }
  }

  // ---- Import Session package dialog (SessionPackageOperation) ----
  // state: { phase: 'validating'|'importing'|'completed', percent, filename }
  function packageDialog(filename) {
    const statusIcon = h('div', {
      class: 'mt-0.5 flex size-6 shrink-0 items-center justify-center text-primary'
    })
    const status = h('p', { role: 'status', class: 'text-base font-semibold leading-6' })
    const meter = h('div', { class: 'osk-meter' })
    const desc = h(
      'p',
      { class: 'text-sm leading-relaxed text-muted-foreground' },
      'Import creates a new read-only window.Session. No code runs automatically.'
    )
    const footer = h('div', {
      class: 'flex shrink-0 flex-wrap justify-end gap-3 border-t border-border-300/90 px-5 py-3.5'
    })
    const panel = h(
      'div',
      {
        role: 'dialog',
        'aria-label': 'Import Session package',
        class:
          'osk-dialog flex flex-col rounded-xl border border-border bg-card p-0 text-foreground shadow-dialog'
      },
      h(
        'div',
        {
          class:
            'flex shrink-0 items-center justify-between gap-3 border-b border-border-300/90 px-5 py-3.5'
        },
        h(
          'div',
          { class: 'min-w-0 w-full space-y-1' },
          h(
            'div',
            { class: 'flex items-start gap-2' },
            h(
              'h2',
              {
                class:
                  'min-w-0 text-lg font-semibold text-text-000 min-w-0 flex-1 break-words py-0.5 leading-6'
              },
              'Import Session package'
            ),
            h(
              'div',
              { class: 'flex shrink-0 items-center gap-1' },
              button(
                icon('x', 'size-4'),
                'ghost',
                'icon-sm',
                'cursor-pointer rounded-lg text-muted-foreground'
              )
            )
          ),
          h('p', { class: 'truncate text-sm text-muted-foreground' }, filename),
          desc
        )
      ),
      h(
        'div',
        { class: 'min-w-0 p-5 min-h-0 space-y-5' },
        h(
          'div',
          { class: 'space-y-5 py-1' },
          h(
            'div',
            { class: 'flex items-start gap-3' },
            statusIcon,
            h('div', { class: 'min-w-0 flex-1 space-y-1.5' }, status)
          ),
          meter
        )
      ),
      footer
    )
    const overlay = h('div', { class: 'osk-overlay bg-black/50' })
    const el = h('div', { class: 'osk-dialog-layer' }, overlay, panel)
    let last = ''
    function set(st) {
      const key = `${st.phase}|${st.percent}`
      if (key === last) return
      last = key
      const done = st.phase === 'completed'
      statusIcon.replaceChildren(
        icon(done ? 'check' : 'loader', `size-5 ${done ? '' : 'osk-spin'}`)
      )
      status.textContent = done
        ? 'Package operation completed'
        : st.phase === 'validating'
          ? 'Validating package…'
          : 'Importing research…'
      desc.style.display = done ? '' : 'none'
      if (st.phase === 'validating')
        meter.replaceChildren(
          h(
            'div',
            { role: 'progressbar', class: 'h-2 w-full overflow-hidden rounded-full bg-muted' },
            h('div', { class: 'osk-indet h-full w-1/3 rounded-full bg-primary' })
          )
        )
      else if (st.phase === 'importing') {
        const p = Math.floor(st.percent)
        meter.replaceChildren(
          h(
            'div',
            { class: 'space-y-2' },
            h(
              'div',
              { class: 'flex items-baseline justify-between gap-3' },
              h('span', { class: 'text-xs text-muted-foreground' }, 'Current stage'),
              h('span', { class: 'text-xl font-semibold tabular-nums' }, `${p}%`)
            ),
            h(
              'div',
              { class: 'osk-progress h-2 w-full overflow-hidden rounded-full bg-muted' },
              h('div', { class: 'h-full rounded-full bg-primary', style: { width: `${p}%` } })
            ),
            h(
              'div',
              {
                class:
                  'flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground'
              },
              h('span', {}, `${((26.9 * p) / 100).toFixed(1)} MB / 26.9 MB`),
              h('span', {}, `Files: ${Math.round((240 * p) / 100)} / 240`)
            )
          )
        )
      } else meter.replaceChildren()
      footer.replaceChildren(
        ...(done
          ? [
              button('Close', 'outline'),
              button('Open imported Session', 'default', 'default', 'osk-open-btn')
            ]
          : [button('Cancel', 'ghost'), button('Run in background', 'default')])
      )
    }
    set({ phase: 'validating' })
    return { el, panel, overlay, set, openButton: () => footer.querySelector('.osk-open-btn') }
  }

  // ---- Replay panel for an imported Session (SessionReplayPreview: ReplaySourceDetails + transcript + ReplayControls) ----
  function replayPanel(o) {
    const transcript = h(
      'section',
      {
        'aria-label': 'Historical conversation',
        class:
          'osk-replay-transcript relative min-h-0 min-w-0 overflow-hidden border-border-200 bg-bg-000 px-4 py-3'
      },
      h(
        'div',
        { class: 'osk-replay-inner' },
        h(
          'details',
          { open: '', class: 'text-xs text-text-300 osk-source' },
          h(
            'summary',
            { class: 'cursor-pointer font-medium text-text-100' },
            'Imported research history'
          ),
          h('p', { class: 'mt-2' }, `Imported on ${o.importedOn}`),
          h('p', { class: 'mt-2 leading-5' }, `Source: ${o.sourceFile} · ${o.counts}`)
        ),
        o.steps.map((s) =>
          h(
            'div',
            { class: 'osk-replay-step' },
            h('div', { class: 'mb-1 text-xs font-medium text-text-300' }, s.who),
            s.who === 'User'
              ? h(
                  'div',
                  { class: 'flex min-w-0 flex-col items-end' },
                  h(
                    'div',
                    {
                      'data-slot': 'user-message-bubble',
                      class:
                        'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text'
                    },
                    h('div', { class: 'whitespace-pre-wrap break-words' }, s.text)
                  )
                )
              : h('div', { class: 'text-sm leading-relaxed text-text-000' }, markdown(s.text)),
            s.meta
              ? h(
                  'div',
                  {
                    class:
                      'mt-1 flex min-h-6 w-full items-center justify-end text-[11px] leading-4 text-text-000/70 tabular-nums'
                  },
                  s.meta
                )
              : null
          )
        )
      )
    )
    const fill = h('div', { class: 'absolute h-full bg-primary' })
    const thumb = h('span', {
      class: 'osk-thumb relative z-10 block size-3 rounded-full bg-primary'
    })
    const time = h('span', {
      class: 'osk-replay-time font-mono text-xs tabular-nums text-muted-foreground'
    })
    const stepLabel = h('span', { class: 'min-w-0 truncate' })
    const stepCount = h('span', { class: 'ml-auto shrink-0 tabular-nums text-muted-foreground' })
    const playBtn = button(icon('play', 'size-3.5'), 'ghost', 'icon-sm', 'osk-play text-text-000')
    const controls = h(
      'div',
      {
        class: 'shrink-0 space-y-1 border-t border-border-200 bg-bg-000 px-3 py-2',
        'data-testid': 'replay-controls'
      },
      h(
        'div',
        { class: 'flex min-w-0 items-center gap-1', 'data-testid': 'replay-step-actions' },
        playBtn,
        h(
          'button',
          {
            type: 'button',
            class: `${BTN} h-8 min-w-0 max-w-xl flex-1 justify-start gap-2 px-1 text-xs`
          },
          icon('msg', 'size-3.5'),
          stepLabel,
          stepCount,
          icon('chevronDown', 'size-3')
        ),
        time
      ),
      h(
        'div',
        {
          class: 'group/timeline relative flex h-6 items-center',
          'data-testid': 'replay-timeline'
        },
        h(
          'div',
          { class: 'relative flex h-6 w-full touch-none select-none items-center' },
          h(
            'div',
            { class: 'relative h-1 w-full grow overflow-hidden rounded-full bg-muted osk-track' },
            fill,
            ...o.breaks.map((b) =>
              h('span', {
                class: 'pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-bg-000',
                style: { left: `${b}%` }
              })
            )
          ),
          thumb
        )
      )
    )
    const el = h(
      'div',
      {
        class: 'osk-replay flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg-000 text-text-100',
        'data-testid': 'replay-panel'
      },
      h(
        'div',
        { class: 'osk-replay-head flex items-center gap-2 border-b border-border-200' },
        h(
          'span',
          { class: 'min-w-0 flex-1 truncate text-[13px] font-semibold text-text-000' },
          o.title
        ),
        h(
          'span',
          { class: 'rounded-full border border-border-200 px-3 py-1 text-xs text-text-300' },
          'Read-only research history'
        )
      ),
      transcript,
      controls
    )
    function set(p, stepIndex, label, total, clock) {
      fill.style.width = `${p * 100}%`
      thumb.style.left = `calc(${p * 100}% - 6px)`
      stepLabel.textContent = label
      stepCount.textContent = `${stepIndex + 1} / ${total}`
      time.textContent = clock
    }
    return { el, transcript, inner: transcript.firstChild, set }
  }

  window.OSKit = {
    h,
    icon,
    markdown,
    workspace,
    message,
    toolGroup,
    mark,
    packageDialog,
    replayPanel,
    button,
    projectMenu
  }
})()

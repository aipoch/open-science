/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
// FlyCube session rendered with the native Open-Science UI kit (os-kit.js).
// Drop-in replacement for style 01's old hand-made js/session.js: same API — window.Session.build(root, data, compact) / window.Session.mark(...).
;(() => {
  const K = window.OSKit

  // session-en.json step rows -> app tool rows (Skill / Notebook run)
  const rowOf = (r) => {
    if (/^Loading skill /.test(r))
      return { icon: 'zap', label: 'Skill', detail: r.replace(/^Loading skill /, '') }
    if (/^host\.|^\w+\(|\(\)|\.py|--/.test(r))
      return { icon: 'book', label: 'Notebook run', detail: r }
    return { icon: 'book', label: 'Notebook run', detail: r }
  }

  function messages(session) {
    return session.messages.map((m, index) => ({
      i: m.i ?? index,
      role: m.role,
      md: m.md,
      steps: m.steps
        ? {
            title: m.steps.title,
            meta: m.steps.meta,
            expanded: true,
            rows: m.steps.rows.map(rowOf)
          }
        : null,
      completed: m.status ? m.status.replace(' · ', ' ') : null
    }))
  }

  function build(root, data, compact, opts = {}) {
    const s = data.session
    const sidebar = Array.isArray(s.sidebar) ? s.sidebar : []
    const preview = data.preview
    const ws = K.workspace({
      compact,
      project: s.project,
      title: s.sessionTitle,
      sections: [
        {
          label: 'Active',
          items: [
            {
              title: s.sessionTitle,
              active: true,
              status: opts.imported ? 'idle' : 'done',
              imported: !!opts.imported
            }
          ]
        },
        ...(sidebar.length > 1
          ? [{ label: 'Earlier', items: sidebar.slice(1).map((t) => ({ title: t })) }]
          : [])
      ],
      messages: messages(s),
      composer: opts.imported ? false : true,
      host: s.hostLabel,
      bottom: opts.bottom || null,
      panel:
        opts.panel !== undefined
          ? opts.panel
          : preview
            ? {
                tabs: preview.tabs || [
                  { title: preview.name, icon: 'fileJson' },
                  { title: 'lora_front18_depth9_r4.json', icon: 'fileJson' },
                  { title: 'beam_eval_lora.py', icon: 'file' }
                ],
                active: 0,
                body: preview.node || preview.text.split('\n').slice(0, 80).join('\n')
              }
            : null
    })
    root.append(ws.el)
    return { app: ws.el, thread: ws.thread, scroller: ws.scroller, ws }
  }

  // highlight text inside message i
  function mark(thread, i, text) {
    const m = thread.querySelector(`.osk-msg[data-i="${i}"]`)
    return m ? K.mark(m, text) : null
  }

  window.Session = { build, mark }
})()

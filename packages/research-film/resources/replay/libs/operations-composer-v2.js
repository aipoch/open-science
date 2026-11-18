/* eslint-disable @typescript-eslint/explicit-function-return-type -- Vendored standalone browser runtime. */
// Native Open-Science 1.2.0 composer geometry, staged by the video clock.
// No installed-app settings, network requests, or interactive state are changed.
;(() => {
  const S = '.stage[data-operations][data-ops-version="2"]'
  const style = document.createElement('style')
  style.textContent = `
    ${S} .oc2-root{position:absolute;left:16px;right:6px;bottom:58px;padding:0 24px;z-index:20;font:14px/1.5 Inter,sans-serif;color:var(--text-000);pointer-events:none}
    ${S}[data-mixed-chapter=compose] .oc2-root{bottom:12px}
    ${S} .oc2-inner{position:relative;width:100%;max-width:896px;margin:0 auto}
    ${S} .oc2-plan-host:empty{display:none}
    ${S} .oc2-notebook-strip{position:relative;display:flex;min-height:68px;align-items:flex-start;margin-bottom:-32px;padding:4px 8px 0;border-radius:16px;background:var(--bg-200)}
    ${S} .oc2-notebook{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--text-100);font:400 12px/1.5 Inter,sans-serif}
    ${S} .oc2-notebook .oc2-icon{width:14px;height:14px}
    ${S} .oc2-card{position:relative;z-index:1;display:flex;flex-direction:column;gap:8px;padding:8px 12px;border:1px solid var(--border,var(--color-border-200));border-radius:16px;background:var(--bg-000);margin:0;box-shadow:none}
    ${S} .oc2-input-wrap{position:relative;min-width:0;flex:1}
    ${S} .oc2-input{min-height:36px;max-height:200px;width:100%;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:transparent;padding:6px 0;font:15px/1.625 Inter,sans-serif;color:var(--text-000);outline:none;scrollbar-width:thin}
    ${S} .oc2-input[data-new=true]{min-height:80px}
    ${S} .oc2-placeholder{position:absolute;left:0;right:0;top:0;padding:6px 28px 6px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:15px/1.625 Inter,sans-serif;color:var(--muted-foreground,var(--text-300))}
    ${S} .oc2-help{position:absolute;right:0;top:8px;color:var(--text-300)}
    ${S} .oc2-help .oc2-icon{width:14px;height:14px}
    ${S} .oc2-caret{display:inline-block;width:1.5px;height:16px;margin-left:1px;background:var(--text-000);vertical-align:-2px}
    ${S} .oc2-uploads{display:flex;max-height:92px;flex-wrap:wrap;gap:8px;overflow-y:auto;border-bottom:1px solid var(--border,var(--color-border-200));padding-bottom:8px;scrollbar-width:thin}
    ${S} .oc2-chip{display:flex;height:36px;min-width:0;max-width:220px;align-items:center;gap:8px;padding:0 8px;border:1px solid var(--color-border-200);border-radius:8px;background:var(--bg-200);color:var(--text-000)}
    ${S} .oc2-file-icon{display:inline-flex;width:20px;height:20px;flex:none;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,var(--color-border-200) 60%,transparent);border-radius:6px;background:var(--bg-200);padding:2px;color:var(--text-300)}
    ${S} .oc2-file-icon .oc2-icon{width:100%;height:100%;stroke-width:2.4}
    ${S} .oc2-chip-text{min-width:0;flex:1}
    ${S} .oc2-file-name{display:flex;min-width:0;font:12px/16px Inter,sans-serif}
    ${S} .oc2-file-stem{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    ${S} .oc2-file-ext{flex:none;white-space:nowrap}
    ${S} .oc2-file-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/12px Inter,sans-serif;color:var(--text-300)}
    ${S} .oc2-remove{display:flex;width:24px;height:24px;flex:none;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--text-300)}
    ${S} .oc2-remove .oc2-icon{width:14px;height:14px;stroke-width:2.2}
    ${S} .oc2-progress{height:2px;margin-top:4px;overflow:hidden;border-radius:999px;background:var(--bg-300)}
    ${S} .oc2-progress-fill{height:100%;border-radius:999px;background:var(--primary)}
    ${S} .oc2-toolbar{container-type:inline-size;display:flex;align-items:center;gap:4px;height:32px;min-width:0}
    ${S} .oc2-tool{position:relative;display:flex;height:32px;min-width:32px;flex:none;align-items:center;justify-content:center;gap:4px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--text-300);font:13px/20px Inter,sans-serif}
    ${S} .oc2-tool[data-hover=true]{background:var(--bg-200);color:var(--text-100)}
    ${S} .oc2-icon{display:block;width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    ${S} .oc2-dot{position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:var(--primary);box-shadow:0 0 0 1px var(--bg-000)}
    ${S} .oc2-flex-space{flex:1;min-width:0}
    ${S} .oc2-context{height:32px;display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:6px;font:12px/1.5 Inter,sans-serif;white-space:nowrap}
    ${S} .oc2-context .oc2-icon{width:14px;height:14px}
    ${S} .oc2-model{display:flex;height:32px;min-width:0;max-width:220px;flex-shrink:1;align-items:center;gap:4px;border:0;border-radius:6px;padding:0 10px;background:transparent;font:14px/1.5 Inter,sans-serif;color:var(--text-300)}
    ${S} .oc2-provider{width:16px;height:16px;flex:none}
    ${S} .oc2-model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--text-000)}
    ${S} .oc2-effort{margin-left:2px;white-space:nowrap;color:var(--text-300)}
    ${S} .oc2-model .oc2-chevron,${S} .oc2-model .oc2-chevron .oc2-icon{width:14px;height:14px}
    ${S} .oc2-send{display:flex;flex:none;border-radius:6px;overflow:hidden;background:var(--primary);color:var(--primary-foreground)}
    ${S} .oc2-send button{position:relative;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:0;background:transparent;color:inherit}
    ${S} .oc2-send button[aria-disabled=true]{opacity:.5}
    ${S} .oc2-send-main .oc2-icon{width:16px;height:16px;stroke-width:2.2}
    ${S} .oc2-send-more .oc2-icon{width:14px;height:14px;stroke-width:2.2}
    ${S} .oc2-send-more:after{content:'';position:absolute;left:0;top:8px;bottom:8px;width:1px;background:color-mix(in srgb,var(--primary-foreground) 20%,transparent)}
    ${S} .oc2-send-more[data-hover=true]{background:color-mix(in srgb,var(--primary-foreground) 10%,transparent)}
    ${S} .oc2-send[data-running=true]{width:64px;justify-content:flex-end;border-radius:8px;background:var(--bg-200);color:var(--text-000)}
    ${S} .oc2-send[data-running=true] button{border:1px solid transparent}
    ${S} .oc2-send[data-running=true] .oc2-send-main{color:var(--text-000)}
    ${S} .oc2-send[data-running=true] .oc2-send-main[data-hover=true]{background:var(--bg-300)}
    ${S} .oc2-send[data-running=true] .oc2-send-main .oc2-icon{width:14px;height:14px}
    ${S} .oc2-send[data-running=true] .oc2-send-more{color:var(--text-300)}
    ${S} .oc2-send[data-running=true] .oc2-send-more .oc2-icon{stroke-width:2}
    ${S} .oc2-send[data-running=true] .oc2-send-more:after{top:20%;bottom:20%;background:currentColor;opacity:.2}
    ${S} .oc2-send[data-running=true] .oc2-send-more[data-hover=true]{background:var(--bg-200);color:var(--text-100)}
    ${S} .oc2-plan-progress{display:flex;align-items:center;flex:none}
    ${S} .oc2-plan-progress button{display:flex;align-items:center;gap:4px;height:28px;border:1px solid transparent;border-radius:6px;background:transparent;padding:4px 10px;color:var(--text-100);font:400 12px/16px Inter,sans-serif}
    ${S} .oc2-plan-progress .oc2-icon{width:14px;height:14px}
    ${S} .oc2-plan-progress-count{font-variant-numeric:tabular-nums}
    ${S} .oc2-menu{position:absolute;z-index:60;min-width:128px;padding:4px;border:1px solid var(--border,#dededa);border-radius:15px;background:var(--popover,#fff);color:var(--popover-foreground,var(--text-000));box-shadow:0 2px 8px #00000014;font:13px/20px Inter,sans-serif;overflow:visible}
    ${S} .oc2-controls-menu,${S} .oc2-permission-menu{width:288px}
    ${S} .oc2-add-menu,${S} .oc2-send-menu{width:224px}
    ${S} .oc2-menu-row{position:relative;display:flex;min-height:32px;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font:500 13px/20px Inter,sans-serif;white-space:nowrap}
    ${S} .oc2-menu-row[data-hover=true]{background:var(--bg-200)}
    ${S} .oc2-menu-row[data-disabled=true]{opacity:.5}
    ${S} .oc2-menu-row>.oc2-icon{width:16px;height:16px;color:var(--text-200,var(--text-300))}
    ${S} .oc2-menu-label{padding:6px 8px;font:500 12px/20px Inter,sans-serif;color:var(--text-300)}
    ${S} .oc2-menu-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
    ${S} .oc2-separator{height:1px;margin:4px -4px;background:var(--border,#dededa)}
    ${S} .oc2-capsule{display:flex;flex:none;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:var(--bg-200);color:var(--text-100);font:500 11px/16px Inter,sans-serif;white-space:nowrap}
    ${S} .oc2-capsule .oc2-icon{width:12px;height:12px}
    ${S} .oc2-capsule[data-profile=full]{background:color-mix(in srgb,var(--color-status-warning-surface,#fff4d5) 10%,transparent);color:var(--color-status-warning-foreground,oklch(55.5% .163 48.998))}
    ${S} .oc2-capsule[data-profile=auto]{background:#3b82f61a;color:#2563eb}
    ${S} .oc2-full-option>.oc2-icon,${S} .oc2-full-option .oc2-menu-text{color:var(--color-status-warning-foreground,oklch(55.5% .163 48.998))}
    ${S} .oc2-profile-check{margin-left:auto;width:16px;height:16px;color:var(--text-000)}
    ${S} .oc2-switch{display:flex;width:24px;height:14px;flex:none;align-items:center;padding:1px;border-radius:999px;background:var(--input,#dededa)}
    ${S} .oc2-switch i{display:block;width:12px;height:12px;flex:none;border-radius:50%;background:var(--background,#fafaf8)}
    ${S} .oc2-switch[data-on=true]{background:var(--primary);justify-content:flex-end}
    ${S} .oc2-tooltip{position:absolute;z-index:65;max-width:288px;padding:4px 8px;border-radius:6px;background:var(--text-000);color:var(--bg-000);font:11px/16px Inter,sans-serif;white-space:normal;box-shadow:0 4px 6px #0000001a}
    ${S} .oc2-confirm-layer{position:absolute;inset:0;z-index:75;display:flex;align-items:center;justify-content:center;pointer-events:none}
    ${S} .oc2-dialog-shade{position:absolute;inset:0;background:#00000080}
    ${S} .oc2-dialog{position:relative;z-index:1;width:440px;max-width:calc(100% - 32px);border:1px solid var(--border,#dededa);border-radius:12px;background:var(--card,var(--bg-000));color:var(--foreground,var(--text-000));overflow:hidden;box-shadow:0 20px 60px #0003;font:14px/1.5 Inter,sans-serif}
    ${S} .oc2-dialog-head{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border,#dededa)}
    ${S} .oc2-warning-icon{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;border-radius:50%;background:var(--color-status-warning-surface,#fff4d5);color:var(--color-status-warning-foreground,oklch(55.5% .163 48.998))}
    ${S} .oc2-warning-icon .oc2-icon{width:20px;height:20px}
    ${S} .oc2-dialog-title{flex:1;font:600 16px/24px Inter,sans-serif}
    ${S} .oc2-dialog-close{border:0;background:transparent;color:var(--text-300);padding:4px}
    ${S} .oc2-dialog-body{padding:20px;font:14px/1.625 Inter,sans-serif;color:var(--muted-foreground,var(--text-300))}
    ${S} .oc2-dialog-actions{display:flex;justify-content:flex-end;gap:12px;border-top:1px solid var(--border,#dededa);padding:14px 20px}
    ${S} .oc2-dialog-button{height:32px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--foreground,var(--text-000));font:500 14px/20px Inter,sans-serif}
    ${S} .oc2-dialog-button.enable{background:var(--color-status-warning-surface,#fff4d5);color:var(--color-status-warning-foreground,oklch(55.5% .163 48.998))}
    @container (max-width:448px){${S} .oc2-context-label{display:none}}
  `
  document.head.append(style)

  const OPENAI_NATIVE_SRC =
    "data:image/svg+xml,%3csvg%20fill='%236B7280'%20role='img'%20viewBox='0%200%2024%2024'%20xmlns='http://www.w3.org/2000/svg'%3e%3ctitle%3eOpenAI%3c/title%3e%3cpath%20d='M22.2819%209.8211a5.9857%205.9857%200%200%200-.516-4.9108%206.0555%206.0555%200%200%200-6.5094-2.9A5.9856%205.9856%200%200%200%2010.583%200a6.0645%206.0645%200%200%200-5.7968%204.2053%205.9857%205.9857%200%200%200-3.997%202.9001%206.0555%206.0555%200%200%200%20.743%207.04%205.9857%205.9857%200%200%200%20.516%204.9108%206.0555%206.0555%200%200%200%206.5094%202.9A5.9856%205.9856%200%200%200%2013.417%2024a6.0645%206.0645%200%200%200%205.7968-4.2053%205.9857%205.9857%200%200%200%203.997-2.9001%206.0555%206.0555%200%200%200-.9289-7.0735Zm-9.1138%2012.1528a4.5012%204.5012%200%200%201-2.8916-1.0402l.1432-.0812%204.8012-2.7706a.7652.7652%200%200%200%20.3892-.665v-6.7722l2.0298%201.1718a.074.074%200%200%201%20.0407.058v5.6024a4.5268%204.5268%200%200%201-4.5125%204.497ZM3.46%2019.3192a4.5023%204.5023%200%200%201-.5402-3.0247l.1431.0856%204.8056%202.7706a.766.766%200%200%200%20.771%200l5.8664-3.3811v2.3435a.076.076%200%200%201-.0291.0624L9.62%2021.0008a4.5268%204.5268%200%200%201-6.16-1.6816ZM2.1969%208.5483a4.5013%204.5013%200%200%201%202.3315-1.9823v5.7087a.766.766%200%200%200%20.3892.665l5.8619%203.3766-2.0298%201.1718a.074.074%200%200%201-.0693%200l-4.849-2.7929A4.5268%204.5268%200%200%201%202.1969%208.5483Zm16.6673%203.8798-5.8619-3.3811%202.0298-1.1718a.074.074%200%200%201%20.0693%200l4.849%202.7974a4.5268%204.5268%200%200%201-.6982%208.1588v-5.7087a.766.766%200%200%200-.3892-.6946Zm2.0209-3.0425-.1431-.0856-4.8012-2.7974a.766.766%200%200%200-.771%200l-5.8619%203.3811v-2.3435a.076.076%200%200%201%20.0291-.0624l4.8579-2.8019a4.5268%204.5268%200%200%201%206.6902%204.7092ZM8.1814%2013.9406%206.1516%2012.7688a.074.074%200%200%201-.0407-.058V7.104a4.5268%204.5268%200%200%201%207.4158-3.4662l-.1431.0812-4.8012%202.7706a.7652.7652%200%200%200-.3892.665v6.786Z'/%3e%3c/svg%3e"
  const clamp = (x) => Math.max(0, Math.min(1, x))
  const interval = (p, a, b) => clamp((p - a) / (b - a))
  const visible = (node, on) => {
    node.style.display = on ? '' : 'none'
  }

  window.OPSComposerV2 = {
    create({ K, h = K.h, D = {}, workspace, targets = {} }) {
      const icon = (name, size = 16) => {
        const paths = window.LUCIDE?.[name]
        if (!paths) {
          const aliases = {
            'book-open': 'book',
            'file-text': 'file',
            'arrow-up': 'arrowUp',
            'chevron-down': 'chevronDown',
            'chevron-right': 'chevronRight',
            'shield-alert': 'shield',
            'shield-check': 'shield',
            'triangle-alert': 'shield'
          }
          const fallback = K.icon(aliases[name] || name)
          fallback.classList.add('oc2-icon')
          fallback.style.width = `${size}px`
          fallback.style.height = `${size}px`
          return fallback
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        Object.entries({
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          class: 'oc2-icon',
          'aria-hidden': 'true',
          width: size,
          height: size
        }).forEach(([key, value]) => svg.setAttribute(key, value))
        paths.forEach((d) => {
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', d)
          svg.append(path)
        })
        return svg
      }
      const track = (name, node) => {
        if (name) targets[name] = node
        return node
      }
      const tool = (name, title, graphic) =>
        track(
          name,
          h('button', { type: 'button', class: 'oc2-tool', 'aria-label': title }, graphic)
        )
      const row = (graphic, label, tail, target) =>
        track(
          target,
          h(
            'div',
            { class: 'oc2-menu-row', role: 'menuitem' },
            graphic ? icon(graphic) : null,
            h('span', { class: 'oc2-menu-text' }, label),
            tail
          )
        )
      const switchEl = (on) =>
        h('span', { class: 'oc2-switch', 'data-on': String(on), 'aria-hidden': 'true' }, h('i'))
      const sep = () => h('div', { class: 'oc2-separator' })
      const menu = (cls, ...kids) => h('div', { class: `oc2-menu ${cls}`, role: 'menu' }, ...kids)
      const chevron = () => icon('chevron-right', 12)
      const attachments = Array.isArray(D.attachments) ? D.attachments : []
      const uploadList = h('div', { class: 'oc2-uploads' }),
        uploadNodes = []
      attachments.forEach((f) => {
        const fileName = String(f.name || 'attachment'),
          lastDot = fileName.lastIndexOf('.')
        const stem = lastDot > 0 ? fileName.slice(0, lastDot) : fileName,
          ext = lastDot > 0 ? fileName.slice(lastDot) : ''
        const meta = h('div', { class: 'oc2-file-meta' }),
          barFill = h('div', { class: 'oc2-progress-fill' }),
          bar = h('div', { class: 'oc2-progress', role: 'progressbar' }, barFill)
        const fileType = /\.(xlsx?|csv|tsv)$/i.test(fileName)
          ? 'file-spreadsheet'
          : /\.(tar|gz|zip|7z)$/i.test(fileName)
            ? 'file-archive'
            : 'file-text'
        const chip = h(
          'div',
          { class: 'oc2-chip' },
          h('span', { class: 'oc2-file-icon' }, icon(fileType)),
          h(
            'div',
            { class: 'oc2-chip-text' },
            h(
              'div',
              { class: 'oc2-file-name', title: fileName },
              h('span', { class: 'oc2-file-stem' }, stem),
              h('span', { class: 'oc2-file-ext' }, ext)
            ),
            meta,
            bar
          ),
          h(
            'button',
            { type: 'button', class: 'oc2-remove', 'aria-label': `Remove attachment ${fileName}` },
            icon('x', 14)
          )
        )
        uploadList.append(chip)
        uploadNodes.push({ chip, meta, bar, barFill, file: f })
      })
      const input = track(
        'draft',
        h('div', {
          class: 'oc2-input',
          role: 'textbox',
          'aria-label': 'Ask anything',
          'aria-multiline': 'true',
          'data-testid': 'composer-input'
        })
      )
      const placeholder = h(
        'div',
        { class: 'oc2-placeholder' },
        'Ask anything — / skills · @ files · # sessions · Ctrl+K search · ↑↓ history'
      )
      const inputWrap = h(
        'div',
        { class: 'oc2-input-wrap' },
        input,
        placeholder,
        h('span', { class: 'oc2-help' }, icon('circle-question-mark', 14))
      )
      const add = tool(
        'add',
        'Add attachment, save as skill, view context window, or request review',
        icon('plus')
      )
      add.setAttribute('data-testid', 'composer-plus-trigger')
      const indicator = h('i', { class: 'oc2-dot' }),
        controls = tool('controls', 'Agent controls', icon('sliders-horizontal'))
      controls.setAttribute('data-testid', 'composer-controls-trigger')
      controls.append(indicator)
      const context = h(
        'span',
        { class: 'oc2-context' },
        icon('gauge', 14),
        h('span', { class: 'oc2-context-label' })
      )
      const contextValue = context.lastChild
      const modelName = String(D.agentModel || 'gpt-6.1-sol')
      const effort = D.agentReasoningEffort || D.reasoningEffort
      const effortLabels = {
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Max'
      }
      const model = h(
        'button',
        { type: 'button', class: 'oc2-model', 'aria-label': 'Select model' },
        h('img', { class: 'oc2-provider', src: OPENAI_NATIVE_SRC, alt: '' }),
        h('span', { class: 'oc2-model-name' }, modelName),
        effort && effort !== 'default'
          ? h('span', { class: 'oc2-effort' }, `· ${effortLabels[effort] || effort}`)
          : null,
        h('span', { class: 'oc2-chevron' }, icon('chevron-down', 14))
      )
      const send = track(
        'send',
        h(
          'button',
          { type: 'button', class: 'oc2-send-main', 'aria-label': 'Send message' },
          icon('arrow-up')
        )
      )
      const sendMore = track(
        'sendMore',
        h(
          'button',
          {
            type: 'button',
            class: 'oc2-send-more',
            'aria-label': 'More send options',
            'data-testid': 'branch-send-menu-trigger'
          },
          icon('chevron-down', 14)
        )
      )
      const sendBlock = track(
        'sendBlock',
        h(
          'div',
          { class: 'oc2-send', role: 'group', 'aria-label': 'Send message options' },
          send,
          sendMore
        )
      )
      targets.cancelRun = send
      const toolbar = h(
        'div',
        { class: 'oc2-toolbar' },
        add,
        controls,
        h('span', { class: 'oc2-flex-space' }),
        context,
        model,
        sendBlock
      )
      const card = h(
        'form',
        { class: 'oc2-card', 'data-testid': 'ordinary-composer-form' },
        uploadList,
        inputWrap,
        toolbar
      )
      card.addEventListener('submit', (event) => event.preventDefault())
      const notebook = h(
        'div',
        { class: 'oc2-notebook-strip' },
        h(
          'button',
          { type: 'button', class: 'oc2-notebook', 'aria-label': 'Open notebook' },
          icon('book-open', 14),
          'Notebook'
        )
      )
      const planHost = h('div', { class: 'oc2-plan-host', 'data-testid': 'plan-composer-host' })
      const progressCount = h('span', { class: 'oc2-plan-progress-count' })
      const progressButton = h(
        'button',
        { type: 'button', 'aria-label': 'Open plan' },
        icon('list-checks', 14),
        progressCount
      )
      const planProgress = track(
        'planProgress',
        h(
          'div',
          { class: 'oc2-plan-progress', 'data-testid': 'plan-progress-strip' },
          progressButton
        )
      )
      notebook.prepend(planProgress)
      const inner = h('div', { class: 'oc2-inner' }, planHost, notebook, card)
      const composer = h('div', { class: 'oc2-root' }, inner)

      const profileIcon = h('span'),
        profileText = h('span'),
        capsule = h(
          'span',
          { class: 'oc2-capsule', 'data-testid': 'profile-capsule' },
          profileIcon,
          profileText,
          chevron()
        )
      const permissionRow = row('shield', 'Permission mode', capsule, 'permission')
      const autoSwitch = switchEl(false),
        memorySwitch = switchEl(D.memoryEnabled ?? false),
        delegationSwitch = switchEl(D.delegationEnabled ?? true)
      const autoReview = row('scan-eye', 'Auto-review', autoSwitch, 'autoReview')
      autoReview.setAttribute('data-ops', 'auto-review')
      const controlsMenu = menu(
        'oc2-controls-menu',
        permissionRow,
        sep(),
        autoReview,
        row('brain-circuit', 'Memory', memorySwitch),
        row('git-fork', 'Delegation', delegationSwitch),
        sep(),
        row(
          'user-round',
          'Specialist',
          h('span', { class: 'oc2-capsule' }, D.specialistLabel || 'None', chevron())
        ),
        sep(),
        row(
          'server',
          'Compute',
          D.computeStatusLabel
            ? h('span', { class: 'oc2-capsule' }, D.computeStatusLabel, chevron())
            : chevron()
        )
      )
      const profiles = [
        ['ask', 'shield', 'Ask for approval'],
        ['auto', 'shield-check', 'Auto-approve edits'],
        ['full', 'shield-alert', 'Full access']
      ]
      const profileRows = profiles.map(([id, graphic, label]) => {
        const check = icon('check')
        check.classList.add('oc2-profile-check')
        const node = row(graphic, label, check, `profile-${id}`)
        node.dataset.profile = id
        if (id === 'full') node.classList.add('oc2-full-option')
        return { id, node, check }
      })
      const permissionMenu = menu('oc2-permission-menu', ...profileRows.map((r) => r.node))
      const attachFiles = row(
        'file-text',
        'Attach files',
        icon('circle-question-mark', 14),
        'addFiles'
      )
      attachFiles.setAttribute('data-testid', 'menu-attach-files')
      const addMenu = menu(
        'oc2-add-menu',
        h('div', { class: 'oc2-menu-label' }, 'Files'),
        attachFiles,
        row('folder', 'Your files', chevron()),
        sep(),
        h('div', { class: 'oc2-menu-label' }, 'Conversation actions'),
        row('scan-eye', 'Request review'),
        sep(),
        row('book-marked', 'Save as skill'),
        sep(),
        row('chart-no-axes-combined', 'Context window')
      )
      const planFirst = row('list-checks', 'Plan first', null, 'planFirst')
      planFirst.setAttribute('data-testid', 'menu-plan-first')
      const sendMenu = menu(
        'oc2-send-menu',
        planFirst,
        row('message-circle', 'New side chat'),
        row('git-branch', 'Branch in new session')
      )
      const reviewerTooltip = h(
        'div',
        { class: 'oc2-tooltip', role: 'tooltip' },
        'A reviewer agent checks every change before it lands.'
      )
      inner.append(controlsMenu, permissionMenu, addMenu, sendMenu, reviewerTooltip)

      const enable = track(
        'enableFull',
        h('button', { type: 'button', class: 'oc2-dialog-button enable' }, 'Enable')
      )
      const confirmLayer = h(
        'div',
        { class: 'oc2-confirm-layer' },
        h('div', { class: 'oc2-dialog-shade' }),
        h(
          'section',
          { class: 'oc2-dialog', role: 'alertdialog', 'aria-label': 'Enable Full access?' },
          h(
            'div',
            { class: 'oc2-dialog-head' },
            h('span', { class: 'oc2-warning-icon' }, icon('triangle-alert', 20)),
            h('div', { class: 'oc2-dialog-title' }, 'Enable Full access?'),
            h('span', { class: 'oc2-dialog-close' }, icon('x'))
          ),
          h(
            'div',
            { class: 'oc2-dialog-body' },
            'The agent can run commands, change files, execute notebook code, and make network requests without asking first. Authentication failures and execution errors can still stop the run.'
          ),
          h(
            'div',
            { class: 'oc2-dialog-actions' },
            h('button', { type: 'button', class: 'oc2-dialog-button' }, 'Cancel'),
            enable
          )
        )
      )
      workspace.ws.conv.querySelector('.osk-composer')?.remove()
      workspace.ws.conv.querySelector('.ops-composer')?.remove()
      workspace.ws.conv.append(composer)
      workspace.app.append(confirmLayer)
      const stage = workspace.app.closest('.stage')
      const placeAbove = (popup, anchor, alignEnd = false) => {
        const box = inner.getBoundingClientRect(),
          a = anchor.getBoundingClientRect(),
          scale = inner.offsetWidth / box.width || 1
        let left =
          (alignEnd ? a.right - box.left : a.left - box.left) * scale -
          (alignEnd ? popup.offsetWidth : 0)
        const minLeft = -Math.max(0, inner.offsetLeft) + 4,
          maxLeft = workspace.ws.conv.clientWidth - inner.offsetLeft - popup.offsetWidth - 4
        left = Math.max(minLeft, Math.min(maxLeft, left))
        popup.style.left = `${left}px`
        popup.style.bottom = `${(box.bottom - a.top) * scale + 8}px`
        popup.style.top = 'auto'
      }
      function sync(s = {}) {
        const p = clamp(Number(s.progress) || 0),
          composing = s.scene === 'compose'
        const draft =
          composing && p >= 0.1 && p < 0.985
            ? String(
                s.typedPrompt ??
                  String(D.prompt || '').slice(
                    0,
                    Math.floor(String(D.prompt || '').length * interval(p, 0.1, 0.5))
                  )
              )
            : ''
        input.replaceChildren(
          ...[
            draft,
            composing && p >= 0.1 && p < 0.5 ? h('i', { class: 'oc2-caret' }) : null
          ].filter((v) => v !== null)
        )
        input.dataset.new = String(composing)
        visible(placeholder, !draft)
        visible(inputWrap.querySelector('.oc2-help'), !draft)
        const awaitPlan = s.scene === 'plan' && p >= 0.26 && s.planStatus !== 'approved'
        visible(card, !awaitPlan)
        visible(notebook, !awaitPlan) // Plan module owns planHost contents and visibility.
        visible(planProgress, Boolean(s.planProgress))
        if (s.planProgress) {
          progressCount.textContent = `step ${s.planProgress.completed}/${s.planProgress.total}`
          progressButton.setAttribute(
            'aria-label',
            `Open plan, step ${s.planProgress.completed} of ${s.planProgress.total}`
          )
        }
        const states = Array.isArray(s.uploadStates)
          ? s.uploadStates
          : attachments.map((_, i) =>
              p < 0.065 + i * 0.015 ? 'absent' : p < 0.16 + i * 0.015 ? 'uploading' : 'uploaded'
            )
        let uploadCount = 0
        uploadNodes.forEach((item, i) => {
          const status = composing && p < 0.985 ? states[i] || 'absent' : 'absent'
          visible(item.chip, status !== 'absent')
          if (status === 'absent') return
          uploadCount++
          const fileSize =
            item.file.label ||
            (Number.isFinite(item.file.bytes) ? `${(item.file.bytes / 1e6).toFixed(2)} MB` : '')
          const percent = Math.round(
              (Number.isFinite(s.uploadProgresses?.[i])
                ? s.uploadProgresses[i]
                : interval(p, 0.065 + i * 0.015, 0.16 + i * 0.015)) * 100
            ),
            pending = status !== 'uploaded'
          item.meta.textContent = pending ? `${percent}% of ${fileSize}` : fileSize
          visible(item.bar, pending)
          item.barFill.style.width = `${percent}%`
          item.bar.setAttribute('aria-valuenow', String(percent))
          item.chip.dataset.uploadState = status
        })
        visible(uploadList, uploadCount > 0)
        const full = s.permission === 'full' || s.permission === 'Full access',
          profile = full ? 'full' : s.permission === 'auto' ? 'auto' : 'ask',
          review = Boolean(s.autoReview)
        profileIcon.replaceChildren(
          icon(
            profile === 'full' ? 'shield-alert' : profile === 'auto' ? 'shield-check' : 'shield',
            12
          )
        )
        profileText.textContent =
          profile === 'full' ? 'Full access' : profile === 'auto' ? 'Auto' : 'Ask'
        capsule.dataset.profile = profile
        autoSwitch.dataset.on = String(review)
        memorySwitch.dataset.on = String(s.memoryEnabled ?? D.memoryEnabled ?? false)
        delegationSwitch.dataset.on = String(s.delegationEnabled ?? D.delegationEnabled ?? true)
        visible(indicator, profile !== 'ask' || review || Boolean(s.memoryEnabled))
        profileRows.forEach(({ id, node, check }) => {
          visible(check, id === profile)
          node.dataset.hover = String(
            composing && !s.skipAccessSetup && p >= 0.6 && p < 0.63 && id === 'full'
          )
        })
        const confirming = composing && !s.skipAccessSetup && p >= 0.63 && p < 0.705
        const parentOpen = composing && p >= 0.53 && p < 0.84 && !confirming
        visible(controlsMenu, parentOpen)
        visible(permissionMenu, composing && !s.skipAccessSetup && p >= 0.56 && p < 0.63)
        visible(confirmLayer, confirming)
        visible(addMenu, composing && p >= 0.035 && p < 0.065)
        visible(sendMenu, composing && p >= 0.84 && p < 0.985)
        const showTooltip = parentOpen && p >= 0.77 && p < 0.84
        visible(reviewerTooltip, showTooltip)
        controls.dataset.hover = String(parentOpen)
        permissionRow.dataset.hover = String(
          composing && !s.skipAccessSetup && p >= 0.56 && p < 0.63
        )
        autoReview.dataset.hover = String(parentOpen && p >= 0.72)
        planFirst.dataset.hover = String(
          Boolean(s.planFirstHover) || (composing && p >= 0.95 && p < 0.985)
        )
        planFirst.dataset.disabled = String(!draft)
        const running = Boolean(s.runActive)
        send.replaceChildren(icon(running ? 'square' : 'arrow-up', running ? 14 : 16))
        send.setAttribute('aria-label', running ? 'Cancel run' : 'Send message')
        send.setAttribute('aria-disabled', String(!running && !draft))
        sendBlock.dataset.running = String(running)
        sendBlock.dataset.disabled = String(!running && !draft)
        sendBlock.setAttribute(
          'data-testid',
          running ? 'composer-running-control-slot' : 'composer-send-control-slot'
        )
        visible(sendMore, true)
        sendMore.setAttribute(
          'data-testid',
          running ? 'running-side-chat-menu-trigger' : 'branch-send-menu-trigger'
        )
        sendMore.setAttribute('aria-disabled', 'false')
        sendMore.dataset.hover = String(sendMenu.style.display !== 'none')
        const usage = s.contextUsage || D.contextUsage,
          used = usage?.used,
          size = usage?.size
        const hasContext = typeof used === 'number' && Number.isFinite(used)
        visible(context, hasContext)
        if (hasContext)
          contextValue.textContent =
            typeof size === 'number' && size > 0
              ? `${Math.round(Math.min(100, (used / size) * 100))}%`
              : String(used)
        if (parentOpen) placeAbove(controlsMenu, controls)
        if (addMenu.style.display !== 'none') placeAbove(addMenu, add)
        if (sendMenu.style.display !== 'none') placeAbove(sendMenu, sendMore, true)
        if (permissionMenu.style.display !== 'none') {
          const b = inner.getBoundingClientRect(),
            a = permissionRow.getBoundingClientRect(),
            m = controlsMenu.getBoundingClientRect(),
            scale = inner.offsetWidth / b.width || 1
          permissionMenu.style.left = `${(m.right - b.left) * scale + 8}px`
          permissionMenu.style.top = `${(a.top - b.top) * scale - 5}px`
          permissionMenu.style.bottom = 'auto'
        }
        if (showTooltip) {
          const b = inner.getBoundingClientRect(),
            a = autoReview.getBoundingClientRect(),
            scale = inner.offsetWidth / b.width || 1
          reviewerTooltip.style.left = `${(a.right - b.left) * scale + 8}px`
          reviewerTooltip.style.top = `${(a.top - b.top) * scale}px`
        }
        if (stage) {
          stage.dataset.opsConfirmFull = String(confirming)
          stage.dataset.opsPermissionSubmenu = String(permissionMenu.style.display !== 'none')
          const bottom = composing ? 12 : 58
          stage.style.setProperty('--ops-composer-space', `${composer.offsetHeight + bottom + 8}px`)
        }
      }
      ;[controlsMenu, permissionMenu, addMenu, sendMenu, reviewerTooltip, confirmLayer].forEach(
        (node) => visible(node, false)
      )
      return {
        composer,
        card,
        input,
        uploadList,
        controlsMenu,
        sendMenu,
        addMenu,
        planHost,
        sync,
        permissionMenu,
        confirmLayer,
        reviewerTooltip
      }
    }
  }
})()

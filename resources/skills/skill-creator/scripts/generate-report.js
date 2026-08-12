'use strict'
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const { escapeHtml } = require('./utils')

const generateReport = (benchmark, title = 'Skill evaluation report') => {
  const configurations = Object.entries(benchmark.run_summary ?? {}).filter(
    ([name]) => name !== 'delta'
  )
  const rows = configurations
    .map(
      ([name, summary]) =>
        `<tr><th>${escapeHtml(name)}</th><td>${Number(summary.pass_rate?.mean ?? 0).toFixed(
          3
        )}</td><td>${Number(summary.time_seconds?.mean ?? 0).toFixed(1)}</td><td>${Math.round(
          summary.tokens?.mean ?? 0
        )}</td></tr>`
    )
    .join('')
  const notes = (benchmark.notes ?? []).map((note) => `<li>${escapeHtml(note)}</li>`).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>body{font:14px system-ui;margin:2rem;max-width:72rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.5rem;text-align:left}</style></head>
<body><h1>${escapeHtml(title)}</h1><table><thead><tr><th>Configuration</th><th>Pass rate</th><th>Seconds</th><th>Tokens</th></tr></thead><tbody>${rows}</tbody></table><h2>Notes</h2><ul>${notes}</ul></body></html>`
}

module.exports = { generateReport }

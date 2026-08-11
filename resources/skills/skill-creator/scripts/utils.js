'use strict'
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const { readFile, writeFile } = require('node:fs/promises')

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const writeJson = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

const summarize = (values) => {
  if (values.length === 0) return { mean: 0, stddev: 0, min: 0, max: 0 }
  const average = mean(values)
  return {
    mean: average,
    stddev: Math.sqrt(mean(values.map((value) => (value - average) ** 2))),
    min: Math.min(...values),
    max: Math.max(...values)
  }
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

module.exports = { escapeHtml, mean, readJson, summarize, writeJson }

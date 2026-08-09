'use strict'
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const { readdir, readFile, stat, writeFile } = require('node:fs/promises')
const { basename, join, relative, resolve } = require('node:path')
const { escapeHtml } = require('../scripts/utils')

const MAX_EMBED_BYTES = 2 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['.csv', '.html', '.json', '.md', '.txt', '.xml', '.yaml', '.yml'])
const IMAGE_MIME = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}
const extension = (name) => name.slice(name.lastIndexOf('.')).toLowerCase()

const embedFile = async (path) => {
  const metadata = await stat(path)
  if (metadata.size > MAX_EMBED_BYTES) {
    return { name: basename(path), type: 'omitted', reason: 'File exceeds the 2 MiB review limit.' }
  }
  const bytes = await readFile(path)
  const ext = extension(path)
  if (TEXT_EXTENSIONS.has(ext)) {
    return { name: basename(path), type: 'text', content: bytes.toString('utf8') }
  }
  if (IMAGE_MIME[ext]) {
    return {
      name: basename(path),
      type: 'image',
      data_uri: `data:${IMAGE_MIME[ext]};base64,${bytes.toString('base64')}`
    }
  }
  return { name: basename(path), type: 'binary', size: bytes.byteLength }
}

const findRuns = async (workspace) => {
  const root = resolve(workspace)
  const runs = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    const outputs = entries.find((entry) => entry.isDirectory() && entry.name === 'outputs')
    if (outputs) {
      const outputDir = join(directory, 'outputs')
      const outputEntries = await readdir(outputDir, { withFileTypes: true })
      const files = await Promise.all(
        outputEntries
          .filter((entry) => entry.isFile())
          .map((entry) => embedFile(join(outputDir, entry.name)))
      )
      const readOptionalJson = async (name) => {
        try {
          return JSON.parse(await readFile(join(directory, name), 'utf8'))
        } catch {
          return undefined
        }
      }
      const metadata = await readOptionalJson('eval_metadata.json')
      runs.push({
        id: relative(root, directory).replaceAll('\\', '-').replaceAll('/', '-'),
        prompt: metadata?.prompt ?? '(No prompt found)',
        eval_id: metadata?.eval_id,
        outputs: files,
        grading: await readOptionalJson('grading.json')
      })
      return
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && !['.git', 'inputs', 'node_modules', 'skill'].includes(entry.name)
        )
        .map((entry) => visit(join(directory, entry.name)))
    )
  }
  await visit(root)
  return runs.sort((left, right) => left.id.localeCompare(right.id))
}

const generateReview = async ({
  workspace,
  templatePath,
  outputPath,
  skillName,
  benchmarkPath
}) => {
  const [template, runs, benchmark] = await Promise.all([
    readFile(templatePath, 'utf8'),
    findRuns(workspace),
    benchmarkPath ? readFile(benchmarkPath, 'utf8').then(JSON.parse) : undefined
  ])
  const data = JSON.stringify({ skill_name: skillName, runs, benchmark }).replaceAll('<', '\\u003c')
  const html = template
    .replace('__REVIEW_DATA_PLACEHOLDER__', data)
    .replaceAll('__SKILL_NAME_PLACEHOLDER__', () => escapeHtml(skillName))
  await writeFile(outputPath, html, 'utf8')
  return { output_path: outputPath, run_count: runs.length }
}

module.exports = { findRuns, generateReview }

if (require.main === module) {
  const [workspace, outputPath, templatePath, skillName = 'Skill'] = process.argv.slice(2)
  if (!workspace || !outputPath || !templatePath) {
    console.error(
      'Usage: node generate-review.js <workspace> <output.html> <viewer.html> [skill-name]'
    )
    process.exitCode = 1
  } else {
    generateReview({ workspace, outputPath, templatePath, skillName }).then(
      console.log,
      (error) => {
        console.error(error.message)
        process.exitCode = 1
      }
    )
  }
}

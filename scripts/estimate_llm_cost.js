#!/usr/bin/env node
/**
 * Estimate LLM labeling cost for BERTopic based on local note corpus statistics.
 *
 * Usage:
 *   node scripts/estimate_llm_cost.js [--db=path] [--min-topic-size=12] [--nr-topics=80]
 *                                     [--repr-docs=5] [--repr-snippet=160]
 *                                     [--prompt-base=120] [--top-n-words=12]
 *                                     [--output-tokens=48] [--cached-fraction=0.0]
 *
 * All values are rough heuristics. Adjust the knobs above to simulate
 * different BERTopic configurations and prompt shapes.
 */

const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

function parseArgs(argv) {
  const out = {}
  for (const arg of argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase()
    let value = match[2]
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value)
    }
    out[key] = value
  }
  return out
}

function htmlToPlain(html) {
  if (!html) return ''
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function approxTokensFromChars(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.ceil(chars / 4)
}

function collectCorpusStats(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Note database not found at ${dbPath}`)
  }
  const db = new Database(dbPath, { readonly: true })
  const stmt = db.prepare('SELECT value_html FROM note_fields WHERE ord = 0')
  let noteCount = 0
  let totalChars = 0
  let maxChars = 0
  for (const row of stmt.iterate()) {
    const plain = htmlToPlain(row.value_html)
    const len = plain.length
    if (!len) continue
    noteCount += 1
    totalChars += len
    if (len > maxChars) maxChars = len
  }
  db.close()

  if (noteCount === 0) {
    throw new Error('No note fronts found in database (ord = 0).')
  }

  const totalTokens = approxTokensFromChars(totalChars)
  const avgTokens = totalTokens / noteCount
  const maxTokens = approxTokensFromChars(maxChars)

  return {
    noteCount,
    totalChars,
    totalTokens,
    avgTokens,
    maxTokens,
  }
}

function estimateTopicCount({ noteCount, minTopicSize, nrTopicsConfig }) {
  if (Number.isFinite(nrTopicsConfig) && nrTopicsConfig > 0) {
    return Math.round(nrTopicsConfig)
  }
  const size = Number.isFinite(minTopicSize) && minTopicSize > 0 ? minTopicSize : 12
  const est = Math.max(1, Math.round(noteCount / size))
  return est
}

function estimateTokens({
  stats,
  topicCount,
  reprDocs,
  reprSnippet,
  promptBase,
  topNWords,
  outputTokens,
}) {
  const avgTokens = stats.avgTokens
  const docSnippetTokens = Math.max(1, Math.min(avgTokens, reprSnippet))
  const perTopicInput = promptBase + reprDocs * docSnippetTokens + Math.max(0, topNWords)
  const totalInput = perTopicInput * topicCount
  const totalOutput = Math.max(0, outputTokens) * topicCount
  return { perTopicInput, totalInput, totalOutput }
}

function applyCaching(totalInput, cachedFraction, pricing) {
  if (!cachedFraction || cachedFraction <= 0) {
    return totalInput * pricing.input
  }
  const cachedPart = Math.max(0, Math.min(1, cachedFraction))
  const cachedTokens = totalInput * cachedPart
  const freshTokens = totalInput - cachedTokens
  return freshTokens * pricing.input + cachedTokens * (pricing.cachedInput ?? pricing.input)
}

function main() {
  const args = parseArgs(process.argv)

  const dbPath = args.db
    ? path.resolve(args.db)
    : path.resolve(process.cwd(), 'database', 'anki_cache.db')

  const minTopicSize = Number.isFinite(args['min-topic-size']) ? Number(args['min-topic-size']) : undefined
  const nrTopicsConfig = Number.isFinite(args['nr-topics']) ? Number(args['nr-topics']) : undefined
  const reprDocs = Number.isFinite(args['repr-docs']) ? Math.max(1, Number(args['repr-docs'])) : 5
  const reprSnippet = Number.isFinite(args['repr-snippet']) ? Math.max(32, Number(args['repr-snippet'])) : 160
  const promptBase = Number.isFinite(args['prompt-base']) ? Math.max(0, Number(args['prompt-base'])) : 120
  const topNWords = Number.isFinite(args['top-n-words']) ? Math.max(0, Number(args['top-n-words'])) : 12
  const outputTokens = Number.isFinite(args['output-tokens']) ? Math.max(0, Number(args['output-tokens'])) : 48
  const cachedFraction = Number.isFinite(args['cached-fraction']) ? Math.max(0, Math.min(1, Number(args['cached-fraction']))) : 0

  const stats = collectCorpusStats(dbPath)
  const topicCount = estimateTopicCount({ noteCount: stats.noteCount, minTopicSize, nrTopicsConfig })
  const tokenEstimate = estimateTokens({
    stats,
    topicCount,
    reprDocs,
    reprSnippet,
    promptBase,
    topNWords,
    outputTokens,
  })

  const pricing = {
    'GPT-5 nano': { input: 0.05 / 1_000_000, cachedInput: 0.005 / 1_000_000, output: 0.40 / 1_000_000 },
    'GPT-5 mini': { input: 0.25 / 1_000_000, cachedInput: 0.02 / 1_000_000, output: 1.00 / 1_000_000 },
    'GPT-5': { input: 1.25 / 1_000_000, cachedInput: 0.10 / 1_000_000, output: 5.00 / 1_000_000 },
  }

  console.log('--- Corpus Statistics ---')
  console.log(`Notes analysed        : ${stats.noteCount.toLocaleString()}`)
  console.log(`Total characters      : ${stats.totalChars.toLocaleString()}`)
  console.log(`Approx total tokens   : ${stats.totalTokens.toLocaleString()}`)
  console.log(`Avg tokens per note   : ${stats.avgTokens.toFixed(2)}`)
  console.log(`Max tokens (single)   : ${stats.maxTokens}`)
  console.log('')

  console.log('--- Estimation Inputs ---')
  console.log(`Assumed topic count   : ${topicCount.toLocaleString()}`)
  console.log(`Representative docs   : ${reprDocs}`)
  console.log(`Snippet tokens/doc    : ${reprSnippet}`)
  console.log(`Prompt base tokens    : ${promptBase}`)
  console.log(`Top-N terms included  : ${topNWords}`)
  console.log(`Output tokens/topic   : ${outputTokens}`)
  console.log(`Cached input fraction : ${(cachedFraction * 100).toFixed(1)}%`)
  console.log('')

  console.log('--- Token Totals ---')
  console.log(`Input tokens per topic: ${tokenEstimate.perTopicInput.toFixed(2)}`)
  console.log(`Total input tokens    : ${tokenEstimate.totalInput.toLocaleString()}`)
  console.log(`Total output tokens   : ${tokenEstimate.totalOutput.toLocaleString()}`)
  console.log('')

  console.log('--- Estimated Cost ---')
  for (const [model, rate] of Object.entries(pricing)) {
    const inputCost = applyCaching(tokenEstimate.totalInput, cachedFraction, rate)
    const outputCost = tokenEstimate.totalOutput * rate.output
    const totalCost = inputCost + outputCost
    console.log(`${model.padEnd(11)} : $${totalCost.toFixed(4)} (input $${inputCost.toFixed(4)} + output $${outputCost.toFixed(4)})`)
  }
  console.log('')
  console.log('Adjust CLI flags to match your BERTopic configuration for tighter estimates.')
}

try {
  main()
} catch (err) {
  console.error('Failed to estimate cost:', err.message)
  process.exit(1)
}


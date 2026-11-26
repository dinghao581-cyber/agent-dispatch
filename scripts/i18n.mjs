#!/usr/bin/env node
// 界面文字工具（无依赖）：
//   node scripts/i18n.mjs extract   从 hooks/ 里所有 L('中文', 'English') 生成 locales/_source.json（英文 → 中文，供翻译参考）
//   node scripts/i18n.mjs check     检查 locales/*.json：缺句、多余句、{0} 占位符对不上
// UI string tool (no dependencies): extract builds locales/_source.json from every L(zh, en) call;
// check verifies each locale file covers every string with matching {n} placeholders.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hooks = path.join(root, 'hooks')
const localesDir = path.join(root, 'locales')

const STR = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`
const CALL = new RegExp(String.raw`\bL\(\s*(${STR})\s*,\s*(${STR})\s*[,)]`, 'g')
const ANY_L = /\bL\(/g

const unquote = s => JSON.parse(s[0] === '"' ? s : `"${s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`)

function extract() {
  const map = {}
  const problems = []
  for (const f of fs.readdirSync(hooks).filter(f => /\.tsx?$/.test(f) && f !== 'i18n.ts')) {
    const text = fs.readFileSync(path.join(hooks, f), 'utf8')
    const literal = new Set()
    for (const m of text.matchAll(CALL)) {
      literal.add(m.index)
      const zh = unquote(m[1])
      const en = unquote(m[2])
      // 同一句英文对应两种中文写法不算错（中文写在代码里），译文表里共用一条
      if (map[en] === undefined) map[en] = zh
    }
    for (const m of text.matchAll(ANY_L)) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1
      const before = text.slice(lineStart, m.index)
      if (/^\s*(\/\/|\*)/.test(before)) continue
      if (!literal.has(m.index)) {
        const line = text.slice(0, m.index).split('\n').length
        problems.push(`${f}:${line}: L() needs two string literals (use {0} placeholders for values)`)
      }
    }
  }
  return { map, problems }
}

const holes = s => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',')

const cmd = process.argv[2]
const { map, problems } = extract()
if (cmd === 'extract') {
  fs.mkdirSync(localesDir, { recursive: true })
  const sorted = Object.fromEntries(Object.keys(map).sort().map(k => [k, map[k]]))
  fs.writeFileSync(path.join(localesDir, '_source.json'), JSON.stringify(sorted, null, 1) + '\n')
  console.log(`${Object.keys(map).length} strings → locales/_source.json`)
  if (problems.length) {
    console.log(problems.join('\n'))
    process.exit(1)
  }
} else if (cmd === 'check') {
  let bad = problems.length
  if (problems.length) console.log(problems.join('\n'))
  const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json') && !f.startsWith('_'))
  for (const f of files) {
    let dict
    try {
      dict = JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'))
    } catch (e) {
      console.log(`${f}: invalid JSON (${e.message})`)
      bad++
      continue
    }
    const missing = Object.keys(map).filter(k => typeof dict[k] !== 'string' || !dict[k].trim())
    const extra = Object.keys(dict).filter(k => !(k in map))
    const holesOff = Object.keys(map).filter(k => typeof dict[k] === 'string' && holes(dict[k]) !== holes(k))
    if (missing.length || extra.length || holesOff.length) {
      bad++
      console.log(`${f}: ${missing.length} missing, ${extra.length} extra, ${holesOff.length} placeholder mismatches`)
      for (const k of holesOff.slice(0, 5)) console.log(`   placeholders: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`)
      for (const k of missing.slice(0, 3)) console.log(`   missing: ${JSON.stringify(k)}`)
    }
  }
  console.log(`${Object.keys(map).length} strings, ${files.length} locale files, ${bad ? `${bad} with problems` : 'all good'}`)
  process.exit(bad ? 1 : 0)
} else {
  console.log('usage: node scripts/i18n.mjs extract|check')
  process.exit(2)
}

// 界面语言：和 Claude 桌面端一样的 43 种。每处文字写成 L('中文', 'English', ...值)，
// 文中 {0} {1} 是按顺序填进去的值。简体中文和英文就写在代码里；其余语言在 locales/<代码>.json，
// 以英文原文为键，缺哪句就显示英文。
// UI language: the same 43 languages as the Claude desktop app. Every user-facing string is
// L('中文', 'English', ...values) with {0} {1} placeholders. zh-Hans and en-US live in the code;
// the rest live in locales/<code>.json keyed by the English text, falling back to English.
import type { Host, IO } from './util'
import { runText } from './util'

export const LANGUAGES = [
  { code: 'en-US', name: 'English', english: 'English' },
  { code: 'zh-Hans', name: '简体中文', english: 'Simplified Chinese' },
  { code: 'zh-Hant', name: '繁體中文', english: 'Traditional Chinese' },
  { code: 'ja-JP', name: '日本語', english: 'Japanese' },
  { code: 'ko-KR', name: '한국어', english: 'Korean' },
  { code: 'de-DE', name: 'Deutsch', english: 'German' },
  { code: 'fr-FR', name: 'Français', english: 'French' },
  { code: 'es-ES', name: 'Español (España)', english: 'Spanish (Spain)' },
  { code: 'es-419', name: 'Español (Latinoamérica)', english: 'Latin American Spanish' },
  { code: 'pt-BR', name: 'Português (Brasil)', english: 'Brazilian Portuguese' },
  { code: 'it-IT', name: 'Italiano', english: 'Italian' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch' },
  { code: 'sv', name: 'Svenska', english: 'Swedish' },
  { code: 'da', name: 'Dansk', english: 'Danish' },
  { code: 'nb', name: 'Norsk bokmål', english: 'Norwegian Bokmål' },
  { code: 'fi', name: 'Suomi', english: 'Finnish' },
  { code: 'ru', name: 'Русский', english: 'Russian' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish' },
  { code: 'id-ID', name: 'Bahasa Indonesia', english: 'Indonesian' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese' },
  { code: 'th', name: 'ไทย', english: 'Thai' },
  { code: 'fil', name: 'Filipino', english: 'Filipino' },
  { code: 'hi-IN', name: 'हिन्दी', english: 'Hindi' },
  { code: 'bn', name: 'বাংলা', english: 'Bengali' },
  { code: 'mr', name: 'मराठी', english: 'Marathi' },
  { code: 'gu', name: 'ગુજરાતી', english: 'Gujarati' },
  { code: 'ta', name: 'தமிழ்', english: 'Tamil' },
  { code: 'te', name: 'తెలుగు', english: 'Telugu' },
  { code: 'kn', name: 'ಕನ್ನಡ', english: 'Kannada' },
  { code: 'ml', name: 'മലയാളം', english: 'Malayalam' },
  { code: 'bho', name: 'भोजपुरी', english: 'Bhojpuri' },
  { code: 'sw', name: 'Kiswahili', english: 'Swahili' },
  { code: 'am', name: 'አማርኛ', english: 'Amharic' },
  { code: 'ha', name: 'Hausa', english: 'Hausa' },
  { code: 'ig', name: 'Igbo', english: 'Igbo' },
  { code: 'yo', name: 'Yorùbá', english: 'Yoruba' },
  { code: 'om', name: 'Afaan Oromoo', english: 'Oromo' },
  { code: 'so', name: 'Soomaali', english: 'Somali' },
  { code: 'rw', name: 'Kinyarwanda', english: 'Kinyarwanda' },
  { code: 'rn', name: 'Ikirundi', english: 'Kirundi' },
  { code: 'ny', name: 'Chichewa', english: 'Chichewa' },
  { code: 'wo', name: 'Wolof', english: 'Wolof' },
] as const

export type Lang = (typeof LANGUAGES)[number]['code']
/** 'zh' / 'en' 是 0.4 及以前存下的旧值，读到时当作 zh-Hans / en-US */
export type LangSetting = 'auto' | Lang | 'zh' | 'en'

const CODES = new Set<string>(LANGUAGES.map(l => l.code))

let current: Lang = 'en-US'
let dict: Record<string, string> = {}
const loaded = new Map<string, Record<string, string>>()

export function setLang(lang: string): void {
  const next = normalizeSetting(lang)
  current = next === 'auto' ? 'en-US' : next
  dict = loaded.get(current) ?? {}
}

export function getLang(): Lang {
  return current
}

export function isZh(): boolean {
  return current === 'zh-Hans'
}

export function langName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.english ?? 'English'
}

function fill(text: string, values: readonly unknown[]): string {
  if (values.length === 0) return text
  return text.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < values.length ? String(values[Number(i)]) : m))
}

export function L(zh: string, en: string, ...values: unknown[]): string {
  if (current === 'zh-Hans') return fill(zh, values)
  if (current === 'en-US') return fill(en, values)
  return fill(dict[en] ?? en, values)
}

export function normalizeSetting(v: string | undefined): LangSetting & ('auto' | Lang) {
  if (v === 'zh') return 'zh-Hans'
  if (v === 'en') return 'en-US'
  if (v && CODES.has(v)) return v as Lang
  return 'auto'
}

/** 把系统给的语言标签（zh-Hans-CN、zh_TW、es-MX、en-AU…）对到 43 种之一；对不上返回 undefined */
export function matchLocale(tag: string): Lang | undefined {
  const t = tag.trim().replace(/_/g, '-').replace(/^"|"$/g, '')
  if (!t) return undefined
  const parts = t.split('-')
  const base = (parts[0] ?? '').toLowerCase()
  const rest = parts.slice(1).map(p => p.toLowerCase())
  if (base === 'zh') return rest.some(p => ['hant', 'tw', 'hk', 'mo'].includes(p)) ? 'zh-Hant' : 'zh-Hans'
  if (base === 'es') return rest.length === 0 || rest.includes('es') ? 'es-ES' : 'es-419'
  if (base === 'pt') return 'pt-BR'
  if (base === 'en') return 'en-US'
  if (base === 'no' || base === 'nn' || base === 'nb') return 'nb'
  if (base === 'tl') return 'fil'
  return LANGUAGES.find(l => (l.code.split('-')[0] ?? '').toLowerCase() === base)?.code
}

/** 'auto'：按系统首选语言列表，取第一个对得上的 */
export async function resolveLang(io: IO, host: Host, setting: string | undefined): Promise<Lang> {
  const s = normalizeSetting(setting)
  if (s !== 'auto') return s
  const out = host.isWindows
    ? await runText(io, ['powershell', '-NoProfile', '-Command', '(Get-Culture).Name'])
    : await runText(io, ['/usr/bin/defaults', 'read', '-g', 'AppleLanguages'])
  for (const tag of out.split(/[\s,()]+/)) {
    const m = matchLocale(tag)
    if (m) return m
  }
  return 'en-US'
}

/** 读入一种语言的译文（插件目录 locales/<代码>.json）；读不到就全用英文 */
export async function loadLocale(io: IO, pluginRoot: string, lang: Lang): Promise<void> {
  if (lang !== 'zh-Hans' && lang !== 'en-US' && !loaded.has(lang) && pluginRoot) {
    try {
      const text = await io.read(`${pluginRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/locales/${lang}.json`)
      const parsed = text ? (JSON.parse(text) as Record<string, string>) : {}
      loaded.set(lang, parsed && typeof parsed === 'object' ? parsed : {})
    } catch {
      loaded.set(lang, {})
    }
  }
  setLang(lang)
}

/** 只分中文 / 英文、不进译文表：给智能体看的提示词（里面有“VERDICT:”这类要原样解析的格式） */
export function Z(zh: string, en: string, ...values: unknown[]): string {
  return fill(current === 'zh-Hans' ? zh : en, values)
}

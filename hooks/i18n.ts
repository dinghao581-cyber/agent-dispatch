// 界面语言：中文 / English。每处文字写成 L('中文', 'English')，按当前语言取一个。
// UI language: every user-facing string is written as L('中文', 'English').
import type { Host, IO } from './util'
import { runText } from './util'

export type Lang = 'zh' | 'en'
export type LangSetting = 'auto' | Lang

let current: Lang = 'en'

export function setLang(lang: Lang): void {
  current = lang
}

export function getLang(): Lang {
  return current
}

export function L(zh: string, en: string): string {
  return current === 'zh' ? zh : en
}

/** 'auto'：按系统首选语言，中文系统用中文，其余用英文 */
export async function resolveLang(io: IO, host: Host, setting: LangSetting | undefined): Promise<Lang> {
  if (setting === 'zh' || setting === 'en') return setting
  const out = host.isWindows
    ? await runText(io, ['powershell', '-NoProfile', '-Command', '(Get-Culture).Name'])
    : await runText(io, ['/usr/bin/defaults', 'read', '-g', 'AppleLanguages'])
  return /\bzh/i.test(out) ? 'zh' : 'en'
}

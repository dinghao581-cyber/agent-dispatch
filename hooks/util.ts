// 跨平台小工具：路径、删除文件、读 JSON、时间格式。
import { getLang } from './i18n'
// 模块里没有 Node，文件和进程操作都经由 register.tsx 在会话开始时建好的 IO 适配层。

export type FsEntryLite = { name: string; kind: string; size: number; mtimeMs: number }
export type SpawnStream = AsyncGenerator<
  { stream: 'stdout' | 'stderr'; text: string },
  { code: number | null; signal: string | null }
>

/** 引擎能力的适配层：每个函数在 register.tsx 里直接写成 $.名词.方法() */
export type IO = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list(path: string): Promise<FsEntryLite[]>
  exists(path: string): Promise<boolean>
  run(
    argv: readonly string[],
    init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  spawn(req: { argv: readonly string[]; cwd?: string; env?: Record<string, string>; input?: string }): SpawnStream
  sleep(ms: number): Promise<void>
  toast(text: string): void
  notify(text: string, title: string): void
  submit(text: string): void
  machine(): Promise<{ sysname: string }>
  hookEnv(): Promise<Record<string, string | undefined>>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
}

export type Host = {
  isWindows: boolean
  home: string
  hostname: string
  sessionId: string
  pluginData: string
}

export async function detectHost(io: IO): Promise<Host> {
  const m = await io.machine()
  const isWindows = /windows|mingw|msys|cygwin/i.test(m.sysname)
  const env = await io.hookEnv()
  const home = isWindows
    ? (await runText(io, ['cmd', '/c', 'echo %USERPROFILE%'])).trim()
    : (await runText(io, ['/usr/bin/printenv', 'HOME'])).trim()
  const hostname = (await runText(io, ['hostname'])).trim().replace(/\.local$/, '') || 'machine'
  return {
    isWindows,
    home: norm(home),
    hostname: hostname.replace(/[^A-Za-z0-9_.-]/g, '-'),
    sessionId: env.CLAUDE_CODE_SESSION_ID ?? `s${Date.now()}`,
    pluginData: norm(env.CLAUDE_PLUGIN_DATA ?? ''),
  }
}

export async function runText(io: IO, argv: string[], cwd?: string): Promise<string> {
  try {
    const r = await io.run(argv, { cwd, timeoutMs: 20000 })
    return r.stdout
  } catch {
    return ''
  }
}

/** 统一用正斜杠；Windows 也认。 */
export function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function join(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? norm(p) : norm(p).replace(/^\/+/, '')))
    .join('/')
}

export function expandHome(p: string, host: Host): string {
  if (p === '~') return host.home
  if (p.startsWith('~/')) return join(host.home, p.slice(2))
  return norm(p)
}

export async function readJson<T>(io: IO, path: string): Promise<T | undefined> {
  try {
    const text = await io.read(path)
    if (typeof text !== 'string' || text.trim() === '') return undefined
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export async function writeJson(io: IO, path: string, value: unknown): Promise<void> {
  await io.write(path, JSON.stringify(value, null, 1))
}

export async function listDir(io: IO, path: string) {
  try {
    return await io.list(path)
  } catch {
    return []
  }
}

export async function exists(io: IO, path: string): Promise<boolean> {
  try {
    return await io.exists(path)
  } catch {
    return false
  }
}

export async function removeFile(io: IO, host: Host, path: string): Promise<void> {
  const argv = host.isWindows
    ? ['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, '\\')]
    : ['/bin/rm', '-f', path]
  await runText(io, argv)
}

export async function removeDir(io: IO, host: Host, path: string): Promise<void> {
  const argv = host.isWindows
    ? ['cmd', '/c', 'rmdir', '/s', '/q', path.replace(/\//g, '\\')]
    : ['/bin/rm', '-rf', path]
  await runText(io, argv)
}

export function shellArgv(host: Host, command: string): string[] {
  return host.isWindows ? ['cmd', '/c', command] : ['/bin/sh', '-c', command]
}

export function newId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const r = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, '0')
  return `T${d}-${t}-${r}`
}

/** 工单号里的年月，用来分目录：T20261126-... → 202611 */
export function monthOf(id: string): string {
  return id.slice(1, 7)
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function clip(text: string, n: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const zh = getLang() === 'zh'
  const s = Math.floor(ms / 1000)
  if (s < 60) return zh ? `${s}秒` : `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return zh ? `${m}分${s % 60 ? `${s % 60}秒` : ''}` : `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
  const h = Math.floor(m / 60)
  return zh ? `${h}时${m % 60}分` : `${h}h ${m % 60}m`
}

export function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtUSD(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

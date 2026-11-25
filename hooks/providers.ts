// 智能体接口：每种模型怎么启动、怎么计价、是否可用。
// 目前只开 DeepSeek Flash；GPT 与 Claude API 留好位置，等有 Key 再打开。
import type { IO, Host } from './util'
import { expandHome } from './util'
import type { Settings } from '../types'

export type Price = { hit: number; miss: number; out: number } // 美元 / 百万 Token（高峰价）

export type Provider = {
  id: string
  label: string
  short: string
  enabled: boolean
  /** 高峰半价规则（DeepSeek：UTC 工作日 01-04、06-10 为高峰） */
  peakAware: boolean
  price?: Price
  note?: string
}

export const PROVIDERS: Provider[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    short: 'DS-Flash',
    enabled: true,
    peakAware: true,
    price: { hit: 0.006, miss: 0.3, out: 1.2 },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    short: 'DS-Pro',
    enabled: false,
    peakAware: true,
    price: { hit: 0.044, miss: 1.32, out: 3.96 },
    note: '已预留，按需在设置里打开',
  },
  {
    id: 'claude-api',
    label: 'Claude API',
    short: 'Claude',
    enabled: false,
    peakAware: false,
    note: '接口已预留：需要 ANTHROPIC_API_KEY',
  },
  {
    id: 'openai-gpt',
    label: 'GPT',
    short: 'GPT',
    enabled: false,
    peakAware: false,
    note: '接口已预留：需要 OpenAI Key 和 Codex CLI',
  },
]

export function providerOf(id: string): Provider | undefined {
  return PROVIDERS.find(p => p.id === id)
}

/** DeepSeek 高峰：UTC 周一至周五 01:00-04:00、06:00-10:00 */
export function isPeak(ms = Date.now()): boolean {
  const d = new Date(ms)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

/** 现在能否开新单：只跑低谷时，高峰前 15 分钟也不开 */
export function canStartNow(offPeakOnly: boolean, ms = Date.now()): boolean {
  if (!offPeakOnly) return true
  return !isPeak(ms) && !isPeak(ms + 15 * 60 * 1000)
}

export function costOf(
  provider: Provider | undefined,
  u: { input: number; cacheRead: number; output: number },
  peak: boolean,
): number {
  const p = provider?.price
  if (!p) return 0
  const f = provider!.peakAware && !peak ? 0.5 : 1
  return ((u.cacheRead * p.hit + u.input * p.miss + u.output * p.out) / 1e6) * f
}

export type Launch = { argv: string[]; env: Record<string, string>; input: string }

const READ_TOOLS = 'Read,Grep,Glob'
const EDIT_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash'

/** 读 deepseek.env（KEY=VALUE），不打印任何值 */
async function readEnvFile(io: IO, path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let text = ''
  try {
    const r = await io.read(path)
    text = typeof r === 'string' ? r : ''
  } catch {
    return out
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    const key = m?.[1]
    if (!m || !key) continue
    let v = (m[2] ?? '').trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[key] = v
  }
  return out
}

export async function checkProvider(
  io: IO,
  host: Host,
  settings: Settings,
  id: string,
): Promise<string | undefined> {
  const p = providerOf(id)
  if (!p) return `未知的智能体：${id}`
  if (!p.enabled) return `${p.label} 尚未开放（${p.note ?? '未配置'}）`
  if (id.startsWith('deepseek')) {
    const env = await readEnvFile(io, expandHome(settings.deepseekEnvFile, host))
    if (!env.DEEPSEEK_API_KEY) return `没找到 DeepSeek Key：请在 ${settings.deepseekEnvFile} 里填写 DEEPSEEK_API_KEY`
  }
  return undefined
}

export async function buildLaunch(
  io: IO,
  host: Host,
  settings: Settings,
  spec: { provider: string; mode: 'read' | 'edit'; prompt: string; maxTurns?: number },
): Promise<Launch> {
  const tools = spec.mode === 'edit' ? EDIT_TOOLS : READ_TOOLS
  const argv = [
    settings.claudePath || 'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--tools',
    tools,
    '--allowedTools',
    tools,
  ]
  if (spec.mode === 'edit') argv.push('--permission-mode', 'acceptEdits')
  if (spec.maxTurns && spec.maxTurns > 0) argv.push('--max-turns', String(spec.maxTurns))

  const env: Record<string, string> = { AGENT_DISPATCH_CHILD: '1' }
  if (spec.provider.startsWith('deepseek')) {
    const file = await readEnvFile(io, expandHome(settings.deepseekEnvFile, host))
    const model = spec.provider === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : file.DEEPSEEK_MODEL || 'deepseek-flash'
    Object.assign(env, {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: file.DEEPSEEK_API_KEY ?? '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    })
  }
  const input = `${spec.prompt}\n\n---\n完成后请在回答的最后单独写一行，以“【摘要】”开头，用一句话（不超过 80 字）总结结果。`
  return { argv, env, input }
}

/** stream-json 一行一事件；把它变成进度信息 */
export type StreamUpdate = {
  turnsDelta: number
  action?: string
  text?: string
  usageDelta?: { input: number; cacheRead: number; output: number }
  result?: { text: string; isError: boolean; turns: number; usage?: { input: number; cacheRead: number; output: number } }
  initModel?: string
}

function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const pick = (k: string) => (typeof input?.[k] === 'string' ? (input![k] as string) : '')
  const file = pick('file_path') || pick('path')
  const short = file ? file.replace(/\\/g, '/').split('/').slice(-2).join('/') : ''
  if (name === 'Bash') return `Bash ${pick('command').slice(0, 60)}`
  if (name === 'Grep') return `Grep “${pick('pattern').slice(0, 40)}”`
  if (name === 'Glob') return `Glob ${pick('pattern').slice(0, 40)}`
  return short ? `${name} ${short}` : name
}

export function parseStreamLine(line: string, seen: Set<string>): StreamUpdate | undefined {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!ev || typeof ev !== 'object') return undefined
  if (ev.type === 'system' && ev.subtype === 'init') return { turnsDelta: 0, initModel: String(ev.model ?? '') }
  if (ev.type === 'assistant' && ev.message) {
    const msg = ev.message
    const upd: StreamUpdate = { turnsDelta: 0 }
    const mid = String(msg.id ?? '')
    if (mid && !seen.has(mid)) {
      seen.add(mid)
      upd.turnsDelta = 1
      const u = msg.usage
      if (u) {
        upd.usageDelta = {
          input: Number(u.input_tokens ?? 0),
          cacheRead: Number(u.cache_read_input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
        }
      }
    }
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c?.type === 'tool_use') upd.action = describeTool(String(c.name), c.input)
      else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) upd.text = c.text
    }
    return upd
  }
  if (ev.type === 'result') {
    const u = ev.usage
    return {
      turnsDelta: 0,
      result: {
        text: typeof ev.result === 'string' ? ev.result : '',
        isError: Boolean(ev.is_error) || (typeof ev.subtype === 'string' && ev.subtype !== 'success'),
        turns: Number(ev.num_turns ?? 0),
        usage: u
          ? {
              input: Number(u.input_tokens ?? 0),
              cacheRead: Number(u.cache_read_input_tokens ?? 0),
              output: Number(u.output_tokens ?? 0),
            }
          : undefined,
      },
    }
  }
  return undefined
}

export function extractSummary(text: string): string {
  const m = /【摘要】\s*(.+)/.exec(text)
  if (m?.[1]) return m[1].trim().slice(0, 160)
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 120 ? `${s.slice(0, 119)}…` : s
}

export function extractVerdict(text: string): 'approved' | 'rejected' | undefined {
  const m = /【结论】\s*(不通过|通过)/.exec(text)
  if (!m) return undefined
  return m[1] === '通过' ? 'approved' : 'rejected'
}

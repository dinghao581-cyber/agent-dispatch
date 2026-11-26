// 任务板存储层。
//
// 为了让 NAS（SMB）上多台电脑同时用、而且工单再多也不卡，任务板不是一个大文本，而是：
//   tasks/<年月>/<工单号>/spec.json            工单内容（创建者写一次）
//   tasks/<年月>/<工单号>/state.<机器>.json     运行状态（只由跑它的机器写）
//   tasks/<年月>/<工单号>/log.<机器>.<n>.txt    原始输出，分段存
//   tasks/<年月>/<工单号>/result.<机器>.md      最终回答
//   queue/<工单号>.json                         排队标记，认领后删除
//   claims/<工单号>/<机器>.json                 认领票据，先到先得
//   index/<机器>.json                           热层：这台机器近几天的工单精简行
//   digest/<机器>/<年-月>.json                  冷层：归档的精简行和摘要，按月分文件
//   controls/<机器>/<时间>-<工单号>.json        给某台机器的操作请求（停止、批准…）
//   locks/<机器>.json                           同一台机器只让一个 Claude 会话当调度者
// 每个文件只有一个写入者，SMB 上不会互相覆盖；
// Claude 和面板只读热层与按需查询，所以几千、几万条工单也不会撑爆上下文。
import type { IO, Host } from './util'
import { join, listDir, monthOf, readJson, removeDir, removeFile, writeJson, exists } from './util'
import type { Row, TaskSpec, TaskState, TaskStatus } from '../types'

export type ControlAction = 'stop' | 'approve' | 'reject' | 'cancel'
export type Control = { id: string; action: ControlAction; note?: string; by: string; at: number }

const TERMINAL: TaskStatus[] = ['done', 'failed', 'stopped', 'rejected', 'interrupted']
export const isTerminal = (s: TaskStatus) => TERMINAL.includes(s)

export function rowOf(spec: TaskSpec, state?: TaskState): Row {
  return {
    id: spec.id,
    title: spec.title,
    status: state?.status ?? 'queued',
    provider: spec.provider,
    machine: state?.machine,
    target: spec.target,
    priority: spec.priority,
    tags: spec.tags,
    createdAt: spec.createdAt,
    startedAt: state?.startedAt,
    endedAt: state?.endedAt,
    updatedAt: state?.updatedAt ?? spec.createdAt,
    turns: state?.turns ?? 0,
    lastAction: state?.lastAction,
    costUSD: state?.costUSD ?? 0,
    summary: state?.summary,
    reviewTo: spec.reviewTo,
    retryOf: spec.retryOf?.replace(/^auto:/, '') || undefined,
  }
}

/** 失败 / 停止 / 驳回 / 中断，但后来重新派单成功了：不再算异常，归到“完成”一栏 */
export function markRetried(rows: Row[]): Row[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  const fixed = new Map<string, string>()
  for (const r of rows) {
    if (r.status !== 'done') continue
    let target = r.retryOf
    const seen = new Set<string>()
    while (target && !seen.has(target)) {
      seen.add(target)
      const t = byId.get(target)
      if (!t || t.status === 'done' || !isTerminal(t.status)) break
      if (!fixed.has(t.id)) fixed.set(t.id, r.id)
      target = t.retryOf
    }
  }
  return rows.map(r => (fixed.has(r.id) ? { ...r, retriedBy: fixed.get(r.id) } : r))
}

/** 面板分栏和计数用的状态：重派成功的旧工单记作 retried */
export function effectiveStatus(r: Row): string {
  return r.retriedBy ? 'retried' : r.status
}

export class Board {
  specCache = new Map<string, TaskSpec>()
  /** 本机热层，内存为准，定时落盘 */
  hot = new Map<string, Row>()
  hotDirty = false
  otherHot: Row[] = []

  constructor(
    readonly io: IO,
    readonly host: Host,
    readonly root: string,
    readonly machine: string,
  ) {}

  taskDir(id: string) {
    return join(this.root, 'tasks', monthOf(id), id)
  }
  specPath(id: string) {
    return join(this.taskDir(id), 'spec.json')
  }
  statePath(id: string, machine = this.machine) {
    return join(this.taskDir(id), `state.${machine}.json`)
  }
  resultPath(id: string, machine = this.machine) {
    return join(this.taskDir(id), `result.${machine}.md`)
  }
  logPath(id: string, part: number, machine = this.machine) {
    return join(this.taskDir(id), `log.${machine}.${part}.txt`)
  }

  async init(): Promise<void> {
    // 目录按需创建：写一个说明文件即可把根目录建出来
    const readme = join(this.root, 'README.txt')
    if (!(await exists(this.io, readme))) {
      await this.io.write(
        readme,
        '派单器任务板（agent-dispatch）。每个文件只由一台机器写入，请勿手工修改。\nagent-dispatch task board. Each file has a single writer machine; do not edit by hand.\n',
      )
    }
    const saved = await readJson<Row[]>(this.io, join(this.root, 'index', `${this.machine}.json`))
    if (saved) for (const r of saved) this.hot.set(r.id, r)
  }

  // ---------- 工单 ----------

  async createTask(spec: TaskSpec): Promise<void> {
    this.specCache.set(spec.id, spec)
    await writeJson(this.io, this.specPath(spec.id), spec)
    await writeJson(this.io, join(this.root, 'queue', `${spec.id}.json`), {
      id: spec.id,
      priority: spec.priority,
      target: spec.target,
      provider: spec.provider,
      createdAt: spec.createdAt,
    })
  }

  async getSpec(id: string): Promise<TaskSpec | undefined> {
    const hit = this.specCache.get(id)
    if (hit) return hit
    const spec = await readJson<TaskSpec>(this.io, this.specPath(id))
    if (spec) this.specCache.set(id, spec)
    return spec
  }

  /** 所有机器写过的状态里取最新一份 */
  async getState(id: string): Promise<TaskState | undefined> {
    const entries = await listDir(this.io, this.taskDir(id))
    let best: TaskState | undefined
    for (const e of entries) {
      if (!/^state\..+\.json$/.test(e.name)) continue
      const s = await readJson<TaskState>(this.io, join(this.taskDir(id), e.name))
      if (s && (!best || s.updatedAt > best.updatedAt)) best = s
    }
    return best
  }

  async writeState(state: TaskState, spec: TaskSpec): Promise<void> {
    state.updatedAt = Date.now()
    await writeJson(this.io, this.statePath(state.id), state)
    this.hot.set(state.id, rowOf(spec, state))
    this.hotDirty = true
  }

  async writeLogPart(id: string, part: number, text: string): Promise<void> {
    await this.io.write(this.logPath(id, part), text)
  }

  async readLogTail(id: string, machine: string, parts: number, maxChars: number): Promise<string> {
    let out = ''
    for (let p = parts; p >= 0 && out.length < maxChars; p--) {
      try {
        const t = await this.io.read(this.logPath(id, p, machine))
        if (typeof t === 'string') out = t + out
      } catch {
        /* 这一段还没写 */
      }
    }
    return out.length > maxChars ? out.slice(out.length - maxChars) : out
  }

  async writeResult(id: string, text: string): Promise<void> {
    await this.io.write(this.resultPath(id), text)
  }

  async readResult(id: string, machine: string): Promise<string | undefined> {
    try {
      const t = await this.io.read(this.resultPath(id, machine))
      return typeof t === 'string' ? t : undefined
    } catch {
      return undefined
    }
  }

  // ---------- 排队与认领 ----------

  async listQueue(): Promise<{ id: string; priority: number; target: string; provider: string; createdAt: number }[]> {
    const dir = join(this.root, 'queue')
    const out = []
    for (const e of await listDir(this.io, dir)) {
      if (!e.name.endsWith('.json')) continue
      const m = await readJson<any>(this.io, join(dir, e.name))
      if (m?.id) out.push(m)
    }
    return out
  }

  async dequeue(id: string): Promise<void> {
    await removeFile(this.io, this.host, join(this.root, 'queue', `${id}.json`))
  }

  /** 写票据，稍等，再看谁的票据最早；最早的赢。 */
  async claim(id: string): Promise<boolean> {
    const dir = join(this.root, 'claims', id)
    const before = await listDir(this.io, dir)
    if (before.some(e => e.name !== `${this.machine}.json`)) return false
    const ts = Date.now()
    await writeJson(this.io, join(dir, `${this.machine}.json`), { machine: this.machine, ts })
    await this.io.sleep(this.root.startsWith('/Volumes/') || /^[A-Za-z]:/.test(this.root) ? 1200 : 50)
    let winner = { machine: this.machine, ts }
    for (const e of await listDir(this.io, dir)) {
      const c = await readJson<{ machine: string; ts: number }>(this.io, join(dir, e.name))
      if (!c) continue
      if (c.ts < winner.ts || (c.ts === winner.ts && c.machine < winner.machine)) winner = c
    }
    return winner.machine === this.machine
  }

  async clearClaims(id: string): Promise<void> {
    await removeDir(this.io, this.host, join(this.root, 'claims', id))
  }

  // ---------- 操作请求（跨机器、跨会话） ----------

  async sendControl(machine: string, c: Control): Promise<void> {
    await writeJson(this.io, join(this.root, 'controls', machine, `${c.at}-${c.id}-${c.action}.json`), c)
  }

  async takeControls(): Promise<Control[]> {
    const dir = join(this.root, 'controls', this.machine)
    const out: Control[] = []
    for (const e of await listDir(this.io, dir)) {
      const p = join(dir, e.name)
      const c = await readJson<Control>(this.io, p)
      await removeFile(this.io, this.host, p)
      if (c) out.push(c)
    }
    return out
  }

  // ---------- 调度者锁（同一台机器只一个会话调度） ----------

  async tryLock(sessionId: string): Promise<boolean> {
    const p = join(this.root, 'locks', `${this.machine}.json`)
    const cur = await readJson<{ sessionId: string; beat: number }>(this.io, p)
    const now = Date.now()
    if (cur && cur.sessionId !== sessionId && now - cur.beat < 20000) return false
    await writeJson(this.io, p, { sessionId, beat: now })
    return true
  }

  async releaseLock(sessionId: string): Promise<void> {
    const p = join(this.root, 'locks', `${this.machine}.json`)
    const cur = await readJson<{ sessionId: string }>(this.io, p)
    if (cur?.sessionId === sessionId) await writeJson(this.io, p, { sessionId: '', beat: 0 })
  }

  // ---------- 热层与冷层 ----------

  async flushHot(): Promise<void> {
    if (!this.hotDirty) return
    this.hotDirty = false
    await writeJson(this.io, join(this.root, 'index', `${this.machine}.json`), [...this.hot.values()])
  }

  async reloadOwnHot(): Promise<void> {
    const saved = await readJson<Row[]>(this.io, join(this.root, 'index', `${this.machine}.json`))
    if (!saved) return
    this.hot.clear()
    for (const r of saved) this.hot.set(r.id, r)
  }

  async loadOtherHot(): Promise<void> {
    const dir = join(this.root, 'index')
    const rows: Row[] = []
    for (const e of await listDir(this.io, dir)) {
      if (!e.name.endsWith('.json') || e.name === `${this.machine}.json`) continue
      const list = await readJson<Row[]>(this.io, join(dir, e.name))
      if (Array.isArray(list)) rows.push(...list)
    }
    this.otherHot = rows
  }

  /** 结束超过 hotDays 天的行搬到按月归档，热层保持精简 */
  async archive(hotDays: number): Promise<number> {
    const cutoff = Date.now() - hotDays * 86400000
    const byMonth = new Map<string, Row[]>()
    for (const r of this.hot.values()) {
      if (!isTerminal(r.status) || (r.endedAt ?? r.updatedAt) > cutoff) continue
      const d = new Date(r.endedAt ?? r.updatedAt)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      byMonth.set(key, [...(byMonth.get(key) ?? []), r])
    }
    let moved = 0
    for (const [month, rows] of byMonth) {
      const p = join(this.root, 'digest', this.machine, `${month}.json`)
      const old = (await readJson<Row[]>(this.io, p)) ?? []
      const ids = new Set(old.map(r => r.id))
      await writeJson(this.io, p, [...old, ...rows.filter(r => !ids.has(r.id))])
      for (const r of rows) this.hot.delete(r.id)
      moved += rows.length
    }
    if (moved) this.hotDirty = true
    return moved
  }

  /** 冷层按月倒序读取，直到够数 */
  async *archiveRows(): AsyncGenerator<Row> {
    const base = join(this.root, 'digest')
    const files: { path: string; month: string }[] = []
    for (const m of await listDir(this.io, base)) {
      for (const f of await listDir(this.io, join(base, m.name))) {
        if (f.name.endsWith('.json')) files.push({ path: join(base, m.name, f.name), month: f.name })
      }
    }
    files.sort((a, b) => (a.month < b.month ? 1 : -1))
    for (const f of files) {
      const rows = (await readJson<Row[]>(this.io, f.path)) ?? []
      rows.sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
      for (const r of rows) yield r
    }
  }

  async removeTaskQueueAndClaims(id: string): Promise<void> {
    await this.dequeue(id)
    await this.clearClaims(id)
  }
}

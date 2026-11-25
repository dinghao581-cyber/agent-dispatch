// 调度器：认领排队工单、启动智能体、跟踪进度、跑验收闸门、按设置把合并请求交给用户 / Claude / 审查智能体。
import type { IO, Host, SpawnStream } from './util'
import { L, getLang } from './i18n'
import {
  clip,
  dayKey,
  exists,
  expandHome,
  fmtDuration,
  fmtTime,
  fmtTokens,
  fmtUSD,
  join,
  newId,
  shellArgv,
  tail,
} from './util'
import { Board, isTerminal, rowOf } from './board'
import type { Control, ControlAction } from './board'
import {
  buildLaunch,
  canStartNow,
  checkProvider,
  costOf,
  extractSummary,
  extractVerdict,
  isPeak,
  parseStreamLine,
  providerOf,
  readEnvFile,
  maskKey,
  writeDeepseekKey,
  testDeepseek,
} from './providers'
import type { Detail, ReviewTo, Row, Settings, Snapshot, TaskSpec, TaskState } from '../types'

const LOG_PART_CHARS = 200_000
const MAX_EVENTS = 80

type Run = {
  spec: TaskSpec
  state: TaskState
  stream?: SpawnStream
  logBuf: string
  lineBuf: string
  seen: Set<string>
  dirty: boolean
  stopRequested: boolean
  resultText: string
  isError: boolean
}

export const DEFAULT_SETTINGS = (host: Host): Settings => ({
  mode: 'local',
  sharedDir: '',
  localDir: join(host.pluginData || join(host.home, '.claude', 'agent-dispatch'), 'board'),
  maxConcurrent: 4,
  offPeakOnly: false,
  defaultWorktree: false,
  defaultReviewTo: 'user',
  deepseekEnvFile: '~/.agent-dispatch/deepseek.env',
  claudePath: 'claude',
  machineName: '',
  hotDays: 3,
  worktreeDir: '~/.agent-dispatch/worktrees',
  language: 'auto',
  showBand: true,
  autoOpen: true,
})

export type CreateInput = {
  title: string
  prompt: string
  provider?: string
  mode?: 'read' | 'edit'
  cwd?: string
  target?: string
  priority?: number
  tags?: string[]
  worktree?: boolean
  testCommand?: string
  reviewTo?: ReviewTo
  maxTurns?: number
  reviewOf?: string
  retryOf?: string
}

export class Dispatcher {
  board!: Board
  isOwner = false
  /** 有界面的会话才调度；无头子进程（claude -p）只会加载、不会认领工单 */
  active = false
  warning?: string
  keyHint?: string
  lastWarnCheck = 0
  runs = new Map<string, Run>()
  queueRows: Row[] = []
  ticking = false
  lastArchive = 0
  lastOther = 0
  lastError?: string
  onSnapshot?: (s: Snapshot) => void | Promise<void>
  onDetailTick?: () => void | Promise<void>

  constructor(
    readonly io: IO,
    readonly host: Host,
    public settings: Settings,
    readonly sessionCwd: string,
  ) {}

  get boardDir(): string {
    return this.settings.mode === 'shared'
      ? expandHome(this.settings.sharedDir, this.host)
      : expandHome(this.settings.localDir, this.host)
  }

  get machine(): string {
    return this.settings.machineName || this.host.hostname
  }

  async open(): Promise<void> {
    this.board = new Board(this.io, this.host, this.boardDir, this.machine)
    await this.board.init()
  }

  /** 第一次真正画出界面时调用：开始抢调度锁、处理上次中断的工单 */
  async activate(): Promise<void> {
    if (this.active) return
    this.active = true
    this.isOwner = await this.board.tryLock(this.host.sessionId)
    if (this.isOwner) await this.markInterrupted()
    void this.tick()
  }

  /**
   * 上次没跑完的工单：
   * - 客户端正常关闭（session.end 记下了时间）→ 按用户的选择，标为中断，不自动重跑；
   * - 扩展重新加载或进程意外退出（没有关闭记录）→ 自动重新派单，进度不丢。
   */
  async markInterrupted(): Promise<void> {
    const closedAt = Number((await this.io.storeGet('cleanCloseAt')) ?? 0)
    for (const row of [...this.board.hot.values()]) {
      if (row.status !== 'running' && row.status !== 'testing') continue
      if (this.runs.has(row.id)) continue
      const spec = await this.board.getSpec(row.id)
      const state = await this.board.getState(row.id)
      if (!spec || !state || state.machine !== this.machine) continue
      state.status = 'interrupted'
      state.endedAt = Date.now()
      const byReload = closedAt < state.startedAt
      if (byReload && !spec.retryOf?.startsWith('auto:')) {
        const again = await this.retry(row.id, true)
        this.pushEvent(state, L(`扩展重新加载打断了它，已自动重新派单：${again.id}`, `Interrupted by an extension reload; queued again as ${again.id}`))
      } else {
        this.pushEvent(state, L('客户端关闭，智能体已随之停止', 'Client closed; the agent stopped with it'))
      }
      await this.board.writeState(state, spec)
    }
    await this.board.flushHot()
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) {
      run.stopRequested = true
      try {
        await run.stream?.return({ code: null, signal: 'SIGTERM' })
      } catch {
        /* 已经结束 */
      }
    }
    if (this.isOwner) await this.board.releaseLock(this.host.sessionId)
    this.isOwner = false
  }

  async refreshKeyStatus(): Promise<void> {
    this.warning = await checkProvider(this.io, this.host, this.settings, 'deepseek-flash')
    const env = await readEnvFile(this.io, expandHome(this.settings.deepseekEnvFile, this.host))
    this.keyHint = env.DEEPSEEK_API_KEY ? maskKey(env.DEEPSEEK_API_KEY) : undefined
  }

  async saveDeepseekKey(raw: string): Promise<string> {
    const hint = await writeDeepseekKey(this.io, this.host, this.settings, raw)
    await this.refreshKeyStatus()
    void this.tick()
    const test = await testDeepseek(this.io, this.host, this.settings)
    return L(`已保存 Key（${hint}）。${test}`, `Key saved (${hint}). ${test}`)
  }

  async testDeepseek(): Promise<string> {
    return testDeepseek(this.io, this.host, this.settings)
  }

  pushEvent(state: TaskState, text: string): void {
    state.events.push({ t: Date.now(), text })
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
  }

  // ---------- 创建 ----------

  async create(input: CreateInput): Promise<TaskSpec> {
    const provider = input.provider ?? 'deepseek-flash'
    const problem = await checkProvider(this.io, this.host, this.settings, provider)
    if (problem) throw new Error(problem)
    if (!input.title?.trim() || !input.prompt?.trim()) throw new Error(L('工单需要 title 和 prompt', 'A task needs a title and a prompt'))
    const worktree = input.worktree ?? this.settings.defaultWorktree
    const spec: TaskSpec = {
      id: newId(),
      title: clip(input.title, 80),
      prompt: input.prompt,
      provider,
      mode: input.mode ?? 'read',
      cwd: input.cwd ?? this.sessionCwd,
      target: input.target ?? (this.settings.mode === 'shared' ? 'any' : this.machine),
      priority: Math.min(5, Math.max(1, Math.round(input.priority ?? 3))),
      tags: input.tags ?? [],
      gate: { worktree, testCommand: input.testCommand },
      reviewTo: worktree ? (input.reviewTo ?? this.settings.defaultReviewTo) : 'none',
      maxTurns: input.maxTurns,
      createdBy: this.machine,
      createdAt: Date.now(),
      reviewOf: input.reviewOf,
      retryOf: input.retryOf,
    }
    await this.board.createTask(spec)
    this.queueRows.push(rowOf(spec))
    void this.tick()
    return spec
  }

  // ---------- 主循环 ----------

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      this.isOwner = this.active ? await this.board.tryLock(this.host.sessionId) : false
      if (Date.now() - this.lastWarnCheck > 30000) {
        this.lastWarnCheck = Date.now()
        await this.refreshKeyStatus()
      }
      if (this.isOwner) {
        for (const c of await this.board.takeControls()) await this.applyControl(c)
        for (const run of this.runs.values()) if (run.dirty) await this.flushRun(run)
        await this.schedule()
        if (Date.now() - this.lastArchive > 10 * 60 * 1000) {
          this.lastArchive = Date.now()
          await this.board.archive(this.settings.hotDays)
        }
        await this.board.flushHot()
      } else {
        // 旁观会话：本机热层以调度会话写的文件为准
        await this.board.reloadOwnHot()
      }
      await this.refreshQueue()
      if (Date.now() - this.lastOther > 5000 || !this.isOwner) {
        this.lastOther = Date.now()
        await this.board.loadOtherHot()
      }
      this.lastError = undefined
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      this.ticking = false
    }
    await this.onSnapshot?.(this.snapshot())
    await this.onDetailTick?.()
  }

  async refreshQueue(): Promise<void> {
    const markers = await this.board.listQueue()
    const rows: Row[] = []
    for (const m of markers) {
      const spec = await this.board.getSpec(m.id)
      if (spec) rows.push(rowOf(spec))
    }
    this.queueRows = rows
  }

  async schedule(): Promise<void> {
    let free = this.settings.maxConcurrent - this.runs.size
    if (free <= 0 || !canStartNow(this.settings.offPeakOnly)) return
    const markers = (await this.board.listQueue())
      .filter(m => m.target === 'any' || m.target === this.machine)
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
    let started = 0
    for (const m of markers) {
      if (free <= 0 || started >= 2) break
      if (this.runs.has(m.id)) continue
      const spec = await this.board.getSpec(m.id)
      if (!spec) continue
      if (await checkProvider(this.io, this.host, this.settings, spec.provider)) continue
      if (!(await exists(this.io, spec.cwd))) continue
      if (!(await this.board.claim(spec.id))) continue
      await this.board.dequeue(spec.id)
      void this.launch(spec)
      free--
      started++
    }
  }

  // ---------- 运行一张工单 ----------

  async launch(spec: TaskSpec): Promise<void> {
    const state: TaskState = {
      id: spec.id,
      machine: this.machine,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      turns: 0,
      usage: { input: 0, cacheRead: 0, output: 0 },
      costUSD: 0,
      events: [],
      logParts: 0,
    }
    const run: Run = {
      spec,
      state,
      logBuf: '',
      lineBuf: '',
      seen: new Set(),
      dirty: true,
      stopRequested: false,
      resultText: '',
      isError: false,
    }
    this.runs.set(spec.id, run)
    this.pushEvent(state, L(`${this.machine} 认领，开始运行（${providerOf(spec.provider)?.label ?? spec.provider}）`, `Claimed by ${this.machine}, running (${providerOf(spec.provider)?.label ?? spec.provider})`))

    let cwd = spec.cwd
    if (spec.gate.worktree) {
      const wt = await this.setupWorktree(spec, state)
      if (!wt) {
        state.status = 'failed'
        state.endedAt = Date.now()
        await this.finish(run)
        return
      }
      cwd = wt
    }
    await this.flushRun(run)

    try {
      const launch = await buildLaunch(this.io, this.host, this.settings, spec)
      run.stream = this.io.spawn({ argv: launch.argv, cwd, env: launch.env, input: launch.input })
      let peak = isPeak()
      for await (const chunk of run.stream!) {
        if (chunk.stream === 'stderr') {
          run.logBuf += `[stderr] ${chunk.text}`
          run.dirty = true
          continue
        }
        run.logBuf += chunk.text
        run.lineBuf += chunk.text
        const lines = run.lineBuf.split('\n')
        run.lineBuf = lines.pop() ?? ''
        peak = isPeak()
        for (const line of lines) this.applyLine(run, line, peak)
        if (run.logBuf.length > LOG_PART_CHARS) {
          await this.board.writeLogPart(spec.id, state.logParts, run.logBuf)
          state.logParts++
          run.logBuf = ''
        }
        run.dirty = true
      }
      if (run.lineBuf.trim()) this.applyLine(run, run.lineBuf, peak)
    } catch (err) {
      run.isError = true
      state.error = err instanceof Error ? err.message : String(err)
      this.pushEvent(state, L(`启动失败：${clip(state.error, 200)}`, `Failed to start: ${clip(state.error, 200)}`))
    }

    state.endedAt = Date.now()
    if (run.stopRequested) {
      state.status = 'stopped'
      this.pushEvent(state, L('已停止', 'Stopped'))
    } else if (run.isError || !run.resultText) {
      state.status = 'failed'
      this.pushEvent(state, state.error ? L('运行失败', 'Run failed') : L('智能体没有给出结果', 'The agent returned no result'))
    } else {
      state.summary = extractSummary(run.resultText)
      await this.board.writeResult(spec.id, run.resultText)
      this.pushEvent(state, L(`智能体完成：${clip(state.summary, 120)}`, `Agent finished: ${clip(state.summary, 120)}`))
      await this.afterAgent(run)
      return
    }
    await this.finish(run)
  }

  applyLine(run: Run, line: string, peak: boolean): void {
    if (!line.trim()) return
    const upd = parseStreamLine(line, run.seen)
    if (!upd) return
    const st = run.state
    const prov = providerOf(run.spec.provider)
    if (upd.initModel) this.pushEvent(st, L(`模型就绪：${upd.initModel}`, `Model ready: ${upd.initModel}`))
    if (upd.turnsDelta) st.turns += upd.turnsDelta
    if (upd.usageDelta) {
      st.usage.input += upd.usageDelta.input
      st.usage.cacheRead += upd.usageDelta.cacheRead
      st.usage.output += upd.usageDelta.output
      st.costUSD += costOf(prov, upd.usageDelta, peak)
    }
    if (upd.action) {
      st.lastAction = upd.action
      this.pushEvent(st, upd.action)
    }
    if (upd.result) {
      run.resultText = upd.result.text
      run.isError = upd.result.isError
      if (upd.result.turns) st.turns = upd.result.turns
      if (upd.result.usage) {
        // 以最终汇总为准重算费用（按结束时是否高峰计）
        st.usage = upd.result.usage
        st.costUSD = costOf(prov, upd.result.usage, peak)
      }
    }
  }

  async flushRun(run: Run): Promise<void> {
    run.dirty = false
    await this.board.writeState(run.state, run.spec)
    if (run.logBuf) await this.board.writeLogPart(run.spec.id, run.state.logParts, run.logBuf)
  }

  async finish(run: Run): Promise<void> {
    if (run.logBuf) await this.board.writeLogPart(run.spec.id, run.state.logParts, run.logBuf)
    await this.board.writeState(run.state, run.spec)
    this.runs.delete(run.spec.id)
    await this.board.clearClaims(run.spec.id)
    await this.board.flushHot()
    if (run.spec.reviewOf) await this.onReviewFinished(run)
    if (run.state.status === 'failed') {
      void this.io.toast(L(`派单失败：${run.spec.title}`, `Task failed: ${run.spec.title}`))
    }
  }

  // ---------- 验收闸门 ----------

  async git(args: string[], cwd: string, timeoutMs = 120000) {
    try {
      return await this.io.run(['git', ...args], { cwd, timeoutMs })
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }

  async setupWorktree(spec: TaskSpec, state: TaskState): Promise<string | undefined> {
    const top = await this.git(['rev-parse', '--show-toplevel'], spec.cwd)
    if (top.exitCode !== 0) {
      state.error = L('工作目录不是 Git 仓库，无法开独立 worktree', 'The working directory is not a Git repository; cannot create a worktree')
      this.pushEvent(state, state.error)
      return undefined
    }
    const repoRoot = top.stdout.trim().replace(/\\/g, '/')
    const base = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)).stdout.trim()
    const branch = `dispatch/${spec.id}`
    const wt = join(expandHome(this.settings.worktreeDir || '~/.agent-dispatch/worktrees', this.host), spec.id)
    const add = await this.git(['worktree', 'add', '-b', branch, wt, 'HEAD'], repoRoot)
    if (add.exitCode !== 0) {
      state.error = L(`建 worktree 失败：${clip(add.stderr, 200)}`, `Could not create worktree: ${clip(add.stderr, 200)}`)
      this.pushEvent(state, state.error)
      return undefined
    }
    const rel = spec.cwd.replace(/\\/g, '/').slice(repoRoot.length).replace(/^\/+/, '')
    Object.assign(state, { worktree: wt, repoRoot, branch, baseBranch: base })
    this.pushEvent(state, L(`独立 worktree：${branch}（基于 ${base}）`, `Own worktree: ${branch} (from ${base})`))
    return rel ? join(wt, rel) : wt
  }

  async afterAgent(run: Run): Promise<void> {
    const { spec, state } = run
    if (!spec.gate.worktree || !state.worktree || !state.repoRoot) {
      state.status = 'done'
      await this.finish(run)
      return
    }
    // 把智能体留下的改动提交到它自己的分支
    await this.git(['add', '-A'], state.worktree)
    const staged = await this.git(['diff', '--cached', '--quiet'], state.worktree)
    if (staged.exitCode === 1) {
      const email = (await this.git(['config', 'user.email'], state.worktree)).stdout.trim()
      const ident = email ? [] : ['-c', 'user.name=agent-dispatch', '-c', 'user.email=agent-dispatch@localhost']
      await this.git([...ident, 'commit', '-m', L(`派单 ${spec.id}：${spec.title}`, `dispatch ${spec.id}: ${spec.title}`)], state.worktree)
    }
    const ahead = await this.git(['rev-list', '--count', `${state.baseBranch}..${state.branch}`], state.repoRoot)
    if (ahead.stdout.trim() === '0') {
      // 可改文件的工单却什么都没改：多半是被拦下或没做成，不能算完成
      state.status = spec.mode === 'edit' ? 'failed' : 'done'
      if (spec.mode === 'edit') state.error = L('智能体没有留下任何代码改动', 'The agent left no code changes')
      this.pushEvent(state, spec.mode === 'edit' ? L('没有代码改动：判为失败，请看结果里智能体的说明', "No code changes: marked failed; see the agent's explanation in the result") : L('没有代码改动，无需合并', 'No code changes; nothing to merge'))
      await this.cleanupWorktree(state, true)
      await this.finish(run)
      return
    }
    if (spec.gate.testCommand) {
      state.status = 'testing'
      this.pushEvent(state, L(`验收测试：${spec.gate.testCommand}`, `Acceptance test: ${spec.gate.testCommand}`))
      await this.flushRun(run)
      let out = ''
      let code: number | null = 1
      try {
        const t = this.io.spawn({ argv: shellArgv(this.host, spec.gate.testCommand), cwd: state.worktree })
        for (;;) {
          const step = await t.next()
          if (step.done) {
            code = step.value?.code ?? 1
            break
          }
          out = tail(out + step.value.text, 12000)
        }
      } catch (err) {
        out += `\n${err instanceof Error ? err.message : String(err)}`
      }
      state.testTail = out
      state.testPassed = code === 0
      this.pushEvent(state, state.testPassed ? L('测试通过', 'Tests passed') : L(`测试不通过（退出码 ${code}）`, `Tests failed (exit code ${code})`))
      if (!state.testPassed) {
        state.status = 'failed'
        state.error = L('验收测试不通过', 'Acceptance tests failed')
        await this.finish(run)
        return
      }
    }
    await this.routeReview(run)
  }

  async routeReview(run: Run): Promise<void> {
    const { spec, state } = run
    const to = spec.reviewTo
    if (to === 'none') {
      state.status = 'done'
      this.pushEvent(state, L(`分支 ${state.branch} 已保留，未自动合并`, `Branch ${state.branch} kept, not merged`))
      await this.finish(run)
      return
    }
    state.status = 'review'
    const msg = L(
      `派单器：工单 ${spec.id}「${spec.title}」已完成${spec.gate.testCommand ? '并通过测试' : ''}，等待验收合并（分支 ${state.branch}）。`,
      `Dispatcher: task ${spec.id} "${spec.title}" is done${spec.gate.testCommand ? ' and passed its tests' : ''}; waiting for review to merge (branch ${state.branch}).`,
    )
    if (to === 'user') {
      this.pushEvent(state, L('等待用户验收', 'Waiting for your review'))
      if (this.settings.autoOpen) this.io.openPane()
      void this.io.toast(msg)
      void this.io.notify(msg, L('派单器 · 待验收', 'Dispatcher · review needed'))
    } else if (to === 'claude') {
      this.pushEvent(state, L('已交给 Claude 验收', 'Handed to Claude for review'))
      void this.io.submit(
        `${msg}\n${L(`请用 dispatch_get 查看结果与改动，然后用 dispatch_control 批准（approve，会合并进 ${state.baseBranch}）或驳回（reject）。`, `Use dispatch_get to read the result and changes, then dispatch_control to approve (merges into ${state.baseBranch}) or reject.`)}`,
      )
    } else if (to === 'agent') {
      this.pushEvent(state, L('已交给审查智能体', 'Handed to a reviewer agent'))
      await this.finish(run)
      await this.spawnReviewer(spec, state)
      return
    }
    await this.finish(run)
  }

  async spawnReviewer(spec: TaskSpec, state: TaskState): Promise<void> {
    const diff = await this.git(['diff', `${state.baseBranch}...${state.branch}`], state.repoRoot!)
    const prompt = [
      L(
        '你是代码审查员。请审查下面这次改动是否正确完成了任务，是否引入明显错误或越界修改。只读，不要修改文件。',
        'You are a code reviewer. Check whether the change below correctly completes the task and whether it introduces obvious bugs or out-of-scope edits. Read only; do not modify files.',
      ),
      `${L('## 原任务', '## Original task')}\n${spec.prompt}`,
      state.testTail ? `${L('## 测试输出（尾部）', '## Test output (tail)')}\n\`\`\`\n${tail(state.testTail, 4000)}\n\`\`\`` : '',
      `${L('## 改动', '## Changes')} (git diff ${state.baseBranch}...${state.branch})\n\`\`\`diff\n${tail(diff.stdout, 60000)}\n\`\`\``,
      L(
        '审查完毕后，在最后单独写一行结论，格式必须是“【结论】通过”或“【结论】不通过：原因”。',
        'When done, end with a line of its own in exactly this form: "VERDICT: PASS" or "VERDICT: FAIL: reason".',
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
    await this.create({
      title: L(`审查：${spec.title}`, `Review: ${spec.title}`),
      prompt,
      provider: 'deepseek-flash',
      mode: 'read',
      cwd: state.worktree!,
      target: this.machine,
      priority: Math.max(1, spec.priority - 1),
      tags: [L('审查', 'review')],
      worktree: false,
      reviewOf: spec.id,
    })
  }

  async onReviewFinished(run: Run): Promise<void> {
    const parentId = run.spec.reviewOf!
    const verdict = run.state.status === 'done' ? extractVerdict(run.resultText) : undefined
    if (verdict === 'approved') await this.approve(parentId, L('审查智能体', 'reviewer agent'), run.state.summary)
    else if (verdict === 'rejected') await this.reject(parentId, L('审查智能体', 'reviewer agent'), run.state.summary)
    else {
      const parent = await this.loadOwned(parentId)
      if (parent) {
        this.pushEvent(parent.state, L('审查智能体没有给出明确结论，改为等待用户验收', 'The reviewer gave no clear verdict; waiting for your review instead'))
        await this.board.writeState(parent.state, parent.spec)
        await this.board.flushHot()
      }
      void this.io.toast(L(`审查没有结论，请人工验收：${parentId}`, `No review verdict; please review ${parentId} yourself`))
    }
  }

  async cleanupWorktree(state: TaskState, deleteBranch: boolean): Promise<void> {
    if (!state.repoRoot || !state.worktree) return
    await this.git(['worktree', 'remove', '--force', state.worktree], state.repoRoot)
    if (deleteBranch && state.branch) await this.git(['branch', '-D', state.branch], state.repoRoot)
  }

  // ---------- 操作 ----------

  async loadOwned(id: string): Promise<{ spec: TaskSpec; state: TaskState } | undefined> {
    const run = this.runs.get(id)
    if (run) return { spec: run.spec, state: run.state }
    const spec = await this.board.getSpec(id)
    const state = await this.board.getState(id)
    if (!spec || !state) return undefined
    return { spec, state }
  }

  /** 工单在哪台机器上：本机直接处理，否则发操作请求 */
  async control(id: string, action: ControlAction, by: string, note?: string): Promise<string> {
    const state = await this.board.getState(id)
    const owner = state?.machine
    if (action === 'cancel' && !state) {
      const spec = await this.board.getSpec(id)
      if (!spec) return L(`找不到工单 ${id}`, `Task ${id} not found`)
      await this.board.dequeue(id)
      const st: TaskState = {
        id,
        machine: this.machine,
        status: 'stopped',
        startedAt: Date.now(),
        endedAt: Date.now(),
        updatedAt: Date.now(),
        turns: 0,
        usage: { input: 0, cacheRead: 0, output: 0 },
        costUSD: 0,
        events: [{ t: Date.now(), text: L(`${by} 取消了排队`, `${by} cancelled the queued task`) }],
        logParts: 0,
      }
      await this.board.writeState(st, spec)
      await this.board.flushHot()
      void this.tick()
      return L(`已取消排队中的工单 ${id}`, `Cancelled queued task ${id}`)
    }
    if (!state) return L(`工单 ${id} 还没开始运行`, `Task ${id} has not started yet`)
    if (owner !== this.machine || !this.isOwner) {
      await this.board.sendControl(owner!, { id, action, note, by, at: Date.now() })
      return L(`已把“${action}”请求发给 ${owner} 上的派单器`, `Sent "${action}" to the dispatcher on ${owner}`)
    }
    return this.applyControl({ id, action, note, by, at: Date.now() })
  }

  async applyControl(c: Control): Promise<string> {
    if (c.action === 'stop' || c.action === 'cancel') {
      const run = this.runs.get(c.id)
      if (!run) return L(`工单 ${c.id} 不在运行中`, `Task ${c.id} is not running`)
      run.stopRequested = true
      try {
        await run.stream?.return({ code: null, signal: 'SIGTERM' })
      } catch {
        /* 已结束 */
      }
      return L(`已停止 ${c.id}`, `Stopped ${c.id}`)
    }
    if (c.action === 'approve') return this.approve(c.id, c.by, c.note)
    if (c.action === 'reject') return this.reject(c.id, c.by, c.note)
    return L('未知操作', 'Unknown action')
  }

  async approve(id: string, by: string, note?: string): Promise<string> {
    const owned = await this.loadOwned(id)
    if (!owned) return L(`找不到工单 ${id}`, `Task ${id} not found`)
    const { spec, state } = owned
    if (state.status !== 'review') return L(`工单 ${id} 当前状态是 ${state.status}，不在待审`, `Task ${id} is ${state.status}, not waiting for review`)
    const repo = state.repoRoot!
    const dirty = await this.git(['status', '--porcelain', '--untracked-files=no'], repo)
    if (dirty.stdout.trim()) {
      this.pushEvent(state, L(`${by} 批准，但主工作区有未提交改动，暂不合并`, `Approved by ${by}, but the main checkout has uncommitted changes; not merged yet`))
      await this.board.writeState(state, spec)
      await this.board.flushHot()
      return L(`主工作区 ${repo} 有未提交改动，先提交或暂存后再批准`, `${repo} has uncommitted changes; commit or stash them, then approve again`)
    }
    const merge = await this.git(['merge', '--no-ff', '-m', L(`合并派单 ${id}：${spec.title}`, `Merge dispatch ${id}: ${spec.title}`), state.branch!], repo)
    if (merge.exitCode !== 0) {
      await this.git(['merge', '--abort'], repo)
      this.pushEvent(state, L(`${by} 批准，但合并冲突，已放弃合并`, `Approved by ${by}, but the merge conflicted and was aborted`))
      await this.board.writeState(state, spec)
      await this.board.flushHot()
      return L(`合并冲突，已放弃：${clip(merge.stdout + merge.stderr, 300)}`, `Merge conflict, aborted: ${clip(merge.stdout + merge.stderr, 300)}`)
    }
    state.review = { verdict: 'approved', by, at: Date.now(), note }
    state.status = 'done'
    this.pushEvent(state, L(`${by} 批准，已合并进当前分支${note ? `：${clip(note, 100)}` : ''}`, `Approved by ${by}, merged into the current branch${note ? `: ${clip(note, 100)}` : ''}`))
    await this.cleanupWorktree(state, true)
    await this.board.writeState(state, spec)
    await this.board.flushHot()
    void this.tick()
    return L(`已批准并合并 ${id}`, `Approved and merged ${id}`)
  }

  async reject(id: string, by: string, note?: string): Promise<string> {
    const owned = await this.loadOwned(id)
    if (!owned) return L(`找不到工单 ${id}`, `Task ${id} not found`)
    const { spec, state } = owned
    if (state.status !== 'review') return L(`工单 ${id} 当前状态是 ${state.status}，不在待审`, `Task ${id} is ${state.status}, not waiting for review`)
    state.review = { verdict: 'rejected', by, at: Date.now(), note }
    state.status = 'rejected'
    this.pushEvent(state, L(`${by} 驳回${note ? `：${clip(note, 120)}` : ''}（分支 ${state.branch} 保留）`, `Rejected by ${by}${note ? `: ${clip(note, 120)}` : ''} (branch ${state.branch} kept)`))
    await this.cleanupWorktree(state, false)
    await this.board.writeState(state, spec)
    await this.board.flushHot()
    void this.tick()
    return L(`已驳回 ${id}，分支 ${state.branch} 保留备查`, `Rejected ${id}; branch ${state.branch} kept for reference`)
  }

  async retry(id: string, auto = false): Promise<TaskSpec> {
    const spec = await this.board.getSpec(id)
    if (!spec) throw new Error(L(`找不到工单 ${id}`, `Task ${id} not found`))
    return this.create({
      title: spec.title,
      prompt: spec.prompt,
      provider: spec.provider,
      mode: spec.mode,
      cwd: spec.cwd,
      target: spec.target,
      priority: spec.priority,
      tags: spec.tags,
      worktree: spec.gate.worktree,
      testCommand: spec.gate.testCommand,
      reviewTo: spec.reviewTo,
      maxTurns: spec.maxTurns,
      // 自动重派只做一次：再被打断就停下来等人处理
      retryOf: auto ? `auto:${id}` : id,
    })
  }

  // ---------- 读取 ----------

  allRows(): Row[] {
    const map = new Map<string, Row>()
    const put = (r: Row) => {
      const cur = map.get(r.id)
      if (!cur || r.updatedAt >= cur.updatedAt) map.set(r.id, r)
    }
    for (const r of this.queueRows) put(r)
    for (const r of this.board.otherHot) put(r)
    for (const r of this.board.hot.values()) put(r)
    for (const run of this.runs.values()) put(rowOf(run.spec, run.state))
    // 排队标记还在但已有状态的，以状态为准
    return [...map.values()]
  }

  snapshot(): Snapshot {
    const rows = this.allRows()
    const counts: Record<string, number> = {}
    let costToday = 0
    const today = dayKey(Date.now())
    for (const r of rows) {
      counts[r.status] = (counts[r.status] ?? 0) + 1
      const when = r.endedAt ?? r.startedAt
      if (when && dayKey(when) === today) costToday += r.costUSD
    }
    const order: Record<string, number> = { running: 0, testing: 1, review: 2, queued: 3 }
    rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.updatedAt - a.updatedAt)
    return {
      machine: this.machine,
      mode: this.settings.mode,
      boardDir: this.boardDir,
      isOwner: this.isOwner,
      running: [...this.runs.values()].length,
      maxConcurrent: this.settings.maxConcurrent,
      offPeakOnly: this.settings.offPeakOnly,
      isPeak: isPeak(),
      costToday,
      counts,
      rows: rows.slice(0, 400),
      error: this.lastError,
      warning: this.warning,
      keyHint: this.keyHint,
      isActive: this.active,
      lang: getLang(),
      refreshedAt: Date.now(),
    }
  }

  async detail(id: string): Promise<Detail | undefined> {
    const run = this.runs.get(id)
    const spec = run?.spec ?? (await this.board.getSpec(id))
    if (!spec) return undefined
    const state = run?.state ?? (await this.board.getState(id))
    const row = rowOf(spec, state)
    let logTail = ''
    let result: string | undefined
    if (run) {
      logTail = tail(run.logBuf, 6000)
    } else if (state) {
      logTail = await this.board.readLogTail(id, state.machine, state.logParts, 6000)
      result = await this.board.readResult(id, state.machine)
    }
    return {
      id,
      row,
      prompt: spec.prompt,
      cwd: spec.cwd,
      mode: spec.mode,
      gate: spec.gate,
      events: state?.events ?? [],
      usage: state?.usage ?? { input: 0, cacheRead: 0, output: 0 },
      result,
      logTail: humanLog(logTail),
      testTail: state?.testTail,
      error: state?.error,
      branch: state?.branch,
      worktree: state?.worktree,
      review: state?.review,
      loadedAt: Date.now(),
    }
  }

  /** 给 Claude 的分页查询：先热层，再按月读冷层 */
  async query(f: {
    status?: string
    text?: string
    tag?: string
    machine?: string
    limit?: number
    cursor?: number
  }): Promise<{ rows: Row[]; next?: number; total?: number }> {
    const limit = Math.min(50, Math.max(1, f.limit ?? 20))
    const offset = Math.max(0, f.cursor ?? 0)
    const active = ['running', 'testing', 'review', 'queued']
    const match = (r: Row) =>
      (!f.status ||
        (f.status === 'active' ? active.includes(r.status) : r.status === f.status)) &&
      (!f.machine || r.machine === f.machine) &&
      (!f.tag || r.tags.includes(f.tag)) &&
      (!f.text ||
        `${r.id} ${r.title} ${r.summary ?? ''}`.toLowerCase().includes(f.text.toLowerCase()))
    const hot = this.allRows()
      .filter(match)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const seen = new Set(hot.map(r => r.id))
    const out = hot.slice(offset, offset + limit)
    let index = hot.length
    if (out.length < limit && f.status !== 'active' && !active.includes(f.status ?? '')) {
      for await (const r of this.board.archiveRows()) {
        if (seen.has(r.id) || !match(r)) continue
        if (index >= offset) out.push(r)
        index++
        if (out.length >= limit) break
      }
    }
    const next = out.length === limit ? offset + limit : undefined
    return { rows: out, next, total: out.length < limit ? index : undefined }
  }

  overviewText(): string {
    const s = this.snapshot()
    const c = (k: string) => s.counts[k] ?? 0
    const lines = [
      L(
        `派单器 · ${s.machine} · ${s.mode === 'shared' ? `共享任务板 ${s.boardDir}` : `本机任务板 ${s.boardDir}`}${s.isOwner ? '' : '（本会话只旁观，调度由本机另一个会话负责）'}`,
        `Dispatcher · ${s.machine} · ${s.mode === 'shared' ? `shared board ${s.boardDir}` : `local board ${s.boardDir}`}${s.isOwner ? '' : ' (this session only watches; another session on this machine schedules)'}`,
      ),
      L(
        `运行 ${c('running') + c('testing')}/${s.maxConcurrent} · 排队 ${c('queued')} · 待审 ${c('review')} · 近 ${this.settings.hotDays} 天完成 ${c('done')} · 失败 ${c('failed')} · 中断 ${c('interrupted')}`,
        `Running ${c('running') + c('testing')}/${s.maxConcurrent} · queued ${c('queued')} · review ${c('review')} · done (last ${this.settings.hotDays} days) ${c('done')} · failed ${c('failed')} · interrupted ${c('interrupted')}`,
      ),
      L(
        `今日费用 ${fmtUSD(s.costToday)} · ${s.isPeak ? 'DeepSeek 高峰时段' : 'DeepSeek 低谷时段'}${s.offPeakOnly ? '（只在低谷开新单）' : ''}`,
        `Cost today ${fmtUSD(s.costToday)} · ${s.isPeak ? 'DeepSeek peak hours' : 'DeepSeek off-peak'}${s.offPeakOnly ? ' (new tasks start off-peak only)' : ''}`,
      ),
    ]
    const pick = (st: string[], n: number) => s.rows.filter(r => st.includes(r.status)).slice(0, n)
    const fmt = (r: Row) =>
      `- ${r.id} [${statusLabel(r.status)}] ${r.title}${r.machine ? ` @${r.machine}` : ''}${r.turns ? ` · ${r.turns} ${L('轮', 'turns')}` : ''}${r.costUSD ? ` · ${fmtUSD(r.costUSD)}` : ''}${r.lastAction && (r.status === 'running') ? ` · ${clip(r.lastAction, 50)}` : ''}${r.summary && isTerminal(r.status) ? ` · ${clip(r.summary, 80)}` : ''}`
    const running = pick(['running', 'testing'], 10)
    const attention = pick(['review', 'failed', 'interrupted'], 10)
    if (running.length) lines.push('', L('运行中：', 'Running:'), ...running.map(fmt))
    if (attention.length) lines.push('', L('需要处理：', 'Needs attention:'), ...attention.map(fmt))
    if (s.error) lines.push('', L(`最近一次刷新出错：${s.error}`, `Last refresh failed: ${s.error}`))
    lines.push('', L('更多用 dispatch_list 分页查询，单张详情用 dispatch_get。', 'Use dispatch_list for paged queries and dispatch_get for one task.'))
    return lines.join('\n')
  }
}

export function statusLabel(s: string): string {
  const zh: Record<string, string> = {
    queued: '排队',
    running: '运行中',
    testing: '测试中',
    review: '待审',
    done: '完成',
    failed: '失败',
    stopped: '已停止',
    rejected: '已驳回',
    interrupted: '中断',
  }
  const en: Record<string, string> = {
    queued: 'Queued',
    running: 'Running',
    testing: 'Testing',
    review: 'Review',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
    rejected: 'Rejected',
    interrupted: 'Interrupted',
  }
  return L(zh[s] ?? s, en[s] ?? s)
}

/** 把 stream-json 原始日志转成人能读的几行 */
function humanLog(raw: string): string {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('[stderr]')) {
      out.push(t)
      continue
    }
    try {
      const ev = JSON.parse(t)
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) out.push(`💬 ${clip(c.text, 300)}`)
          if (c.type === 'tool_use') out.push(`🔧 ${c.name} ${clip(JSON.stringify(c.input ?? {}), 160)}`)
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_result') {
            const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '')
            out.push(`   ↳ ${clip(body, 160)}`)
          }
        }
      } else if (ev.type === 'result') {
        out.push(L(`✅ 结束：${ev.subtype ?? ''} · ${ev.num_turns ?? '?'} 轮`, `✅ Finished: ${ev.subtype ?? ''} · ${ev.num_turns ?? '?'} turns`))
      }
    } catch {
      /* 半行或非 JSON：跳过 */
    }
  }
  return out.slice(-60).join('\n')
}

export function rowLine(r: Row): string {
  const parts = [
    r.id,
    statusLabel(r.status),
    r.title,
    providerOf(r.provider)?.short ?? r.provider,
    r.machine ? `@${r.machine}` : r.target !== 'any' ? `→${r.target}` : '',
    r.turns ? L(`${r.turns}轮`, `${r.turns} turns`) : '',
    r.costUSD ? fmtUSD(r.costUSD) : '',
    r.startedAt
      ? r.endedAt
        ? fmtDuration(r.endedAt - r.startedAt)
        : L(`已运行${fmtDuration(Date.now() - r.startedAt)}`, `running ${fmtDuration(Date.now() - r.startedAt)}`)
      : L(`建于${fmtTime(r.createdAt)}`, `created ${fmtTime(r.createdAt)}`),
    r.summary ? `${L('摘要：', 'Summary: ')}${clip(r.summary, 100)}` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

export function detailText(d: Detail, part: string): string {
  const r = d.row
  const head = [
    `${r.id} · ${statusLabel(r.status)} · ${r.title}`,
    L(
      `智能体 ${providerOf(r.provider)?.label ?? r.provider} · 模式 ${d.mode === 'edit' ? '可改文件' : '只读'} · 机器 ${r.machine ?? '未认领'} · 目录 ${d.cwd}`,
      `Agent ${providerOf(r.provider)?.label ?? r.provider} · mode ${d.mode === 'edit' ? 'can edit' : 'read only'} · machine ${r.machine ?? 'unclaimed'} · dir ${d.cwd}`,
    ),
    L(
      `轮次 ${r.turns} · Token 输入 ${fmtTokens(d.usage.input)} / 缓存 ${fmtTokens(d.usage.cacheRead)} / 输出 ${fmtTokens(d.usage.output)} · 费用 ${fmtUSD(r.costUSD)}`,
      `Turns ${r.turns} · tokens in ${fmtTokens(d.usage.input)} / cached ${fmtTokens(d.usage.cacheRead)} / out ${fmtTokens(d.usage.output)} · cost ${fmtUSD(r.costUSD)}`,
    ),
    d.gate.worktree
      ? L(
          `验收闸门：独立分支 ${d.branch ?? '（待建）'}${d.gate.testCommand ? ` · 测试 ${d.gate.testCommand}` : ''} · 验收交给 ${r.reviewTo}`,
          `Gate: branch ${d.branch ?? '(pending)'}${d.gate.testCommand ? ` · test ${d.gate.testCommand}` : ''} · review by ${r.reviewTo}`,
        )
      : L('验收闸门：关', 'Gate: off'),
    d.error ? `${L('错误：', 'Error: ')}${d.error}` : '',
    d.review
      ? L(
          `审查：${d.review.verdict === 'approved' ? '批准' : '驳回'}（${d.review.by}）${d.review.note ? ` ${clip(d.review.note, 200)}` : ''}`,
          `Review: ${d.review.verdict === 'approved' ? 'approved' : 'rejected'} (${d.review.by})${d.review.note ? ` ${clip(d.review.note, 200)}` : ''}`,
        )
      : '',
  ].filter(Boolean)
  if (part === 'log') return [...head, '', L('日志尾部：', 'Log tail:'), d.logTail || L('（暂无）', '(none yet)')].join('\n')
  if (part === 'events')
    return [...head, '', L('进展：', 'Progress:'), ...d.events.map(e => `${fmtTime(e.t)} ${e.text}`)].join('\n')
  if (part === 'prompt') return [...head, '', L('任务内容：', 'Task:'), d.prompt].join('\n')
  if (part === 'result' || part === 'full') {
    return [
      ...head,
      '',
      L('结果：', 'Result:'),
      d.result ? tail(d.result, part === 'full' ? 30000 : 8000) : L('（暂无）', '(none yet)'),
      d.testTail ? `\n${L('测试输出（尾部）：', 'Test output (tail):')}\n${tail(d.testTail, 3000)}` : '',
    ].join('\n')
  }
  return [
    ...head,
    r.summary ? `${L('摘要：', 'Summary: ')}${r.summary}` : '',
    L('最近进展：', 'Recent progress:'),
    ...d.events.slice(-8).map(e => `${fmtTime(e.t)} ${e.text}`),
  ]
    .filter(Boolean)
    .join('\n')
}

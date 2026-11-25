// 派单器入口：会话开始时连上任务板、注册 Claude 可调用的工具、打开右侧面板、启动调度循环。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { IO } from './util'
import { detectHost } from './util'
import { DEFAULT_SETTINGS, Dispatcher, detailText, rowLine } from './runner'
import type { CreateInput } from './runner'
import { PROVIDERS } from './providers'
import { renderPane } from './view'
import type { Actions } from './view'
import type { Detail, Settings, Snapshot, Tab, View } from '../types'

const PANE = 'dispatch'

const snapshotAtom = atom({ plugin: 'agent-dispatch', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snap-1' })
const viewAtom = atom({ plugin: 'agent-dispatch', key: 'view' } as const, { tab: 'active', page: 0 } as View, { shape: 'view-1' })
const detailAtom = atom({ plugin: 'agent-dispatch', key: 'detail' } as const, null as Detail | null, { shape: 'detail-1' })

let disp: Dispatcher | undefined
const FALLBACK_SETTINGS = DEFAULT_SETTINGS({ isWindows: false, home: '~', hostname: '', sessionId: '', pluginData: '' })
let timer: { cancel: () => void } | undefined
let io: IO | undefined
// 重新加载后 session.start 要几秒才把派单器建好；这期间到来的工具调用先等它
let markReady: () => void = () => {}
const ready = new Promise<void>(resolve => {
  markReady = resolve
})

async function startDispatcher(adapter: IO, cwd: string): Promise<Dispatcher> {
  const host = await detectHost(adapter)
  const saved = (await adapter.storeGet('settings')) as Partial<Settings> | undefined
  const settings = { ...DEFAULT_SETTINGS(host), ...(saved ?? {}) }
  const d = new Dispatcher(adapter, host, settings, cwd)
  await d.open()
  return d
}

const ok = (text: string) => ({ result: text })
const fail = (text: string) => ({ result: `出错：${text}` })

const createSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '工单标题，一句话' },
    prompt: {
      type: 'string',
      description: '交给智能体的完整任务说明。智能体看不到当前对话：写清背景、文件路径、要做什么、怎样算完成。',
    },
    provider: {
      type: 'string',
      enum: PROVIDERS.map(p => p.id),
      description: `用哪个智能体，默认 deepseek-flash。可用：${PROVIDERS.filter(p => p.enabled).map(p => p.id).join(', ')}`,
    },
    mode: { type: 'string', enum: ['read', 'edit'], description: 'read 只读（默认）；edit 可改文件、跑命令' },
    cwd: { type: 'string', description: '工作目录，默认当前会话目录' },
    target: { type: 'string', description: "'any' 任意机器认领，或指定机器名" },
    priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 最高，默认 3' },
    tags: { type: 'array', items: { type: 'string' } },
    worktree: { type: 'boolean', description: '验收闸门：在独立 Git 分支/worktree 里干活，完成后走验收再合并' },
    testCommand: { type: 'string', description: '验收测试命令（在 worktree 里执行，退出码 0 才算通过）' },
    reviewTo: {
      type: 'string',
      enum: ['user', 'claude', 'agent', 'none'],
      description: '通过测试后的合并请求交给谁：user 用户在面板批准；claude 交给当前 Claude 会话；agent 交给审查智能体；none 只保留分支',
    },
    maxTurns: { type: 'integer', description: '最多对话轮数（可选）' },
    tasks: {
      type: 'array',
      description: '批量派单：每项字段同上（title、prompt 必填）。给了 tasks 就忽略顶层字段。',
      items: { type: 'object' },
    },
  },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 派单器自己启动的无头智能体也会加载插件：只在有界面的会话里运行
    io = {
      read: async path => {
        const r = await $.fs.read(path)
        return typeof r === 'string' ? r : ''
      },
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
      run: (argv, init) => $.process.run(argv, init),
      spawn: req => $.process.spawn(req),
      sleep: ms => $.clock.sleep(ms),
      toast: text => void $.ui.toast(text),
      notify: (text, title) => void $.ui.notify(text, { title }),
      submit: text => void $.prompt.submit({ text }),
      machine: () => $.session.machine(),
      hookEnv: () => $.process.hookEnv(),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value as any),
    }
    try {
      disp = await startDispatcher(io, e.cwd)
      disp.onSnapshot = async s => {
        await update($, snapshotAtom, () => s)
      }
      disp.onDetailTick = async () => {
        const v = await read($, viewAtom)
        if (!v.selected || !disp) return
        const det = await disp.detail(v.selected)
        await update($, detailAtom, () => det ?? null)
      }
      markReady()
    } catch (err) {
      markReady()
      void $.ui.toast(`派单器启动失败：${err instanceof Error ? err.message : String(err)}`)
      return started
    }

    await $.tool.register({
      name: 'dispatch_create',
      description:
        '派单器：创建一张或多张工单，交给后台智能体（默认 DeepSeek Flash）执行。返回工单号。智能体在右侧面板显示状态与进度。适合规格明确、可独立完成的批量活。',
      inputSchema: createSchema,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_overview',
      description: '派单器总览：各状态数量、运行中的智能体、需要处理的工单、今日费用。先用它看全局，再按需查询。',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_list',
      description:
        '派单器分页查询工单（热层 + 按月归档），不会一次返回全部。status 可为 active/queued/running/testing/review/done/failed/stopped/rejected/interrupted；text 按标题/摘要/工单号搜索；cursor 用上次返回的 next。',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          text: { type: 'string' },
          tag: { type: 'string' },
          machine: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          cursor: { type: 'integer' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_get',
      description:
        '派单器：查看单张工单。part=summary（默认，状态+摘要+最近进展）、result（智能体的最终回答）、full（完整结果）、events（全部进展）、log（原始输出尾部）、prompt（任务内容）。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          part: { type: 'string', enum: ['summary', 'result', 'full', 'events', 'log', 'prompt'] },
        },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_control',
      description:
        '派单器：操作工单。stop 停止运行；cancel 取消排队；retry 重新派单；approve 批准待审工单并合并分支；reject 驳回待审工单。工单在别的机器上时会自动转发请求。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['stop', 'cancel', 'retry', 'approve', 'reject'] },
          note: { type: 'string', description: '批准/驳回的理由' },
        },
        required: ['id', 'action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_settings',
      description:
        '派单器设置：action=get 查看；action=set 修改。字段：mode(shared/local)、sharedDir、localDir、maxConcurrent、offPeakOnly、defaultWorktree、defaultReviewTo(user/claude/agent/none)、deepseekEnvFile、claudePath、machineName、hotDays、worktreeDir。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'] },
          mode: { type: 'string', enum: ['shared', 'local'] },
          sharedDir: { type: 'string' },
          localDir: { type: 'string' },
          maxConcurrent: { type: 'integer', minimum: 1, maximum: 64 },
          offPeakOnly: { type: 'boolean' },
          defaultWorktree: { type: 'boolean' },
          defaultReviewTo: { type: 'string', enum: ['user', 'claude', 'agent', 'none'] },
          deepseekEnvFile: { type: 'string' },
          claudePath: { type: 'string' },
          machineName: { type: 'string' },
          hotDays: { type: 'integer', minimum: 1, maximum: 30 },
          worktreeDir: { type: 'string', description: '验收闸门 worktree 目录，不能放在 ~/.claude 下' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'dispatch', description: '打开派单器面板' })

    timer?.cancel()
    timer = $.clock.every(3000, () => {
      void disp?.tick()
    })
    void disp.tick()
    // 会话启动时界面还没接上；等第一次画出提示栏再决定是否打开侧栏、开始调度
    return started
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    await disp?.close()
    return next(e)
  })

  // 界面第一次画出提示栏：说明这是有人在看的会话，开始调度；桌面端顺手打开右侧面板
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disp && !disp.active) {
      void disp.activate()
      if (e.surface === 'desktop' || e.viewport?.isFullscreen) void $.ui.open({ id: PANE, title: '派单器' })
    }
    return next(e)
  })

  on('command.run', { command: 'dispatch' }, async $ => {
    void disp?.activate()
    await $.ui.open({ id: PANE, title: '派单器' })
    return { text: '派单器面板已打开。' }
  })

  // ---------- Claude 可调用的工具 ----------

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_create' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail('派单器没有启动')
    const input = e as unknown as CreateInput & { tasks?: CreateInput[] }
    const list = Array.isArray(input.tasks) && input.tasks.length ? input.tasks : [input]
    const lines: string[] = []
    for (const one of list) {
      try {
        const spec = await disp.create(one)
        lines.push(`${spec.id} · ${spec.title} · ${spec.provider} · ${spec.mode === 'edit' ? '可改文件' : '只读'}${spec.gate.worktree ? ` · 闸门开（验收交给 ${spec.reviewTo}）` : ''}`)
      } catch (err) {
        lines.push(`未创建「${one.title ?? '?'}」：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const s = disp.snapshot()
    return ok(
      `已派单 ${lines.filter(l => l.startsWith('T')).length} 张：\n${lines.join('\n')}\n\n` +
        `当前运行 ${s.running}/${s.maxConcurrent}${s.offPeakOnly && s.isPeak ? '；现在是 DeepSeek 高峰时段，排队到低谷再开' : ''}。进度看右侧面板，或用 dispatch_get。`,
    )
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_overview' }, async ($) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail('派单器没有启动')
    await disp.tick()
    return ok(disp.overviewText())
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_list' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail('派单器没有启动')
    const f = e as any
    const { rows, next } = await disp.query({
      status: f.status,
      text: f.text,
      tag: f.tag,
      machine: f.machine,
      limit: f.limit,
      cursor: f.cursor,
    })
    if (!rows.length) return ok('没有符合条件的工单。')
    return ok(`${rows.map(rowLine).join('\n')}${next !== undefined ? `\n\n还有更多：cursor=${next}` : '\n\n（已到末尾）'}`)
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_get' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail('派单器没有启动')
    const f = e as any
    const d = await disp.detail(String(f.id ?? ''))
    if (!d) return fail(`找不到工单 ${f.id}`)
    return ok(detailText(d, f.part ?? 'summary'))
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_control' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail('派单器没有启动')
    const f = e as any
    const id = String(f.id ?? '')
    try {
      if (f.action === 'retry') {
        const spec = await disp.retry(id)
        return ok(`已重新派单：${spec.id}`)
      }
      return ok(await disp.control(id, f.action, 'Claude', f.note))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_settings' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail('派单器没有启动')
    const f = e as any
    if (f.action === 'set') {
      const patch: Partial<Settings> = {}
      for (const k of [
        'mode',
        'sharedDir',
        'localDir',
        'maxConcurrent',
        'offPeakOnly',
        'defaultWorktree',
        'defaultReviewTo',
        'deepseekEnvFile',
        'claudePath',
        'machineName',
        'hotDays',
        'worktreeDir',
      ] as const) {
        if (f[k] !== undefined) (patch as any)[k] = f[k]
      }
      const msg = await applySettings(patch)
      if (msg) return fail(msg)
    }
    const s = disp.settings
    return ok(
      Object.entries(s)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n') + `\n任务板目录：${disp.boardDir}`,
    )
  })

  // ---------- 右侧面板 ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void disp?.activate()
    const el = $.ui.resolve(e)
    const s = await read($, snapshotAtom)
    const v = await read($, viewAtom)
    const d = await read($, detailAtom)
    const say = (t: string) => void $.ui.toast(t)
    const act = (fn: () => Promise<string>) => () => {
      void fn().then(say, err => say(`出错：${err instanceof Error ? err.message : String(err)}`))
    }
    const actions: Actions = {
      setTab: (tab: Tab) => void update($, viewAtom, cur => ({ ...cur, tab, page: 0, selected: undefined })),
      setPage: page => void update($, viewAtom, cur => ({ ...cur, page })),
      open: id => {
        void (async () => {
          await update($, detailAtom, () => null)
          await update($, viewAtom, cur => ({ ...cur, selected: id }))
          const det = await disp?.detail(id)
          await update($, detailAtom, () => det ?? null)
        })()
      },
      back: () => void update($, viewAtom, cur => ({ ...cur, selected: undefined })),
      stop: id => act(async () => (disp ? disp.control(id, 'stop', '用户') : '派单器没有启动'))(),
      cancel: id => act(async () => (disp ? disp.control(id, 'cancel', '用户') : '派单器没有启动'))(),
      approve: id => act(async () => (disp ? disp.control(id, 'approve', '用户') : '派单器没有启动'))(),
      reject: id => act(async () => (disp ? disp.control(id, 'reject', '用户') : '派单器没有启动'))(),
      retry: id =>
        act(async () => {
          if (!disp) return '派单器没有启动'
          const spec = await disp.retry(id)
          return `已重新派单：${spec.id}`
        })(),
      refresh: () => void disp?.tick(),
      openSettings: () => void update($, viewAtom, (cur): View => ({ ...cur, screen: 'settings', selected: undefined })),
      closeSettings: () => void update($, viewAtom, (cur): View => ({ ...cur, screen: 'list' })),
      setSetting: (key, value) =>
        act(async () => (await applySettings({ [key]: value } as Partial<Settings>)) ?? '已保存')(),
    }
    return renderPane(el, (e as any).props, s, v, d, actions, disp?.settings ?? FALLBACK_SETTINGS)
  })
}

/** 改设置；换任务板需要先停下正在跑的智能体 */
async function applySettings(patch: Partial<Settings>): Promise<string | undefined> {
  if (!disp || !io) return '派单器没有启动'
  const next = { ...disp.settings, ...patch }
  if (next.mode === 'shared' && !next.sharedDir.trim()) return '请先在设置里填写共享任务板目录（例如 NAS 上的文件夹）'
  if (!Number.isFinite(next.maxConcurrent) || next.maxConcurrent < 1) return '同时运行上限至少为 1'
  if (/(^|[\\/])\.claude([\\/]|$)/.test(next.worktreeDir)) return 'worktree 目录不能放在 .claude 文件夹里：Claude Code 会拦下智能体对那里的修改'
  const boardChanged =
    next.mode !== disp.settings.mode ||
    next.sharedDir !== disp.settings.sharedDir ||
    next.localDir !== disp.settings.localDir ||
    next.machineName !== disp.settings.machineName
  if (boardChanged && disp.runs.size > 0) return `还有 ${disp.runs.size} 个智能体在运行，等它们结束或先停止，再切换任务板`
  if (boardChanged) {
    const fresh = new Dispatcher(io, disp.host, next, disp.sessionCwd)
    fresh.onSnapshot = disp.onSnapshot
    fresh.onDetailTick = disp.onDetailTick
    try {
      await fresh.open()
    } catch (err) {
      return `打不开任务板 ${fresh.boardDir}：${err instanceof Error ? err.message : String(err)}`
    }
    const wasActive = disp.active
    await disp.close()
    disp = fresh
    if (wasActive) await fresh.activate()
  } else {
    disp.settings = next
  }
  await io.storeSet('settings', next)
  void disp.tick()
  return undefined
}

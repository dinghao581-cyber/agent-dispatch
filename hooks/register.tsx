// 派单器入口：会话开始时连上任务板、注册 Claude 可调用的工具、打开右侧面板、启动调度循环。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { IO } from './util'
import { detectHost } from './util'
import { L, resolveLang, setLang } from './i18n'
import { DEFAULT_SETTINGS, Dispatcher, detailText, rowLine } from './runner'
import type { CreateInput } from './runner'
import { PROVIDERS } from './providers'
import { renderBand, renderPane } from './view'
import type { Actions } from './view'
import type { Detail, Settings, Snapshot, Tab, View } from '../types'

const PANE = 'dispatch'

const snapshotAtom = atom({ plugin: 'agent-dispatch', key: 'snapshot' } as const, null as Snapshot | null, { shape: 'snap-1' })
const viewAtom = atom({ plugin: 'agent-dispatch', key: 'view' } as const, { tab: 'active', page: 0 } as View, { shape: 'view-1' })
const activeAtom = atom({ plugin: 'agent-dispatch', key: 'active' } as const, false)
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
  setLang(await resolveLang(adapter, host, settings.language))
  const d = new Dispatcher(adapter, host, settings, cwd)
  await d.open()
  return d
}

const ok = (text: string) => ({ result: text })
const fail = (text: string) => ({ result: `${L('出错：', 'Error: ')}${text}` })

const createSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Task title, one line' },
    prompt: {
      type: 'string',
      description:
        'Full instructions for the agent. The agent cannot see this conversation: state the background, file paths, what to do and what counts as done.',
    },
    provider: {
      type: 'string',
      enum: PROVIDERS.map(p => p.id),
      description: `Which agent runs it; default deepseek-flash. Available: ${PROVIDERS.filter(p => p.enabled).map(p => p.id).join(', ')}`,
    },
    mode: { type: 'string', enum: ['read', 'edit'], description: 'read: read only (default); edit: may edit files and run commands' },
    cwd: { type: 'string', description: "Working directory; defaults to this session's" },
    target: { type: 'string', description: "'any' (any machine may claim it) or a machine name" },
    priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 is highest; default 3' },
    tags: { type: 'array', items: { type: 'string' } },
    worktree: { type: 'boolean', description: 'Acceptance gate: work on an own Git branch/worktree, then test and review before merging' },
    testCommand: { type: 'string', description: 'Acceptance test command, run in the worktree; exit code 0 passes' },
    reviewTo: {
      type: 'string',
      enum: ['user', 'claude', 'agent', 'none'],
      description:
        'Who decides the merge after tests pass: user (approve in the panel), claude (this Claude session is notified), agent (a reviewer agent), none (keep the branch only)',
    },
    maxTurns: { type: 'integer', description: 'Maximum turns (optional)' },
    tasks: {
      type: 'array',
      description: 'Create several tasks at once: each item has the fields above (title and prompt required). When given, top-level fields are ignored.',
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
      fetch: (url, init) => $.http.fetch(url, init),
      openPane: () => void $.ui.open({ id: PANE, title: L('派单器', 'Dispatcher') }),
    }
    try {
      disp = await startDispatcher(io, e.cwd)
      let remembered = false
      disp.onSnapshot = async s => {
        await update($, snapshotAtom, () => s)
        if (s.isActive && !remembered) {
          remembered = true
          await update($, activeAtom, () => true)
        }
      }
      // 扩展重新加载：本会话之前已在调度，就直接接着调度
      if (await read($, activeAtom)) void disp.activate()
      disp.onDetailTick = async () => {
        const v = await read($, viewAtom)
        if (!v.selected || !disp) return
        const det = await disp.detail(v.selected)
        await update($, detailAtom, () => det ?? null)
      }
      markReady()
    } catch (err) {
      markReady()
      void $.ui.toast(`${L('派单器启动失败：', 'Dispatcher failed to start: ')}${err instanceof Error ? err.message : String(err)}`)
      return started
    }

    await $.tool.register({
      name: 'dispatch_create',
      description:
        'Dispatcher: create one or more tasks for background agents (DeepSeek Flash by default). Returns task ids; status and progress show in the side panel. Best for well-specified work that can be done independently.',
      inputSchema: createSchema,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_overview',
      description: 'Dispatcher overview: counts by status, running agents, tasks needing attention, cost today. Start here, then query as needed.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_list',
      description:
        'Dispatcher: paged task query (hot index plus monthly archives), never everything at once. status: active/queued/running/testing/review/done/failed/stopped/rejected/interrupted; text searches title, summary and id; cursor is the next value from the previous page.',
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
        "Dispatcher: read one task. part=summary (default: status, summary, recent progress), result (the agent's final answer), full (whole result), events (all progress), log (raw output tail), prompt (the task).",
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
        'Dispatcher: act on a task. stop a running task; cancel a queued one; retry as a new task; approve a task in review (merges its branch); reject it. Requests for tasks on another machine are forwarded.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['stop', 'cancel', 'retry', 'approve', 'reject'] },
          note: { type: 'string', description: 'Reason for approving or rejecting' },
        },
        required: ['id', 'action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch_settings',
      description:
        'Dispatcher settings: action=get to read, action=set to change, action=test to check the DeepSeek key (shows the balance). The key itself is entered by the user in the panel, never through this tool. Fields: language (auto/zh/en), mode (shared/local), sharedDir, localDir, maxConcurrent, offPeakOnly, defaultWorktree, defaultReviewTo (user/claude/agent/none), deepseekEnvFile, claudePath, machineName, hotDays, worktreeDir.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'test'] },
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
          worktreeDir: { type: 'string', description: 'Folder for gate worktrees; must not be inside ~/.claude' },
          language: { type: 'string', enum: ['auto', 'zh', 'en'] },
          showBand: { type: 'boolean' },
          autoOpen: { type: 'boolean' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'dispatch', description: 'Open the dispatcher panel / 打开派单器面板' })

    timer?.cancel()
    timer = $.clock.every(3000, () => {
      void disp?.tick()
    })
    void disp.tick()
    // 会话启动时界面还没接上；等第一次画出提示栏再决定是否打开侧栏、开始调度
    return started
  })

  on('session.end', async ($, e, next) => {
    // 记下“正常关闭”：下次打开时，这次停掉的工单按用户的选择标为中断，不自动重跑
    await $.store.set('cleanCloseAt', Date.now())
    timer?.cancel()
    await disp?.close()
    return next(e)
  })

  // 界面第一次画出提示栏：说明这是有人在看的会话，开始调度；桌面端顺手打开右侧面板
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disp && !disp.active) {
      void disp.activate()
      if (e.surface === 'desktop' || e.viewport?.isFullscreen) void $.ui.open({ id: PANE, title: L('派单器', 'Dispatcher') })
    }
    const s = await read($, snapshotAtom)
    const settings = disp?.settings ?? FALLBACK_SETTINGS
    if (!s || !settings.showBand || (e.props as any)?.hasSurvey) return next(e)
    // 输入框上方的一行：随时看到进度，点“打开”回到面板
    return renderBand($.ui.resolve(e), s, () => void $.ui.open({ id: PANE, title: L('派单器', 'Dispatcher'), focus: true }))
  })

  // 右键菜单里也能打开
  on('ui.render', { component: 'ContextMenu' }, ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Button key="open-dispatch" onPress={() => void $.ui.open({ id: PANE, title: L('派单器', 'Dispatcher'), focus: true })}>
          {L('打开派单器', 'Open dispatcher')} <Text dimColor>{L('右侧面板', 'side panel')}</Text>
        </Button>
      </Box>
    )
  })

  on('command.run', { command: 'dispatch' }, async $ => {
    void disp?.activate()
    await $.ui.open({ id: PANE, title: L('派单器', 'Dispatcher') })
    return { text: L('派单器面板已打开。', 'Dispatcher panel opened.') }
  })

  // ---------- Claude 可调用的工具 ----------

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_create' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail(L('派单器没有启动', 'The dispatcher is not running'))
    // Claude 在本会话里用派单器，说明这是有人在用的会话：开始调度
    void disp.activate()
    const input = e as unknown as CreateInput & { tasks?: CreateInput[] }
    if (disp.settings.autoOpen) void $.ui.open({ id: PANE, title: L('派单器', 'Dispatcher') })
    const list = Array.isArray(input.tasks) && input.tasks.length ? input.tasks : [input]
    const lines: string[] = []
    for (const one of list) {
      try {
        const spec = await disp.create(one)
        lines.push(
          `${spec.id} · ${spec.title} · ${spec.provider} · ${spec.mode === 'edit' ? L('可改文件', 'can edit') : L('只读', 'read only')}${spec.gate.worktree ? L(` · 闸门开（验收交给 ${spec.reviewTo}）`, ` · gate on (review by ${spec.reviewTo})`) : ''}`,
        )
      } catch (err) {
        lines.push(L(`未创建「${one.title ?? '?'}」：`, `Not created "${one.title ?? '?'}": `) + (err instanceof Error ? err.message : String(err)))
      }
    }
    const s = disp.snapshot()
    return ok(
      L(`已派单 ${lines.filter(l => l.startsWith('T')).length} 张：`, `Created ${lines.filter(l => l.startsWith('T')).length} task(s):`) +
        `\n${lines.join('\n')}\n\n` +
        L(
          `当前运行 ${s.running}/${s.maxConcurrent}${s.offPeakOnly && s.isPeak ? '；现在是 DeepSeek 高峰时段，排队到低谷再开' : ''}。进度看右侧面板，或用 dispatch_get。`,
          `Running ${s.running}/${s.maxConcurrent}${s.offPeakOnly && s.isPeak ? '; DeepSeek peak hours now, queued until off-peak' : ''}. Watch the side panel or use dispatch_get.`,
        ),
    )
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_overview' }, async ($) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail(L('派单器没有启动', 'The dispatcher is not running'))
    // Claude 在本会话里用派单器，说明这是有人在用的会话：开始调度
    void disp.activate()
    await disp.tick()
    return ok(disp.overviewText())
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_list' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail(L('派单器没有启动', 'The dispatcher is not running'))
    // Claude 在本会话里用派单器，说明这是有人在用的会话：开始调度
    void disp.activate()
    const f = e as any
    const { rows, next } = await disp.query({
      status: f.status,
      text: f.text,
      tag: f.tag,
      machine: f.machine,
      limit: f.limit,
      cursor: f.cursor,
    })
    if (!rows.length) return ok(L('没有符合条件的工单。', 'No matching tasks.'))
    return ok(`${rows.map(rowLine).join('\n')}${next !== undefined ? `\n\n${L('还有更多：', 'More: ')}cursor=${next}` : `\n\n${L('（已到末尾）', '(end)')}`}`)
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_get' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail(L('派单器没有启动', 'The dispatcher is not running'))
    // Claude 在本会话里用派单器，说明这是有人在用的会话：开始调度
    void disp.activate()
    const f = e as any
    const d = await disp.detail(String(f.id ?? ''))
    if (!d) return fail(L(`找不到工单 ${f.id}`, `Task ${f.id} not found`))
    return ok(detailText(d, f.part ?? 'summary'))
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_control' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail(L('派单器没有启动', 'The dispatcher is not running'))
    // Claude 在本会话里用派单器，说明这是有人在用的会话：开始调度
    void disp.activate()
    const f = e as any
    const id = String(f.id ?? '')
    try {
      if (f.action === 'retry') {
        const spec = await disp.retry(id)
        return ok(L(`已重新派单：${spec.id}`, `Created again as ${spec.id}`))
      }
      return ok(await disp.control(id, f.action, 'Claude', f.note))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  on('tool.run', { tool: 'mcp__agent-dispatch__dispatch_settings' }, async ($, e) => {
    if (!disp) await Promise.race([ready, $.clock.sleep(15000)])
    if (!disp) return fail(L('派单器没有启动', 'The dispatcher is not running'))
    // Claude 在本会话里用派单器，说明这是有人在用的会话：开始调度
    void disp.activate()
    const f = e as any
    if (f.action === 'test') return ok(await disp.testDeepseek())
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
        'language',
        'showBand',
        'autoOpen',
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
        .join('\n') +
        `\n${L('任务板目录：', 'Board folder: ')}${disp.boardDir}` +
        `\nDeepSeek key: ${disp.keyHint ?? L('未配置', 'not set')}`,
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
      void fn().then(say, err => say(`${L('出错：', 'Error: ')}${err instanceof Error ? err.message : String(err)}`))
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
      stop: id => act(async () => (disp ? disp.control(id, 'stop', L('用户', 'you')) : L('派单器没有启动', 'The dispatcher is not running')))(),
      cancel: id => act(async () => (disp ? disp.control(id, 'cancel', L('用户', 'you')) : L('派单器没有启动', 'The dispatcher is not running')))(),
      approve: id => act(async () => (disp ? disp.control(id, 'approve', L('用户', 'you')) : L('派单器没有启动', 'The dispatcher is not running')))(),
      reject: id => act(async () => (disp ? disp.control(id, 'reject', L('用户', 'you')) : L('派单器没有启动', 'The dispatcher is not running')))(),
      retry: id =>
        act(async () => {
          if (!disp) return L('派单器没有启动', 'The dispatcher is not running')
          const spec = await disp.retry(id)
          return L(`已重新派单：${spec.id}`, `Created again as ${spec.id}`)
        })(),
      refresh: () => void disp?.tick(),
      saveKey: value =>
        act(async () => (disp ? disp.saveDeepseekKey(value) : L('派单器没有启动', 'The dispatcher is not running')))(),
      testKey: () => act(async () => (disp ? disp.testDeepseek() : L('派单器没有启动', 'The dispatcher is not running')))(),
      openSettings: () => void update($, viewAtom, (cur): View => ({ ...cur, screen: 'settings', selected: undefined })),
      closeSettings: () => void update($, viewAtom, (cur): View => ({ ...cur, screen: 'list' })),
      setSetting: (key, value) =>
        act(async () => (await applySettings({ [key]: value } as Partial<Settings>)) ?? L('已保存', 'Saved'))(),
    }
    return renderPane(el, (e as any).props, s, v, d, actions, disp?.settings ?? FALLBACK_SETTINGS)
  })
}

/** 改设置；换任务板需要先停下正在跑的智能体 */
async function applySettings(patch: Partial<Settings>): Promise<string | undefined> {
  if (!disp || !io) return L('派单器没有启动', 'The dispatcher is not running')
  const next = { ...disp.settings, ...patch }
  if (next.mode === 'shared' && !next.sharedDir.trim())
    return L('请先在设置里填写共享任务板目录（例如 NAS 上的文件夹）', 'Set the shared board folder first (for example a folder on your NAS)')
  if (!Number.isFinite(next.maxConcurrent) || next.maxConcurrent < 1) return L('同时运行上限至少为 1', 'Max agents must be at least 1')
  if (/(^|[\\/])\.claude([\\/]|$)/.test(next.worktreeDir))
    return L('worktree 目录不能放在 .claude 文件夹里：Claude Code 会拦下智能体对那里的修改', 'The worktree folder cannot be inside a .claude folder: Claude Code blocks edits there')
  const boardChanged =
    next.mode !== disp.settings.mode ||
    next.sharedDir !== disp.settings.sharedDir ||
    next.localDir !== disp.settings.localDir ||
    next.machineName !== disp.settings.machineName
  if (boardChanged && disp.runs.size > 0)
    return L(`还有 ${disp.runs.size} 个智能体在运行，等它们结束或先停止，再切换任务板`, `${disp.runs.size} agent(s) still running; wait or stop them before switching boards`)
  if (boardChanged) {
    const fresh = new Dispatcher(io, disp.host, next, disp.sessionCwd)
    fresh.onSnapshot = disp.onSnapshot
    fresh.onDetailTick = disp.onDetailTick
    try {
      await fresh.open()
    } catch (err) {
      return L(`打不开任务板 ${fresh.boardDir}：`, `Cannot open board ${fresh.boardDir}: `) + (err instanceof Error ? err.message : String(err))
    }
    const wasActive = disp.active
    await disp.close()
    disp = fresh
    if (wasActive) await fresh.activate()
  } else {
    disp.settings = next
  }
  await io.storeSet('settings', next)
  if (patch.language !== undefined) setLang(await resolveLang(io, disp.host, next.language))
  void disp.tick()
  return undefined
}

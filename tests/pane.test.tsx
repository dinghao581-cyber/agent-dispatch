import { expect, test } from 'claude-code/testing'
import { markRetried } from '../hooks/board'

const PANE = {
  plugin: 'agent-dispatch',
  component: 'Pane',
  requestId: 'dispatch',
  props: {
    title: '派单器',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const now = Date.now()
const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `测试工单 ${id}`,
  status,
  provider: 'deepseek-flash',
  machine: 'mac',
  target: 'any',
  priority: 3,
  tags: [],
  createdAt: now - 60000,
  startedAt: now - 30000,
  updatedAt: now,
  turns: 7,
  lastAction: 'Read hooks/runner.ts',
  costUSD: 0.012,
  reviewTo: 'user',
  ...extra,
})

const SNAPSHOT = {
  machine: 'mac',
  mode: 'shared',
  boardDir: '/Volumes/NAS/AgentDispatch',
  isOwner: true,
  running: 1,
  maxConcurrent: 4,
  offPeakOnly: true,
  isPeak: false,
  costToday: 0.42,
  counts: { running: 1, review: 1, done: 1 },
  rows: [
    row('T1', 'running'),
    row('T2', 'review', { summary: '改好了，等待合并' }),
    row('T3', 'done', { endedAt: now, summary: '完成' }),
  ],
  isActive: true,
  warning: '没找到 DeepSeek Key',
  refreshedAt: now,
}

function seed(on: any, view: unknown, detail: unknown = null, lang = 'zh-Hans') {
  on('state.get', (_: unknown, e: any) => {
    const by: Record<string, unknown> = {
      snapshot: { shape: 'snap-1', value: { ...SNAPSHOT, lang } },
      view: { shape: 'view-1', value: view },
      detail: { shape: 'detail-1', value: detail },
    }
    return { value: { value: by[e.key], version: 1 } }
  })
}

test('列表在桌面和终端都画得出来', async ($, on) => {
  seed(on, { tab: 'active', page: 0 })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /派单器/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /测试工单 T1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /低谷/ })).toBeDefined()
    await ui.unmount()
  }
})

test('待审栏和详情页画得出来', async ($, on) => {
  seed(on, { tab: 'review', page: 0, selected: 'T2' }, {
    id: 'T2',
    row: row('T2', 'review', { summary: '改好了，等待合并' }),
    prompt: '把 README 的错别字改掉',
    cwd: '/tmp/repo',
    mode: 'edit',
    gate: { worktree: true, testCommand: 'npm test' },
    events: [{ t: now, text: '测试通过' }],
    usage: { input: 1000, cacheRead: 20000, output: 500 },
    result: '已修改 README.md\n\n【摘要】改好了',
    logTail: '🔧 Edit README.md',
    branch: 'dispatch/T2',
    loadedAt: now,
  })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /验收闸门/ })).toBeDefined()
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    await ui.unmount()
  }
})

test('最小化成小组件时只显示一眼信息', async ($, on) => {
  seed(on, { tab: 'active', page: 0 })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /今日/ })).toBeDefined()
  await ui.unmount()
})

test('设置页“常用”一页：语言、Key、并发、开关，说明默认收起', async ($, on) => {
  seed(on, { tab: 'active', page: 0, screen: 'settings' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /同时运行上限/ })).toBeDefined()
    expect(await ui.find({ key: 'sel-language' })).toBeDefined()
    expect(await ui.find({ key: 'tg-offPeakOnly' })).toBeDefined()
    expect(await ui.find({ key: 'info-offPeakOnly' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /低谷价是高峰的一半/ })).toBeUndefined()
    expect(await ui.find({ key: 'sel-mode' })).toBeUndefined()
    await ui.unmount()
  }
})

test('点开 ⓘ 才显示说明', async ($, on) => {
  seed(on, { tab: 'active', page: 0, screen: 'settings', info: 'offPeakOnly' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /低谷价是高峰的一半/ })).toBeDefined()
  await ui.unmount()
})

test('设置页“任务板”一页：位置、目录、机器名', async ($, on) => {
  seed(on, { tab: 'active', page: 0, screen: 'settings', settingsTab: 'board' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'sel-mode' })).toBeDefined()
    expect(await ui.find({ key: 'in-localDir' })).toBeDefined()
    expect(await ui.find({ key: 'in-machineName' })).toBeDefined()
    await ui.unmount()
  }
})

test('设置页“高级”一页：状态栏、归档、路径', async ($, on) => {
  seed(on, { tab: 'active', page: 0, screen: 'settings', settingsTab: 'advanced' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'tg-showBand' })).toBeDefined()
  expect(await ui.find({ key: 'sel-hotDays' })).toBeDefined()
  expect(await ui.find({ key: 'in-claudePath' })).toBeDefined()
  await ui.unmount()
})

test('没有译文表的语言显示英文，不会显示中文', async ($, on) => {
  seed(on, { tab: 'active', page: 0 }, null, 'ja-JP')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Dispatcher/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /低谷/ })).toBeUndefined()
  await ui.unmount()
})

test('旧设置值 en 仍当英文用', async ($, on) => {
  seed(on, { tab: 'active', page: 0 }, null, 'en')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Dispatcher/ })).toBeDefined()
  await ui.unmount()
})

test('切到英文后面板和设置页都是英文', async ($, on) => {
  seed(on, { tab: 'active', page: 0 }, null, 'en-US')
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Dispatcher/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Off-peak/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /低谷/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('英文设置页有语言选项', async ($, on) => {
  seed(on, { tab: 'active', page: 0, screen: 'settings' }, null, 'en-US')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'sel-language' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Max agents at once/ })).toBeDefined()
  await ui.unmount()
})

test('设置页可以直接粘贴 DeepSeek Key', async ($, on) => {
  seed(on, { tab: 'active', page: 0, screen: 'settings' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'in-dskey' })).toBeDefined()
    expect(await ui.find({ key: 'testkey' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /还没填/ })).toBeDefined()
    await ui.unmount()
  }
})

test('输入框上方的状态栏能画出来并带打开按钮', async ($, on) => {
  seed(on, { tab: 'active', page: 0 })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-dispatch', component: 'AbovePrompt', requestId: 'band', props: {}, surface } as any)
    expect(await ui.find({ key: 'open-panel' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /待审 1/ })).toBeDefined()
    await ui.unmount()
  }
})

test('重派成功的旧工单不算异常，归到完成栏', async ($, on) => {
  const marked = markRetried([
    row('T4', 'failed') as any,
    row('T5', 'failed', { retryOf: 'T4' }) as any,
    row('T6', 'done', { retryOf: 'T5' }) as any,
    row('T7', 'failed') as any,
    row('T8', 'failed', { retryOf: 'T7' }) as any,
  ])
  expect(marked.find(r => r.id === 'T4')?.retriedBy).toBe('T6')
  expect(marked.find(r => r.id === 'T5')?.retriedBy).toBe('T6')
  expect(marked.find(r => r.id === 'T7')?.retriedBy).toBeUndefined()
  expect(marked.find(r => r.id === 'T8')?.retriedBy).toBeUndefined()
})

const RETRY_ROWS = [row('T4', 'failed', { retriedBy: 'T6' }), row('T6', 'done', { retryOf: 'T4', endedAt: now }), row('T7', 'failed')]

function seedRetry(on: any, tab: string) {
  on('state.get', (_: unknown, e: any) => {
    const by: Record<string, unknown> = {
      snapshot: { shape: 'snap-1', value: { ...SNAPSHOT, lang: 'zh-Hans', rows: RETRY_ROWS, counts: { retried: 1, done: 1, failed: 1 } } },
      view: { shape: 'view-1', value: { tab, page: 0 } },
      detail: { shape: 'detail-1', value: null },
    }
    return { value: { value: by[e.key], version: 1 } }
  })
}

test('异常栏不显示重派成功的旧工单', async ($, on) => {
  seedRetry(on, 'failed')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /测试工单 T7/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /测试工单 T4/ })).toBeUndefined()
  await ui.unmount()
})

test('完成栏显示“已重派成功”', async ($, on) => {
  seedRetry(on, 'done')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /测试工单 T4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已重派成功 → T6/ })).toBeDefined()
  await ui.unmount()
})

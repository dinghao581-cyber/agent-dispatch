// 右侧面板：总览 → 分栏列表 → 点开看单张工单的全部细节。
import { clip, fmtDuration, fmtTime, fmtTokens, fmtUSD } from './util'
import { PROVIDERS, providerOf } from './providers'
import { statusLabel } from './runner'
import type { Detail, Row, Settings, Snapshot, Tab, View } from '../types'

export type Actions = {
  setTab: (tab: Tab) => void
  setPage: (page: number) => void
  open: (id: string) => void
  back: () => void
  stop: (id: string) => void
  cancel: (id: string) => void
  retry: (id: string) => void
  approve: (id: string) => void
  reject: (id: string) => void
  refresh: () => void
  openSettings: () => void
  closeSettings: () => void
  setSetting: (key: keyof Settings, value: string | number | boolean) => void
}

const PAGE = 12

const TABS: { tab: Tab; label: string; statuses: string[] }[] = [
  { tab: 'active', label: '进行中', statuses: ['running', 'testing'] },
  { tab: 'queued', label: '排队', statuses: ['queued'] },
  { tab: 'review', label: '待审', statuses: ['review'] },
  { tab: 'done', label: '完成', statuses: ['done'] },
  { tab: 'failed', label: '异常', statuses: ['failed', 'stopped', 'rejected', 'interrupted'] },
]

const GLYPH: Record<string, { g: string; color?: string }> = {
  queued: { g: '○', color: 'inactive' },
  running: { g: '●', color: 'claude' },
  testing: { g: '◑', color: 'warning' },
  review: { g: '◆', color: 'warning' },
  done: { g: '✓', color: 'success' },
  failed: { g: '✕', color: 'error' },
  stopped: { g: '■', color: 'inactive' },
  rejected: { g: '✕', color: 'inactive' },
  interrupted: { g: '!', color: 'warning' },
}

function count(s: Snapshot, statuses: string[]): number {
  return statuses.reduce((n, k) => n + (s.counts[k] ?? 0), 0)
}

function elapsed(r: Row): string {
  if (!r.startedAt) return `建于 ${fmtTime(r.createdAt)}`
  return r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : fmtDuration(Date.now() - r.startedAt)
}

export function renderPane(
  el: any,
  props: any,
  s: Snapshot | null,
  v: View,
  d: Detail | null,
  a: Actions,
  settings?: Settings,
) {
  const { Box, Text, Button, Progress, Markdown, Code } = el
  const width: number = props?.bodyColumns ?? 60

  if (!s) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text weight="semibold">派单器</Text>
        <Text dimColor>正在连接任务板…</Text>
      </Box>
    )
  }

  const active = count(s, ['running', 'testing'])
  const queued = count(s, ['queued'])
  const review = count(s, ['review'])

  // 最小化成小组件时：一眼看完
  if (props?.placement === 'widget') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text weight="semibold">派单器</Text>
        <Text>
          <Text color="claude">● {active}</Text> 运行 · {queued} 排队 · <Text color={review ? 'warning' : undefined}>{review} 待审</Text>
        </Text>
        <Text dimColor>今日 {fmtUSD(s.costToday)}</Text>
      </Box>
    )
  }

  const header = (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" size="heading">
          派单器
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {s.machine} · {s.mode === 'shared' ? '共享任务板' : '本机任务板'}
          </Text>
          <Button key="settings" label="⚙ 设置" plain onPress={a.openSettings} />
        </Box>
      </Box>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Text>
          <Text color="claude">● </Text>运行 {active}/{s.maxConcurrent}
        </Text>
        <Text>排队 {queued}</Text>
        <Text color={review ? 'warning' : undefined}>待审 {review}</Text>
        <Text>今日 {fmtUSD(s.costToday)}</Text>
        {s.isPeak ? (
          <Text color="warning">高峰{s.offPeakOnly ? ' · 暂停开新单' : ''}</Text>
        ) : (
          <Text color="success">低谷 · 半价</Text>
        )}
      </Box>
      {s.isActive && !s.isOwner && <Text dimColor>本会话只旁观：本机另一个 Claude 会话正在调度</Text>}
      {s.warning && <Text color="warning">⚠ {s.warning}（点“⚙ 设置”修改）</Text>}
      {s.error && <Text color="error">刷新出错：{clip(s.error, 120)}</Text>}
    </Box>
  )

  if (v.screen === 'settings' && settings) return renderSettings(el, width, s, settings, a)
  if (v.selected) return renderDetail(el, width, s, d, v.selected, a)

  const tabDef = TABS.find(t => t.tab === v.tab) ?? TABS[0]!
  const rows = s.rows.filter(r => tabDef.statuses.includes(r.status))
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const page = Math.min(v.page, pages - 1)
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginBottom={1}>
        {TABS.map(t => (
          <Button
            key={`tab-${t.tab}`}
            variant={t.tab === v.tab ? 'primary' : 'secondary'}
            onPress={() => a.setTab(t.tab)}
          >
            {t.label} <Text dimColor>{count(s, t.statuses)}</Text>
          </Button>
        ))}
      </Box>

      {shown.length === 0 && (
        <Box paddingY={1}>
          <Text dimColor>{emptyText(v.tab)}</Text>
        </Box>
      )}

      {shown.map(r => {
        const g = GLYPH[r.status] ?? { g: '·' }
        const meta = [
          providerOf(r.provider)?.short ?? r.provider,
          r.machine ? `@${r.machine}` : r.target !== 'any' ? `→${r.target}` : '',
          r.turns ? `${r.turns}轮` : '',
          elapsed(r),
          r.costUSD ? fmtUSD(r.costUSD) : '',
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <Box key={`row-${r.id}`} flexDirection="column" marginBottom={1}>
            <Button key={`open-${r.id}`} plain onPress={() => a.open(r.id)}>
              <Text color={g.color}>{g.g} </Text>
              <Text weight="medium">{clip(r.title, Math.max(16, width - 6))}</Text>
            </Button>
            <Text dimColor wrap="truncate-end">
              {'   '}
              {meta}
            </Text>
            {r.status === 'running' && (
              <Box paddingLeft={3}>
                <Progress label={r.lastAction ? clip(r.lastAction, Math.max(16, width - 12)) : '思考中…'} color="claude" />
              </Box>
            )}
            {r.status !== 'running' && r.summary && (
              <Text dimColor wrap="truncate-end">
                {'   '}
                {clip(r.summary, Math.max(20, width - 4))}
              </Text>
            )}
          </Box>
        )
      })}

      {pages > 1 && (
        <Box flexDirection="row" gap={1} alignItems="center" marginBottom={1}>
          <Button key="prev" label="‹ 上一页" plain dimColor={page === 0} onPress={() => a.setPage(Math.max(0, page - 1))} />
          <Text dimColor>
            第 {page + 1}/{pages} 页
          </Text>
          <Button key="next" label="下一页 ›" plain dimColor={page >= pages - 1} onPress={() => a.setPage(Math.min(pages - 1, page + 1))} />
        </Box>
      )}

      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="refresh" label="↻ 刷新" plain onPress={a.refresh} />
        <Text dimColor wrap="truncate-middle">
          {s.boardDir}
        </Text>
      </Box>
    </Box>
  )
}

function emptyText(tab: Tab): string {
  return (
    {
      active: '没有正在运行的智能体。让 Claude 用 dispatch_create 派一张单试试。',
      queued: '排队为空。',
      review: '没有等待验收的工单。',
      done: '近几天没有完成的工单；更早的已归档，可让 Claude 用 dispatch_list 查询。',
      failed: '没有异常工单。',
    } as Record<Tab, string>
  )[tab]
}

function renderDetail(el: any, width: number, s: Snapshot, d: Detail | null, id: string, a: Actions) {
  const { Box, Text, Button, Progress, Markdown, Code } = el
  const row = d?.row ?? s.rows.find(r => r.id === id)
  if (!row) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Button key="back" label="‹ 返回列表" plain onPress={a.back} />
        <Text dimColor>正在读取 {id}…</Text>
      </Box>
    )
  }
  const g = GLYPH[row.status] ?? { g: '·' }
  const prov = providerOf(row.provider)
  const section = (title: string, body: any, key: string) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
      <Text weight="semibold">{title}</Text>
      {body}
    </Box>
  )
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Button key="back" label="‹ 返回列表" plain onPress={a.back} />
        <Text dimColor>{row.id}</Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={g.color ?? 'subtle'} paddingX={1} marginBottom={1}>
        <Text weight="bold" size="heading">
          <Text color={g.color}>{g.g} </Text>
          {row.title}
        </Text>
        <Text>
          <Text color={g.color}>{statusLabel(row.status)}</Text>
          <Text dimColor>
            {' '}
            · {prov?.label ?? row.provider} · {d?.mode === 'edit' ? '可改文件' : '只读'} · {row.machine ? `@${row.machine}` : '待认领'}
          </Text>
        </Text>
        <Text dimColor>
          {row.startedAt ? `开始 ${fmtTime(row.startedAt)} · 用时 ${elapsed(row)}` : `创建 ${fmtTime(row.createdAt)}`} · {row.turns} 轮 · {fmtUSD(row.costUSD)}
        </Text>
        {d && (
          <Text dimColor>
            Token 输入 {fmtTokens(d.usage.input)} · 缓存 {fmtTokens(d.usage.cacheRead)} · 输出 {fmtTokens(d.usage.output)}
          </Text>
        )}
        {row.status === 'running' && (
          <Box marginTop={1}>
            <Progress label={row.lastAction ? clip(row.lastAction, Math.max(16, width - 12)) : '思考中…'} color="claude" />
          </Box>
        )}
        {d?.error && <Text color="error">{clip(d.error, 300)}</Text>}
      </Box>

      <Box flexDirection="row" gap={1} flexWrap="wrap" marginBottom={1}>
        {row.status === 'running' && <Button key="stop" label="停止" onPress={() => a.stop(row.id)} />}
        {row.status === 'queued' && <Button key="cancel" label="取消排队" onPress={() => a.cancel(row.id)} />}
        {row.status === 'review' && <Button key="approve" label="批准并合并" variant="primary" onPress={() => a.approve(row.id)} />}
        {row.status === 'review' && <Button key="reject" label="驳回" onPress={() => a.reject(row.id)} />}
        {['failed', 'stopped', 'interrupted', 'rejected', 'done'].includes(row.status) && (
          <Button key="retry" label="重新派单" onPress={() => a.retry(row.id)} />
        )}
      </Box>

      {row.summary && section('摘要', <Text>{row.summary}</Text>, 'sum')}

      {d?.gate.worktree &&
        section(
          '验收闸门',
          <Box flexDirection="column">
            <Text dimColor>分支 {d.branch ?? '（待建）'} · 验收交给 {reviewToLabel(row.reviewTo)}</Text>
            {d.gate.testCommand && <Text dimColor>测试 {d.gate.testCommand}</Text>}
            {d.review && (
              <Text color={d.review.verdict === 'approved' ? 'success' : 'error'}>
                {d.review.verdict === 'approved' ? '已批准' : '已驳回'}（{d.review.by}）{d.review.note ? `：${clip(d.review.note, 200)}` : ''}
              </Text>
            )}
            {d.testTail && <Code source={tailLines(d.testTail, 20)} wrap="wrap" />}
          </Box>,
          'gate',
        )}

      {section(
        '进展',
        d && d.events.length ? (
          <Box flexDirection="column">
            {d.events.slice(-14).map((e, i) => (
              <Text key={`ev-${i}`} wrap="truncate-end">
                <Text dimColor>{fmtTime(e.t).slice(-5)} </Text>
                {e.text}
              </Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>还没有进展。</Text>
        ),
        'events',
      )}

      {d?.result && section('结果', <Markdown text={clip3(d.result, 6000)} />, 'result')}

      {section('任务内容', <Markdown text={clip3(d?.prompt ?? '', 3000)} />, 'prompt')}

      {d?.logTail && section('输出日志（尾部）', <Code source={tailLines(d.logTail, 40)} wrap="wrap" />, 'log')}

      <Text dimColor>目录 {d?.cwd ?? ''}</Text>
    </Box>
  )
}

function reviewToLabel(r: string): string {
  return ({ user: '用户', claude: 'Claude', agent: '审查智能体', none: '不合并' } as Record<string, string>)[r] ?? r
}

function tailLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n')
}

function clip3(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}\n\n…（已截断，完整内容可让 Claude 用 dispatch_get 查看）` : text
}

const onOff = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
]

function renderSettings(el: any, width: number, s: Snapshot, st: Settings, a: Actions) {
  const { Box, Text, Button, Input, Select } = el
  const field = (label: string, hint: string, control: any, key: string) => (
    <Box key={key} flexDirection="column" marginBottom={1}>
      <Text weight="medium">{label}</Text>
      {control}
      {hint ? (
        <Text dimColor wrap="wrap">
          {hint}
        </Text>
      ) : null}
    </Box>
  )
  const text = (key: keyof Settings, placeholder: string) => (
    <Input
      key={`in-${key}`}
      value={String(st[key] ?? '')}
      placeholder={placeholder}
      submitLabel="保存"
      onSubmit={(value: string) => a.setSetting(key, value.trim())}
    />
  )
  const pick = (key: keyof Settings, options: { value: string; label: string }[], current: string, map?: (v: string) => string | number | boolean) => (
    <Select key={`sel-${key}`} options={options} value={current} onSelect={(value: string) => a.setSetting(key, map ? map(value) : value)} />
  )
  const section = (title: string, children: any[], key: string) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
      <Text weight="semibold">{title}</Text>
      {children}
    </Box>
  )
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Button key="back" label="‹ 返回" plain onPress={a.closeSettings} />
        <Text weight="bold" size="heading">
          设置
        </Text>
      </Box>

      {section(
        '任务板',
        [
          field(
            '存放位置',
            '共享：多台电脑（Mac / Windows）共用 NAS 上的同一个任务板；本机：只给这台电脑用。',
            pick('mode', [
              { value: 'local', label: '本机' },
              { value: 'shared', label: '共享（NAS / 网络盘）' },
            ], st.mode),
            'f-mode',
          ),
          field(
            '共享任务板目录',
            'Mac 填挂载后的路径，如 /Volumes/NAS/AgentDispatch；Windows 请把 NAS 映射成盘符，如 Z:/AgentDispatch。',
            text('sharedDir', '/Volumes/NAS/AgentDispatch'),
            'f-shared',
          ),
          field('本机任务板目录', '', text('localDir', '默认放在插件数据目录'), 'f-local'),
          field('这台电脑的名字', '留空用系统主机名；共享任务板上用它区分各台电脑。', text('machineName', s.machine), 'f-machine'),
          field(
            '归档前在热层保留',
            '结束超过这么多天的工单移到按月归档，面板保持轻快；归档的仍可查询。',
            pick('hotDays', [1, 3, 7, 14, 30].map(n => ({ value: String(n), label: `${n} 天` })), String(st.hotDays), v => Number(v)),
            'f-hot',
          ),
        ],
        'sec-board',
      )}

      {section(
        '调度',
        [
          field(
            '同时运行上限',
            '这台电脑最多同时跑几个智能体。',
            pick('maxConcurrent', [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map(n => ({ value: String(n), label: `${n} 个` })), String(st.maxConcurrent), v => Number(v)),
            'f-conc',
          ),
          field(
            '只在 DeepSeek 低谷时段开新单',
            '低谷价是高峰的一半。DeepSeek 按 UTC 定高峰：工作日 UTC 1–4、6–10 点，即北京时间 9:00–12:00、14:00–18:00；中国法定节假日全天为低谷（派单器暂按工作日处理，只会更保守）。',
            pick('offPeakOnly', onOff, st.offPeakOnly ? 'on' : 'off', v => v === 'on'),
            'f-peak',
          ),
        ],
        'sec-sched',
      )}

      {section(
        '验收闸门（新工单默认值）',
        [
          field(
            '默认开启',
            '开启后智能体在独立 Git 分支里干活，完成后先测试、再验收合并；每张工单也能单独指定。',
            pick('defaultWorktree', onOff, st.defaultWorktree ? 'on' : 'off', v => v === 'on'),
            'f-gate',
          ),
          field(
            'worktree 目录',
            '智能体在这里的独立分支副本里干活。不能放在 .claude 文件夹里（Claude Code 会拦下对那里的修改）。',
            text('worktreeDir', '~/.agent-dispatch/worktrees'),
            'f-wt',
          ),
          field(
            '合并请求交给',
            '',
            pick('defaultReviewTo', [
              { value: 'user', label: '我（在面板里批准）' },
              { value: 'claude', label: 'Claude（自动提醒当前会话）' },
              { value: 'agent', label: '审查智能体（自动审查并批准/驳回）' },
              { value: 'none', label: '不合并，只保留分支' },
            ], st.defaultReviewTo),
            'f-review',
          ),
        ],
        'sec-gate',
      )}

      {section(
        '智能体',
        [
          field(
            'DeepSeek Key 文件',
            '一个文本文件，内容写 DEEPSEEK_API_KEY=你的Key（可选 DEEPSEEK_MODEL=deepseek-flash）。派单器只把它交给智能体进程，不显示、不上传。',
            text('deepseekEnvFile', '~/.agent-dispatch/deepseek.env'),
            'f-key',
          ),
          field('claude 命令', '启动无头智能体用的 Claude Code 命令；不在 PATH 里就填完整路径。', text('claudePath', 'claude'), 'f-claude'),
          <Box key="providers" flexDirection="column">
            {PROVIDERS.map(p => (
              <Text key={`p-${p.id}`} wrap="truncate-end">
                <Text color={p.enabled ? 'success' : 'inactive'}>{p.enabled ? '● ' : '○ '}</Text>
                {p.label}
                <Text dimColor>{p.enabled ? ' · 可用' : ` · ${p.note ?? '未开放'}`}</Text>
              </Text>
            ))}
          </Box>,
        ],
        'sec-agents',
      )}
      <Text dimColor>修改即时保存；任务板位置要等运行中的智能体结束后才能切换。</Text>
    </Box>
  )
}

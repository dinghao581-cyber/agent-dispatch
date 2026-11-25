// 右侧面板：总览 → 分栏列表 → 点开看单张工单的全部细节。所有文字走 L(中文, English)。
import { clip, fmtDuration, fmtTime, fmtTokens, fmtUSD } from './util'
import { PROVIDERS, noteOf, providerOf } from './providers'
import { L, setLang } from './i18n'
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

const TABS: { tab: Tab; label: () => string; statuses: string[] }[] = [
  { tab: 'active', label: () => L('进行中', 'Active'), statuses: ['running', 'testing'] },
  { tab: 'queued', label: () => L('排队', 'Queued'), statuses: ['queued'] },
  { tab: 'review', label: () => L('待审', 'Review'), statuses: ['review'] },
  { tab: 'done', label: () => L('完成', 'Done'), statuses: ['done'] },
  { tab: 'failed', label: () => L('异常', 'Issues'), statuses: ['failed', 'stopped', 'rejected', 'interrupted'] },
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
  if (!r.startedAt) return L(`建于 ${fmtTime(r.createdAt)}`, `created ${fmtTime(r.createdAt)}`)
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
  // 语言以调度器写进快照的为准，切换后面板随快照重画
  if (s?.lang) setLang(s.lang)

  if (!s) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text weight="semibold">{L('派单器', 'Dispatcher')}</Text>
        <Text dimColor>{L('正在连接任务板…', 'Connecting to the task board…')}</Text>
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
        <Text weight="semibold">{L('派单器', 'Dispatcher')}</Text>
        <Text>
          <Text color="claude">● {active}</Text> {L('运行', 'running')} · {queued} {L('排队', 'queued')} ·{' '}
          <Text color={review ? 'warning' : undefined}>
            {review} {L('待审', 'to review')}
          </Text>
        </Text>
        <Text dimColor>
          {L('今日', 'Today')} {fmtUSD(s.costToday)}
        </Text>
      </Box>
    )
  }

  const header = (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="bold" size="heading">
          {L('派单器', 'Dispatcher')}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {s.machine} · {s.mode === 'shared' ? L('共享任务板', 'shared board') : L('本机任务板', 'local board')}
          </Text>
          <Button key="settings" label={L('⚙ 设置', '⚙ Settings')} plain onPress={a.openSettings} />
        </Box>
      </Box>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Text>
          <Text color="claude">● </Text>
          {L('运行', 'Running')} {active}/{s.maxConcurrent}
        </Text>
        <Text>
          {L('排队', 'Queued')} {queued}
        </Text>
        <Text color={review ? 'warning' : undefined}>
          {L('待审', 'Review')} {review}
        </Text>
        <Text>
          {L('今日', 'Today')} {fmtUSD(s.costToday)}
        </Text>
        {s.isPeak ? (
          <Text color="warning">{L(`高峰${s.offPeakOnly ? ' · 暂停开新单' : ''}`, `Peak${s.offPeakOnly ? ' · new tasks paused' : ''}`)}</Text>
        ) : (
          <Text color="success">{L('低谷 · 半价', 'Off-peak · half price')}</Text>
        )}
      </Box>
      {s.isActive && !s.isOwner && (
        <Text dimColor>{L('本会话只旁观：本机另一个 Claude 会话正在调度', 'Watching only: another Claude session on this machine is scheduling')}</Text>
      )}
      {s.warning && <Text color="warning">⚠ {s.warning}{L('（点“⚙ 设置”修改）', ' (fix it in ⚙ Settings)')}</Text>}
      {s.error && <Text color="error">{L('刷新出错：', 'Refresh failed: ')}{clip(s.error, 120)}</Text>}
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
            {t.label()} <Text dimColor>{count(s, t.statuses)}</Text>
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
          r.turns ? L(`${r.turns}轮`, `${r.turns} turns`) : '',
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
                <Progress label={r.lastAction ? clip(r.lastAction, Math.max(16, width - 12)) : L('思考中…', 'Thinking…')} color="claude" />
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
          <Button key="prev" label={L('‹ 上一页', '‹ Prev')} plain dimColor={page === 0} onPress={() => a.setPage(Math.max(0, page - 1))} />
          <Text dimColor>{L(`第 ${page + 1}/${pages} 页`, `Page ${page + 1}/${pages}`)}</Text>
          <Button key="next" label={L('下一页 ›', 'Next ›')} plain dimColor={page >= pages - 1} onPress={() => a.setPage(Math.min(pages - 1, page + 1))} />
        </Box>
      )}

      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="refresh" label={L('↻ 刷新', '↻ Refresh')} plain onPress={a.refresh} />
        <Text dimColor wrap="truncate-middle">
          {s.boardDir}
        </Text>
      </Box>
    </Box>
  )
}

function emptyText(tab: Tab): string {
  const zh: Record<Tab, string> = {
    active: '没有正在运行的智能体。让 Claude 用 dispatch_create 派一张单试试。',
    queued: '排队为空。',
    review: '没有等待验收的工单。',
    done: '近几天没有完成的工单；更早的已归档，可让 Claude 用 dispatch_list 查询。',
    failed: '没有异常工单。',
  }
  const en: Record<Tab, string> = {
    active: 'No agents running. Ask Claude to create a task with dispatch_create.',
    queued: 'Nothing queued.',
    review: 'Nothing waiting for review.',
    done: 'Nothing finished in the last few days; older tasks are archived and Claude can find them with dispatch_list.',
    failed: 'No failed or stopped tasks.',
  }
  return L(zh[tab], en[tab])
}

function renderDetail(el: any, width: number, s: Snapshot, d: Detail | null, id: string, a: Actions) {
  const { Box, Text, Button, Progress, Markdown, Code } = el
  const row = d?.row ?? s.rows.find(r => r.id === id)
  if (!row) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Button key="back" label={L('‹ 返回列表', '‹ Back')} plain onPress={a.back} />
        <Text dimColor>{L(`正在读取 ${id}…`, `Loading ${id}…`)}</Text>
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
        <Button key="back" label={L('‹ 返回列表', '‹ Back')} plain onPress={a.back} />
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
            · {prov?.label ?? row.provider} · {d?.mode === 'edit' ? L('可改文件', 'can edit') : L('只读', 'read only')} ·{' '}
            {row.machine ? `@${row.machine}` : L('待认领', 'unclaimed')}
          </Text>
        </Text>
        <Text dimColor>
          {row.startedAt
            ? L(`开始 ${fmtTime(row.startedAt)} · 用时 ${elapsed(row)}`, `started ${fmtTime(row.startedAt)} · took ${elapsed(row)}`)
            : L(`创建 ${fmtTime(row.createdAt)}`, `created ${fmtTime(row.createdAt)}`)}{' '}
          · {row.turns} {L('轮', 'turns')} · {fmtUSD(row.costUSD)}
        </Text>
        {d && (
          <Text dimColor>
            {L(
              `Token 输入 ${fmtTokens(d.usage.input)} · 缓存 ${fmtTokens(d.usage.cacheRead)} · 输出 ${fmtTokens(d.usage.output)}`,
              `Tokens in ${fmtTokens(d.usage.input)} · cached ${fmtTokens(d.usage.cacheRead)} · out ${fmtTokens(d.usage.output)}`,
            )}
          </Text>
        )}
        {row.status === 'running' && (
          <Box marginTop={1}>
            <Progress label={row.lastAction ? clip(row.lastAction, Math.max(16, width - 12)) : L('思考中…', 'Thinking…')} color="claude" />
          </Box>
        )}
        {d?.error && <Text color="error">{clip(d.error, 300)}</Text>}
      </Box>

      <Box flexDirection="row" gap={1} flexWrap="wrap" marginBottom={1}>
        {row.status === 'running' && <Button key="stop" label={L('停止', 'Stop')} onPress={() => a.stop(row.id)} />}
        {row.status === 'queued' && <Button key="cancel" label={L('取消排队', 'Cancel')} onPress={() => a.cancel(row.id)} />}
        {row.status === 'review' && <Button key="approve" label={L('批准并合并', 'Approve & merge')} variant="primary" onPress={() => a.approve(row.id)} />}
        {row.status === 'review' && <Button key="reject" label={L('驳回', 'Reject')} onPress={() => a.reject(row.id)} />}
        {['failed', 'stopped', 'interrupted', 'rejected', 'done'].includes(row.status) && (
          <Button key="retry" label={L('重新派单', 'Run again')} onPress={() => a.retry(row.id)} />
        )}
      </Box>

      {row.summary && section(L('摘要', 'Summary'), <Text>{row.summary}</Text>, 'sum')}

      {d?.gate.worktree &&
        section(
          L('验收闸门', 'Acceptance gate'),
          <Box flexDirection="column">
            <Text dimColor>
              {L(`分支 ${d.branch ?? '（待建）'} · 验收交给 ${reviewToLabel(row.reviewTo)}`, `Branch ${d.branch ?? '(pending)'} · review by ${reviewToLabel(row.reviewTo)}`)}
            </Text>
            {d.gate.testCommand && (
              <Text dimColor>
                {L('测试', 'Test')} {d.gate.testCommand}
              </Text>
            )}
            {d.review && (
              <Text color={d.review.verdict === 'approved' ? 'success' : 'error'}>
                {d.review.verdict === 'approved' ? L('已批准', 'Approved') : L('已驳回', 'Rejected')} ({d.review.by})
                {d.review.note ? `: ${clip(d.review.note, 200)}` : ''}
              </Text>
            )}
            {d.testTail && <Code source={tailLines(d.testTail, 20)} wrap="wrap" />}
          </Box>,
          'gate',
        )}

      {section(
        L('进展', 'Progress'),
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
          <Text dimColor>{L('还没有进展。', 'No progress yet.')}</Text>
        ),
        'events',
      )}

      {d?.result && section(L('结果', 'Result'), <Markdown text={clip3(d.result, 6000)} />, 'result')}

      {section(L('任务内容', 'Task'), <Markdown text={clip3(d?.prompt ?? '', 3000)} />, 'prompt')}

      {d?.logTail && section(L('输出日志（尾部）', 'Output log (tail)'), <Code source={tailLines(d.logTail, 40)} wrap="wrap" />, 'log')}

      <Text dimColor>
        {L('目录', 'Dir')} {d?.cwd ?? ''}
      </Text>
    </Box>
  )
}

function reviewToLabel(r: string): string {
  const zh: Record<string, string> = { user: '用户', claude: 'Claude', agent: '审查智能体', none: '不合并' }
  const en: Record<string, string> = { user: 'you', claude: 'Claude', agent: 'reviewer agent', none: 'no merge' }
  return L(zh[r] ?? r, en[r] ?? r)
}

function tailLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n')
}

function clip3(text: string, n: number): string {
  return text.length > n
    ? `${text.slice(0, n)}\n\n${L('…（已截断，完整内容可让 Claude 用 dispatch_get 查看）', '… (cut; ask Claude to read it in full with dispatch_get)')}`
    : text
}

const onOff = () => [
  { value: 'on', label: L('开', 'On') },
  { value: 'off', label: L('关', 'Off') },
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
      submitLabel={L('保存', 'Save')}
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
        <Button key="back" label={L('‹ 返回', '‹ Back')} plain onPress={a.closeSettings} />
        <Text weight="bold" size="heading">
          {L('设置', 'Settings')}
        </Text>
      </Box>

      {section(
        L('语言', 'Language'),
        [
          field(
            '语言 / Language',
            '',
            pick(
              'language',
              [
                { value: 'auto', label: L('自动（跟随系统）', 'Auto (follow system)') },
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ],
              st.language ?? 'auto',
            ),
            'f-lang',
          ),
        ],
        'sec-lang',
      )}

      {section(
        L('任务板', 'Task board'),
        [
          field(
            L('存放位置', 'Where'),
            L('共享：多台电脑（Mac / Windows）共用 NAS 上的同一个任务板；本机：只给这台电脑用。', 'Shared: several computers (Mac / Windows) use one board on a NAS. Local: this computer only.'),
            pick('mode', [
              { value: 'local', label: L('本机', 'This computer') },
              { value: 'shared', label: L('共享（NAS / 网络盘）', 'Shared (NAS / network drive)') },
            ], st.mode),
            'f-mode',
          ),
          field(
            L('共享任务板目录', 'Shared board folder'),
            L('Mac 填挂载后的路径，如 /Volumes/NAS/AgentDispatch；Windows 请把 NAS 映射成盘符，如 Z:/AgentDispatch。', 'On a Mac, the mounted path, e.g. /Volumes/NAS/AgentDispatch. On Windows, map the NAS to a drive letter, e.g. Z:/AgentDispatch.'),
            text('sharedDir', '/Volumes/NAS/AgentDispatch'),
            'f-shared',
          ),
          field(L('本机任务板目录', 'Local board folder'), '', text('localDir', L('默认放在插件数据目录', "Defaults to the plugin's data folder")), 'f-local'),
          field(
            L('这台电脑的名字', 'Name of this computer'),
            L('留空用系统主机名；共享任务板上用它区分各台电脑。', 'Leave empty to use the host name; the shared board tells computers apart by it.'),
            text('machineName', s.machine),
            'f-machine',
          ),
          field(
            L('归档前在热层保留', 'Keep in the hot index for'),
            L('结束超过这么多天的工单移到按月归档，面板保持轻快；归档的仍可查询。', 'Tasks finished longer ago move to monthly archives so the panel stays light; archived tasks can still be queried.'),
            pick('hotDays', [1, 3, 7, 14, 30].map(n => ({ value: String(n), label: L(`${n} 天`, `${n} day${n > 1 ? 's' : ''}`) })), String(st.hotDays), v => Number(v)),
            'f-hot',
          ),
        ],
        'sec-board',
      )}

      {section(
        L('调度', 'Scheduling'),
        [
          field(
            L('同时运行上限', 'Max agents at once'),
            L('这台电脑最多同时跑几个智能体。', 'How many agents this computer runs at the same time.'),
            pick('maxConcurrent', [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map(n => ({ value: String(n), label: L(`${n} 个`, String(n)) })), String(st.maxConcurrent), v => Number(v)),
            'f-conc',
          ),
          field(
            L('只在 DeepSeek 低谷时段开新单', 'Start new tasks only in DeepSeek off-peak hours'),
            L(
              '低谷价是高峰的一半。DeepSeek 按 UTC 定高峰：工作日 UTC 1–4、6–10 点，即北京时间 9:00–12:00、14:00–18:00；中国法定节假日全天为低谷（派单器暂按工作日处理，只会更保守）。',
              'Off-peak costs half. DeepSeek peak hours are weekdays 01:00–04:00 and 06:00–10:00 UTC; Chinese public holidays are off-peak all day (treated as weekdays here, which only errs on the cautious side).',
            ),
            pick('offPeakOnly', onOff(), st.offPeakOnly ? 'on' : 'off', v => v === 'on'),
            'f-peak',
          ),
        ],
        'sec-sched',
      )}

      {section(
        L('验收闸门（新工单默认值）', 'Acceptance gate (defaults for new tasks)'),
        [
          field(
            L('默认开启', 'On by default'),
            L('开启后智能体在独立 Git 分支里干活，完成后先测试、再验收合并；每张工单也能单独指定。', 'Agents work on their own Git branch; when done, tests run and then a review decides the merge. Each task can override this.'),
            pick('defaultWorktree', onOff(), st.defaultWorktree ? 'on' : 'off', v => v === 'on'),
            'f-gate',
          ),
          field(
            L('worktree 目录', 'Worktree folder'),
            L('智能体在这里的独立分支副本里干活。不能放在 .claude 文件夹里（Claude Code 会拦下对那里的修改）。', 'Agents work in branch copies here. Not inside a .claude folder (Claude Code blocks edits there).'),
            text('worktreeDir', '~/.agent-dispatch/worktrees'),
            'f-wt',
          ),
          field(
            L('合并请求交给', 'Merge requests go to'),
            '',
            pick('defaultReviewTo', [
              { value: 'user', label: L('我（在面板里批准）', 'Me (approve in this panel)') },
              { value: 'claude', label: L('Claude（自动提醒当前会话）', 'Claude (the current session is notified)') },
              { value: 'agent', label: L('审查智能体（自动审查并批准/驳回）', 'A reviewer agent (approves or rejects)') },
              { value: 'none', label: L('不合并，只保留分支', 'No merge, keep the branch') },
            ], st.defaultReviewTo),
            'f-review',
          ),
        ],
        'sec-gate',
      )}

      {section(
        L('智能体', 'Agents'),
        [
          field(
            L('DeepSeek Key 文件', 'DeepSeek key file'),
            L('一个文本文件，内容写 DEEPSEEK_API_KEY=你的Key（可选 DEEPSEEK_MODEL=deepseek-flash）。派单器只把它交给智能体进程，不显示、不上传。', 'A text file with DEEPSEEK_API_KEY=your-key (optionally DEEPSEEK_MODEL=deepseek-flash). It is only passed to agent processes, never shown or uploaded.'),
            text('deepseekEnvFile', '~/.agent-dispatch/deepseek.env'),
            'f-key',
          ),
          field(
            L('claude 命令', 'claude command'),
            L('启动无头智能体用的 Claude Code 命令；不在 PATH 里就填完整路径。', 'The Claude Code command used for headless agents; give the full path if it is not on PATH.'),
            text('claudePath', 'claude'),
            'f-claude',
          ),
          <Box key="providers" flexDirection="column">
            {PROVIDERS.map(p => (
              <Text key={`p-${p.id}`} wrap="truncate-end">
                <Text color={p.enabled ? 'success' : 'inactive'}>{p.enabled ? '● ' : '○ '}</Text>
                {p.label}
                <Text dimColor>{` · ${noteOf(p)}`}</Text>
              </Text>
            ))}
          </Box>,
        ],
        'sec-agents',
      )}
      <Text dimColor>{L('修改即时保存；任务板位置要等运行中的智能体结束后才能切换。', 'Changes save immediately; the board location can change only when no agent is running.')}</Text>
    </Box>
  )
}

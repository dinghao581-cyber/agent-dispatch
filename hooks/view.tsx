// 右侧面板：总览 → 分栏列表 → 点开看单张工单的全部细节；设置页分“常用 / 任务板 / 高级”三页。
// 所有文字走 L(中文, English, ...值)；说明文字默认收起，点 ⓘ 才展开。
import { clip, fmtDuration, fmtTime, fmtTokens, fmtUSD } from './util'
import { PROVIDERS, noteOf, providerOf } from './providers'
import { L, LANGUAGES, normalizeSetting, setLang } from './i18n'
import { statusLabel } from './runner'
import type { Detail, Row, Settings, SettingsTab, Snapshot, Tab, View } from '../types'

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
  setSettingsTab: (tab: SettingsTab) => void
  toggleInfo: (key: string) => void
  setSetting: (key: keyof Settings, value: string | number | boolean) => void
  saveKey: (value: string) => void
  testKey: () => void
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
  if (!r.startedAt) return L('建于 {0}', 'created {0}', fmtTime(r.createdAt))
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
  const { Box, Text, Button, Progress } = el
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

  if (v.screen === 'settings' && settings) return renderSettings(el, s, settings, v, a)
  if (v.selected) return renderDetail(el, width, s, d, v.selected, a)

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text weight="bold" size="heading">
          {L('派单器', 'Dispatcher')}
        </Text>
        <Button key="settings" label={L('⚙ 设置', '⚙ Settings')} plain onPress={a.openSettings} />
      </Box>
      <Text wrap="truncate-end">
        <Text color={active ? 'claude' : 'inactive'}>● </Text>
        {L('运行 {0}/{1}', 'Running {0}/{1}', active, s.maxConcurrent)}
        <Text dimColor> · </Text>
        {L('今日 {0}', 'Today {0}', fmtUSD(s.costToday))}
        <Text dimColor> · </Text>
        {s.isPeak ? (
          <Text color="warning">{s.offPeakOnly ? L('高峰 · 暂停开新单', 'Peak · new tasks paused') : L('高峰', 'Peak')}</Text>
        ) : (
          <Text color="success">{L('低谷 · 半价', 'Off-peak · half price')}</Text>
        )}
      </Text>
      {s.isActive && !s.isOwner && <Text dimColor>{L('只旁观：本机另一个会话在调度', 'Watching only: another session here is scheduling')}</Text>}
      {s.warning && (
        <Button key="warn" plain onPress={a.openSettings}>
          <Text color="warning">⚠ {s.warning}</Text>
        </Button>
      )}
      {s.error && <Text color="error">{L('刷新出错：', 'Refresh failed: ')}{clip(s.error, 120)}</Text>}
    </Box>
  )

  const tabDef = TABS.find(t => t.tab === v.tab) ?? TABS[0]!
  const rows = s.rows.filter(r => tabDef.statuses.includes(r.status))
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const page = Math.min(v.page, pages - 1)
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginBottom={1}>
        {TABS.map(t => {
          const n = count(s, t.statuses)
          return (
            <Button key={`tab-${t.tab}`} variant={t.tab === v.tab ? 'primary' : 'secondary'} onPress={() => a.setTab(t.tab)}>
              {t.label()}
              {n ? <Text dimColor> {n}</Text> : ''}
            </Button>
          )
        })}
      </Box>

      {shown.length === 0 && (
        <Box paddingY={1}>
          <Text dimColor>{emptyText(v.tab)}</Text>
        </Box>
      )}

      {shown.map(r => {
        const g = GLYPH[r.status] ?? { g: '·' }
        const meta = [s.mode === 'shared' && r.machine ? `@${r.machine}` : '', elapsed(r), r.costUSD ? fmtUSD(r.costUSD) : '']
          .filter(Boolean)
          .join(' · ')
        return (
          <Box key={`row-${r.id}`} flexDirection="column" marginBottom={1}>
            <Button key={`open-${r.id}`} plain onPress={() => a.open(r.id)}>
              <Text color={g.color}>{g.g} </Text>
              <Text weight="medium">{clip(r.title, Math.max(16, width - 6))}</Text>
            </Button>
            {r.status === 'running' ? (
              <Box paddingLeft={2}>
                <Progress label={r.lastAction ? clip(r.lastAction, Math.max(16, width - 12)) : L('思考中…', 'Thinking…')} color="claude" />
              </Box>
            ) : (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {r.summary ? clip(r.summary, Math.max(20, width - 4)) : meta}
              </Text>
            )}
          </Box>
        )
      })}

      {pages > 1 && (
        <Box flexDirection="row" gap={1} alignItems="center" marginBottom={1}>
          <Button key="prev" label="‹" plain dimColor={page === 0} onPress={() => a.setPage(Math.max(0, page - 1))} />
          <Text dimColor>
            {page + 1}/{pages}
          </Text>
          <Button key="next" label="›" plain dimColor={page >= pages - 1} onPress={() => a.setPage(Math.min(pages - 1, page + 1))} />
        </Box>
      )}

      <Button key="refresh" label={L('↻ 刷新', '↻ Refresh')} plain dimColor onPress={a.refresh} />
    </Box>
  )
}

function emptyText(tab: Tab): string {
  switch (tab) {
    case 'active':
      return L('没有运行中的智能体。对 Claude 说“用派单器派一张单”。', 'No agents running. Ask Claude to dispatch a task.')
    case 'queued':
      return L('排队为空。', 'Nothing queued.')
    case 'review':
      return L('没有待审的工单。', 'Nothing to review.')
    case 'done':
      return L('近几天没有完成的工单。', 'Nothing finished in the last few days.')
    default:
      return L('没有异常工单。', 'No problems.')
  }
}

function renderDetail(el: any, width: number, s: Snapshot, d: Detail | null, id: string, a: Actions) {
  const { Box, Text, Button, Progress, Markdown, Code } = el
  const row = d?.row ?? s.rows.find(r => r.id === id)
  if (!row) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Button key="back" label={L('‹ 返回', '‹ Back')} plain onPress={a.back} />
        <Text dimColor>{L('正在读取 {0}…', 'Loading {0}…', id)}</Text>
      </Box>
    )
  }
  const g = GLYPH[row.status] ?? { g: '·' }
  const prov = providerOf(row.provider)
  const section = (title: string, body: any, key: string) => (
    <Box key={key} flexDirection="column" marginBottom={1}>
      <Text weight="semibold">{title}</Text>
      {body}
    </Box>
  )
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Button key="back" label={L('‹ 返回', '‹ Back')} plain onPress={a.back} />
        <Text dimColor size="footnote">
          {row.id}
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={g.color ?? 'subtle'} paddingX={1} marginBottom={1}>
        <Text weight="bold" size="heading">
          <Text color={g.color}>{g.g} </Text>
          {row.title}
        </Text>
        <Text>
          <Text color={g.color}>{statusLabel(row.status)}</Text>
          <Text dimColor>
            {' · '}
            {[
              prov?.short ?? row.provider,
              d?.mode === 'edit' ? L('可改文件', 'can edit') : L('只读', 'read only'),
              row.machine ? `@${row.machine}` : L('待认领', 'unclaimed'),
              row.startedAt ? elapsed(row) : '',
              fmtUSD(row.costUSD),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Text>
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
              {L('分支 {0} · 验收交给 {1}', 'Branch {0} · review by {1}', d.branch ?? L('（待建）', '(pending)'), reviewToLabel(row.reviewTo))}
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

      {d?.result && section(L('结果', 'Result'), <Markdown text={clip3(d.result, 6000)} />, 'result')}

      {section(
        L('进展', 'Progress'),
        d && d.events.length ? (
          <Box flexDirection="column">
            {d.events.slice(-10).map((e, i) => (
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

      {section(L('任务内容', 'Task'), <Markdown text={clip3(d?.prompt ?? '', 3000)} />, 'prompt')}

      {d?.logTail && section(L('输出日志（尾部）', 'Output log (tail)'), <Code source={tailLines(d.logTail, 40)} wrap="wrap" />, 'log')}

      {d && (
        <Text dimColor size="footnote">
          {L('Token 输入 {0} · 缓存 {1} · 输出 {2}', 'Tokens in {0} · cached {1} · out {2}', fmtTokens(d.usage.input), fmtTokens(d.usage.cacheRead), fmtTokens(d.usage.output))}
          {' · '}
          {d.cwd}
        </Text>
      )}
    </Box>
  )
}

function reviewToLabel(r: string): string {
  switch (r) {
    case 'user':
      return L('我', 'me')
    case 'claude':
      return 'Claude'
    case 'agent':
      return L('审查智能体', 'reviewer agent')
    case 'none':
      return L('不合并', 'no merge')
    default:
      return r
  }
}

function tailLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n')
}

function clip3(text: string, n: number): string {
  return text.length > n
    ? `${text.slice(0, n)}\n\n${L('…（已截断，完整内容可让 Claude 用 dispatch_get 查看）', '… (cut; ask Claude to read it in full with dispatch_get)')}`
    : text
}

const SETTINGS_TABS: { tab: SettingsTab; label: () => string }[] = [
  { tab: 'basic', label: () => L('常用', 'General') },
  { tab: 'board', label: () => L('任务板', 'Task board') },
  { tab: 'advanced', label: () => L('高级', 'Advanced') },
]

function renderSettings(el: any, s: Snapshot, st: Settings, v: View, a: Actions) {
  const { Box, Text, Button, Input, Select, Link } = el
  const tab: SettingsTab = v.settingsTab ?? 'basic'

  /** 说明默认收起：点 ⓘ 展开，再点收起 */
  const info = (key: string, hint: string) => ({
    button: <Button key={`info-${key}`} label="ⓘ" plain dimColor onPress={() => a.toggleInfo(key)} />,
    text:
      v.info === key ? (
        <Text key={`hint-${key}`} dimColor size="footnote" wrap="wrap">
          {hint}
        </Text>
      ) : null,
  })

  /** 一行：左边标签（可带 ⓘ），右边控件 */
  const row = (key: string, label: string, control: any, hint?: string) => {
    const i = hint ? info(key, hint) : undefined
    return (
      <Box key={`row-${key}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
            <Text>{label}</Text>
            {i?.button}
          </Box>
          {control}
        </Box>
        {i?.text}
      </Box>
    )
  }

  /** 路径之类的长输入：标签在上，输入框占满一行 */
  const block = (key: string, label: string, control: any, hint?: string) => {
    const i = hint ? info(key, hint) : undefined
    return (
      <Box key={`row-${key}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text>{label}</Text>
          {i?.button}
        </Box>
        {i?.text}
        {control}
      </Box>
    )
  }

  const toggle = (key: keyof Settings, on: boolean) => (
    <Button
      key={`tg-${key}`}
      label={on ? L('● 开', '● On') : L('○ 关', '○ Off')}
      variant={on ? 'primary' : 'secondary'}
      onPress={() => a.setSetting(key, !on)}
    />
  )

  const pick = (key: keyof Settings, options: { value: string; label: string }[], current: string, map?: (v: string) => string | number | boolean) => (
    <Select key={`sel-${key}`} options={options} value={current} onSelect={(value: string) => a.setSetting(key, map ? map(value) : value)} />
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

  const status = (
    <Text wrap="truncate-end" size="footnote">
      {s.keyHint ? <Text color="success">✓ Key</Text> : <Text color="warning">⚠ {L('未填 Key', 'No key')}</Text>}
      <Text dimColor>
        {' · '}
        {st.mode === 'shared' ? L('共享任务板', 'Shared board') : L('本机任务板', 'Local board')}
        {' · '}
        {L('上限 {0}', 'Max {0}', st.maxConcurrent)}
      </Text>
    </Text>
  )

  const basic = [
    row(
      'language',
      L('语言', 'Language'),
      pick(
        'language',
        [{ value: 'auto', label: L('自动（跟随系统）', 'Auto (system)') }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))],
        normalizeSetting(st.language),
      ),
    ),
    <Box key="row-dskey" flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text>DeepSeek Key</Text>
          {info('dskey', L('Key 只存在这台电脑的一个文件里，仅你自己可读，不显示、不上传。', 'Kept only in a file on this computer, readable by you alone; never shown or uploaded.')).button}
        </Box>
        {s.keyHint ? <Text color="success">✓ {s.keyHint}</Text> : <Text color="warning">{L('还没填', 'Not set')}</Text>}
      </Box>
      {info('dskey', L('Key 只存在这台电脑的一个文件里，仅你自己可读，不显示、不上传。', 'Kept only in a file on this computer, readable by you alone; never shown or uploaded.')).text}
      <Input
        key="in-dskey"
        value=""
        placeholder={s.keyHint ? L('粘贴新 Key 替换', 'Paste a new key to replace') : L('粘贴 sk- 开头的 Key', 'Paste your sk-… key')}
        submitLabel={L('保存', 'Save')}
        onSubmit={(value: string) => a.saveKey(value)}
      />
      <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
        <Button key="testkey" label={L('测试连接', 'Test')} onPress={a.testKey} />
        {!s.keyHint && <Link key="getkey" href="https://platform.deepseek.com/api_keys" label={L('创建 Key ↗', 'Get a key ↗')} />}
      </Box>
    </Box>,
    row(
      'maxConcurrent',
      L('同时运行上限', 'Max agents at once'),
      pick('maxConcurrent', [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].map(n => ({ value: String(n), label: String(n) })), String(st.maxConcurrent), v => Number(v)),
    ),
    row(
      'offPeakOnly',
      L('只在低谷开新单', 'Off-peak only'),
      toggle('offPeakOnly', !!st.offPeakOnly),
      L(
        '低谷价是高峰的一半。高峰：工作日北京时间 9:00–12:00、14:00–18:00（UTC 1–4、6–10 点）。',
        'Off-peak costs half. Peak hours: weekdays 01:00–04:00 and 06:00–10:00 UTC.',
      ),
    ),
    row(
      'defaultWorktree',
      L('验收闸门', 'Acceptance gate'),
      toggle('defaultWorktree', !!st.defaultWorktree),
      L(
        '新工单默认在独立 Git 分支里干活，完成后先测试、再验收合并。每张工单也能单独指定。',
        'New tasks work on their own Git branch, then run tests and wait for review before merging. Each task can override this.',
      ),
    ),
    st.defaultWorktree
      ? row(
          'defaultReviewTo',
          L('合并交给', 'Merges go to'),
          pick(
            'defaultReviewTo',
            [
              { value: 'user', label: L('我', 'Me') },
              { value: 'claude', label: 'Claude' },
              { value: 'agent', label: L('审查智能体', 'Reviewer agent') },
              { value: 'none', label: L('不合并', 'No merge') },
            ],
            st.defaultReviewTo,
          ),
        )
      : null,
  ]

  const board = [
    row(
      'mode',
      L('存放位置', 'Location'),
      pick(
        'mode',
        [
          { value: 'local', label: L('本机', 'This computer') },
          { value: 'shared', label: L('共享（NAS）', 'Shared (NAS)') },
        ],
        st.mode,
      ),
      L('共享：几台电脑（Mac / Windows）共用 NAS 上的同一个任务板。', 'Shared: several computers (Mac / Windows) use one board on a NAS.'),
    ),
    st.mode === 'shared'
      ? block(
          'sharedDir',
          L('共享目录', 'Shared folder'),
          text('sharedDir', '/Volumes/NAS/AgentDispatch'),
          L('Mac 填挂载路径，如 /Volumes/NAS/AgentDispatch；Windows 先把 NAS 映射成盘符，如 Z:/AgentDispatch。', 'Mac: the mounted path, e.g. /Volumes/NAS/AgentDispatch. Windows: map the NAS to a drive letter first, e.g. Z:/AgentDispatch.'),
        )
      : block('localDir', L('本机目录', 'Local folder'), text('localDir', L('默认在插件数据目录', "Plugin's data folder"))),
    block(
      'machineName',
      L('这台电脑的名字', 'Computer name'),
      text('machineName', s.machine),
      L('留空用主机名；共享任务板靠它区分各台电脑。', 'Empty uses the host name; the shared board tells computers apart by it.'),
    ),
  ]

  const advanced = [
    row(
      'showBand',
      L('输入框上方状态栏', 'Status line'),
      toggle('showBand', st.showBand !== false),
      L('一行显示运行、排队、待审数量，带“打开面板”按钮。', 'One line above the prompt with counts and an Open panel button.'),
    ),
    row(
      'autoOpen',
      L('自动打开面板', 'Open panel automatically'),
      toggle('autoOpen', st.autoOpen !== false),
      L('派单时、有工单待审时自动打开。', 'When tasks are created or one needs review.'),
    ),
    row(
      'hotDays',
      L('归档前保留', 'Archive after'),
      pick('hotDays', [1, 3, 7, 14, 30].map(n => ({ value: String(n), label: n === 1 ? L('1 天', '1 day') : L('{0} 天', '{0} days', n) })), String(st.hotDays), v => Number(v)),
      L('结束超过这么多天的工单移到按月归档，面板保持轻快；归档的仍可查询。', 'Older finished tasks move to monthly archives to keep the panel light; they can still be queried.'),
    ),
    block(
      'worktreeDir',
      L('worktree 目录', 'Worktree folder'),
      text('worktreeDir', '~/.agent-dispatch/worktrees'),
      L('验收闸门的分支副本放这里。不能放在 .claude 文件夹里。', 'Branch copies for the acceptance gate. Not inside a .claude folder.'),
    ),
    block('deepseekEnvFile', L('Key 文件位置', 'Key file'), text('deepseekEnvFile', '~/.agent-dispatch/deepseek.env')),
    block(
      'claudePath',
      L('claude 命令', 'claude command'),
      text('claudePath', 'claude'),
      L('启动后台智能体用的 Claude Code；不在 PATH 里就填完整路径。', 'The Claude Code command for background agents; use the full path if it is not on PATH.'),
    ),
    <Box key="providers" flexDirection="column" marginTop={1}>
      <Text weight="medium">{L('智能体', 'Agents')}</Text>
      {PROVIDERS.map(p => (
        <Text key={`p-${p.id}`} wrap="truncate-end" size="footnote">
          <Text color={p.enabled ? 'success' : 'inactive'}>{p.enabled ? '● ' : '○ '}</Text>
          {p.label}
          <Text dimColor>{` · ${noteOf(p)}`}</Text>
        </Text>
      ))}
    </Box>,
  ]

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Button key="back" label={L('‹ 返回', '‹ Back')} plain onPress={a.closeSettings} />
        <Text weight="bold" size="heading">
          {L('设置', 'Settings')}
        </Text>
      </Box>
      {status}
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1} marginBottom={1}>
        {SETTINGS_TABS.map(t => (
          <Button key={`stab-${t.tab}`} variant={t.tab === tab ? 'primary' : 'secondary'} onPress={() => a.setSettingsTab(t.tab)}>
            {t.label()}
          </Button>
        ))}
      </Box>
      {(tab === 'board' ? board : tab === 'advanced' ? advanced : basic).filter(Boolean)}
      <Text dimColor size="caption">
        {L('改动即时保存', 'Changes save instantly')}
      </Text>
    </Box>
  )
}

/** 输入框上方的一行状态：派单器 · 运行 · 排队 · 待审 · [打开] */
export function renderBand(el: any, s: Snapshot, open: () => void) {
  const { Box, Text, Button } = el
  if (s.lang) setLang(s.lang)
  const active = count(s, ['running', 'testing'])
  const queued = count(s, ['queued'])
  const review = count(s, ['review'])
  const issues = count(s, ['failed', 'interrupted'])
  return (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text color={active ? 'claude' : 'inactive'}>●</Text>
      <Text weight="medium">{L('派单器', 'Dispatcher')}</Text>
      <Text dimColor>{L('运行 {0}/{1} · 排队 {2}', 'running {0}/{1} · queued {2}', active, s.maxConcurrent, queued)}</Text>
      {review > 0 && <Text color="warning">{L('待审 {0}', 'review {0}', review)}</Text>}
      {issues > 0 && <Text color="error">{L('异常 {0}', 'issues {0}', issues)}</Text>}
      <Button key="open-panel" label={L('打开面板', 'Open panel')} plain onPress={open} />
    </Box>
  )
}

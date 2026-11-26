// 派单器的类型契约：任务板上的数据形状，以及面板读取的会话状态。

export type TaskStatus =
  | 'queued' // 排队，等机器认领
  | 'running' // 智能体运行中
  | 'testing' // 验收闸门：跑测试
  | 'review' // 待审：等用户 / Claude / 审查智能体
  | 'done' // 完成
  | 'failed' // 失败（含测试不通过）
  | 'stopped' // 被停止或取消
  | 'rejected' // 审查驳回
  | 'interrupted' // 客户端关闭或重载时中断

export type ReviewTo = 'user' | 'claude' | 'agent' | 'none'

export type TaskSpec = {
  id: string
  title: string
  prompt: string
  provider: string
  mode: 'read' | 'edit'
  cwd: string
  /** 'any' 或指定机器名 */
  target: string
  /** 1 最高，5 最低 */
  priority: number
  tags: string[]
  gate: { worktree: boolean; testCommand?: string }
  reviewTo: ReviewTo
  maxTurns?: number
  createdBy: string
  createdAt: number
  /** 审查工单：被审的工单号 */
  reviewOf?: string
  retryOf?: string
}

export type TaskEvent = { t: number; text: string }

export type TaskState = {
  id: string
  machine: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  updatedAt: number
  turns: number
  lastAction?: string
  usage: { input: number; cacheRead: number; output: number }
  costUSD: number
  summary?: string
  error?: string
  worktree?: string
  repoRoot?: string
  branch?: string
  baseBranch?: string
  testPassed?: boolean
  testTail?: string
  review?: { verdict: 'approved' | 'rejected'; by: string; at: number; note?: string }
  events: TaskEvent[]
  logParts: number
}

/** 面板和查询用的一行精简记录 */
export type Row = {
  id: string
  title: string
  status: TaskStatus
  provider: string
  machine?: string
  target: string
  priority: number
  tags: string[]
  createdAt: number
  startedAt?: number
  endedAt?: number
  updatedAt: number
  turns: number
  lastAction?: string
  costUSD: number
  summary?: string
  reviewTo: ReviewTo
  /** 这张是哪张工单的重新派单（自动重派也指向原工单） */
  retryOf?: string
  /** 算出来的：它的某次重新派单已经完成，这张就不再算异常 */
  retriedBy?: string
}

export type Settings = {
  mode: 'shared' | 'local'
  sharedDir: string
  localDir: string
  maxConcurrent: number
  offPeakOnly: boolean
  defaultWorktree: boolean
  defaultReviewTo: ReviewTo
  deepseekEnvFile: string
  claudePath: string
  machineName: string
  hotDays: number
  /** 验收闸门的 worktree 放哪；不能在 ~/.claude 下面（Claude Code 会把那里当敏感目录拦下修改） */
  worktreeDir: string
  /** 界面语言：auto 跟随系统，或 43 种语言代码之一（zh-Hans、en-US、ja-JP…）；旧值 zh / en 仍认 */
  language: string
  /** 输入框上方显示一行派单器状态和“打开”按钮 */
  showBand: boolean
  /** 派单、有工单待审时自动打开右侧面板 */
  autoOpen: boolean
}

export type Snapshot = {
  machine: string
  mode: 'shared' | 'local'
  boardDir: string
  isOwner: boolean
  running: number
  maxConcurrent: number
  offPeakOnly: boolean
  isPeak: boolean
  costToday: number
  counts: Record<string, number>
  rows: Row[]
  error?: string
  /** 配置提醒，例如还没设置 DeepSeek Key 文件 */
  warning?: string
  /** 已保存的 DeepSeek Key 的掩码（sk-…1a2b），没有则空 */
  keyHint?: string
  /** 本会话是否已接上界面、负责调度 */
  isActive: boolean
  /** 当前界面语言代码；变了面板就重画 */
  lang: string
  refreshedAt: number
}

export type Detail = {
  id: string
  row: Row
  prompt: string
  cwd: string
  mode: 'read' | 'edit'
  gate: { worktree: boolean; testCommand?: string }
  events: TaskEvent[]
  usage: { input: number; cacheRead: number; output: number }
  result?: string
  logTail: string
  testTail?: string
  error?: string
  branch?: string
  worktree?: string
  review?: TaskState['review']
  loadedAt: number
}

export type Tab = 'active' | 'queued' | 'review' | 'done' | 'failed'

export type SettingsTab = 'basic' | 'board' | 'advanced'

export type View = {
  tab: Tab
  page: number
  selected?: string
  screen?: 'list' | 'settings'
  /** 设置页当前分页 */
  settingsTab?: SettingsTab
  /** 设置页里展开说明的那一项 */
  info?: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-dispatch': {
      snapshot: Shaped<Snapshot | null>
      view: Shaped<View>
      detail: Shaped<Detail | null>
      /** 本会话是否已在调度：重新加载后据此立即恢复，不用等界面重画 */
      active: boolean
    }
  }
}

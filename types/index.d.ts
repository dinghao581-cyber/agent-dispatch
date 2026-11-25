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
  /** 本会话是否已接上界面、负责调度 */
  isActive: boolean
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

export type View = { tab: Tab; page: number; selected?: string; screen?: 'list' | 'settings' }

declare module 'claude-code' {
  interface PluginState {
    'agent-dispatch': {
      snapshot: Shaped<Snapshot | null>
      view: Shaped<View>
      detail: Shaped<Detail | null>
    }
  }
}

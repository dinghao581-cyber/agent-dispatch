# 派单器 · agent-dispatch

在 Claude 客户端（Mac / Windows 桌面端的 Code 页，以及终端版 Claude Code）的右侧面板里调度一群后台智能体：每个智能体的状态、进度一目了然，点开看完整细节；Claude 可以直接调用工具派单、查询、停止和验收。

*A Claude Code mod that dispatches background coding agents (DeepSeek today; GPT and Claude API slots reserved) from a sidebar panel. Claude can call it directly; tasks can live on a shared NAS board used by several machines. UI is in Chinese; English README section below.*

## 功能

- **右侧面板**：进行中 / 排队 / 待审 / 完成 / 异常五栏；运行中的智能体显示实时动作和进度条；点开看摘要、进展时间线、最终结果、任务内容、输出日志和 Token 费用。最小化后变成一眼能看完的小组件。
- **图形化设置页**：面板右上角“⚙ 设置”，任务板位置、并发数、低谷时段、验收闸门默认值、Key 文件路径都能直接改。
- **Claude 直接调用**：`dispatch_create`（支持批量）、`dispatch_overview`、`dispatch_list`、`dispatch_get`、`dispatch_control`、`dispatch_settings`。
- **共享任务板**：多台电脑共用 NAS 上的同一个任务板，各自认领能做的工单；也可以只用本机。
- **工单再多也不卡**：每张工单一个目录、每个文件只由一台电脑写入；面板和 Claude 只读精简的“热层”，结束超过几天的工单按月归档，按条件分页查询。
- **验收闸门**（可按工单开关）：智能体在独立 Git 分支 / worktree 里干活，结束后自动提交、跑测试，通过后把合并请求交给你、交给 Claude，或交给审查智能体自动批准 / 驳回。
- **省钱**：可设置只在 DeepSeek 低谷（半价）时段开新单；费用按实际 Token 计算。
- 关掉客户端时智能体随之停止，下次打开标为“中断”，可一键重新派单。

## 安装

在终端版 Claude Code 里：

```
/plugin install agent-dispatch --marketplace dinghao581-cyber/agent-dispatch
```

或在 shell 里：

```
claude plugin install agent-dispatch --marketplace dinghao581-cyber/agent-dispatch
```

桌面端：点输入框旁的 **+** → Plugins → Add marketplace，填 `dinghao581-cyber/agent-dispatch`，再 Add plugin。

## 第一次使用

1. 准备 DeepSeek Key 文件（默认 `~/.agent-dispatch/deepseek.env`，路径可在设置里改）：
   ```
   DEEPSEEK_API_KEY=你的 Key
   DEEPSEEK_MODEL=deepseek-flash
   ```
   派单器只把它交给智能体进程，不显示、不上传。
2. 确认 `claude` 命令可用（智能体就是用 DeepSeek 接口跑的无头 Claude Code）。不在 PATH 里就在设置里填完整路径。
3. 打开面板（桌面端会自动出现在右侧；也可以输入 `/dispatch`），然后对 Claude 说“用派单器派一张单：……”。

### 多台电脑共享

设置 → 任务板 → 存放位置选“共享”，填共享目录：Mac 用挂载后的路径（如 `/Volumes/NAS/AgentDispatch`），Windows 请先把 NAS 映射成盘符（如 `Z:/AgentDispatch`），因为扩展读不了 `\\server\share` 形式的网络路径。每台电脑填一个不同的名字。

## 任务板的文件布局

```
tasks/<年月>/<工单号>/spec.json            工单内容（创建者写一次）
tasks/<年月>/<工单号>/state.<机器>.json     运行状态（只由跑它的机器写）
tasks/<年月>/<工单号>/log.<机器>.<n>.txt    原始输出，分段
tasks/<年月>/<工单号>/result.<机器>.md      最终回答
queue/<工单号>.json                         排队标记
claims/<工单号>/<机器>.json                 认领票据，最早者得
index/<机器>.json                           热层：近几天的精简行
digest/<机器>/<年-月>.json                  按月归档
controls/<机器>/…                           跨机器操作请求（停止、批准…）
locks/<机器>.json                           每台电脑只让一个会话调度
```

## 智能体

| 智能体 | 状态 |
| --- | --- |
| DeepSeek Flash | 可用 |
| DeepSeek V4 Pro | 已预留 |
| Claude API | 已预留，需要 `ANTHROPIC_API_KEY` |
| GPT | 已预留，需要 OpenAI Key 和 Codex CLI |

新增一种智能体：在 `hooks/providers.ts` 的 `PROVIDERS` 里登记，并在 `buildLaunch` 里给出启动命令和环境变量。

## 开发

源码是 TypeScript 写的 Claude Code 扩展（`hooks/`），类型契约在 `types/index.d.ts`。

```
claude plugin validate .
claude plugin test .
```

## English

**agent-dispatch** is a Claude Code mod: a sidebar panel that runs and tracks background agents (headless Claude Code pointed at DeepSeek's Anthropic-compatible API), plus `dispatch_*` tools so Claude can create, query, stop and approve tasks itself.

- Shared task board on a NAS for several machines (single-writer files, safe over SMB), or a local board.
- Scales to thousands of tasks: a small "hot" index plus monthly archives, paged queries.
- Optional acceptance gate: per-task git worktree, auto-commit, test command, then the merge request goes to you, to Claude, or to a reviewer agent.
- Off-peak-only scheduling for DeepSeek's half-price hours; cost tracked from real token usage.
- Install with `/plugin install agent-dispatch --marketplace dinghao581-cyber/agent-dispatch`, put `DEEPSEEK_API_KEY=...` in `~/.agent-dispatch/deepseek.env`, open the panel with `/dispatch`.

## 许可证

[Apache-2.0](LICENSE)

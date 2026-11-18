# M2 后端任务运行时

更新：2026-11-18（Asia/Shanghai）。已实现第一块后端：本地插件注册、启用状态、项目登记、任务 / 尝试 / 事件 / 产物持久化、管理员 API、独立单 worker 和 Codex CLI 适配器。**尚未接入聊天意图派发、任务卡片和桌宠状态；真实模型任务未验收。**

已确认的目标方案：通过 API 或 CLI 在后台执行，读取结构化进度，主要在菜菜查看任务。后台模型只负责理解、调度、关键节点整理与最终汇报；执行器沿用用户各自配置的模型和认证。是否需要软件打开取决于所选入口，不要求模拟聊天界面或让每个任务在桌面软件中可见。完整方案见 [后台执行方案](AGENT_PLUGIN_ARCHITECTURE.md#已确认的后台执行方案)。

下面的 CLI 登录检查、忽略用户配置和独立启动描述是当前原型的实际行为，**不代表目标方案已经实现**。后台 CLI 与软件配置是否共享尚待核实；下一步核实真实 API / CLI 入口和配置来源，再修正适配器。后台中转站密钥不提供给执行器，也不以当前 CLI 未登录判定其他接口不可用。

本机核实的 CLI 为 `0.169.0-alpha.11.1`，`codex login status` 当前返回未认证。自动化使用真实子进程夹具验证协议与生命周期，不代表真实 Codex 已修复项目。用户最新决定先接 DeepSeek Harness，跑通后再考虑 Codex；当前 CLI 实现保留为原型，本轮不继续扩展。

## 启动与配置

API 与 worker 在同一 `backend` 工作目录运行，使用相同 `.env` 与文件型 SQLite 数据库：

```sh
cd backend
.venv/bin/uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
```

在另一个终端运行：

```sh
cd backend
.venv/bin/python -m app.task_worker
```

可选环境配置：

```dotenv
# GUI 启动时 PATH 可能不包含 CLI；可以填写可执行文件绝对路径。
CODEX_BINARY=codex
TASK_POLL_SECONDS=0.5
```

worker 必须能访问已认证的 Codex CLI，可在同一系统账号与 `CODEX_HOME` 下执行 `codex login`。它使用 CLI 自己的认证，尚不复用菜菜管理页中的中转站配置。适配器只接受已核实的 `0.169.x` 版本及必要参数；其他版本明确返回不可用，需核实协议并更新适配器。

插件默认关闭。启用及每次创建、执行任务均检查 CLI 可用性。CLI 不可用时返回稳定原因代码，例如 `codex_missing`、`codex_not_authenticated`，不创建假执行结果。重复提交已存在的任务仍返回原任务，不要求执行器重新可用。

API 不负责启动或停止 worker；此阶段 worker 独立启动。API / 聊天窗关闭不会停止该进程；需要主动停止 worker 才触发其中的运行中断清理。桌面宿主的 worker 生命周期整合属于下一阶段，不能视为已经完成应用退出验收。

## 接口与最小操作顺序

以下接口都要求 `Authorization: Bearer <ADMIN_TOKEN>`。

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/plugins` | 清单、启用状态、CLI 版本、能力、限制和不可用原因 |
| `PUT /api/v1/plugins/caicai.coding` | `{"enabled":true}` 启用插件；关闭不隐式取消已有运行，尚未领取的任务会失败 |
| `POST /api/v1/projects` | `{"name":"验证项目","root":"/absolute/project"}`，登记目录授权 |
| `GET /api/v1/projects` | 已登记项目 |
| `POST /api/v1/tasks` | 创建任务；同一会话及幂等键返回原记录，参数不同返回 409 |
| `GET /api/v1/tasks?conversation_id=...&limit=50` | 最近任务，可按会话过滤 |
| `GET /api/v1/tasks/{id}` | 任务、尝试历史、产物及 SHA-256（存在且不超过 10 MiB 的文件） |
| `GET /api/v1/tasks/{id}/events?after=0&limit=100` | 按序号分页补读持久事件；目前采用轮询，无 SSE |
| `POST /api/v1/tasks/{id}/cancel` | 排队取消，或请求停止运行进程组 |
| `POST /api/v1/tasks/{id}/acknowledge-interruption` | 人工核查中断后解除派发阻塞，要求 `{"confirm_no_running_process":true}` |

先创建 `desktop` / `debug` 会话，登记项目并启用插件，然后提交：

```json
{
  "conversation_id": "已创建的本地会话ID",
  "project_id": "已登记的项目ID",
  "agent_id": "caicai.coding/coding",
  "goal": "运行项目测试，修复失败问题，重新验证并说明改动",
  "idempotency_key": "test-repair-001",
  "timeout_seconds": 600
}
```

目录必须为存在的绝对目录；符号链接会规范化并去重。执行前再次检查目录，目录改指其他位置则拒绝。使用 Git 项目根目录；首版不传 `--skip-git-repo-check`，非 Git 项目由 CLI 拒绝。项目目录通过管理员接口明确登记，任务参数只能引用已有项目 ID，不能传任意运行命令、执行器路径或 CLI 参数。

## 执行与恢复边界

- 内置 `caicai.coding/coding`，适配器只从后端显式代码注册，不根据清单导入模块。清单支持契约 v1 和首版固定的 `goal` schema；未知版本、重复 ID、缺失执行器、未知能力及不支持的 schema 拒绝注册。插件启用状态持久化；首版配置 schema 为空，不支持任意执行参数。
- worker 持有数据库旁的独占锁，只允许一个实例。领取、状态转换和事件序号分配使用短跨进程锁及数据库事务；外部执行期间不占锁，也不占聊天服务的模型配置锁。此机制仅支持同一台 macOS / POSIX 主机的文件型 SQLite，不支持多主机或网络文件系统。
- CLI 使用 `exec --json --ephemeral --ignore-user-config --sandbox workspace-write`，`approval_policy="never"`，工具网络关闭。目标通过文件型标准输入传入，不拼接 shell。每次执行有独立进程组；取消、超时或 worker 正常退出会终止并确认自有进程组，确认不了则标记中断。没有关闭沙箱或自动批准的降级路径。
- `workspace-write` **不是仅允许读取项目的隔离**：执行器仍可能读取系统允许的其他文件，并可能写入系统临时目录；不能承诺严格的项目内读权限。CLI 托管限制仍然适用。暂不接入自定义 MCP / hooks，带祖先项目 `.codex/config.toml` 的目录会被拒绝；忽略用户 CLI 配置以免引入额外执行能力。沙箱在本机认证后的实际写入 / 网络边界仍待真机验收。
- CLI 子进程只继承必要系统环境与可选 `OPENAI_API_KEY`，不继承后端管理员令牌和中转站环境密钥。仅保存选定事件字段，限制单行、文本及事件数量；过滤常见凭据格式与已知环境密钥，不保存原始 stderr / 失败对象。自由文本无法保证识别所有业务秘密，事件接口仅管理员可读。
- CLI 必须正常退出并产生 `turn.completed`，才能记录执行成功。命令检查以 `command_execution` 的退出码与输出单独呈现，CLI 成功不等于所有测试通过。产物来自 CLI 的 `file_change` 事件并核验路径和当前文件哈希，**尚无独立 Git diff 审计或自动判断任务目标是否完成**。
- 排队取消不启动执行器；运行中先为 `cancelling`，停止确认后才到 `cancelled`。取消晚于真实完成时保留成功结果。超时停止后为 `failed/timeout`；worker 收到退出信号时为 `interrupted/shutdown`。终态不受迟到事件覆盖。
- worker 重启将旧活跃任务标记为 `interrupted/worker_lost`，不查询或重放旧 CLI 会话。未核查中断会阻止后续所有派发及领取；已排队任务保留。管理员须先核查可能遗留的执行，核查接口也会拒绝仍存在的已记录进程组。强制崩溃发生在启动进程与保存 PID 之间时，需人工确认没有遗留进程后再解除阻塞；系统不会猜测并杀死未知进程。
- 核查仅解除阻塞，不重跑原任务。目前尚无重试、暂停、恢复、交互审批接口；需要重做时使用新的幂等键显式创建新任务，注意它可能重复产生副作用。会话删除保留任务和事件历史，并清空会话外键。

## 已验证与下一步

2026-11-18 验证记录：项目根目录执行 `backend/.venv/bin/pytest -q backend/tests`，全量 161 项通过（已有 139 项，新增任务测试 22 项）；最终迟到取消竞态修正后，相关竞态及独立 worker 生命周期定向复核 2 项通过。`backend/.venv/bin/ruff check backend` 与 `git diff --check` 通过。未修改前端或桌面代码，本轮未重跑其测试与 Electron 验收。

自动化覆盖真实夹具子进程的成功、文件产物、事件重连补读、并发幂等、失败、缺失终态、协议错误、排队取消、进程组及子进程取消、超时、聊天并行、worker 退出、独立进程重复启动拒绝、中断核查、目录校验和管理员鉴权。夹具不调用真实模型。

后续依次完成：确认 DeepSeek Harness 的具体来源与安装版本，核实后台 API / CLI、用户模型与认证配置来源、结构化事件及取消能力；复用调度底座实现其适配器并做隔离 Git 项目真实验收，再接任务面板、聊天派发、关键节点汇报及 worker 生命周期。DeepSeek Harness 完整闭环跑通后再考虑 Codex，不以 Codex CLI 登录或原型改造作为当前前置条件。当前代码尚未切换默认执行器；Codex 原型仍是已有实现，不代表 DeepSeek Harness 已可用。ASR 与多 Agent 调度继续后置。

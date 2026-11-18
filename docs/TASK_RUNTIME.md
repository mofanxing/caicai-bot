# M2 任务运行时

更新：2026-11-18（Asia/Shanghai）。

已实现本地插件注册、项目登记、任务 / 尝试 / 事件 / 产物持久化、管理员 API、独立单 worker、DeepSeek Harness 适配器、任务中心、聊天显式派发和桌面自有 worker 生命周期。真实 Harness 修复及取消验收已通过，详细来源、配置与边界见 [DeepSeek Harness 接入](DEEPSEEK_HARNESS.md)。

默认执行器为 DeepSeek Harness，逻辑 Agent 为 caicai.deepseek/coding。旧 caicai.coding/coding 保留 Codex CLI 技术原型，不自动迁移旧任务。任务由独立 worker 执行，菜菜模型用于普通聊天和按需增量汇报，执行模型与认证由 Harness 自己管理。

## 启动

桌面自动启动的后端会托管一个 worker；任务中心显示 worker 的实际运行与归属。关闭聊天窗口不取消任务；退出整个桌面应用会停止自有 worker 及其执行。外部后端与外部 worker 不由桌宠退出逻辑停止。

手动启动时，在同一 backend 目录、相同 .env 与文件型 SQLite 配置下分别运行：

    .venv/bin/uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
    .venv/bin/python -m app.task_worker

可选配置：

    DEEPSEEK_BINARY=dsh
    DEEPSEEK_HOME=
    DEEPSEEK_MODEL_PROFILE=desktop
    CODEX_BINARY=codex
    TASK_POLL_SECONDS=0.5

默认 Harness home 为 ~/.dsh；桌宠进程的 DSH_HOME 不作为执行器配置来源。插件默认关闭，启用前检查所选执行器版本、参数和模型配置。CLI 就绪不代替真实认证验证；不会把 CLI 未登录当作其他执行器不可用的依据。

## 工作台使用

任务中心可登记项目、启停插件、新建任务、查看任务历史。聊天中填写目标后点击「交给菜菜执行」可选择已登记项目派发，任务卡片跟随所属会话；普通「发送」仍保持聊天语义，不会仅凭模型文本直接运行命令。

详情展示事件、实际检查输出、尝试历史、Harness session ID、改动文件及哈希；可取消，或核查中断。「让菜菜汇报」按需使用关联会话聊天模型，根据旧摘要和有限的新事件生成持久化摘要；无新事件复用已有汇报，汇报失败不影响任务状态。自动意图识别与关键节点自动播报尚未实现。

## 管理员接口

全部要求 Authorization: Bearer <ADMIN_TOKEN>，响应不缓存。

| 接口 | 用途 |
| --- | --- |
| GET /api/v1/task-runtime | worker 状态与归属 |
| GET /api/v1/plugins | 插件、版本、能力、配置状态和不可用原因 |
| PUT /api/v1/plugins/caicai.deepseek | {"enabled":true} 启用 Harness 插件 |
| POST /api/v1/projects | {"name":"项目","root":"/absolute/git-root"} |
| GET /api/v1/projects | 已登记项目 |
| POST /api/v1/tasks | 幂等创建任务 |
| GET /api/v1/tasks?conversation_id=...&limit=50 | 任务列表与当前步骤 |
| GET /api/v1/tasks/{id} | 状态、尝试、产物及文件哈希 |
| GET /api/v1/tasks/{id}/events?after=0&limit=100 | 持久事件分页补读，当前采用轮询 |
| POST /api/v1/tasks/{id}/cancel | 排队取消或请求停止实际执行 |
| POST /api/v1/tasks/{id}/report | 生成 / 复用菜菜的增量汇报 |
| POST /api/v1/tasks/{id}/acknowledge-interruption | 人工核查后解除派发阻塞 |

任务示例：

    {
      "conversation_id": "已创建的本地会话ID",
      "project_id": "已登记项目ID",
      "agent_id": "caicai.deepseek/coding",
      "goal": "运行测试，修复失败并重新验证，说明改动和检查结果",
      "idempotency_key": "repair-001",
      "timeout_seconds": 600
    }

同会话同幂等键和相同输入返回原任务；同键不同输入返回 409。关闭插件不取消正在运行的任务，但未领取的任务会以插件不可用结束。会话删除保留任务历史，汇报需关联会话存在。

## 生命周期与恢复

- worker 持有数据库旁的排他文件锁；同一时刻单任务执行。短事务保护状态和事件序号，模型与 CLI 执行不占数据库锁。只支持同机 POSIX 文件型 SQLite。
- 每次尝试独立启动执行器进程组，记录真实运行标识与版本。取消从 cancelling 到确认停止后才记录 cancelled；迟到取消不能覆盖已完成结果。
- 超时停止后记为 failed/timeout；worker 正常退出记为 interrupted/shutdown；重启识别旧活动任务为 interrupted/worker_lost，不自动重放。
- 未核查中断阻止后续领取与派发。核查接口要求 confirm_no_running_process=true，且拒绝仍存在的已记录进程组；只解除阻塞，不重试。
- 暂无显式重试、交互审批、暂停或恢复接口；重做需新幂等键创建新任务，可能重复产生副作用。
- 执行器成功不等于测试全部通过。分别展示执行器总结、检查命令和输出、实际检测到的文件改动；不编造百分比。

## Codex 原型兼容

旧 caicai.coding/coding 仍使用已核实的 Codex CLI 0.169.x 原型。它检查 codex login status，使用 exec --json --ephemeral --ignore-user-config --sandbox workspace-write、approval_policy=never 和禁工具网络策略，不支持带祖先 .codex/config.toml 的项目。此配置策略仅描述旧原型，不是新的 Harness 配置方案；真实 Codex 模型验收仍未完成，本轮不扩展该执行器。

## 本轮验证（2026-11-18）

- 后端 185 项、前端 71 项、桌面 26 项自动化测试通过；前端与桌面构建、Ruff 和 diff 空白检查通过。
- 真实 Harness 在隔离 Git 项目中修复失败测试，宿主独立重跑退出码从 1 变为 0；另一次运行中取消后 Harness 进程组和 shell 均确认停止。
- 真实 Electron 后端生命周期验收覆盖托管 worker；聊天验收覆盖流式文字、分段语音、窗口收起、动画和任务中心配置加载，无 renderer 错误。
- 桌面任务创建到真实模型执行的完整人工体验、真实任务并行聊天、自动意图识别和关键节点自动播报仍未验收或实现。

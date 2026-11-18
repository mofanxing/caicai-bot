# M2 任务运行时

更新：2026-11-18（Asia/Shanghai）。

已实现本地插件注册、项目登记、任务 / 尝试 / 事件 / 产物持久化、管理员 API、独立单 worker、DeepSeek Harness 适配器、任务中心、聊天显式与自然语言派发、任务结束后的一次性语音提醒和桌面自有 worker 生命周期。完成提醒不写入聊天消息。真实 Harness 修复及取消验收已通过，详细来源、配置与边界见 [DeepSeek Harness 接入](DEEPSEEK_HARNESS.md)。

默认执行器为 DeepSeek Harness，逻辑 Agent 为 caicai.deepseek/coding。旧 caicai.coding/coding 保留 Codex CLI 技术原型，不自动迁移旧任务。任务由独立 worker 执行，菜菜模型用于普通聊天、任务意图理解和按需增量汇报；完成提醒按真实任务状态生成，不调用汇报模型。执行模型与认证由 Harness 自己管理。

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

任务中心可通过桌面原生「选择文件夹」登记项目，支持删除登记（不删除磁盘文件）。有排队 / 活动任务的项目拒绝删除；历史任务仍保留目录快照，相同目录再次登记恢复原 ID。浏览器不能取得本机绝对路径，网页端保留手填，推荐在桌面端选择文件夹。

聊天中直接「发送」明确的项目执行要求（如“帮我修复 XX 项目的登录问题并运行测试”），菜菜使用当前会话模型理解并创建真实后台任务，返回任务编号。已登记项目存在时会多一次意图解析模型调用；普通能力问答保持聊天语义，项目或要求不明确时追问，不允许模型编造项目 ID。执行器仍经目录、插件及可用性校验；同一消息重发不重复建任务。没有项目时先登记，没有会话模型时无法理解自然语言任务；仍保留「交给菜菜执行」及任务中心手动创建入口。

详情展示事件、实际检查输出、尝试历史、Harness session ID、改动文件及哈希；可取消，或核查中断。「让菜菜汇报」按需使用关联会话聊天模型，根据旧摘要和有限的新事件生成持久化摘要；无新事件复用已有汇报，汇报失败不影响任务状态。任务成功、失败、取消或中断后，API 后台维护线程按真实状态生成一句简短提醒，语音沿用所属会话音色与表达配置，不调用汇报模型、不创建聊天消息。通知使用独立语音任务，持久投递标记防止重复生成；未选音色时跳过语音。

前端全局轮询待播语音，按「自动朗读」开关串行播放，普通聊天发送或其他语音播放期间让出音频。提醒没有文字面板、播放器或重播按钮，不进入聊天历史及模型上下文；聊天内也隐藏已结束任务卡片，详情可在任务中心查看。桌面窗口收起继续播放；自然播放结束后立即删除音频文件和语音任务，本机保存清理日志，网络失败或刷新后只重试删除，不重播已经听完的提醒。播放被暂停不算已听完，恢复后继续；未播提醒最多保留五天。浏览器可能要求先交互才能播放，桌面允许主动播放。旧版 task-report 消息立即从聊天 / 上下文排除，后台清理旧消息和音频。

执行记录按 task.finished 事件时间保留 5 天，清理事件、尝试、产物引用及任务，新的汇报不会重置保留期。进行中 / 排队任务与未核查中断任务保留，以防隐藏遗留进程。API 后台、worker 领取及任务列表请求都会触发清理；磁盘项目文件不随执行历史删除。执行中关键节点自动汇报仍未实现。

## 管理员接口

全部要求 Authorization: Bearer <ADMIN_TOKEN>，响应不缓存。

| 接口 | 用途 |
| --- | --- |
| GET /api/v1/task-runtime | worker 状态与归属 |
| GET /api/v1/plugins | 插件、版本、能力、配置状态和不可用原因 |
| PUT /api/v1/plugins/caicai.deepseek | {"enabled":true} 启用 Harness 插件 |
| POST /api/v1/projects | {"name":"项目","root":"/absolute/git-root"} |
| GET /api/v1/projects | 已登记项目 |
| DELETE /api/v1/projects/{id} | 移除登记，不删除磁盘文件；有待执行任务返回 409 |
| GET /api/v1/task-notifications | 最近 5 天尚未消费的独立提醒语音 |
| DELETE /api/v1/task-notifications/{job_id} | 自然播完后幂等删除语音任务与音频 |
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

- 提交前重新运行：后端 204 项、前端 80 项、桌面 26 项自动化测试通过；前端与桌面生产构建、Ruff 和 diff 空白检查通过。
- 此前已通过真实 Harness 验收：在隔离 Git 项目中修复失败测试，宿主独立重跑退出码从 1 变为 0；另一次运行中取消后 Harness 进程组和 shell 均确认停止。本轮未重复调用真实 Harness 模型。
- 真实 Electron 后端生命周期验收覆盖托管 worker；聊天隔离验收覆盖原生文件夹选择按钮 / 鉴权 / 取消（对话框结果夹具）、自然语言创建持久任务、收起窗口后的完成语音实际播放、完成通知不入聊天且播完删除音频，以及项目移除不删任务记录；renderer 错误为 0。模型与执行器使用确定性夹具，语音使用静音 WAV，不调用真实模型或 TTS。
- 新增自动化覆盖删除登记、五天清理、自然语言幂等派发 / 追问、并发通知去重、无聊天消息、一次性音色任务及清理重试。完整桌面人工体验、真实任务并行聊天和执行中关键节点自动播报仍待验收或实现。

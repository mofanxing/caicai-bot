# DeepSeek Harness 接入

核实与实施日期：2026-11-18；版本兼容核实：2026-11-19；文档更新：2026-11-20（Asia/Shanghai）。

已完成：正式适配器、独立插件、任务中心、聊天显式派发、详情与事件补读、按需增量汇报，以及桌面自有后端的 worker 托管。已通过真实模型修复与真实取消验收。自然语言自动识别建任务、任务结束后的一次性语音提醒已接通；执行中关键节点自动汇报和语音已实现；交互审批和恢复继续后置。

## 已核实的安装与协议

- 本机应用：/Applications/DeepSeek Harness.app，bundle ID 为 com.deepseek.dsh。
- 首次核实版本（2026-11-18）：0.2.2-rc.3，应用包声明作者为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.，构建提交为 6b729fedde0c8fd03af7afdf5a711aa64fe87c3b。2026-11-19 核实的本机安装版本为 0.2.2-rc.5。
- 安装包声明源码仓库：https://github.com/deepseek-ai/deepseek-harness.git，包为 @deepseek-ai/dsh-headless。
- 自带 CLI 位于 Contents/Resources/runtime/cli/bin/dsh。无需另装 CLI，不要求 GUI 保持打开。
- 已实测 dsh --version 和 dsh headless --help；支持 --json、标准输入任务、--permission-mode workspace-write、--approval-policy never。
- 协议依据为该安装包随附的 README.zh.md、src/json-stream.ts、src/index.ts、src/startup.ts，不假设其他版本兼容。
- JSON 事件包括 session、status、text、thinking、tool_call、tool_result、final、error；只有进程退出码为 0 且 final.reason.kind 为 completed 才记录执行器成功。工具返回不等于检查通过。菜菜不保存 thinking 事件。

2026-11-19 本机升级至 0.2.2-rc.5 后，旧适配器因只接受 0.2.2-rc.3 而返回
`deepseek_version_unsupported`。已核对 rc.5 安装包中的 headless 参数、JSON 事件协议及
headless overlay 配置，适配器现在同时接受 0.2.2-rc.3 / 0.2.2-rc.5，并继续检查必要参数
和模型选择。不支持的版本也会显示实际检测版本及已核实版本，便于定位后续升级问题。
rc.5 已通过本机 CLI 与模型选择就绪检查，以及两版协议夹具的任务全流程回归；
下文真实模型修复及取消验收仍对应 2026-11-18 的 rc.3，未在此次检查中重跑真实模型任务。

## 配置归属与来源

执行模型和认证由 Harness 管理；菜菜的聊天模型只做聊天和汇报，不向执行器传入后台中转站密钥。当前适配器核实了内置 deepseek 和 deepseek-account 路由，其他模型提供方明确提示不支持，不静默换模型。

菜菜默认从 ~/.dsh/profiles/desktop/cordis.patch.yml 读取已保存的 agent-default-model 的 provider、model、reasoningEffort 字段。首版要求先在 Harness 中明确选择并保存模型；不猜测未配置的选择，不导入 desktop 的 GUI 或第三方插件配置。

随附 headless profile 默认禁用托管凭据和账号，GUI 登录不能直接推断为 headless 可用。适配器按安装包文档，为每次运行生成一个权限为 0600 的临时 overlay，启用 credentials、authorization、deepseek-account 并引用所选模型。凭据由 Harness 原生组件从自己的 home 读取，不复制密钥，不修改用户 profile。临时 overlay 退出后删除。执行器运行会正常产生 Harness 自己的会话记录。

桌宠也使用 DSH_HOME，但它指向桌宠自己的隔离目录。适配器有意忽略父进程的 DSH_HOME，默认使用 ~/.dsh；自定义 Harness home 必须通过 DEEPSEEK_HOME 指定，随后只对 Harness 子进程设置 DSH_HOME。

backend/.env 可选配置：

    DEEPSEEK_BINARY=dsh
    DEEPSEEK_HOME=
    DEEPSEEK_MODEL_PROFILE=desktop

找不到 PATH 中的 dsh 时，默认自动定位 /Applications/DeepSeek Harness.app 自带的 CLI。显式配置的其他路径缺失时不会降级到另一个程序。可用性检查只验证版本、参数与模型选择，不调用模型、不承诺保存的登录仍有效；认证错误在真实运行中呈现。

## 升级后任务中心提示不可用

- 当前已核实版本为 0.2.2-rc.3 / 0.2.2-rc.5；其他版本返回 `deepseek_version_unsupported`，提示包含实际检测版本和已核实版本。
- Harness 升级后若出现此提示，先核对任务中心显示的版本与适配器支持范围；需要更新菜菜适配器并重启 Python 后端。桌面托管后端可通过完全退出、重新启动菜菜加载更新，仅刷新聊天页不会重新加载后端代码。
- 版本检查通过后仍会检查 headless 参数和所选 profile 的模型配置；对应错误分别为 `deepseek_protocol_unsupported` 和 `deepseek_model_not_configured`。执行器就绪仍需在任务中心启用插件才能派发任务。
- 2026-11-19 回归结果：Harness 适配测试 23 项、任务调度及 worker / 体验 / 关键节点相关测试 55 项，共 78 项通过。两版协议夹具均覆盖插件状态查询和任务执行；本机 rc.5 就绪检查返回 `ready: true`。

## 使用

1. 重启后端并重新打开已构建的桌面聊天页。
2. 在「任务中心 → 执行器与项目设置」启用「DeepSeek 编程助手」。
3. 登记 Git 项目的绝对根目录。
4. 点击「新建任务」，选择所属会话和项目、填写任务与验收条件。也可在聊天输入目标后点击「交给菜菜执行」。普通「发送」也会识别明确的项目执行要求并自动派发，普通问答仍保持聊天。
5. 在任务卡片查看状态、最近活动和当前步骤，进入详情查看真实日志、执行尝试、文件改动、哈希和结果，或取消任务。
6. 「让菜菜汇报」使用关联会话的聊天模型整理证据。没有配置聊天模型时保留原始结果并提示配置。无新事件复用缓存；再次汇报只发送旧摘要和最多 32 条新事件，不反复发送完整日志。汇报失败不改变任务执行结果。

默认 TaskCreate.agent_id 为 caicai.deepseek/coding。独立插件 ID 为 caicai.deepseek；旧 caicai.coding/coding 仍指向 Codex 原型，保留已有任务的执行器语义，不把已排队的 Codex 任务偷偷改成 Harness 任务。两个插件默认都不自动启用。

## worker 与窗口生命周期

桌面自动启动的 Python 后端会托管独立任务 worker。关闭聊天窗仅收起，不停止 worker；整个应用退出会关闭 API 到 worker 的 stdin 租约，worker 停止自有执行进程并记录中断。API 意外消失也会触发 EOF 清理。worker 的排他锁阻止同一数据库启动第二个 worker；检测到已有 worker 时按外部服务使用，不会在退出时杀死它。

手动启动或复用的外部 API 不自动接管 worker，请在相同 backend 目录和配置下另运行：

    .venv/bin/python -m app.task_worker

GET /api/v1/task-runtime 返回 worker 运行与归属状态，需管理员鉴权。中断任务沿用已有核查机制，不自动重新执行。硬杀整个进程树、系统崩溃等仍需重启后核查，不能保证清理任意未知后台进程。

## 文件与执行边界

- 任务仅绑定管理员登记的 Git 项目根目录；创建与执行前重新校验。
- workspace-write 与 approval-policy never 由真实 CLI 执行；需要额外权限的工具不自动批准。未使用 auto 或 danger-full-access，不授予额外目录。
- 不承诺只能读取项目；Harness 的文件访问、网络与工具限制以实际沙箱和用户 Harness 配置为准。
- 对 Git 跟踪及未忽略文件做执行前后内容哈希比较，只记录本次实际改变的文件；不会把原有未修改的脏文件算作本次产物。忽略目录外符号链接。
- 首版审计上限：2 万个文件、累计 128 MiB；单文件大于 10 MiB 不审计内容。产物不是完整差异备份，文件删除只保存路径与操作。
- 只保存选定并脱敏的事件字段；通用脱敏不能保证识别所有业务秘密。日志只向管理员开放。
- 取消、超时和 worker 正常退出会停止自有运行进程组并确认停止。不可确认时保留中断状态，不伪装取消成功。

## 真实验收记录

2026-11-18 使用用户已有的 deepseek-account / deepseek-flash、high 配置，未改写用户模型或凭据：

- 在临时 Git 项目准备一个实现错误的 add 函数和 unittest。
- 独立基线检查退出码为 1；通过管理员任务 API 创建任务并由 worker 调用真实 Harness。
- 收到真实 session、状态、bash/read/edit 调用及工具结果；Harness 把减法修成加法，没有修改测试文件。
- final 为 completed 且进程退出为 0；菜菜记录 calculator.py 的 update 和 SHA-256。
- 宿主独立复测退出为 0。
- 另起真实 Harness 运行写入自有 shell PID 后 sleep 90 的任务；发出取消后，适配器返回 cancelled，确认 Harness 进程组及 shell 均已消失。

自动化夹具另外覆盖失败、缺失终态、错会话、异常 JSON、终态后事件、取消 / 超时 / 退出、分页补读、文件归属、配置来源、凭据过滤、汇报缓存与失败隔离。真实修复验收不是对任意项目任务质量或全部工具沙箱边界的保证。

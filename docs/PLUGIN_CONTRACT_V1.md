# 菜菜最小插件契约 v1

更新：2026-11-18（Asia/Shanghai）。DeepSeek Harness 0.2.2-rc.3 适配、任务中心、聊天显式派发、按需增量汇报及桌面 worker 管理已实现；隔离 Git 项目的失败测试修复与运行中取消已通过真实验收。执行模型与认证沿用 Harness 自己的配置。自然语言自动识别派发、关键节点自动播报和完整桌面人工任务验收待完成；Codex 历史原型保留，真实接入后置。显式重试及可选确认 / 恢复接口仍是契约目标。使用说明见 [任务运行时](TASK_RUNTIME.md) 和 [Harness 接入](DEEPSEEK_HARNESS.md)。

## 1. 首版范围

本地显式注册插件，一个编程 Agent、一个执行器、一个独立 worker，同一时刻只运行一次执行尝试。桌宠和聊天只调用任务服务，不启动命令，不保存另一套任务状态。新增角色包与 Agent 插件是两条独立扩展路径。

不做插件市场、远程代码加载、热更新、多 Agent 协作或并行调度。一个插件可以提供 Agent 定义和执行器适配器；执行器已有的工具直接复用，无需先写一套通用工具框架。

2026-11-18 已确认：适配器通过 API / CLI 后台执行并读取结构化事件；任务主要在菜菜查看，不依赖模拟鼠标键盘或聊天界面识别。执行器使用用户独立配置的模型与认证，插件配置仅包含接入与任务管理所需信息，不从后台中转站选择执行模型。后台入口与软件配置是否共享须由适配器实测说明；DeepSeek 适配已沿用用户保存的模型选择与认证；旧 Codex 原型不作为本轮验收依赖。详细方案见 [架构说明](AGENT_PLUGIN_ARCHITECTURE.md#已确认的后台执行方案)。

## 2. 插件清单与注册

清单使用 JSON。以下是结构示例，`coding-primary` 是待实现适配器的逻辑 ID，不表示某个外部执行器已就绪。

```json
{
  "contract_version": 1,
  "id": "caicai.coding",
  "version": "0.1.0",
  "name": "编程助手",
  "description": "在指定项目中检查测试并修复问题",
  "config_schema": {"type": "object", "additionalProperties": false, "properties": {}},
  "agents": [{
    "id": "coding",
    "name": "编程 Agent",
    "description": "检查、修改和验证指定项目",
    "executor_id": "coding-primary",
    "input_schema": {
      "type": "object", "additionalProperties": false,
      "required": ["goal"],
      "properties": {"goal": {"type": "string", "minLength": 1}}
    },
    "required_capabilities": ["filesystem.read", "filesystem.write", "process.exec"],
    "permissions": ["project.read", "project.write", "project.execute"]
  }]
}
```

- `contract_version` 固定为整数 1；未知版本拒绝注册，不猜测兼容。插件自身 `version` 独立保存，执行时记录其版本快照。
- 插件 ID 在注册表内唯一；Agent 的完整 ID 为 `<plugin_id>/<agent_id>`。重复 ID、缺失执行器、无效 schema 或未知能力均报错。
- 配置与启用状态在后端管理；清单不包含真实密钥，也不凭清单中的字符串导入任意 Python 模块。适配器只来自显式登记的本地代码。
- 注册不等于可执行。启用时检查依赖、配置和执行器；每次派发重新检查可用性及所需能力，不就绪时返回明确原因。
- 项目目录由用户选择并在后端登记。模型只能引用已登记项目，不可扩大授权根目录。能力和权限声明用于校验，实际读写、命令和网络边界须由执行器落实；不能约束的必要权限应拒绝派发。

## 3. 执行器适配器

适配器需提供以下五项操作；类型在 M2 用后端 schema 实现。

| 操作 | 输入 | 输出及约束 |
| --- | --- | --- |
| `describe` | 无 | 执行器 ID、名称、实际版本、支持的能力与限制 |
| `check_availability` | 已校验的配置 | `ready`、稳定的原因代码、可展示说明；不能回显凭据 |
| `start` | task / attempt ID、Agent 定义及版本、目标、项目目录、权限、超时配置 | 真实运行引用；启动失败必须区别于未启动，不自动再起一次 |
| `events` | 真实运行引用 | 流式原始进度，经适配器转为下节的事件；执行器断流不能伪装成功 |
| `cancel` | 真实运行引用 | 已送达 / 不支持 / 停止失败；最终是否停止仍需真实进程或执行器终态确认 |

`approval.respond`、`run.query`、`run.resume` 是可选能力，默认不支持。仅对有真实协议的执行器提供适配，不以输入回车、自动同意或重新运行冒充确认、恢复。每次取消只作用于本次运行及其自有子进程，不终止外部共享服务。

首个适配器至少支持项目读写、命令执行、进度、结果和实际取消。其安装版本、启动参数、凭据使用方式、权限边界和真实事件样本须另行记录后验收。

## 4. 数据归属与生命周期

| 实体 | 最小字段 |
| --- | --- |
| Task | ID、关联会话、用户目标、已登记项目及目录快照、Agent / 插件 ID 与版本、状态、创建 / 更新时间、结果摘要 |
| Attempt | ID、task ID、尝试序号、执行器 ID / 版本及配置引用、真实运行引用、状态、开始 / 结束时间、退出码、失败 / 中断原因 |
| Event | task / attempt ID、任务内递增序号、类型、UTC 时间、经脱敏的结构化 payload |
| Artifact | task / attempt ID、产物类型、引用、说明与验证信息；文件需验证仍位于允许目录中 |
| Approval | 仅能力支持时创建：attempt ID、外部确认引用、操作说明、状态、实际回复及时间 |

任务状态固定为 `queued`、`running`、`waiting_confirmation`、`cancelling`、`succeeded`、`failed`、`cancelled`、`interrupted`。

- 创建任务时先完成参数、目录和能力校验；任务与创建事件在同一事务提交。创建请求带幂等键，同一会话重复键返回原任务，输入不同则报冲突。
- worker 以数据库中的原子领取启动一次 Attempt；一个 Task 同时最多一个活跃 Attempt。创建记录与启动外部运行之间的失败应保留可核查状态，禁止盲目重试。
- `queued → running`：成功领取后执行。排队中取消可直接进入 `cancelled`，不启动执行器。
- `running → waiting_confirmation → running`：仅在执行器支持确认时使用；确认请求必须关联本次 Attempt 和真实外部引用。
- 运行中取消先到 `cancelling`，传递取消信号并确认停止后才到 `cancelled`；取消失败保留原因，不单纯改终态。取消与正常完成竞态按实际执行器结果记录，已完成的任务不能被迟到的取消覆盖。
- 正常退出根据实际结果进入 `succeeded` / `failed`；超时请求停止，停止确认后以 `failed` 和 `timeout` 原因结束。无法确认是否停止时进入 `interrupted` 并标明待核查，仍阻止冲突执行。
- 程序重启不自动重放执行中的任务。支持查询时核实外部运行；否则记为 `interrupted`。显式重试新建 Attempt，保留旧记录，并提示可能重复产生副作用。
- 终态不可被迟到事件改写。重试是显式操作，不把失败 Attempt 改回运行中。普通聊天继续使用现有聊天服务，任务执行不长期占用中转站配置锁。

## 5. 事件与界面

事件类型固定为 `task.queued`、`attempt.started`、`progress`、`approval.requested`、`approval.resolved`、`artifact.created`、`cancellation.requested`、`attempt.finished`、`task.finished`。

```json
{
  "task_id": "task-id",
  "attempt_id": "attempt-id",
  "seq": 7,
  "type": "progress",
  "occurred_at": "2026-11-18T08:00:00Z",
  "payload": {"message": "正在运行项目测试"}
}
```

`seq` 在同一任务内跨重试单调递增，先持久化再推送；重连按最后读到的序号补读。UI 按 task / attempt ID 归属显示，旧运行的事件不能覆盖新尝试。首版展示具体步骤和日志，不从 token 数或运行时长编造百分比。

任务卡片至少展示目标、项目、执行器、状态、当前步骤、最近活动时间、阻塞原因、取消入口和结果。事件直接驱动界面；后台模型仅在关键节点或用户询问时按增量信息整理汇报，不逐条解释日志，不反复发送完整历史。详情展示尝试历史、经脱敏的事件、产物与验证结果。聊天状态、任务状态和语音状态分别维护；关闭聊天窗不取消任务，用户进入详情仍能看到等待确认和失败记录。

执行器退出成功只是结果的一部分；交付中需分别呈现它声称做了什么、检测到哪些文件改动、实际运行了哪些检查及检查结果。

## 6. M2 首次验收

在隔离验证项目中派发“检查测试并修复失败问题”，观察真实进度、文件改动与检查结果；重复提交不重复执行。另覆盖排队取消、运行中取消、超时、失败、程序重启中断识别，以及任务进行时正常聊天。窗口收起后继续执行。首个执行器闭环通过后才接第二个插件验证扩展性。

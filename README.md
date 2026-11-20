# 菜菜 Bot

## 后续规划

后台本地音色复刻、试听与聊天音频已实现，接下来推进桌面宠物、任务调度中心与语音输入，微信接入后置。阶段清单与跟进记录见 [桌宠与任务调度中心规划](docs/ROADMAP.md)，实施记录见 [音色复刻方案](docs/VOICE_PLAN.md)，安装操作见 [本地语音使用说明](docs/LOCAL_TTS.md)。

2026-11-17 已确认：桌宠基于 dsh-pet 修改，菜菜采用插件式 Agent 调度架构，通过执行器适配器接入 Codex、DeepSeek Harness 等能力。职责划分、最小插件契约、任务生命周期及实施验收见 [插件式 Agent 调度架构](docs/AGENT_PLUGIN_ARCHITECTURE.md)。M1 已有固定版本的 Mac 桌宠底座、控制面板和正式桌面聊天：复用现有模型配置、流式文字、本地音色和分段播放，按实际生成 / 缓冲 / 出声状态联动气泡与原生动画；关闭聊天窗会收起并保留连接。已支持自动连接或启动 Python 后端、状态提示、显式重试与退出清理，复用的外部后端不随桌宠退出。角色包加载、切换及选择持久化能力保留；临时验证角色已按用户要求移除，不随应用提供。完整人工交互与打包仍待完成。[最小插件契约 v1](docs/PLUGIN_CONTRACT_V1.md) 已定义，DeepSeek Harness 0.2.2-rc.3 / 0.2.2-rc.5 适配、任务中心、聊天显式派发、按需增量汇报及桌面 worker 管理已实现；隔离 Git 项目的失败测试修复与运行中取消已通过真实验收。执行模型与认证沿用 Harness 自己的配置。已接通自然语言自动建任务和任务结束后的一次性语音提醒，执行中关键节点自动汇报与播报已实现，真实桌面任务验收见 [验收记录](docs/DESKTOP_TASK_ACCEPTANCE.md)；Codex 历史原型保留，真实接入后置。启动、角色包接入与验证说明见 [桌面端说明](desktop/README.md)。

聊天设置已移除“回复方式”和“语音表达提示词”控件；选择朗读音色后保存，统一使用文字与语音同步生成，旧纯文字会话也会在保存后切换。已有语音表达提示词继续保留，当前复刻路径暂不传入合成，避免被当成正文念出。“思考与等待语音”支持按会话开关、编辑思考提示语和语音合成等待提示语，并手动“保存并生成提示语音”。两条短句使用当前复刻音色，通过本地 VoxCPM2 合成；每次生成都会删除该会话上一版的两条语音文件和任务记录。进入聊天、发送消息或仅保存设置均不会自动合成提示语音，修改音色或提示语后需要手动重新生成。正式回答开始时立即停止提示。

桌宠改造必须保留 dsh-pet 的动画交互与角色切换能力，并沿用低成本、可快速新增角色的素材制作与接入流程；这是首版要求。已验证额外角色只增加原生素材和配置即可接入；固定上游要求额外角色的 WebM 直接放在 `<种类>-animation/`，详见桌面端说明。

M2 当前状态：DeepSeek Harness 0.2.2-rc.3 / 0.2.2-rc.5 适配、任务中心、聊天显式派发、按需增量汇报及桌面 worker 管理已实现；隔离 Git 项目的失败测试修复与运行中取消已通过真实验收。执行模型与认证沿用 Harness 自己的配置。已接通自然语言自动建任务和任务结束后的一次性语音提醒，执行中关键节点自动汇报与播报已实现，真实桌面任务验收见 [验收记录](docs/DESKTOP_TASK_ACCEPTANCE.md)；Codex 历史原型保留，真实接入后置。使用方式：在“任务中心”登记项目并启用 DeepSeek 插件，在聊天直接说“帮我修复 XX 项目的登录问题并运行测试”即可自动建任务，也可点击“交给菜菜执行”手动派发。项目支持原生文件夹选择及删除登记（保留磁盘文件），已结束任务仅保留近 5 天，中断待核查任务除外。完成后不向聊天写入消息，聊天内隐藏已结束任务卡片；使用已选音色简短播报一次，播完删除音频和语音任务，不显示播放按钮；开启自动朗读后，窗口收起仍继续播报。详情可查步骤、日志、改动和取消；“让菜菜汇报”使用当前会话模型。桌面自启后端托管 worker，外部后端需手动启动 worker。配置与限制见 [Harness 接入](docs/DEEPSEEK_HARNESS.md) 和 [任务运行时](docs/TASK_RUNTIME.md)。

## 浏览器管理页面

新增 frontend 目录，使用 React + TypeScript + Ant Design，可以在网页添加中转站、选择模型、设置角色及测试聊天，无需 Postman。

先按后文启动后端，然后在另一个终端从项目根目录执行：

    cd frontend
    npm ci
    npm run dev

打开 http://127.0.0.1:5173 ，填写 backend/.env 中 ADMIN_TOKEN 的值并连接。先创建会话即可测试模拟回复；使用真实模型时，先配置中转站密钥，再在页面中选择站点和模型并保存。完整说明见 frontend/README.md。

## 后端说明

AI 助手后端。目前完成模型配置、本地文字聊天及本地音色复刻链路，微信接入后置。

已实现：站点创建、查询与删除、页面配置及替换加密密钥、本地聊天记录和会话删除、OpenAI 兼容模型列表及文字对话、会话模型设置、最近 10 轮上下文、消息持久化与去重、管理员鉴权、本地模拟聊天，以及不依赖 debug 接口的正式 desktop 聊天通道。

本轮新增：参考录音上传与管理、VoxCPM2 本地音色复刻、表达提示词试听、聊天音频异步生成与失败重试。

尚未实现：微信扫码登录/底层个人微信协议、真实微信收发验证、ASR、微信原生语音气泡、交互审批和恢复继续。微信部分是本项目自定义 HTTP 桥接契约，没有可直接登录微信的桥接程序，也不声称兼容某个现成协议产品。

## 本地启动

需要 Python 3.11+，在项目根目录执行：

    cd backend
    python3.12 -m venv .venv
    source .venv/bin/activate
    pip install -c constraints.txt -e '.[dev]'
    cp .env.example .env
    python -c 'import secrets; print(secrets.token_urlsafe(32))'

将生成的令牌填写到 .env 的 ADMIN_TOKEN。本机使用时也可以省略生成步骤，设置 `APP_ENV=development` 和 `ADMIN_TOKEN=123456`（本地至少 6 位）；`APP_ENV=production` 仍要求至少 32 位。简单令牌仅用于本机访问，继续绑定 `127.0.0.1`。然后启动：

    uvicorn app.main:create_app --factory --reload --host 127.0.0.1 --port 8000

Python 命令按机器的安装情况替换，版本须满足要求。当前仅支持单进程；不要加 --workers，会话锁在单进程内生效。

接口文档：http://127.0.0.1:8000/docs 。管理接口通过 authorization 参数填写请求头 Bearer <ADMIN_TOKEN>。健康检查为 GET /health。

### 本地音色复刻与聊天语音

本机已部署 VoxCPM2-4bit + MLX-Audio。新机器需 Apple Silicon Mac，推荐 Python 3.12，在项目根目录执行 backend/.venv/bin/python backend/local_tts/setup.py 准备独立环境和约 2.3 GB 模型。推理离线运行，无云端 TTS 调用费。

后台进入“音色与语音”，上传 3～30 秒 WAV/MP3 并生成试听；再到“聊天测试”设置选择朗读音色并保存，回复统一使用文字与语音同步生成。开启顶部“自动朗读”后按段播放，也可手动朗读。当前语气跟随参考录音，自由文本表达提示词暂不参与合成。首次加载较慢，语音失败保留文字，可单独重试音频。详细说明、实测和 API 见 [本地语音文档](docs/LOCAL_TTS.md)。

### 本地模拟聊天

.env 中设置 MOCK_LLM_ENABLED=true，然后依次调用：

1. POST /api/v1/conversations，创建调试会话：

       {"channel":"debug","account_id":"local","peer_id":"me"}

2. 记下返回的 id。
3. POST /api/v1/debug/conversations/{id}/messages：

       {"external_id":"test-001","text":"你好，菜菜"}

4. 得到“模拟回复：你好，菜菜”。相同 external_id 再次提交返回原记录，不重复调用模型。

模拟回答不代表大模型或微信已经连接。APP_ENV=production 时禁用调试入口和接口文档，并拒绝开启模拟模型。

### 接入真实中转站

1. 推荐打开网页「中转站管理 → 添加中转站」，直接填写真实 API Key，无需修改 .env 或重启。也可以通过以下接口创建。
2. POST /api/v1/providers：

       {
         "name": "我的中转站",
         "base_url": "https://你的站点/v1",
         "api_key": "站点提供的真实密钥"
       }

3. GET /api/v1/providers/{id}/models 测试模型列表。
4. PUT /api/v1/conversations/{id}/settings：

       {
         "provider_id": "站点 ID",
         "model_id": "真实模型 ID",
         "reply_mode": "text",
         "system_prompt": "你是菜菜，一个友善自然的聊天助手。"
       }

后端在 base_url 后直接追加 /models 或 /chat/completions，所以站点需要 /v1 时必须填写到 /v1。无法拉取列表时，可直接在会话设置中手动指定 model_id。设置接口为完整替换，未传入字段恢复默认值。

### 删除与密钥保护

- 每轮聊天下方可以删除这一轮提问和回答。聊天右上角「更多」可清空记录或删除测试会话，操作前均有确认。删除的内容不再用于后续模型上下文。
- 中转站可删除或替换密钥。删除站点会解除相关会话的模型绑定，保留聊天记录；需要重新选择模型。为避免已有密钥被转发到其他地址，修改站点地址需删除后重新添加。
- 页面输入的 API Key 使用 Fernet 认证加密后存入数据库。API 不返回明文或密文；页面只显示配置状态，保存或关闭弹窗后清空输入，不写入浏览器存储。
- 本地开发首次保存时自动生成 backend/data/keys/provider.key（文件权限 0600），主密钥独立于数据库且被 Git 忽略。请将主密钥和数据库分开保护及备份；丢失主密钥后需重新填写站点 API Key，不要随意删除或重新生成它。
- 生产环境必须通过 PROVIDER_ENCRYPTION_KEY 配置 Fernet 主密钥，否则无法保存或使用加密的站点密钥。可在受控终端运行 python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())' 生成，并通过秘密管理系统注入；不要放入前端或提交 Git。
- 原有 api_key_env 方式继续兼容，例如 api_key_env=CAICAI_PROVIDER_KEY。页面替换密钥后改用加密存储，但不会删除旧 .env 中的值，需自行移除不再使用的旧密钥。
- 管理接口都要求 ADMIN_TOKEN，响应禁用缓存，校验错误不回显请求值。上游仅允许 HTTPS（本机测试可用 HTTP），禁止自动跟随重定向。服务仅对可信管理员开放；远程部署须为管理页面和 API 配置 HTTPS，并关闭网关请求正文/Authorization 日志。

保护范围：提交时浏览器和对应中转站必然会接触明文，持有后端主密钥的人可以解密数据库，不能承诺绝对不会泄露。请保护电脑、浏览器和 ADMIN_TOKEN，不安装不可信浏览器扩展，不将数据目录或环境文件公开。删除为应用数据删除，不能清除已有备份或上游副本。

删除接口：DELETE /api/v1/providers/{id}、DELETE /api/v1/conversations/{id}/messages/{message_id}、DELETE /api/v1/conversations/{id}/messages、DELETE /api/v1/conversations/{id}。聊天删除支持 debug / desktop 本地会话，不开放微信会话删除。替换密钥使用 PUT /api/v1/providers/{id}/key，请求体为 {"api_key":"新的密钥"}。

当前为单进程保护；同一会话或同一中转站正在请求时，冲突的操作返回 409，稍后重试。

### Responses 协议兼容

默认使用 Chat Completions。仅当站点以 HTTP 400/422 明确提示必须使用 Responses 协议时，自动切换到 Responses 请求，并在当前进程内按站点、地址和模型缓存这一选择。其他错误、超时和连接失败不会自动重复调用。无需更换模型或重建会话。

Responses 适配会保留角色设定及文字历史，从 output 数组中提取助手的 output_text，且发送 store=false。Base URL 只有域名时使用 /v1/responses；已有版本或自定义路径前缀时保留原前缀并追加 /responses。重启后首次请求会重新识别协议。

模型服务错误现在区分 HTTP 状态、认证/权限、额度/限流、超时、网络连接和非 JSON 响应。页面和应用日志不输出密钥或原始上游错误正文。

## 项目结构

    backend/
      app/
        api/routes.py          HTTP、鉴权和输入校验
        core/                  环境配置、业务错误
        integrations/
          llm.py               OpenAI 兼容适配器
          wechat.py            自定义个人微信 HTTP 桥接契约
          local_speech.py      本地语音进程与离线模型调用
        services/speech.py     音色校验、持久化语音任务与清理
        services/chat.py       上下文、模型调用、持久化、投递编排
        db.py                  数据库连接和会话
        models.py              站点、好友会话、消息
        schemas.py             请求和响应类型
        main.py                应用工厂、生命周期
      local_tts/               Mac 独立环境安装、模型 worker、真实验证
      tests/
    compose.yaml

主后端使用 FastAPI + SQLAlchemy + SQLite。业务层不直接依赖个人微信协议库，后续可独立替换桥接程序。语音服务独立接入；当前没有企业微信机器人实现。

## 微信桥接契约（预留）

先验证所选个人微信方案能收发好友文字及原生语音，再实现桥接程序。当前接口不是微信官方回调，也不能直接接入某个未经适配的桥接产品。

1. 创建 channel=wechat_personal 的会话，配置实际 account_id、peer_id 和站点模型。只处理已配置的好友会话，不自动回复未知联系人。
2. 桥接程序收到好友文字后调用 POST /api/v1/channels/wechat-personal/inbound，请求头 Authorization: Bearer <WECHAT_INBOUND_TOKEN>：

       {
         "account_id": "机器人微信账号标识",
         "peer_id": "好友标识",
         "external_id": "原始消息唯一 ID",
         "text": "你好"
       }

3. 生成回答后，后端调用 {WECHAT_BRIDGE_URL}/messages/text，使用 Authorization: Bearer <WECHAT_OUTBOUND_TOKEN>，携带 Idempotency-Key: <内部消息 ID>，请求体包含 account_id、peer_id、text。桥接程序需实现投递和幂等去重，成功返回 2xx。

桥接端必须过滤机器人自己发送的消息和不支持的群聊消息，避免回复循环。入站、出站和管理令牌分别配置。

同一会话处理未结束时返回 409，桥接端应排队后重试。目前同步调用模型和投递，入站请求超时应大于模型超时与投递超时之和。

重复 external_id 总是返回原消息状态，包括失败状态；不自动重新生成或再次投递。delivery_unknown 表示投递结果不确定，需核查，不能直接重发。进程异常退出可能留下 processing/sending 记录，目前没有自动恢复任务。

微信桥接当前仅接受文字消息，微信语音回复仍返回未实现提示；本地后台聊天已支持音色选择及文字 + 语音回复。

## 测试与部署

在 backend 目录激活虚拟环境后：

    pytest -q
    ruff check .

在项目根目录执行 docker compose up --build 启动后端（先填写 backend/.env）。Docker 数据保存在命名卷，本地数据默认位于 backend/data/。Docker 运行需在安装 Docker 的环境另行验证。

启动时为旧数据库幂等补充密钥及语音字段，创建音色和语音任务表，保留已有数据；尚未引入通用迁移框架。多进程部署前需要 Redis 会话锁、任务队列并发协调和发送 outbox。本地 TTS 使用 Mac MLX 独立环境，现有 Docker 镜像不包含该环境；实测与限制见本地语音文档。

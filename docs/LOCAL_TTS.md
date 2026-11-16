# 本地音色复刻使用说明

更新：2026-11-16。已在 Apple M1 Pro / 32 GiB / macOS 26.6.2 / Python 3.12.14 验证。

## 当前能力

后台“音色与语音”支持参考录音上传、删除、原音播放、文字试听和表达提示词；“聊天测试”可选择音色，为回复生成可播放音频。文字先返回，音频在单独队列中生成。语音失败保留文字，重试只重新合成音频，重播复用已有文件。

引擎为 MLX-Audio 0.6.5 + VoxCPM2-4bit，参考音频和表达指令同时传给模型。当前已安装在本机，首次加载按需触发。参考音色是推理时条件，不需要另行训练模型；实际相似度、口音和情绪效果需要用目标录音试听调整，不保证完全复现。

## 安装或迁移

当前实现面向 Apple Silicon Mac；未适配 Windows、Linux 或 Intel Mac。推荐使用已验证的 Python 3.12，系统自带 Python 3.9 不适用。在项目根目录执行：

    cd backend
    .venv/bin/python -m pip install -c constraints.txt -e '.[dev]'
    cd ..
    backend/.venv/bin/python backend/local_tts/setup.py

setup.py 创建 backend/.tts-venv 独立环境，按固定依赖约束安装，并下载约 2.3 GB 模型；首次安装需要网络。已存在的后端环境需先按根 README 建立。模型固定为 mlx-community/VoxCPM2-4bit，revision 为 dc9e5c187858da5f4a13dc4c247e297339216381。

重启原有后端并刷新前端。不要用多个 Uvicorn worker；当前队列并发为 1。首次生成有模型加载和编译开销，可能需数十秒或数分钟。后续模型常驻，实际速度取决于文本、录音与机器负载。

可选环境变量见 backend/.env.example：SPEECH_DATA_DIR、LOCAL_TTS_PYTHON、LOCAL_TTS_MODEL_DIR、LOCAL_TTS_TIMEOUT_SECONDS。默认路径适用于从 backend 目录启动。模型和音色数据位于已被 Git 忽略的 backend/data/tts；独立环境同样被忽略。现有 Docker 镜像不包含 Mac MLX 运行环境。

## 页面使用

1. 打开后台并连接，进入“音色与语音 → 添加音色”。
2. 填写名称，选择 3～30 秒单人、少噪声、无背景音乐的 WAV 或 MP3。使用本人或已获授权的录音。
3. 可填写默认语气，例如“温柔自然，语速稍慢”。“录音文字备注”仅用于记录，当前推理不使用转写。
4. 保存后选择音色，输入要说的话和语音表达提示词，点击“生成试听”，等待后播放。原生播放器支持暂停和拖动进度。
5. 回到“聊天测试”，在设置中选择“文字 + 语音”、音色与表达提示词并保存。聊天回复出现后，音频独立生成，点击播放器收听；已选择音色的会话还可对已有回复点击“用当前音色朗读”。

聊天角色提示词控制回复内容；语音表达提示词控制表达。表达指令与台词分开输入，不会被拼成要朗读的正文。可对比“开心活泼，语气轻快”“平静清晰，自然叙述”等指令；效果取决于模型。

## 限制与数据

- 页面文件上限 20 MB，浏览器在本机转换成单声道 16 kHz / PCM16 WAV，无需 ffmpeg；API 直接上传只接受不超过 10 MB 的 16-bit PCM WAV、1～2 声道、8～48 kHz。
- 一次合成最多 600 字符，表达提示词最多 500 字符。过长聊天回复保留全文并明确提示语音失败，不会偷偷截断；可在试听页分段合成。
- 最多 8 个排队或运行任务；不自动重试合成失败。生成耗时及音频时长写入任务记录。页面重新进入时恢复最近试听任务。
- 运行中任务阻止相关音色/聊天删除。删除音色会删除参考录音与生成文件，并将绑定会话恢复文字回复；聊天文字保留。删除聊天会清理其语音。删除不影响已有备份。
- 服务启动时恢复排队任务，将上次运行中断的任务标为失败，等待手动重试。当前不提供运行中取消。
- 推理强制使用离线模式，语音数据不发送云端 TTS；首次安装下载依赖和模型。聊天文字仍按独立的聊天模型配置调用，聊天模型费用与数据流向不受影响。
- 音频和音色接口要求管理员 Bearer 令牌。前端通过鉴权请求取得 Blob 播放，不将令牌放在音频 URL 中。此项目是单管理员本地应用，没有多用户租户隔离。
- 当前没有语音识别、持续监听、桌宠或微信语音气泡；这些继续按路线图后续实现。

## 验证

常规回归（不需要加载模型）：

    cd backend
    .venv/bin/pytest -q
    .venv/bin/ruff check .

真实本地模型验证（需要已安装模型、Mac GPU，使用临时数据库和官方示例参考录音）：

    cd backend
    .venv/bin/python local_tts/verify.py

结果保存在 backend/data/tts/validation/api-report.json。2026-11-16 验证通过上传 → 试听 → 鉴权获取音频 → 聊天音频 → 重复请求去重 → 删除清理。预热后示例：3.84 秒试听音频耗时 4.605 秒，3.04 秒聊天音频耗时 3.426 秒；这不是固定性能承诺。另经浏览器实际上传、生成和播放验证，3.20 秒音频耗时约 4.0 秒。验证使用官方示例，不代表已评估用户目标音色的主观相似度。

## 接口

全部要求管理员鉴权；任务状态为 queued / running / completed / failed。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/v1/speech/status | 运行环境和模型状态 |
| GET / POST | /api/v1/voices | 列表 / multipart 上传 name、audio、可选 style_prompt、reference_text |
| GET | /api/v1/voices/{id}/reference | 原始参考音频 |
| DELETE | /api/v1/voices/{id} | 删除音色并解除绑定 |
| POST | /api/v1/voices/{id}/previews | text、可选 style_prompt，返回 202 和任务 |
| GET | /api/v1/speech/jobs | 最近 20 条试听任务 |
| GET / DELETE | /api/v1/speech/jobs/{id} | 查询 / 删除已结束任务 |
| GET | /api/v1/speech/jobs/{id}/audio | 已完成音频 |
| POST | /api/v1/conversations/{cid}/messages/{mid}/speech | 只生成或重试该回复的音频 |

会话设置增加 voice_id 和 voice_prompt；reply_mode=both 时自动创建音频任务，消息的 speech_job_id 用于查询进度。重复消息请求复用原记录和语音任务。

## 官方资料

- VoxCPM：https://github.com/OpenBMB/VoxCPM
- MLX-Audio：https://github.com/Blaizzy/mlx-audio
- 已安装模型：https://huggingface.co/mlx-community/VoxCPM2-4bit/tree/dc9e5c187858da5f4a13dc4c247e297339216381

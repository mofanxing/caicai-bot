# 蔡蔡

基于用户于 2026-11-23 提供的透明全身 Q 版人物图制作的独立桌宠角色。
保留深棕卷发、蝴蝶结、大眼睛、奶油白卫衣、灰色短裤和白色球鞋。
这是参考原画的本地二维变形动画版本，不是重新生成的三维角色或逐帧重绘。

## 使用

在项目 `desktop/` 下运行：

```sh
npm run character:caicai
npm start
```

在控制面板选择“蔡蔡 · caicai”，点击“切换形象”。已运行时重新打开或等待面板刷新即可发现。
角色选择沿用原生持久化；初始 `display: none`，安装不改变当前桌宠。
安装器支持项目既有 `CAICAI_DESKTOP_DATA`，以及显式 `DSH_HOME`；不覆盖已存在的配置和素材。

## 动作

十段独立的无声 VP9-alpha WebM，512 × 768、24 fps、每段 2–4 秒。
素材直接放在 `caicai-animation/`，没有额外 `webm/` 子目录。

| 动作 | 联动 |
| --- | --- |
| 待机呼吸 | 默认待机、呼吸、眨眼 |
| 轻轻张望 | 转向、随机小动作 |
| 开心回应 | 点击、完成状态 |
| 开口说话 | 桌面聊天实际出声时 |
| 认真思考 | 桌面聊天生成回复时 |
| 悬空摇摆 | 鼠标拖拽 |
| 轻步移动 | 原生漫游，小幅交替抬脚 |
| 慢慢入睡 | 进入睡眠 |
| 安静小憩 | 睡眠循环 |
| 睡醒啦 | 退出睡眠 |

说话动作是循环开合口型，不是逐音素口型同步。没有配置未制作的动作或原角色专属玩法。
聊天模型、人设与音色继续由既有会话设置管理；这里的人设仅用于原生桌宠碎碎念。

## 播放规则

动作分为自主随机播放与事件触发两类。自主动作播完后会选择下一个动作；点击、拖拽、
聊天和睡眠等状态按各自的规则接管播放，不会把所有素材混在一起随机抽。

当前 `animationWeights` 为 `{ "idle": 24, "turn": 3, "move": 2 }`：

| 自主选择类别 | 每轮概率 | 配置位置 |
| --- | --- | --- |
| 待机 | 24% | `animations.idle` |
| 张望／转向 | 3% | `animations.turn` |
| 移动 | 2% | `animations.moves.actions` |
| 小动作 | 剩余 71% | `animations.categories` |

这里是每次选择的概率，不是播放时间比例，也不是把 24、3、2 再归一化。移动无法执行时
可能回退到小动作；开启实例的 `fixedEnabled` 后，转向与移动的份额归入小动作。
分类内的 `weight` 只控制多个小动作分类之间的相对权重，当前唯一分类的 `weight: 2`
不代表整体播放概率为 2%。候选池有多个动作时随机选择，并尽量避开紧接着重复同一动作。

想更安静，可自行将 `animationWeights` 改成下面这样，使小动作份额降为 10%：

```json
"animationWeights": { "idle": 85, "turn": 3, "move": 2 }
```

事件动作不使用这组自主概率：点击从 `clicks` 中选择，拖拽使用 `drag`，
桌面聊天实际出声使用 `events.whisper[0]`，生成回复时使用 `events.workStatus[0]`。
当前桌面聊天入口在槽位为候选数组时只取第一个有效名字，不支持靠追加候选就随机轮换开场动作。
睡眠按 `sleep` 中同一套 `start → loop → end` 播放。右键“动作”菜单可手动点播已登记的分类动作。

## 自己添加动画

一般只需新增素材、登记动作名并重载，不需要修改桌宠核心代码。以下路径从项目根目录算起，
使用默认数据目录时生效；设置了 `CAICAI_DESKTOP_DATA` 时，将 `desktop/.data` 替换成实际目录。

### 本机立即使用

1. 将新增文件（例如 `挥手.webm`）放进 `desktop/.data/dsh/dsh-pet/pet/caicai-animation/`，
   直接平铺，不要新建 `webm/` 子目录。
2. 编辑 `desktop/.data/dsh/dsh-pet/pet/caicai-config.json`。如果想随机播放挥手，
   找到 `animations.categories` 中“蔡蔡的小动作”这一项，修改为：

   ```json
   {
     "id": "蔡蔡的小动作",
     "weight": 2,
     "actions": ["开心回应", "轻轻张望", "挥手"]
   }
   ```

   这是分类项的示例，只替换该项，不要用它覆盖整个配置文件。
3. 保存后右键蔡蔡，选择“重载配置”。这会按新配置重建桌宠窗口。

只放文件不登记，不会自动参与播放。配置里的名字不带 `.webm`，必须和文件名完全一致。
同一动作可以登记到多个位置；按用途选择：

| 触发场景 | 修改位置 |
| --- | --- |
| 自主随机小动作、右键分类动作 | `animations.categories[].actions` |
| 待机 | `animations.idle` |
| 点击 | `animations.clicks` |
| 拖拽 | `animations.drag` |
| 移动 | `animations.moves.actions`，元素形如 `{ "name": "动作名" }` |
| 聊天说话 | `animations.events.whisper[0]` |
| 聊天思考 | `animations.events.workStatus[0]` |
| 入睡／睡眠循环／醒来 | `animations.sleep[].start`／`loop`／`end` |

素材需为带真实透明通道的 VP9-alpha WebM。建议匹配现有 512 × 768、24 fps 的画布，
保持人物大小和脚底位置一致，循环动作的首尾尽量衔接。普通 MP4 改后缀不等于透明 WebM。
替换同名素材前先备份，替换后同样重载配置。

### 同步进项目和远程仓库

本机 `.data/` 不入 Git。希望在新机器重新安装时也有新增动作，需要同时维护源包：

- 把视频加入 `desktop/characters/caicai/caicai-animation/`。
- 把同样的动作登记写入 `desktop/characters/caicai/caicai-config.json`。
- 在 `desktop/` 运行 `npm test`，检查原生配置、已登记素材和安装兼容性。
  检查按配置动态收集动作名，新增动画无需手动修改固定数量断言。

`npm run character:caicai` 只补充缺失文件，不覆盖已有配置或同名视频。
因此源包修改后，对已经安装过的机器仍需手动同步对应素材和 `animations` 字段，再重载。
保留本机的 `pets`（尤其 `display`、位置和尺寸）及其他个性化字段，
不要整份覆盖成本来用于首次安装的 `display: none` 配置。

## 素材与再制作

- `caicai-character.png`：用户提供的原始 RGBA 图片，未覆盖或修改原下载文件。
- `caicai-config.json`：原生角色包配置，实例 ID 和素材前缀均为 `caicai`，显示名为“蔡蔡”。
- `caicai-preview.png`：待机、说话、睡眠的静态对照，底色仅用于预览。
- `animate.py`：本地生成脚本；只读原画，不调用图像模型或付费 API。

重新制作需要 Python 3.9+、Pillow、NumPy 和 imageio-ffmpeg：

```sh
python3 -m venv desktop/.cache/character-tools
desktop/.cache/character-tools/bin/pip install pillow numpy imageio-ffmpeg
desktop/.cache/character-tools/bin/python desktop/characters/caicai/animate.py
```

上述重制命令从项目根目录运行。生成器只更新本目录的动画及预览；安装器不覆盖已安装文件，
因此重制后如需更新本机素材，应先备份再手动复制对应 WebM，不要删除自己的角色配置。

原图文件名：`jimeng-2026-11-23-5760-用这张照片帮我生成背景透明，全身照的Q版人物照片.png`。
形象及原图的权利归属沿用用户提供素材的授权，未推定为公共领域、MIT 或上游角色的 CC 许可。

## 2026-11-23 验证

- 桌面构建及 28 项测试通过，包含原生配置读取、十段素材完整性、安装及再次安装保留配置。
- 十段 WebM 经 VP9-alpha 解码各抽查三帧：透明和半透明像素存在、画面有变化、人物未触及画布边缘。
- 使用独立临时数据目录启动真实 Electron：控制面板发现两个角色，蔡蔡独立窗口加载成功，
  待机与拖拽素材 URL 指向本角色目录，渲染错误为零，原生多级动作菜单加载通过。
- 既有合成鼠标验收仍有两项 warning：松手位置采样及拖拽期间的穿透强制状态，需人工检查手感。
  本轮不更改上游拖拽逻辑，也不把此结果视为完整交互验收。
- 验收关闭后端自动启动；不调用真实模型或 TTS。说话／思考动作沿用现有聊天状态映射，
  未进行本角色的真人麦克风、真实音色及逐音素口型同步验收。

## 2026-11-24 文档与回归

- 补充自主播放概率、事件触发、手动增加动画、重载及源包与本机配置的同步说明。
- 素材完整性检查按配置动态收集动作，不再固定为十段，后续可以继续扩展。
- 桌面构建及 28 项测试通过，生成脚本 Python 语法检查和 Git 差异格式检查通过。
  本次未重复执行 Electron 交互或真实模型／TTS 验收，相关边界沿用上一节记录。

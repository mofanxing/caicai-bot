# 菜菜桌面端 · M1 第一阶段

已固定并集成 dsh-pet 0.4.9，提交 `fb38ce620576f5ed3735a99536d2b1a4a9eb313f`。
本阶段交付桌宠底座及控制面板；正式桌面聊天、语音状态联动、Python 服务自动启动与打包发布仍在后续 M1 范围。

## 启动

需要 Node.js >= 22.12.0、Git 和 Electron。当前 Mac 已有 Electron 43.3.0，启动器默认复用 `~/.dsh/electron/Electron.app/Contents/MacOS/Electron`。其他位置通过 `CAICAI_ELECTRON_PATH` 指定可执行文件；本项目不会自动替换已有 Electron。

从项目根目录执行：

```sh
cd desktop
npm ci
npm run setup
npm run build
npm start
```

`setup` 将固定提交下载到 `.cache/upstream`，不跟踪移动的 main 分支；`build` 校验提交及缓存工作区后构建共享动画核心和菜菜入口，复制运行时及素材，不复制展示用预览 GIF。缓存有本地改动时拒绝构建。

首次启动显示桌宠及控制面板。关闭面板后桌宠继续常驻；Cmd + 点击桌宠，或右键选择“打开网站”，可重新打开控制面板。托盘可以隐藏/显示角色或退出应用。退出关闭桌宠自己的本机服务，不关闭手动启动的 FastAPI 或 Vite。

控制面板可选择形象、查看后端状态并打开现有工作台。后端和网页仍按根 README 分别启动，默认地址为 `http://127.0.0.1:8000` 和 `http://127.0.0.1:5173`。通过 `CAICAI_BACKEND_URL`、`CAICAI_WORKBENCH_URL` 可覆盖，仅接受本机 HTTP origin。控制面板不读取管理令牌或模型密钥。

## 数据与角色包

默认数据在 `.data/`，通过 `CAICAI_DESKTOP_DATA` 可修改。桌面端使用独立 DSH_HOME 和 Chromium profile，不改写 `~/.dsh/dsh-pet` 的已有配置。`.cache/`、`.data/`、`dist/` 和依赖均不入 Git。沿用固定上游的角色格式：

```text
.data/dsh/dsh-pet/
  main-config.jsonc                 默认角色及全局偏好
  main-animation/webm/             默认角色的自定义素材（可选）
  pet/
    my-pet-config.json             新角色配置，也支持 .jsonc
    my-pet-character.png           参考图（可选）
    my-pet-animation/webm/         透明 VP9-alpha WebM 动画
      <动作名>.webm
```

新增角色只需素材与配置：

1. 按上游角色包格式准备 `<种类>-config.json(c)` 和对应动画目录，给 `pets[]` 实例设置全局唯一 `id`、显示名 `name`，首次安装建议 `display: "none"`。
2. 配置里的动画名须与对应 `.webm` 文件名一致，沿用上游完整动画配置结构；不要直接继承默认形象的动作名却缺少相应素材。
3. 将文件放进上述 `pet/`，保留该角色的作者、来源与许可说明。
4. 重新打开控制面板即可发现角色，选择后点击“切换形象”。上游 `/pet-display` 写回对应配置文件并重建窗口，重启继续按保存的 display 显示。

切换仅修改桌面显示位，保留浏览器显示位，不改聊天、人设、音色或任务。托盘保留上游多开能力。配置、物理、动作链、菜单和角色素材查找均复用上游。

当前只有默认角色完成实际画面验证；测试中的第二角色是配置夹具，不计作第二个独立授权形象。两个真实角色切换、新角色素材加载验收仍待完成。

低成本制作流程见固定缓存中的 `MAKE-YOUR-OWN-PET.md` 和 `CONFIG.md`：参考图 → 绿幕动作视频 → 抠像与归一化 → VP9-alpha WebM → 原生角色配置。不要求 Live2D，不需要修改菜菜或桌宠核心代码。

## 检查

```sh
npm test
npm run smoke
```

`test` 先构建，验证本机地址约束、角色切换规则、原生包发现、配置保存后重新读取及自定义字段保留。

`smoke` 启动真实 Electron，检查控制面板、鉴权、无效角色拒绝、角色读取、配置加载、动画节点及多级菜单，截图后自动退出。报告和截图在 `.data/smoke.json`、`.data/smoke.png`、`.data/control.png`。

基础检查失败返回非零；上游合成鼠标事件的拖拽/穿透断言单独记录 warnings。有 warning 不表示完整交互验收完成。当前仅验证单显示器；实际鼠标拖拽、拖拽中穿透、多显示器与休眠唤醒仍需人工回归。

2026-11-17 本机结果：6 项自动化测试通过；真实 Electron 基础检查通过，控制面板和默认动画可用。上游合成鼠标自检仍有“松手位置采样不一致”和“拖拽中穿透”两项 warning，已保留在检查报告中。

## 与上游的边界

- 上游源码保持原样；通过独立入口复用 host、standalone context 和 Electron helper。
- 构建副本只调整 helper 的 userData 路径，防止与上游抢 Chromium profile；共享动画核心从固定源码构建。
- 控制面板使用独立隔离 session，避免与 file 渲染页的鉴权注入冲突。
- 现阶段不另存模型配置、不调用上游云端语音；原生对话明确提示尚未接通，已有聊天及音色功能继续在菜菜工作台使用。
- 默认形象为非商业授权素材；代码 MIT 与素材许可分别遵守，见 THIRD_PARTY_NOTICES.md。

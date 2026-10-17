# dsh-opencode-bridge

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里使用
**OpenCode Zen 的免费模型**。

不是在 HTTP 层伪造客户端标识，而是**在本机跑一个真实的、隔离的 opencode 运行时**，
再由一个原生 `LlmAdapter` 把它的免费模型接进 DSH 的模型选择器。

```
DSH Agent Loop
   │  LlmAdapter（本插件）
   ▼
隔离的 opencode serve（独立 XDG、随机本地密码、permission=ask）
   │  真实 CLI 身份
   ▼
https://opencode.ai/zen/v1
```

## 为什么必须这样

OpenCode Zen 的免费层只认真实的 OpenCode 客户端流量；改 User-Agent 或请求头会被
`403 FreeTierError` 拒绝。本插件因此不碰协议伪装，而是：

1. 首次启动自动下载官方 opencode 运行时（npm 官方包，sha512 校验，版本 ≥ 1.18.0）；
2. 在隔离的数据目录里拉起 `opencode serve`，只转发常规系统/网络环境变量；
3. 把所有本地工具审批一律拒绝，动作交回 DSH 执行——**运行时在本机不会执行任何命令**；
4. 把运行时当前免费（输入/输出/缓存全部为 0）的模型注册成 `opencode-bridge` provider。

## 安装

```sh
dsh plugin --profile <profile> add github:aiignite/dsh-opencode-bridge
```

或手动链接（开发用）：把本目录链接进 profile 的 `node_modules`，并在 profile
`package.json` 的 `dsh.profile.bundles` 里追加 `dsh-opencode-bridge`。

首次启动会下载约 60–180 MB 的运行时，之后复用。重启 DSH 后，模型选择器里会出现
**OpenCode 免费模型** 分组（provider id `opencode-bridge`）。

## 设置页

设置 → **OpenCode 桥**：运行状态、免费模型数、运行时版本、已运行时长、最近错误与
模型清单，每 5 秒刷新。数据来自同源端点 `GET /api/opencode-bridge/status`。

## 配置

写在 profile 的 `cordis.patch.yml`（或该行的 config）：

```yaml
- id: opencode-bridge
  name: dsh-opencode-bridge
  config:
    dataDir: 'D:\dsh-data\opencode-bridge'   # 运行时、日志、状态目录
    binaryPath: 'C:\path\to\opencode.exe'    # 已有二进制时跳过下载
    images: false                            # 见「已知限制」
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `<DSH_HOME>/opencode-bridge` | 运行时与日志目录 |
| `binaryPath` | 自动下载 | 指定现成的 opencode 可执行文件 |
| `images` | `false` | 图片转 base64 转发（当前上游会 400） |

运行状态写在 `<dataDir>/status.json`，运行时日志在 `<dataDir>/bridge.log`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 首次启动一直停在“正在下载 OpenCode” | 直接下载在部分网络下会卡住：用 `config.binaryPath` 指向已有的 `opencode.exe`，或手动放到 `<dataDir>/runtime/<版本>/opencode.exe` 后重启 |
| 模型选择器里没有分组 | 重启 DSH；设置页需要刷新一次页面才会出现 |
| 设置页显示“异常” | 看 `<dataDir>/bridge.log` 末尾与 `status.json` 的 `lastError` |
| 所有免费模型都报 429 | 上游匿名额度限流，稍后重试或换网络出口 |

## 已知限制

- **没有逐字流式输出。** 每次调用要求模型通过结构化信封一次性返回最终答复；
  事件流里只有 reasoning 和工具前闲聊是逐字的。真正的答案流式需要把桥改成
  native tool calling 架构，属于后续方向。
- **图片输入默认关闭。** 转换链路已实现（attachments → base64 data URL → opencode
  file part），但实测 opencode 1.19.3 + Zen 免费通道返回 `HTTP 400 BadRequest`，
  官方 `opencode run -f` 同样失败，属于上游限制。
- **文件附件不转发**，只保留占位文本。
- 免费额度受上游限流影响，所有免费模型共用同一条匿名额度。

## 安全

- 运行时使用独立 XDG 根与随机本地密码，不读取、不写入用户自己的 opencode 配置与凭据。
- 运行时被配置为「每个操作都要审批」，插件拒绝全部审批，模型无法在本机执行动作。
- 插件只与 `127.0.0.1` 上的本地运行时通信；免费通道不需要任何密钥。
- `config.yaml` 之类的本地凭据不属于本仓库，也不会被读取。

## 开发

```
index.js              Host 插件：运行时生命周期、LlmAdapter、状态路由
client.js             Client 插件：设置页「OpenCode 桥」
cordis.patch.yml      注册插件行
lib/runtime.js        找到/下载 opencode，拉起隔离的 opencode serve
lib/backend.js        一次推理：会话、消息、审批拦截、信封解码
lib/protocol.js       OpenAI 请求 ↔ JSON 信封的双向转换与校验
lib/handoff.js        被拒绝的本地动作 → 外部工具调用
lib/model-id.js       模型 id 匹配
lib/reasoning.js      推理档位映射
locale/*.json         插件展示元数据
```

## 许可与致谢

MIT。`lib/` 下的运行时与协议层复用自
[dsh-opencode-xdbridge](https://github.com/XDTrees/dsh-opencode-xdbridge)（MIT），
详见 [NOTICE.md](./NOTICE.md)；OpenCode Zen 的免费通道由
[OpenCode](https://opencode.ai) 提供。

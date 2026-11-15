<p align="center"><img src="brand/banner.png" alt="Yumeiro · 团队共用的 AI 助手"></p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933">
  <img alt="docker" src="https://img.shields.io/badge/deploy-Docker%20%7C%20%E7%9B%B4%E8%A3%85-2496ED">
  <img alt="clients" src="https://img.shields.io/badge/clients-Web%20%7C%20Windows%20%7C%20Android%20%7C%20iOS%20%7C%20macOS-8A2BE2">
</p>

> **Powered by Yumeiro**  
> 使用 Cindy、Dash黄一孟 的项目进行制作 · 制作者：BYL  
> 以 Apache License 2.0 开源；使用、修改、分发请保留署名与许可证。 详见 [`LICENSE`](./LICENSE)、[`NOTICE`](./NOTICE) 与 [`商业化声明.md`](./商业化声明.md)。

# Yumeiro · 团队共用的 AI 助手

**一台服务器，一个团队，人人都能用 AI。** 自托管的私有 AI 工作空间：管理员给成员开账号、分额度，大家在网页、电脑和手机上共用同一套对话、智能体和技能。

独立实现的自托管网页应用（与官方 Cindy 产品无隶属关系）：管理员（主账号）+ 团队成员、持久化对话、流式回复、智能体、OpenAI 兼容 API、按成员的用量统计与月度额度。数据存 PostgreSQL（可回退到加密 JSON 文件），用 Docker 部署。它不是官方 Cindy 桌面客户端的服务器版，不能复用 Cindy 客户端登录会话。

## ✨ 特色

| | |
|---|---|
| 👥 **团队共用** | 管理员 + 成员、每人独立对话、按成员的用量统计和每日/每月额度 |
| 💬 **对话** | 流式回复、Markdown、附件（文字自动提取）、语音和图片理解 |
| 🤖 **智能体 / 技能 / MCP** | 自定义智能体、技能工坊与市场、MCP 服务（仅管理员开启） |
| 🔌 **模型** | 兼容 OpenAI 接口，可接自己的模型服务，也可绑定 Cindy 账号使用托管模型 |
| 🖥️ **多端客户端** | 网页 · Windows · Android（原生）· iPhone / iPad / Mac（SwiftUI 源码），以及桌宠 |
| 🛡️ **自己的数据** | 数据在你自己的服务器：PostgreSQL（可回退到加密 JSON），密钥分目录保存，Docker 或直装都行 |

## 🚀 快速开始

```sh
unzip Yumeiro-<版本>.zip && cd Yumeiro
chmod +x install.sh && ./install.sh     # 向导式配置，结束后按提示 docker compose up -d --build
```

详细步骤见下面的「一、安装」和 [`安装说明.md`](./安装说明.md)；没有 Docker 请看 [`非Docker安装说明.md`](./非Docker安装说明.md)；日常用法见 [`使用说明.md`](./使用说明.md)。

## 📦 客户端

| 平台 | 位置 |
|---|---|
| 网页 / PWA | 服务器自带，浏览器直接打开 |
| Windows | `clients/windows/`（Electron），安装版 + 便携版 |
| Android | `clients/android-native/`（Kotlin / Compose） |
| iPhone / iPad / Mac | `clients/apple/`（SwiftUI，需在 Mac 上用 Xcode 编译） |

## 📄 许可与署名

以 [Apache License 2.0](./LICENSE) 开源，使用、修改、分发（包括商用）请保留署名和许可证。第三方声明见 [`NOTICE`](./NOTICE)，关于 Cindy 在线服务条款和美术素材的提醒见 [`商业化声明.md`](./商业化声明.md)。

## 一、安装（华为云 / 任意 Linux + Docker）

前置：Docker Engine 与 Compose 插件。把整个目录上传到服务器后：

```sh
chmod +x install.sh
./install.sh
```

向导会依次询问并写好配置（`.env` 不含任何密码，密钥全部在 `secrets/`）：

1. **访问方式与端口**
   - ① 域名 + 自动 HTTPS（Caddy，占用 80/443；国内服务器的域名需 ICP 备案）
   - ② IP:端口 HTTP 直连（**自选端口**；明文传输，仅建议内网/测试）
   - ③ **自选端口**，前面已有 HTTPS（华为云 ELB / WAF / Nginx）
   选 ②③ 时会校验端口范围并提示是否被占用，并提醒在华为云**安全组**放行该端口。
2. **数据库**：内置 PostgreSQL 容器（默认）/ 外部 PostgreSQL（如华为云 RDS，内网地址 + 账号 + 可选 SSL）/ 仅 JSON 文件。
3. **管理员邮箱与密码**：至少 16 字符、输两次确认；直接回车则自动生成强密码并只显示一次。
4. **模型服务**：MODEL_BASE_URL（必须 https）、模型名、API Key（不回显）；可跳过稍后再配。
5. **服务器位置**：在大陆则用 npmmirror 加速构建，并提示配置华为云 SWR 镜像加速。

完成后可选择立即 `docker compose up -d --build`。首次登录成功后运行：

```sh
./install.sh scrub-admin     # 清空服务器上保存的管理员初始密码文件
```

其他命令：`./install.sh --reconfigure`（重新配置，备份旧 .env；**已有的加密密钥和数据库密码不会被重写**）、`--no-start`（只生成配置）。

**无人值守安装**：`YUMEIRO_NONINTERACTIVE=1` 加环境变量 `YUMEIRO_MODE`(1/2/3)、`YUMEIRO_PORT`、`YUMEIRO_DOMAIN`、`YUMEIRO_DB`(1/2/3)、`YUMEIRO_PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD/PGSSL`、`YUMEIRO_ADMIN_EMAIL`、`YUMEIRO_ADMIN_PASSWORD`、`YUMEIRO_MODEL_BASE_URL/MODEL_NAME/MODEL_API_KEY`、`YUMEIRO_CN`、`YUMEIRO_START`。

> **必须备份 `secrets/store_encryption_key`**：所有数据（JSON 与 PostgreSQL）都用它加密，丢失后无法恢复。数据库本身另按常规备份（内置库：`docker compose exec postgres pg_dump -U yumeiro yumeiro > backup.sql`）。

## 二、存储：PostgreSQL 与 JSON 回退

- `STORAGE=auto`（默认）：配置了 `DATABASE_URL` 或 `PGHOST` 就用 PostgreSQL，否则用 JSON。也可显式设为 `postgres` / `json`。
- **每个实体一行**（用户、会话、对话、令牌、智能体、用量统计、用量明细……），内容为 AES-256-GCM 密文（AAD 绑定 kind:id，行不能被互换）；只有 id、类型、所属用户是明文。拿到数据库备份而没有密钥无法读出内容；换错密钥启动会明确报错。
- 保存时只写有变化的行，整批在一个事务里；某次写入失败，下次保存会自动补写。
- **单实例**：数据缓存在应用内存，用数据库咨询锁防止两个实例同时写同一个库，不要横向扩容。
- **自动迁移**：切到 PostgreSQL 的第一次启动，若库是空的且存在 `data/store.json`，会在一个事务里整体导入；原文件保留并备份为 `store.json.pre-postgres.bak`。
- **JSON 镜像**（`JSON_MIRROR`，PostgreSQL 模式默认 true）：每次保存同时写一份加密的 `store.json`，随时可切回。性能敏感可设为 false。
- **回退到 JSON**：停止应用 → 设 `STORAGE=json` → 启动。镜像开着时 store.json 是最新的；没开则先运行 `export-json`。
- **维护命令**（先停应用，它占用单实例锁；容器内：`docker compose run --rm --no-deps yumeiro node scripts/db.mjs <命令>`）：
  - `status`：查看存储配置与两边数据量
  - `migrate [--force]`：JSON → PostgreSQL（库非空须 `--force`，会先清空）
  - `export-json [--force]`：PostgreSQL → store.json（已有文件须 `--force`，会先备份）
- 没有做“PostgreSQL 连不上时自动改用 JSON”：那会让两份数据悄悄分叉。需要回退请按上面手动切换。
- 外部库（华为云 RDS）需要事先建好数据库和账号，程序会自己建表。

## 三、配置项

| 变量 | 说明 |
| --- | --- |
| `APP_PORT` / `APP_BIND` | 宿主机发布端口 / 绑定地址（安装向导设置；域名模式绑定 127.0.0.1） |
| `COOKIE_SECURE` | HTTPS 为 true；HTTP 直连为 false |
| `TRUST_PROXY` | 前面有反向代理为 true；**直接暴露端口必须 false**，否则 X-Forwarded-For 可被伪造绕过限流/IP 白名单 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_FILE` | 仅在库里没有任何账号时用于创建管理员（也可用 `ADMIN_PASSWORD`） |
| `MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY_FILE` | 模型服务；https（本机回环地址可用 http 方便测试） |
| `MODEL_EXTRA_NAMES` | 额外允许成员/智能体/API 使用的模型，逗号分隔 |
| `MODEL_SYSTEM_PROMPT` / `MODEL_CONTEXT_MESSAGES` / `MODEL_TIMEOUT_MS` | 默认系统提示词 / 携带历史条数(2-100) / 超时 |
| `QUOTA_WARN_PERCENT` | 用量提醒线，50–99，默认 80 |
| `PGHOST` `PGPORT` `PGUSER` `PGDATABASE` `PGPASSWORD_FILE` `PGSSLMODE` `DATABASE_URL` | PostgreSQL 连接；`PG_SSL_REJECT_UNAUTHORIZED=false` 可接受自签证书 |
| `NODE_IMAGE` `POSTGRES_IMAGE` `CADDY_IMAGE` `NPM_REGISTRY` | 镜像与依赖源，国内可换成加速地址 |

本地开发（不用 Docker）：Node 22+，`npm install`，参考 `.env.example` 设置环境变量后 `node server.mjs`；`COOKIE_SECURE=false` 用于 HTTP。

## 四、功能

**团队账号**：`.env` 的 ADMIN_EMAIL 是主账号。顶栏 ⌘ →「团队成员」添加成员（邮箱 + ≥12 位密码 + 额度），可停用、重置密码、删除（同时清除其对话、令牌、智能体、统计）。成员只能看到自己的内容，停用/改密立即踢出会话。

**智能体**：系统提示词 + 模型。成员建私有的，主账号可设为全员共享；顶栏下拉选择后用于新对话；API 中用 `agent:<ID>`。

**AI 接入（服务商模板）**：主账号在 ⌘ →「AI 接入」添加服务商。内置模板：OpenAI（ChatGPT API）、Anthropic、Google Gemini、DeepSeek、Moonshot（Kimi）、阿里云百炼（通义）、智谱、火山方舟（豆包）、百度千帆、腾讯混元、硅基流动、OpenRouter、Groq、Mistral、xAI、Ollama，以及“自定义”（任何 OpenAI 兼容服务，含 vLLM、LM Studio、华为云 ModelArts 等）。选模板会预填接口地址（以服务商官方文档为准，可改），再填 API Key，点“拉取模型”自动列出可用模型（也可手填；部分服务不提供模型列表），“测试对话接口”会发一次 1 token 的请求验证密钥和模型名。
- 模型引用名：环境变量里的内置模型保持原名（向后兼容）；接入的服务商用 `标识/模型名`，如 `deepseek/deepseek-chat`。顶栏下拉可为新对话选择模型，智能体可绑定模型，`/v1` API 的 `model` 字段同样使用这些名字。优先级：智能体绑定 > 对话选择 > 主账号设置的默认模型。
- 每个服务商可单独停用，或设为“仅主账号可用”（成员看不到也调不了）。删除/停用后，用到它的智能体和对话自动改用默认模型。
- 密钥加密保存在数据库里，API 只回传掩码；编辑时留空表示保持原密钥。接口地址必须是 https；仅本机/内网地址（localhost、10.x、172.16–31.x、192.168.x、host.docker.internal、单段主机名）允许 http，链路本地地址（169.254.x.x）一律拒绝。服务商之间的计费、限流和隐私政策各自独立，请自行确认。
- 现有 MODEL_BASE_URL 等环境变量继续有效，显示为“内置”服务商。

**OpenAI 兼容 API**：在「API 令牌」创建 `ymr_…` 令牌（仅显示一次，服务器只存哈希）：

```sh
curl https://你的域名/v1/chat/completions -H "Authorization: Bearer ymr_..." -H "Content-Type: application/json" \
  -d '{"model":"agent:<智能体ID>","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

`GET /v1/models` 列出模型与智能体；支持 `stream`；每令牌 60 次/分钟；API 调用不保存对话内容，只记用量。

**用量与额度**：按成员 → 月/日累计（调用数、输入/输出/总 Token、按模型、按来源）。额度（0=不限）：每日调用、每月调用、每月 Token，网页与 API 共用，超额返回 429（`quota_exceeded`）。⌘ →「用量」查看；主账号可按月查看全员。口径：服务器本地时区；Token 取自模型服务商返回值，未返回的只计次数；Token 额度可能被最后一次调用略微超出；主账号自身无额度。

**用量提醒**：任一额度达到 `QUOTA_WARN_PERCENT`（默认 80%）时网页顶栏下方出现黄色提醒条，用尽变红色，可关闭一次（升级到“已用尽”会再次出现）。API 响应头 `X-Yumeiro-Quota-Warning: monthlyCalls=85%`（流式响应反映调用前的用量）。只提醒成员本人，无邮件/推送。

**对话**：流式回复（SSE，可中途停止，已生成部分会保存）、双击重命名、同一对话互斥生成。

**登录与绑定 Cindy 账号**：首页只有本站账号（主账号/成员）的邮箱密码登录，没有任何 Cindy 登录入口，也没有 `/api-login` 页面。登录后在 ⌘ →「Cindy 账号」绑定：一个本站账号最多绑 5 个 Cindy 账号（国服手机号验证码、国际服邮箱验证码，或官方放行时的第三方登录），同一个 Cindy 账号只能绑给一个本站账号，可随时解绑（服务器同时删除授权令牌）。绑定的授权令牌加密保存，页面和 API 都不回传。**模型/智能体切换**在输入框左下角。

**第三方登录与国际服验证的限制（官方服务决定，不是本站能改的）**：
- Google / Apple / 微信登录：官方认证服务只允许“已登记的回调地址”。我们实测 `https://你的域名/api/cindy/callback` 会被官方以 `INVALID_REDIRECT_URI` 拒绝。页面会自动探测，被拒时隐藏这些按钮并显示需要登记的地址；只要 Cindy 官方日后放行，按钮会自动出现。可用的绑定方式是验证码。
- 国际服的邮箱验证码要通过 Cloudflare Turnstile，站点密钥属于 Cindy。在本机 127.0.0.1 上组件能通过，但官方接口仍返回 `CAPTCHA_INVALID`；在你的公网域名上是否可用没有验证过。失败时页面会明确提示并重置验证组件。国服手机号验证码不需要这一步。
- 之前社交登录的跨站回调 cookie 用了 SameSite=Strict（浏览器会丢弃），已改为 Lax。

**智能体引擎（Claude Code / Codex / Pi）**：安装向导第 5 步可选装“运行器”容器（`runner/`，Debian + 三个命令行工具，非 root、丢弃全部 Linux 能力、只读根文件系统、限制内存/CPU/进程数；与应用共用内部网络 agentnet，访问不到 PostgreSQL，也不挂载任何应用密钥）。应用只通过内部地址 + 令牌调用它；每次调用临时传入模型密钥（只允许 *_API_KEY / *_BASE_URL / *_TOKEN 这类变量）。管理员在 ⌘ →「智能体引擎」为每个引擎设置密钥、默认模型、是否启用、是否允许团队成员、权限上限：
- **只读**：Claude Code 仅 Read/Grep/Glob，Codex `-s read-only`，Pi 仅 read/grep/find/ls；
- **可读写工作区文件**：Claude Code `acceptEdits` 且禁用 Bash，Codex `workspace-write`，Pi 去掉 bash。**没有任何模式开放任意 shell 命令**，也没有 `danger-full-access`；
- 成员请求的模式超过上限时自动降到上限。引擎默认全部关闭。

**工作区与多智能体协作**：⌘ →「工作区」。工作区有创建者和成员（按邮箱添加）、一个共享文件目录（在运行器卷里，网页可浏览/上传/读取，路径越界和符号链接逃逸都会被拒绝）和协作记录（每个工作区保留最近 30 条）。协作方式：
- **接力**：按顺序，后一位看到前面所有产出，最后一位的产出是结果；
- **圆桌讨论**：轮流发言 1–4 轮，最后一位综合出结论；
- **主管调度**：第一位是主管，每步输出 JSON 指派成员或 FINISH；非法 JSON 会重试一次，仍失败则以原文结束（状态 `bad_decision`），步数有上限。
参与者可以是“模型智能体”（你在“智能体”里建的提示词 + 模型，也可直接用默认模型）或“引擎”（Claude Code / Codex / Pi）。过程实时显示、可中途停止，每次发言都计入调用额度和用量（来源“工作区”，引擎的 Token 若 CLI 未返回则只计次数）。每人同时最多 2 个协作任务。

## 五、本地桥接（Cindy 原本的智能体）

`bridge/yumeiro-bridge.mjs` 在**你自己的电脑**上运行：

```sh
YUMEIRO_TEAM_URL=https://你的域名 YUMEIRO_TEAM_TOKEN=ymr_... node bridge/yumeiro-bridge.mjs --port=8788
```

本机 `http://127.0.0.1:8788/v1` 同时提供 `team:<模型或 agent:ID>`（转发到团队服务器）和 `cindy:<模型ID>`（调用本机 Cindy 桌面端的“本机 Agent API v1”，首次需在 Cindy 里点允许）。默认 client-only，`--native` 才开放文件/命令能力。只监听回环地址并拒绝带 Origin 的请求。服务器无法直接访问你电脑上的 Cindy（其接口只监听 127.0.0.1），所以只能经桥接使用。

## 六、安全与边界

- 密码用 scrypt 哈希；会话 cookie HttpOnly + SameSite=Strict（HTTPS 时 Secure）；写请求校验来源与 CSRF；登录失败限流；管理员 IP 允许列表；API 令牌只存哈希。
- 静态加密保护的是“只拿到数据库/备份/磁盘”的情况；应用运行时数据在内存中解密，有服务器 root 或应用进程权限的人仍能读取。模型请求会把消息明文发给你配置的模型服务。不是端到端加密。
- Cindy 官方账号登录（`auth-extra.js`）依赖官方认证服务，**没有联网验证过**；不要从桌面端导出 refresh token 或复制凭据库。
- 当前是单实例设计；PostgreSQL 解决的是持久化与备份，不是横向扩容。

## 七、测试

`npm test`（Node 22+）：启动真实服务与模拟模型，覆盖登录、CSRF、对话、流式、团队、API、额度与提醒、JSON→PostgreSQL 迁移与回退、`scripts/db.mjs`。PostgreSQL 测试使用 devDependency `embedded-postgres` 启动真实 PostgreSQL。**运行器与真实的 Claude Code / Codex / Pi 没有联调过**：命令行参数已对照本机 `--help` 核对（claude 2.1.132、codex 0.164.0、pi 0.73.1），测试用模拟 CLI 验证了参数、环境变量隔离、解析和超时；Codex 的 JSON 事件格式与 Pi 的服务商密钥变量名没有用真实模型验证，首次使用请先在“工作区”里跑一个只读小任务。**Docker 镜像构建、`docker compose` 编排和 `install.sh` 的真实启动流程没有在本机测过**（本机没有 Docker）；安装脚本的配置生成用模拟 docker 验证过。

## 更新记录

完整的版本更新记录在 [`CHANGELOG.md`](./CHANGELOG.md)。

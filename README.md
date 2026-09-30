# LingSpark · 灵光

![LingSpark](docs/assets/readme-banner.png)

**给 AI 代理写的中文文档，装一道"编译器"。**

让 Claude Code、Codex 这类代理写需求文档、技术方案、汇报材料时，它每写完一个文件，lingspark 就自动检查一遍：数字前后对不上、说"三点"只列了两点、引用了不存在的章节、空话套话、指代不明……发现问题就退回去让代理改，改完才算交稿。

> 状态：**v0.1 预览版**。确定性检查和 Claude Code 接入已在真实环境使用；其余代理按官方文档适配、尚未实测。见[现状](#现状)。

[English summary](#english-summary)

```
结束之前，lingspark 在 docs/退货流程优化.md 中还有 2 个问题需要处理：

1. 第 3 行 [D111] 正文说「有三点」，但下面的列表有 2 项。建议：把数字改成实际的项数，或者补齐列表。
2. 第 9 行 [S204] 这段主要是空话套话，读者得不到具体信息。建议：写清楚具体做什么、做到什么程度、怎么衡量。
```

## 为什么需要它

让模型"写完自己检查一遍"并不可靠：写的和查的是同一个模型、同一段上下文，它很容易认可自己刚写的东西。lingspark 把检查放到代理**外面**，而且把"这段写得好不好"这种开放问题，拆成大量可以设门槛、可以重复的封闭问题：

- **确定性检查**（不调用任何模型，毫秒级）：数值前后不一致、计数不符、悬空引用、占位符残留、必备章节缺失……
- **语义检查**（逐段问模型"是/否"）：这段有没有指代不明的代词？有没有用"因此"引出一个前面找不到依据的结论？——每个问题都有明确的判断标准、反例清单和置信度门槛，模型把握不够时不报。

这个思路受 TypeSafe AI 的 [Jev](https://docs.typesafe.ai/api) 启发：不让模型写评语，只让它回答带概率的封闭问题。

## 它怎么接进代理

lingspark 以 **hook** 的形式挂在代理上，代理不需要"记得"调用它：

1. 代理每写完一个文件 → lingspark 跑快速检查，把错误告诉代理（不打断它）。
2. 代理准备结束这一轮回答 → lingspark 跑完整检查（含语义检查）。还有错误就拦住，要求先改。

同一个问题只提醒一次；代理认为是误报时，要向用户说明理由，不能自己加注释绕过。所有环节**出错时一律放行**：lingspark 自己坏了，绝不会卡住你的代理。

| 代理 | 支持程度 |
|---|---|
| Claude Code、Codex、Cursor、WorkBuddy | ✅ 支持，一键接入。Codex 需要在 Codex 里用 `/hooks` 信任一次 |

只支持这四个。其他代理（Qoder、CodeBuddy、Trae 等）不会被自动接入。

## 安装

从 [Releases](https://github.com/rytesdd/lingspark/releases) 下载：

| 平台 | 客户端（推荐） | 命令行版 |
|---|---|---|
| **Mac**（Apple 芯片） | `lingspark-…-mac-arm64.dmg`，拖进"应用程序" | `lingspark-macos-arm64` |
| **Windows**（x64） | `lingspark-…-win-x64-setup.exe`，双击安装 | `lingspark.exe` |
| **Linux**（x64） | `lingspark_…_amd64.deb`（Debian/Ubuntu/Mint）或 `lingspark-…-linux-x64.tar.gz`（其他发行版） | 同名不带后缀的文件 |

三个平台的客户端都**不自带浏览器内核**，装好只占约 100MB，绝大部分是检查程序自己的运行环境。
Mac 的窗口用系统自带的网页组件；Windows 和 Linux 用系统自带的 Edge / Chromium 的"应用窗口"
（没有 Chromium 时退回默认浏览器）。

**第一次打开**：预览版都没有做代码签名。

- **Mac**：点"完成"（不要点"移到废纸篓"），然后到"系统设置 → 隐私与安全性"，在"安全性"一栏点"仍要打开"并输入开机密码。macOS 15 起右键 →"打开"已经不能跳过这一步。
- **Windows**：双击安装程序，在"Windows 防护"弹窗里点"更多信息"→"仍要运行"。
- **Linux**：用 `sudo apt install ./lingspark_…_amd64.deb` 安装，或解压 tar.gz 后按里面的《安装说明.md》做；都是本地文件，不会触发签名检查。

也可以从源码构建（需要 Node 22+ 和 pnpm 9；每个平台在自己的系统上构建）：

```bash
pnpm install && pnpm run build:sea          # 命令行版：packages/cli/sea/lingspark
pnpm run build:client                       # Mac 客户端（要装 Xcode 命令行工具）
pnpm run build:client:win                   # Windows 安装程序（要装 NSIS）
pnpm run build:client:linux                 # Linux 的 .deb 和 .tar.gz（要装 dpkg-deb）
```

构建客户端之前先关掉正在运行的客户端：Windows 上 `packages/cli/sea/lingspark.exe`
既是命令行版也是客户端（D-074），双击它会开配置页，而 Windows 不允许覆盖一个正在
运行的程序——构建会直接失败并告诉你关掉它。

## 快速开始

图文版的完整步骤和演示视频见 [使用指南网站](https://rytesdd.github.io/lingspark/)。

下载后，两种方式任选一种，都是一步配好：自动找到你电脑上装过的代理并把检查接进去。之后代理写的每一篇
Markdown 文档都会被检查，不用选文件夹。

**方式一：客户端**。打开 LingSpark：

1. 打开首页的开关
2. 按提示重新打开你的代理（Codex 还要在里面输入 `/hooks` 信任一次）

**方式二：一条命令**。在项目文件夹里运行：

```bash
./lingspark setup
```

配好之后**新开一个代理会话**（代理只在会话开始时读取设置），照常让它写文档就行。

**也可以让代理帮你装**，把下面这段话发给它：

> 帮我安装 lingspark：从 https://github.com/rytesdd/lingspark/releases 下载适合我电脑的版本，然后在当前项目里运行 `lingspark setup`，把输出告诉我。

随时可以用 `lingspark doctor` 自检，用 `lingspark check <文件>` 手动检查一篇文档。

<details>
<summary>手动配置（进阶）</summary>

- 只装某一个代理：`lingspark install --agent claude-code`（`--dry-run` 只看改动不写入；原配置会先备份）
- 代理写出的 Markdown 文档都会检查，不用选文件夹；代理自己的记忆、计划和指令文件（`CLAUDE.md`、`AGENTS.md`、`.claude/`、`.codex/`、`.cursor/` 等）除外。
- 想只查某些目录、或者给文档分类型，在项目里放一个 `.lingspark/config.yaml`：

```yaml
# .lingspark/config.yaml
version: 1
include: ["docs/**/*.md"]      # 默认是全部 Markdown
doc_types:
  "docs/prd/**": prd          # 需求文档会检查必备章节
  "docs/design/**": tech-design
```

- install 和 setup 都会把 lingspark 复制到数据目录，hook 运行的是那一份，所以之后移动或删除下载的文件都不影响。

</details>

## 语义检查：谁来审

空话、指代不明、两篇文档说法矛盾这类问题，要读懂意思才判断得了。默认的做法是**对话内自审**：Agent 一轮结束时，LingSpark 把审稿标准（每条规则的是非题和"哪些不算"）发给正在写文档的这个 Agent，它自己审一遍，有把握的直接改，拿不准的问你，最后交一份简短的结果。不用登录，不用另装模型，四家代理装上就能用。

代价是审的人就是写的人。想要更客观，可以改成在后台另起一个模型来审（`auto`：谁写谁审，另起一个同款 Agent；或指定下表里的某一个）。在**用户级配置**里改：

用户级配置位置：`~/Library/Application Support/lingspark/config.yaml`

```yaml
judge:
  backend: session   # 默认：对话内自审
```

| backend | 说明 | 需要 |
|---|---|---|
| `session` | 对话内自审（默认） | 不需要任何东西 |
| `auto` | 后台另起一个同款 Agent 审：Codex 写的由 Codex 审，Claude Code 写的由 Claude Code 审 | 那个 Agent 的命令行能在后台登录使用；Codex 直接可用 |
| `codex-cli` | 借用本机已登录的 Codex（ChatGPT 订阅即可） | Codex 命令行，或 macOS 上的 ChatGPT 桌面版 |
| `agent-cli` | 借用本机已登录的 Claude Code | 在终端里登录过的 `claude` 命令行 |
| `anthropic` | Claude API，默认 Claude Haiku 4.5 | `ANTHROPIC_API_KEY` |
| `openai-compatible` | 任何兼容 OpenAI 的接口，包括国产模型和本机的 Ollama | `judge.endpoint`、`judge.model`，远程接口需要 `OPENAI_API_KEY` 或 `OPENROUTER_API_KEY` |
| `typesafe` | Jev API | `TYPESAFE_API_KEY` |

API key 也可以放在数据目录的 `credentials.yaml` 里。后台借用本机代理的方式比较慢（每个问题十几到几十秒），所以只在代理结束一轮时跑，写文件时不跑；问过的段落会缓存，不重复问。

**评测不同模型**：每条语义规则都带有正反例，可以横向比较：

```bash
./lingspark eval --backend codex-cli --backend anthropic:claude-sonnet-5
```

## 隐私

- **只读代理写出的文档**。代理写了哪个 Markdown 文件就检查哪个，不会去扫你电脑上的其他文件；代理自己的记忆和指令文件不读。跨文档比对也只在同一次会话写的文档之间进行。
- **确定性检查完全在本机**。只有语义检查会把段落发给你选定的模型服务。
- **出站记录**：每次发出的请求都记在数据目录的 `logs/outbound.jsonl`，只记哈希和字节数，不记正文和 key。
- **离线模式**：`offline: true` 时，只有本机地址（如 Ollama）能被调用，其余一律在发出前拦下。
- **项目配置不能改请求发往哪里**：`judge.endpoint` 和 `judge.command` 只认用户级配置。这样克隆一个不可信的仓库，也不会把你的文档和 key 发到它指定的地方。
- `lingspark mine` 会读取代理的会话记录来挖掘你的修改意见，只在你手动运行时才读。

## 规则

| 编号 | 规则 | 级别 | 方式 |
|---|---|---|---|
| D101 | 数值不一致 | error | 确定性 |
| D102 | 术语不一致 | warning | 确定性 |
| D103 | 悬空引用 | error | 确定性 |
| D104 | 必备章节缺失 | error | 确定性 |
| D105 | 标题层级跳跃 | warning | 确定性 |
| D106 | 中英文标点混用 | warning | 确定性 |
| D108 | 占位符残留 | error | 确定性 |
| D109 | 重复段落 | warning | 确定性 |
| D110 | 空章节 | warning | 确定性 |
| D111 | 计数不符 | error | 确定性 |
| S201 | 指代不明 | warning | 语义 |
| S202 | 句子成分残缺导致歧义 | warning | 语义 |
| S203 | 翻译腔、欧化句式 | warning | 语义 |
| S204 | 空话套话 | warning | 语义 |
| S205 | 段落内自相矛盾 | error | 语义 |
| S206 | 主语或话题中途偷换 | warning | 语义 |
| S207 | 结论没有依据 | warning | 语义 |
| S208 | AI 腔修辞 | info | 语义 |
| S209 | 章节内容与标题不符 | warning | 语义 |

规则都是 YAML（`packages/rules-builtin/rules/`），每条带至少 5 个正例和 5 个"看起来像但其实不是"的反例，这些例子同时是自动测试。语义规则上线的门槛是：**反例零误报、正例召回不低于 60%**，达不到的只以影子规则运行。

个别地方不想被检查时，可以用注释关掉：`<!-- lingspark-disable-next-line D101 -->`；整篇文档关掉，在 frontmatter 里写 `lingspark: false`。

## 现状

**已完成**：确定性检查、语义检查、五种模型后端、缓存与离线模式、Claude Code / Codex / Cursor / WorkBuddy 的 hook 安装与自检、对话内自审、Mac / Windows / Linux 客户端、模型横向评测、会话记录挖掘（Claude Code）。

**还没做**：
- 周报与自动回测：从你的修改意见里总结出候选规则，回测后交你审核上线
- 自动更新、macOS 签名与公证、代码签名（三个平台都没签）、Intel Mac

欢迎提 issue 和 PR，尤其是：你在真实文档里遇到的误报（附一段脱敏后的原文）、新代理的 hook 接入实测。

## 开发

```bash
pnpm install
pnpm run ci          # lint + typecheck + test
pnpm run build:sea   # 单文件程序
pnpm run build:client        # Mac 客户端
pnpm run build:client:win    # Windows 安装程序
pnpm run build:client:linux  # Linux 的 .deb 和 .tar.gz
```

客户端是三个平台各打各的：Node 单文件程序不能交叉编译（D-025），所以每个平台在自己的
runner 或自己的机器上构建，`release.yml` 就是按这个排的。

`DECISIONS.md` 记录了主要的设计决策和理由。语义规则的测试回放的是 `packages/rules-builtin/fixtures/replay/` 里录好的模型回答，CI 不联网；改了语义规则后用 `lingspark eval --record` 重录。

## 致谢

- [Jev](https://docs.typesafe.ai/api)（TypeSafe AI）：封闭问题加概率的判定思路
- [Sniff Test](https://github.com/DanRWilloughby/snifftest)：规则里 `what` / `not_for` 的写法
- [jev-mcp](https://github.com/jkudish/jev-mcp)、[open-alternative-jev](https://github.com/ikermoel/open-alternative-jev)
- 客户端里的思考动画来自 [thinking-orbs](https://www.npmjs.com/package/thinking-orbs)（MIT，© Jakub Antalik），打包在 `packages/core/src/ui/orb.generated.ts`，原许可证随代码保留。

## 许可证

[Apache License 2.0](LICENSE)。可以免费使用、修改、商用；再分发本软件或基于它的作品时，须按协议第 4 条保留 [NOTICE](NOTICE) 里的署名。

---

## English summary

**LingSpark** (灵光, "a flash of inspiration") is a linter for Chinese Markdown documents written by AI coding agents (Claude Code, Codex, Cursor and WorkBuddy). It installs as an agent hook (`lingspark setup`, or double-click it for a setup page): after the agent writes a document, lingspark checks it and, if there are errors, blocks the agent from finishing its turn until they are fixed.

- **Deterministic rules** (no model calls): inconsistent numbers, "three points" followed by a two-item list, dangling references, leftover placeholders, missing required sections, and more.
- **Semantic rules**: each paragraph is judged with closed yes/no questions (ambiguous pronouns, empty buzzwords, conclusions without support, content not matching its heading), with explicit criteria, counter-examples and a confidence threshold. Pluggable backends: your signed-in Codex or Claude Code CLI, the Claude API, any OpenAI-compatible endpoint (including local Ollama), or Jev.
- **Checks what the agent writes, nothing else**: every Markdown file an agent writes, wherever it is, minus the agent's own memory and instruction files; cross-document checks compare the documents written in the same session. A project can narrow the scope with `.lingspark/config.yaml`.
- **Fail-open** everywhere, offline mode, and an outbound log that records hashes and sizes only.

Status: v0.1 preview. User-facing messages are in Chinese. Licensed under Apache 2.0; redistributions must keep the attribution in NOTICE.

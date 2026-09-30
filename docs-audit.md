# 文档 × 代码一致性排查（2026-09-30）

> **更新**：第二节 A/B/C/D 四项已经 Alex 确认并全部处理完毕（见文末"四"），此文档留作记录，确认后可以删除。

针对当前工作区一批未提交的改动（收敛 e2e / Windows 客户端 / hook 自检 / 存在性证据，即 DECISIONS D-076 ~ D-082）做的核对。
结论分两部分：**已清理**（我已直接改掉的）和**待你排查**（已处理，原文保留备查）。文末附"已核实一致"清单。

---

## 一、已清理

### 1. 注释引用不存在的决策编号 D-079（16 处）

代码里所有 "配置目录存在 ≠ agent 在" 的注释都写的是 **D-079**，但 DECISIONS.md 里根本没有 D-079——
D-078 之后直接跳到 D-080，而这组改动实际记录在 **D-081**（"配置目录存在不等于这个 agent 在"）。

已统一改为 D-081，涉及 6 个文件 14 处：

| 文件 | 处数 |
|---|---|
| `packages/core/src/agents.ts` | 3 |
| `packages/core/src/setup.ts` | 3 |
| `packages/core/src/setup.test.ts` | 4 |
| `packages/core/src/doctor.ts` | 1 |
| `packages/core/src/doctor.test.ts` | 1 |
| `packages/core/src/setup-page.ts` | 2 |

验证：`tsc --noEmit` 通过，setup/doctor 共 38 个测试通过。

注意：`packages/core/dist/index.d.ts` 里还有 3 处 D-079，那是构建产物，下次 `pnpm run build` 会重新生成，不要手改。

---

## 二、待你排查（已于当日全部处理完毕）

### A. DECISIONS.md 编号断档：D-079 永远空缺 — ✅ 已补占位

上面把注释对齐到了 D-081，但编号本身跳号了。两个选择：

1. 接受跳号（开发中删过一条草稿决策，正常）；
2. 在 D-078 和 D-080 之间补一行占位，如 `### D-079 ·（编号预留/并入 D-081）`，让"按编号找决策"的人不会扑空。

**处理结果**：按选项 2，在 D-078 与 D-080 之间补了 `### D-079 ·（编号预留）` 条目，说明内容并入 D-081。

### B. README「规则」表缺 G301（跨文档说法矛盾）— ✅ 已补行

`packages/rules-builtin/rules/G301.yaml` 是 `status: active`、`severity: error`、judge 类（第 3 遍跨文档），
但 README.md 的「规则」表只列了 D101–D111 和 S201–S209，没有 G301。
对照：D107（ retired ）没列出是合理的；G301 是 active 的 error 级规则，用户读 README 会不知道有这道检查。

**处理结果**：在规则表末尾补了 G301 一行，并注明"只比对同一次会话写的文档"。

### C. README 用户级配置路径只写了 macOS — ✅ 已补三平台

README.md「语义检查：谁来审」一节写：

> 用户级配置位置：`~/Library/Application Support/lingspark/config.yaml`

但 `paths.ts` 的 `dataDir()` 三分平台：

- macOS：`~/Library/Application Support/lingspark/`
- Windows：`%APPDATA%\lingspark\`
- Linux：`$XDG_DATA_HOME/lingspark/`（默认 `~/.local/share/lingspark/`）

Windows/Linux 用户照 README 找会找不到文件。

**处理结果**：改为三分平台列表（macOS / Windows / Linux + XDG）。

### D. "单测"现在包含收敛 e2e，AGENTS.md 没有说 — ✅ 已补说明

`vitest.config.ts` 的 include 是 `packages/*/src/**/*.test.ts`，涵盖 `e2e/converge.test.ts`；
converge.test.ts 头部注释也明说"`pnpm run test` runs this"（刻意设计，让收敛测试进 CI 当回归闸门）。
所以：

- AGENTS.md 写的"单测：`pnpm run test`（Vitest，packages/*/src/**/*.test.ts）"字面对，但读者会以为跑的是纯单测；
- `test:converge` 脚本（`vitest run packages/core/src/e2e`）与 `test` 是包含关系，前者只在做基线重生成时才有独立价值；
- 每次 `pnpm run test` / CI 都会跑一遍多轮收敛场景，耗时相应增加。

**处理结果**：确认是有意为之（D-076 的本意），在 AGENTS.md「Testing instructions」单测条下补了一句说明（含 glob 包含 e2e、比纯单测慢、是回归闸门、`test:converge` 的用途）。

---

## 三、已核实一致（不用再查）

| 声明 | 出处 | 核实结果 |
|---|---|---|
| `test:converge` 脚本存在，`test:scripts` 含 win-shell 测试 | AGENTS.md / package.json | ✓ package.json 已定义 |
| 收敛 e2e 在 `packages/core/src/e2e/`，基线 `baseline.ts` | AGENTS.md（D-076） | ✓ 四文件齐全，场景 `expectRules` 预言机存在 |
| Windows 客户端 = C#/WebView2，`src/win/`，系统 csc.exe，不装 SDK | AGENTS.md / README（D-080） | ✓ `LingSpark.cs`、`app.manifest`、`webview2.mjs` 齐全，注释自洽 |
| 客户端装在 `%LOCALAPPDATA%\Programs\LingSpark\client\LingSpark.exe`，命令行版在上一层 | README / D-080 | ✓ `installer.mjs`、`build-windows.mjs` 一致 |
| `build:client:win` 需要 NSIS，客户端本体用 csc.exe | AGENTS.md / README | ✓ ci.yml 里 Windows runner 确实 `choco install nsis` |
| hook 自检（琥珀/红两态、只自检 waiting 的 agent、临时数据目录） | D-077 | ✓ `hook/probe.ts`、`setup.ts`、`setup-page.ts`、`messages.probe`、`PROBE_TIMEOUT_MS` 全部对应 |
| `judge.backend: session` 在 doctor 里报 ok 而非 fail | D-078 | ✓ `doctor.ts:checkJudge` 有专门分支 |
| `installBinary` 覆盖失败继续用旧副本（warn），只有没有副本才失败 | D-077 | ✓ `install.ts` 实现与描述一致 |
| 存在性证据：app 名用 `/` 写、按平台拆路径；只给 Cursor/WorkBuddy 填；Claude/Codex 不填 | D-081 | ✓ `agents.ts` 两处 `installedWhen` 与描述一致 |
| doctor 对"目录在、程序不在"的 agent 多打一行 warn | D-081 | ✓ `doctor.ts` + `messages.programFor/programNotFound` |
| AGENTS.md 对 desktop 三分平台的描述（Mac 外壳 / Win 外壳 / Linux 无外壳） | AGENTS.md | ✓ 与 D-074/D-080/D-081 无冲突 |
| CI 禁网 `LINGSPARK_NO_NETWORK=1` | AGENTS.md | ✓ ci.yml env 已设 |
| hook-probe 的 `captured.jsonl` 不入库 | tools/hook-probe/README | ✓ 目录里只有 probe.mjs / summarize.mjs |
| `.lingspark-scratch/`（WebView2 缓存） | D-080 | ✓ 已在 .gitignore |
| README 规则表中列出的规则编号与 `rules/*.yaml` 一致 | README | ✓（除上面 B 条遗漏的 G301；D107 retired 未列出合理） |
| 源码注释里的 "section N / 第 N 节 / 开发文档" 引用 | 约 30 处 | ✓ 有意为之：D-001 说开发文档留在仓库外上一层当参照，这些锚点指向它，不是死链 |

---

## 四、处理记录

1. **B（README 补 G301）和 C（补配置路径）**——✅ 已完成；
2. **A（D-079 占位）**——✅ 已补；
3. **D（AGENTS.md 补一句）**——✅ 已完成。

以上均为文档改动，不涉及代码；代码侧仅第一节的注释编号修正（已过 typecheck 与相关单测）。

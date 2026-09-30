# AGENTS.md

LingSpark（灵光）—— 给 AI 编码代理写的中文 Markdown 文档的"编译器"。
代理每写完一篇文档，hook 自动检查（数字一致性、悬空引用、AI 腔、指代不明、跨文档矛盾……），
有 error 就拦住、不放行这一轮。详见 [README.md](README.md) 与 [DECISIONS.md](DECISIONS.md)。

支持 Claude Code / Codex / Cursor / WorkBuddy 的 hook 接入。
用户级配置优先，判定后端（语义判定模型）的 endpoint / command 不接受项目配置里给的值。

## Setup commands

- Install deps: `pnpm install`
- Run all checks: `pnpm run ci`        # lint + typecheck + test + 图标编解码自测
- Lint:          `pnpm run lint`       # eslint .
- Typecheck:     `pnpm run typecheck`  # tsc -p tsconfig.json --noEmit
- Test:          `pnpm run test`       # vitest run（另见 pnpm run test:scripts）
- Build:         `pnpm run build`      # rules-builtin → core → cli，顺序不可调换
- 单文件可执行:  `pnpm run build:sea`  # 输出在 packages/cli/sea/
- Mac 客户端:     `pnpm run build:client`        # 需要 dmgbuild
- Windows 客户端:  `pnpm run build:client:win`    # 需要 NSIS（makensis）
- Linux 客户端:    `pnpm run build:client:linux`  # 需要 dpkg-deb

需要 Node ≥ 22、pnpm 9.15.0（仓库 `packageManager` 字段已锁定）。
CI 设了 `LINGSPARK_NO_NETWORK=1`：任何测试都不准访问真实网络，回放测试只能读
`packages/rules-builtin/fixtures/replay/` 下的录音。本机开发也不要破这条。

## Project layout

- `packages/core`            — 解析器、规则加载、判定后端、hook 适配、miner、install 逻辑
- `packages/cli`            — CLI 入口，`lingspark` 命令；可打成 Node SEA 单文件二进制
- `packages/desktop`        — 三个平台的客户端外壳：Mac 是 Swift/WKWebView 小程序，Windows 和 Linux
                              不用外壳，程序本身双击就是客户端（D-074）。产物在 `release/<平台>/`，
                              各平台一个目录，互不覆盖
- `packages/rules-builtin`  — YAML 规则源（`rules/*.yaml`），构建期内联为 `generated/rules.ts`
- `examples/demo`           — 端到端演示：让 Claude Code 故意写一篇有 bug 的文档
- `tools/hook-probe`        — 探针：核实某个代理的 hook 实际传什么字段（接新代理时用）
- `tools/corpus`            — 规则语料批跑
- `tools/pass3-eval`        — 跨文档检查评测
- `tools/orb`, `tools/video` — 资源生成
- `docs/`                   — 用户文档站点（GitHub Pages）
- `DECISIONS.md`            — 设计决策和理由；遇到拿不准的问题先来这里

- TypeScript strict + `noUncheckedIndexedAccess` / `verbatimModuleSyntax` / `isolatedModules`
  （`tsconfig.base.json`）；ESM 全栈（`"type": "module"`、`module: NodeNext`）
- ESLint flat config + typescript-eslint 类型感知（经典 project 模式），根 `tsconfig.json` 覆盖
  源码和测试；`*.mjs` 单独一组（只做语法检查，不带类型信息，因为它们在 tsconfig 之外）
- `@typescript-eslint/no-explicit-any` 是 `error`：要写 `any` 必须先在注释里写明理由
- 单一类型导入：`consistent-type-imports: error`
- 解析器、配置校验、规则都不在 hook 的冷启动路径上：CLI 入口只静态引用常量和文案
  （见 `packages/cli/src/lingspark.ts`）

## Testing instructions

- 单测：`pnpm run test`（Vitest，`packages/*/src/**/*.test.ts`）
- 端到端示例：`examples/demo/` 里有手把手指引，用 `lingspark install --agent claude-code --dry-run`
  接入，再开一个 Claude Code 会话让它按脚本写文档
- 跨文档检查评测：`node tools/pass3-eval/run.mjs`
- 接入新代理前，先用 `node tools/hook-probe/probe.mjs` 抓一次真实字段，把结论写进
  `DECISIONS.md`，再去 `packages/core/src/agents.ts` 把它的 `verification` 升级为 `docs`
- 新增行为必须有测试；改语义规则后用 `lingspark eval --record` 重录并提交到
  `packages/rules-builtin/fixtures/replay/<后端>/`
- **必须** 在 `pnpm run ci` 全绿之后才提 PR

## 设计铁律（来自 DECISIONS.md；新增决策请追加，不要写在分散的文档里）

- **出错一律放行（fail-open）。** lingspark 自己崩了，绝不卡住代理——这是产品底线
- **判定 endpoint / command 只认用户级配置。** 项目配置里写了也忽略；理由：克隆一个不可信
  仓库，不能让它把请求和 API key 转发到自己的服务器
- **只读代理写出的 Markdown。** 代理的指令文件（`CLAUDE.md`、`AGENTS.md`、`.claude/`、
  `.codex/`、`.cursor/` 等）一律不读、不检查
- **跨文档比对只在同一次会话写的文档之间进行。** 不扫项目历史
- **每条规则都带正反例。** 语义规则上线门槛：反例零误报、正例召回 ≥ 60%；达不到的转
  `shadow`（照跑、记日志、不提示）
- **hook 的实际命令指向复制到数据目录里的副本**（不是 `packages/cli/dist/`），重建不影响

## PR & commit conventions

- 从 `main` 拉分支；不要直接往 `main` 推
- Conventional commits：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`
- 一个机器查询文件多个独立改动拆 PR；设计决策改动要同步追加到 `DECISIONS.md`
- 重大改动前先开 issue 讨论，避免大 PR 直接落地

## Security & privacy

- 许可证：Apache 2.0；再分发必须保留 [NOTICE](NOTICE) 里的署名（见 LICENSE 第 4 条）
- 不提交秘密：`.env`、API key 不入库；测试只用回放录音，不连真服务
- 数据目录可由 `LINGSPARK_DATA_DIR` 覆盖（测试用它隔离，优先级最高）
- 出站请求每次记一行 `logs/outbound.jsonl`：哈希 + 字节数，不记正文、不记 key
- `offline: true` 时只允许访问本机地址（如 Ollama），其余请求在发出前拦下
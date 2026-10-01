/**
 * Every string a user or an agent ever sees (design doc, section 0.6).
 *
 * Logic modules must not contain user-facing Chinese text; they call into
 * here. This is not about i18n -- internationalisation is out of scope -- it
 * is so the wording can be reviewed and tuned in one place, because the
 * wording of a diagnostic is what decides whether a user trusts the tool.
 *
 * Linguistic *data* is a different thing and stays with the rules that use
 * it: Chinese numerals, units, copulas, section keywords. Those are what a
 * rule reads, not what it says.
 */

import { PROBE_TIMEOUT_MS } from './constants.js';

export const msg = {
  config: {
    unsupportedVersion: (got: unknown, want: number) =>
      `配置文件的 version 是 ${String(got)}，本版本只支持 ${want}。`,
    invalid: (file: string, detail: string) => `配置文件 ${file} 不合法：${detail}`,
    unreadable: (file: string, detail: string) => `读不了配置文件 ${file}：${detail}`,
    credentialInProject: (file: string, key: string) =>
      `项目配置 ${file} 里出现了凭据字段 "${key}"。` +
      `项目配置会进版本库，绝不能放 API key。请把它移到用户级的 credentials.yaml 或环境变量里。` +
      `在移走之前，lingspark 不会加载这个项目的配置。`,
    projectOnlyKeyInUserConfig: (key: string) =>
      `用户级配置里的 "${key}" 被忽略了：这个字段描述的是某个项目的布局，只能写在项目配置里。`,
    userOnlyKeyInProjectConfig: (key: string) =>
      `项目配置里的 "${key}" 被忽略了：这个字段只能写在用户级配置里。`,
    endpointInProject: (field: string) =>
      `项目配置里的 ${field} 被忽略了：文档和 API key 发往哪里、运行哪个程序，只能由你自己的用户级配置决定，不能由随仓库下载来的项目配置决定。`,
    /** Stands in for an empty zod issue path. */
    root: '(根)',
  },

  rules: {
    notYaml: (file: string, detail: string) => `规则文件 ${file} 不是合法的 YAML，已跳过：${detail}`,
    invalid: (file: string, detail: string) => `规则文件 ${file} 不合法，已跳过：${detail}`,
    originMismatch: (id: string, declared: string, actual: string) =>
      `规则 ${id} 声明 origin 为 ${declared}，但它来自 ${actual} 层。以所在层为准。`,
    reservedPrefix: (id: string, file: string) =>
      `规则 ${id}（${file}）占用了内置号段。` +
      `团队规则请用 T 前缀，个人规则请用 P 前缀，否则将来可能和内置规则撞号。`,
    missingImpl: (id: string, impl: string) => `规则 ${id} 的 impl "${impl}" 没有对应的实现，已跳过。`,
    threw: (id: string, detail: string) => `规则 ${id} 运行时出错，已跳过：${detail}`,
    duplicateImpl: (name: string) => `确定性规则实现重名：${name}`,
    glossaryInvalid: (file: string, detail: string) => `术语表 ${file} 不合法，已忽略：${detail}`,
    glossaryUnparsable: (file: string, detail: string) =>
      `术语表 ${file} 解析失败，已忽略：${detail}`,
    exampleNeedsJudge: '判定类规则的 examples 需要判定器，见 M2',
    exampleImplMissing: (impl: string) => `impl "${impl}" 没有注册`,
    exampleThrew: (detail: string) => `规则抛出异常：${detail}`,
    exampleNoAnswer: '判定器没有给出这道题的回答',

    /** zod messages: shown when a rule author's YAML is invalid. */
    schema: {
      choiceTooMany: 'choice 的 criteria 最多 255 个选项',
      idShape: 'id 形如 D101、S201、T-0001、P-0007',
      judgeNeedsQuestion: 'kind 为 judge 的规则必须有 question',
      deterministicNeedsImpl: 'kind 为 deterministic 的规则必须有 impl',
      deterministicNoQuestion: 'kind 为 deterministic 的规则不应有 question',
    },
  },

  /** Fragments that rules splice into their YAML message templates. */
  diag: {
    sectionRef: (n: string) => `第 ${n} 节`,
    tableRef: (n: string) => `表 ${n}`,
    figureRef: (n: string) => `图 ${n}`,
    punctuationInBlock: (n: number) => `，本段共 ${String(n)} 处`,
    punctuationInDocument: (blocks: number, n: number) =>
      `，全文 ${String(blocks)} 个段落共 ${String(n)} 处，看起来整篇都用了半角标点`,
    duplicateExact: '完全相同',
    duplicateNear: '高度相似',
    relatedOther: '另一处',
    relatedOtherValue: '另一处取值',
  },

  cli: {
    usage: `lingspark <命令> [选项]

命令：
  setup               一步配置好：装进代理、选模型、在当前文件夹开启检查
  ui                  打开配置页（直接双击 lingspark 也会打开）
  check <file...>     检查文档
  hook                代理 hook 适配层（由 Claude Code、Codex、Cursor、WorkBuddy 调用）
  install             安装 hook
  uninstall           卸载 hook
  doctor              自检
  mine                挖掘会话记录
  eval                在带标签的样本上评测规则
  shadow-report       影子规则命中报告（最近 7 天）
  feedback            标记一条诊断为误报
  rule-maturity       按真实使用数据汇总规则成熟度
  terms               术语表候选（机器提议，人工确认）

选项：
  -h, --help          显示帮助
  -v, --version       显示版本

用 lingspark <命令> --help 看每个命令的选项。
`,
    checkUsage: `lingspark check <file...> [选项]
lingspark check --all [选项]

指定文件时，除了逐篇检查，还会拿它们和项目里其他文档比对，找出前后矛盾的说法。

选项：
  --all                  检查当前项目里的全部文档，并报告文档之间的所有矛盾
  --budget <秒>          需要问模型的检查最多用多久，默认 120 秒
  --format text|json     输出格式，默认 text
  --passes 0,1,2,3,4     只运行这几遍
  --offline              不发起任何网络请求
  --doc-type <type>      强制指定文档类型：prd | tech-design | report | generic

退出码：0 没有错误；1 至少有一个错误；3 lingspark 自身出错。
`,
    unknownCommand: (name: string) => `未知命令 "${name}"。用 lingspark --help 看可用命令。`,
    notImplemented: (name: string) => `命令 "${name}" 尚未实现。`,
    noFiles: '没有指定要检查的文件。',
    badOption: (name: string, value: string, allowed: string) =>
      `选项 --${name} 的值 "${value}" 不合法，可选：${allowed}`,
    passesAllowed: '0 到 4 之间用逗号分隔',
  },

  /** What the writing model reads when a hook blocks (design doc, 5.3). */
  hook: {
    headSingle: (file: string, n: number, atStop: boolean) =>
      atStop
        ? `结束之前，lingspark 在 ${file} 中还有 ${String(n)} 个问题需要处理：`
        : `lingspark 在 ${file} 中发现 ${String(n)} 个问题，请修改后再继续：`,
    headMulti: (files: number, n: number, atStop: boolean) =>
      atStop
        ? `结束之前，lingspark 在 ${String(files)} 个文件中还有 ${String(n)} 个问题需要处理：`
        : `lingspark 在 ${String(files)} 个文件中发现 ${String(n)} 个问题，请修改后再继续：`,
    fileHeading: (file: string) => `${file}：`,
    item: (index: number, line: number, ruleId: string, message: string) =>
      `${String(index)}. 第 ${String(line)} 行 [${ruleId}] ${message}`,
    suggestion: (text: string) => `建议：${text}`,
    more: (n: number) => `另有 ${String(n)} 条未显示。`,
    warningsNote: '以上提醒 7 天内不会重复出现；同一问题多次提醒仍不改，会被当作错误拦住。',
    amberNote: (n: number) =>
      `另有 ${String(n)} 处可疑但模型把握不足（琥珀清单，不是错误，不阻碍结束，供你和用户参考）：`,
    amberItem: (line: number, ruleId: string, p: number) =>
      `  · 第 ${String(line)} 行 [${ruleId}]，把握 ${String(Math.round(p * 100))}%`,
    closing:
      '如果你认为某条是误报，向用户说明理由，不要自行添加 lingspark-disable 注释。',
  },

  /**
   * What the client says when it runs an agent's hook command itself to see
   * whether it works (D-077). The page shows this next to a connected agent
   * that has not called back yet, so "not restarted" and "not working" stop
   * looking the same.
   */
  probe: {
    noCommand: '配置里没有 lingspark 的 hook 命令',
    unreadable: (command: string) => `看不懂这条 hook 命令，没有运行：${command}`,
    noBinary: (exe: string) => `hook 指向的程序不存在：${exe}`,
    spawnFailed: (exe: string, detail: string) => `hook 命令启动不了（${exe}）：${detail}`,
    badExit: (exe: string, code: string) => `hook 命令退出了（${exe}，退出码 ${code}）`,
    slow: (exe: string) => `hook 命令 ${String(PROBE_TIMEOUT_MS / 1000)} 秒没有返回：${exe}`,
  },

  install: {
    usage: (installable: string, manual: string) => `lingspark install --agent <代理> [--scope user|project] [--dry-run]
lingspark uninstall --agent <代理> [--scope user|project] [--dry-run]

  --agent      要装到哪个代理。可以自动安装的：${installable}
               只能手动接入的（hook 格式还没有官方文档可核实）：${manual}
  --scope      user：对这台电脑上所有项目生效（默认）；project：只写当前目录
  --dry-run    只显示将要做的修改，不写文件

安装只会在配置文件里增加或替换 lingspark 自己的条目，你的其他设置和其他 hook 原样保留；
写之前会在同目录备份原文件。重复执行不会产生重复条目。
`,
    unknownAgent: (id: string) => `不认识的代理 "${id}"。用 lingspark install --help 看支持哪些。`,
    unverifiedAgent: (name: string, source: string) =>
      `${name} 的 hook 格式还没有官方文档可以核实（目前的依据：${source}），` +
      `lingspark 不会替你改它的配置文件，以免改坏。\n` +
      `可以手动接入：在它的 hook 配置里，写完文件时调用\n` +
      `  lingspark hook --agent <id> --event post-tool-use\n` +
      `结束时调用\n` +
      `  lingspark hook --agent <id> --event stop\n` +
      `接入后运行 lingspark doctor 检查。也可以先用仓库里的 tools/hook-probe 看它实际传来的数据。`,
    noSource: '找不到正在运行的 lingspark 程序本身，无法安装。',
    copyFailed: (dest: string, detail: string) => `无法把 lingspark 复制到 ${dest}：${detail}`,
    copyKept: (dest: string, detail: string) =>
      `没能换成新的一份（${dest}：${detail}），hook 继续跑原来那一份，功能不受影响。`,
    copied: (dest: string) => `lingspark 已复制到 ${dest}，hook 运行的是这一份。`,
    quoteInPath: (p: string) => `可执行文件路径里有双引号，无法安全地写进 hook 命令：${p}`,
    unreadable: (file: string, detail: string) => `读不了配置文件 ${file}：${detail}`,
    notJson: (file: string, detail: string) =>
      `配置文件 ${file} 不是合法的 JSON，为了不破坏它，lingspark 没有做任何修改。请先修好这个文件再试：${detail}`,
    notObject: (file: string) =>
      `配置文件 ${file} 的最外层不是一个 JSON 对象，lingspark 不认识这种格式，没有做任何修改。`,
    nothingToDo: (file: string) => `${file} 已经是目标状态，没有改动。`,
    dryRunHead: (file: string, existed: boolean) =>
      existed ? `将修改 ${file}：` : `将创建 ${file}：`,
    installed: (agent: string, file: string) => `已为 ${agent} 安装 lingspark hook：${file}`,
    uninstalled: (agent: string, file: string) => `已从 ${agent} 卸载 lingspark hook：${file}`,
    backup: (file: string) => `原文件已备份到 ${file}`,
    restartHint: '代理的设置在会话启动时读取：已经开着的会话需要重开才会生效。',
    scopeHint:
      '代理写出的 Markdown 文档都会检查，不用选文件夹；代理自己的记忆和指令文件（CLAUDE.md、.claude/ 等）除外。想只查某些目录，在项目里放一个 .lingspark/config.yaml 写上 include。',
  },

  doctor: {
    title: 'lingspark 自检',
    runtime: '运行环境',
    dataDir: '数据目录',
    notWritable: (dir: string, detail: string) => `${dir} 不可写：${detail}`,
    userConfig: '用户级配置',
    usingDefaults: '没有用户级配置，使用默认值',
    valid: '合法',
    projectConfig: '当前目录的项目配置',
    noProjectConfig: (cwd: string) =>
      `${cwd} 没有项目配置，按默认范围检查：代理写出的 Markdown 都查（代理自己的记忆和指令文件除外）`,
    rules: '规则集',
    rulesLoaded: (n: number) => `${String(n)} 条规则全部通过校验`,
    ruleImpls: '规则实现',
    missingImpls: (ids: string) => `这些规则找不到对应的实现：${ids}`,
    hookFor: (agent: string, scope: string) =>
      `${agent} hook（${scope === 'user' ? '用户级' : '项目级'}）`,
    notInstalled: (agent: string) => `未安装。运行 lingspark install --agent ${agent}`,
    partiallyInstalled: (file: string) =>
      `${file} 里只装了一半（写完检查和结束检查缺了一个）。重新运行 lingspark install 可以修复`,
    agentConfigBroken: (file: string, detail: string) => `${file} 不是合法的 JSON：${detail}`,
    programFor: (name: string) => `${name} 程序`,
    programNotFound: (name: string) =>
      `没找到 ${name} 本身（配置目录在，程序不在）。它不会调用 lingspark，多半是卸载留下的；在配置页把它关掉即可。`,
    stalePath: (paths: string, agent: string) =>
      `hook 指向的程序已经不存在：${paths}。hook 会静默失效。重新运行 lingspark install --agent ${agent} 修复`,
    otherCopy: (file: string, agent: string) =>
      `${file} 里的 hook 指向另一份 lingspark，不是正在运行的这一份。如果这不是你想要的，重新运行 lingspark install --agent ${agent}`,
    codexToml: 'Codex config.toml',
    codexTomlHasHooks: (file: string) =>
      `${file} 里也配置了 [hooks]。Codex 建议每一层只用一种写法；lingspark 写在 hooks.json 里，两处同时存在时请确认它们没有冲突`,
    judge: '判定后端',
    judgeOk: (id: string, seconds: number, calibrated: boolean) =>
      `${id} 可用，回答一道题用了 ${seconds.toFixed(1)} 秒${calibrated ? '' : '（自报把握程度，报告门槛会调高）'}`,
    judgeNoAnswer: (id: string) => `${id} 有回应，但没有给出答案`,
    judgeFailed: (id: string, detail: string) => `${id} 调用失败：${detail}`,
    summary: (fails: number, warns: number) =>
      fails === 0 && warns === 0
        ? '全部通过。'
        : `${String(fails)} 项失败，${String(warns)} 项需要注意。`,
  },

  mine: {
    usage: `lingspark mine [--agent claude-code|all] [--since <日期>] [--dry-run]

从你和代理的会话记录里，找出"模型写了文档 → 你提了修改意见 → 模型改了"的片段，
存成修改意见记录，供周报和规则学习使用。

  --agent      扫描哪个代理的会话记录，默认 all
  --since      只看这个日期之后的记录，例如 2026-09-01
  --dry-run    只报告会扫描哪些文件、能提取多少条，不写任何东西

默认关闭。要在用户级配置（${'<数据目录>'}/config.yaml）里打开，并列出允许扫描的项目：

  miner:
    enabled: true
    projects: ["/Users/你/work/prd-repo"]

会话记录只读，lingspark 不会修改或删除它们。
`,
    disabled: (configFile: string) =>
      `挖掘功能没有打开，什么都没做。\n要打开，在 ${configFile} 里写上 miner.enabled: true，并在 miner.projects 里列出允许扫描的项目。`,
    noProjects: (configFile: string) =>
      `挖掘功能已打开，但 miner.projects 是空的，所以没有任何项目被授权扫描，什么都没做。\n在 ${configFile} 的 miner.projects 里列出项目目录。`,
    onlyClaudeCode: (others: string) =>
      `目前只能读 Claude Code 的会话记录。${others} 的会话记录格式还没有核实，适配器在 M3 以后按需添加。`,
    badSince: (v: string) => `--since 的值 "${v}" 不是一个日期，例如 2026-09-01`,
    summary: (seen: number, scanned: number, found: number, dup: number, rewrite: number, dryRun: boolean) =>
      `发现 ${String(seen)} 个会话记录，其中 ${String(scanned)} 个有新内容。` +
      `${dryRun ? '可以提取' : '提取了'} ${String(found)} 条修改意见` +
      (dup > 0 ? `（${String(dup)} 条之前已经提取过）` : '') +
      (rewrite > 0 ? `；${String(rewrite)} 处改动超过全文 60%，视为重写，没有记录` : '') +
      '。',
    preview: '前几条：',
    previewItem: (file: string, feedback: string, missed: boolean) =>
      `  · ${file}：${feedback}${missed ? '　［现有规则没有覆盖］' : ''}`,
    unclassified: '没有配置判定后端，这些记录还没有分类（是不是修改意见、属于哪一类）。配置后再运行一次 mine 会自动补上。',
    notRevision: (n: number) => `${String(n)} 条经判定不是在对文档提修改意见（比如是提新需求或提问），没有记录。`,
    backfilled: (n: number) => `补做了 ${String(n)} 条旧记录的分类。`,
  },

  /** `lingspark shadow-report` (D-085): what shadow rules quietly noticed. */
  shadowReport: {
    usage: `lingspark shadow-report [--days <天数>]

还没有达到提示标准的规则（影子规则）只记录、不打扰你。这个命令汇总它们最近命中了什么：
命中多说明规则抓到了真问题，值得提前启用；一直零命中是它转正前的沉默证据。

  --days      看最近多少天，默认 7，范围 1 到 90

退出码：0。这个命令只读日志，不做任何检查。
`,
    title: (days: number) => `影子规则命中报告（最近 ${String(days)} 天）`,
    explain: '影子规则达标前只记录、不提示。同一天的同一处命中，写文件后和结束时各查一遍，只计一次。',
    ruleLine: (ruleId: string, hits: number, files: number, last: string) =>
      `[${ruleId}] 命中 ${String(hits)} 次，涉及 ${String(files)} 个文件，最近：${last}`,
    empty: (days: number) => `最近 ${String(days)} 天没有影子规则命中。`,
    badDays: '选项 --days 需为 1 到 90 的整数。',
  },

  /** `lingspark feedback` / `lingspark rule-maturity` (D-086): the fp ledger. */
  feedback: {
    usage: `lingspark feedback <规则号> <指纹>

标记一条误报：这条诊断是错的。和拦截记录里的"展示次数"合在一起，
就是这条规则的真实误报率（rule-maturity 查看）。

  规则号      如 S204；指纹在 lingspark check --format json 的输出里。
`,
    badArgs: '用法：lingspark feedback <规则号> <指纹>',
    recorded: (ruleId: string) => `已记录 ${ruleId} 的一条误报。`,
  },

  ruleMaturity: {
    usage: `lingspark rule-maturity

按真实使用数据汇总每条规则的成熟度：展示过多少次、被标过多少次误报、
由此算出的建议等级。改不改规则的 status，由人看着这些数据决定。

退出码：0。只读日志，不做任何检查。
`,
    title: '规则成熟度（真实使用数据）',
    explain:
      '展示 = 拦截记录里这条规则出现过的不同问题数；误报 = 用户用 lingspark feedback 标记过的数。' +
      '误报率 ≥ 10% 建议降回影子；不足 30 次展示的一律"数据不足"。',
    head: `规则    展示  误报  误报率  建议`,
    row: (ruleId: string, shown: number, wrong: number, rate: number, suggestion: string) =>
      `${ruleId.padEnd(7)} ${String(shown).padStart(4)} ${String(wrong).padStart(4)}  ${(rate * 100).toFixed(1).padStart(5)}%  ${suggestion}`,
    empty: '还没有任何展示记录。用上几天再来。',
    foot: '误报率 < 2% 且展示 ≥ 30 的规则，才有资格从提示升级为拦报；语义规则的召回以 lingspark eval 为准。',
  },

  /** `lingspark terms` (D-091): machine-proposed glossary pairs, human review. */
  terms: {
    usage: `lingspark terms

汇总各篇文档里机器发现的术语候选：同一个意思的两种写法（互相包含或
高度相似），都出现多次、又都不在术语表里。要不要收进 .lingspark/glossary.yaml，
由人决定；收下之后 D102 就会盯住这对写法。

退出码：0。只读日志，不做任何检查。
`,
    title: '术语候选（机器提议，人工确认）',
    explain:
      '两个写法在同一篇文档里都出现 ≥2 次、且都不被现有术语表覆盖，才会被提议。' +
      '文件数 = 提议过这对写法的不同文档数；次数 = 各文档里较少一边出现次数之和。',
    head: '写法 A    写法 B    文件数  次数  关系',
    row: (a: string, b: string, files: number, occurrences: number, kind: string) =>
      `${a.padEnd(10)}${b.padEnd(10)}${String(files).padStart(4)}  ${String(occurrences).padStart(4)}  ${kind}`,
    empty: '还没有术语候选。hook 检查过一些文档后（写文档的会话里）再来。',
    foot: '确认要收进术语表：在 .lingspark/glossary.yaml 里加一条，把规范写法放 preferred，另一种放 forbidden。',
  },

  judge: {
    notConfigured:
      '没有配置判定后端，语义检查（第 2 遍）跳过了。在用户级配置的 judge.backend 里选一个：' +
      'agent-cli（借用本机已登录的 Claude Code）、codex-cli（借用本机已登录的 Codex）、anthropic、typesafe（Jev）或 openai-compatible。',
    missingKey: (who: string, hint: string) => `判定后端 ${who} 需要 API key，没有找到。请放在 ${hint}。`,
    needsEndpoint: 'openai-compatible 需要在用户级配置里写 judge.endpoint，例如 https://api.deepseek.com/v1。',
    needsModel: 'openai-compatible 需要写 judge.model，例如 deepseek-chat。',
    noAgentCli:
      '找不到 Claude Code 的命令行。装过 Claude Code 命令行，或在用户级配置的 judge.command 里写上它的路径；' +
      '桌面版用户需要先在终端里运行一次它并登录。',
    inSession:
      '审稿设置是"对话内自审"：由写文档的 Agent 在它自己的对话里审，只在 Agent 写文档时进行；手动检查只做不需要模型的部分。',
    selfReviewOff: (agent: string, step: string) =>
      `${agent} 还不能在后台审稿，它写的文档先只做基础检查（数字、计数、引用、占位符）。要开启它自己审稿：${step}。`,
    selfReviewLater: 'LingSpark 还在适配它的后台审稿，适配好之前只做基础检查',
    autoNone:
      '"跟随 Agent" 没找到能在后台审稿的 Agent，语义检查跳过了。Codex 装好并登录即可直接用；' +
      'Claude Code 需要在终端里运行一次它的命令行并登录。',
    noCodexCli:
      '找不到 Codex 的命令行。装过 Codex 命令行或 ChatGPT 桌面版，或在用户级配置的 judge.command 里写上它的路径。',
    mockInConfig: 'judge.backend 不能是 mock：那是测试用的假判定器，用它做真实检查会报出凭空编造的问题。',
    notYet: (backend: string, milestone: string) => `判定后端 ${backend} 在 ${milestone} 交付，本版本还不能用。`,
    failed: (detail: string) => `判定器调用失败，这部分语义检查跳过了：${detail}`,
    skippedSlow: '判定后端较慢（每次要几秒），写完文件时不跑语义检查，结束时统一检查。',
    offline: '离线模式：判定后端不在本机，语义检查（第 2 遍）跳过了。',
  },

  eval: {
    usage: `lingspark eval --backend <后端> [--backend <后端> ...] [--rules S201,S204] [--record | --replay] [--fixtures <目录>]

在每条语义规则自带的正反例上，比较不同判定后端的表现。

  --backend    typesafe | anthropic | openai-compatible | agent-cli | codex-cli，可以写成 anthropic:claude-sonnet-5 指定型号
  --rules      只评测这几条规则
  --record     调用真实后端，同时把每次问答录下来
  --replay     不联网，只回放之前录下的问答
  --fixtures   录音放在哪里，默认在数据目录下的 eval/fixtures
  --concurrency 每个后端同时发几个问题，默认 4

达标标准（开发文档 10.4）：反例零误报，正例召回不低于 60%。
`,
    needBackend: '至少指定一个 --backend。',
    header: (mode: string) => `判定后端对比（${mode}）`,
    modes: { live: '实时调用', record: '实时调用并录制', replay: '回放录音' } as Record<string, string>,
    backendLine: (spec: string, id: string, calibrated: boolean) =>
      `\n■ ${spec}（${id}，${calibrated ? '概率已校准' : '自报把握，门槛 +0.1'}）`,
    problem: (spec: string, why: string) => `\n■ ${spec}：无法运行。${why}`,
    ruleLine: (id: string, name: string, hit: number, pos: number, fp: number, neg: number, skipped: number, ok: boolean) =>
      `  ${ok ? '✓' : '✗'} ${id} ${name}  正例 ${String(hit)}/${String(pos)}  反例误报 ${String(fp)}/${String(neg)}` +
      (skipped > 0 ? `  （${String(skipped)} 个没能运行）` : ''),
    totals: (pass: number, total: number, calls: number, failures: number, latency: string, tokens: string, cost: string) =>
      `  达标 ${String(pass)}/${String(total)} 条 · 调用 ${String(calls)} 次（失败 ${String(failures)}）· 平均 ${latency} · 用量 ${tokens} · 每千次约 ${cost}`,
    unknownCost: '未知',
    progress: (spec: string, done: number, total: number) => `${spec}：已问 ${String(done)}/${String(total)}`,
    skippedWhy: (why: string) => `      没能运行的原因（第一个）：${why}`,
  },

  log: {
    loopGuard: (ruleId: string, fp: string, n: number) =>
      `循环保护：${ruleId} ${fp} 已向模型反馈 ${String(n)} 次仍未消失，本会话内不再阻断。模型可能无法修复此问题，也可能是误报。`,
    hookFailed: (detail: string) => `hook 出错，已放行：${detail}`,
    hookBadInput: 'hook 的 stdin 无法解析，已放行',
    stopReentry: (turn: string) => `Stop 在本轮（${turn}）已经阻断过，这次放行`,
    stateSaveFailed: (detail: string) => `会话状态写入失败：${detail}`,
  },

  check: {
    suggestion: (text: string) => `建议：${text}`,
    probability: (p: number) => `(p=${p.toFixed(2)})`,
    skipped: {
      'opted-out': '已跳过（frontmatter 里写了 lingspark: false）',
      'out-of-scope': '已跳过（不在项目配置的检查范围内）',
      'not-found': '文件不存在',
      unreadable: '文件读取失败',
    } as Record<string, string>,
    summary: (files: number, errors: number, warnings: number, infos: number) =>
      `检查了 ${files} 个文件：${errors} 个错误，${warnings} 个警告` +
      (infos > 0 ? `，${infos} 条提示` : '') +
      '。',
    passesSkipped: (passes: string) => `注意：第 ${passes} 遍尚未实现，本次没有运行。`,
    /** D-090: the amber list -- judge-suspected but below the report bar. */
    amberHead: (n: number) => `另有 ${String(n)} 处可疑、但模型把握不足（琥珀清单，不阻断，供人工扫一眼）：`,
    amberItem: (file: string, line: number, ruleId: string, p: number) =>
      `  ${file}:${String(line)} [${ruleId}] 把握 ${String(Math.round(p * 100))}%`,
  },
  setup: {
    noAgentsFound:
      '没有找到能接入的 Agent 工具。装好 Claude Code、Codex、Cursor 或 WorkBuddy 并用过一次后，重新打开 LingSpark。',
    judgeNotSaved: (why: string) => `Agent 工具已接入，但审稿方式没能写进配置：${why}`,
    sessionReview: '写文档的 Agent 在自己的对话里按标准审一遍，不用登录、不用装别的',
    selfReviewOn: '自己审稿：已开启',
    selfReviewOff: (step: string | null) =>
      step === null ? '自己审稿：还在适配，先只做基础检查' : `自己审稿：未开启，先只做基础检查。开启方法：${step}`,
    autoReady: '在后台另起一个同款 Agent 来审，更客观；除 Codex 外要先给它单独登录',
    autoNone: '在后台另起一个同款 Agent 来审，更客观；除 Codex 外要先给它单独登录',
    codexMissing: '这台电脑上没有 ChatGPT 桌面版',
    codexReady: '用你的会员，不另收费',
    codexLoggedOut: '需要先在 ChatGPT 桌面版里登录',
    claudeMissing: '这台电脑上没有 Claude Code',
    claudeFound: '用你的会员；需要登录过，点"试一下"确认',
    keyFound: '已开通，按用量付费',
    keyMissing: '需要开通',
    agentOn: (id: string) => `${id}：已启用`,
    agentAlreadyOn: (id: string) => `${id}：之前已启用`,
    agentOff: (id: string) => `${id}：已停用`,
    noSuchFolder: (dir: string) => `文件夹不存在：${dir}`,
    folderTooBroad: (dir: string) =>
      `${dir} 范围太大：它下面所有 Markdown（包括别的项目的 README）都会被检查。请选一个具体的项目文件夹。`,
    folderOn: (dir: string) => `已在 ${dir} 开启检查`,
    folderOff: (dir: string) => `已在 ${dir} 关闭检查`,
    folderEdited: (file: string) => `${file} 被手动改过，没有删除它；想关闭检查请自己删掉这个文件。`,
    usage: `lingspark setup [--judge <后端>] [--agents <代理,...>]

一步配置好 lingspark：
  1. 找到这台电脑上用过的代理（Claude Code、Codex、Cursor、WorkBuddy），把检查装进去
  2. 挑一个能用的模型做语义检查（已经配置过的不会改）

之后代理写出的文档都会检查，不用选文件夹。

  --judge <后端>      谁来审稿：session（对话内自审，默认）| auto（独立审稿）| codex-cli | anthropic | typesafe | agent-cli | none
  --agents <列表>     只装这几个代理，逗号分隔

想用点按钮的方式：运行 lingspark ui，或者直接双击 lingspark。
`,
    heading: 'lingspark 配置',
    agentsHead: '代理：',
    noAgents: '  没有找到用过的代理（Claude Code、Codex、Cursor、WorkBuddy）。装好代理、用过一次之后再运行 lingspark setup。',
    communityAgent: (name: string) => `  ${name}：只有社区资料，没有自动接入；可按 lingspark install --help 手动配置`,
    judgeHead: '语义检查模型：',
    judgeKept: (b: string) => `  保持现有设置：${b}`,
    judgeChosen: (label: string) => `  已选择 ${label}`,
    judgeNone:
      '  没有找到可用的模型，语义检查先关着（数字、计数、引用等确定性检查照常运行）。\n' +
      '  登录 Codex（codex login）或设置 ANTHROPIC_API_KEY 后，再运行一次 lingspark setup。',
    done: '完成。新开一个代理会话后生效（代理只在会话开始时读取设置）。',
    uiOpening: (url: string) => `配置页已在浏览器打开：${url}\n不要关闭这个窗口；配置完成后在页面上点"完成"，或者直接关掉这个窗口。`,
    uiNoBrowser: (url: string) => `请在浏览器里打开：${url}`,
    uiWindow: 'LingSpark 窗口已打开。关掉那个窗口，这里也会一起结束。',
    pickerUnavailable: '这个系统上没法弹出选择文件夹的窗口，请直接粘贴文件夹路径。',
  },
  pass3: {
    contradiction: (here: string, otherFile: string, line: number, there: string) =>
      `这里说「${here}」，但 ${otherFile} 第 ${String(line)} 行说「${there}」，两处矛盾`,
    noGenerator: (backend: string) =>
      `跨文档一致性检查需要一个能写内容的模型，${backend} 只能回答是非题，这一项跳过了。换成 codex-cli、agent-cli、anthropic 或 openai-compatible 即可。`,
    timedOut: '跨文档一致性检查没在时限内做完，已做完的部分会记住，下次接着做。',
  },
} as const;

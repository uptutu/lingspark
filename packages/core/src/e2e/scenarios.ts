// The documents the harness starts from.
//
// Each seed is a first draft of the kind an agent actually produces on its
// first pass: the numbers do not agree, a section is missing, a list says
// "three" and lists four, half-width punctuation slipped in. The defects are
// not planted one per rule -- a real draft fails several at once, and the
// interesting question is whether the fixes interact badly.
//
// Seeds are written with `\n` only. The parser counts a line by `\n`, so a
// `\r` would shift every column a rule reports and silently move every repair.

import type { Scenario } from './converge.js';

const INCLUDE = 'include: ["docs/**/*.md"]\n';

/** S1: a PRD that contradicts itself and does not know how many things it has. */
const PRD_SEED = `---
doc_type: prd
---

# 会员体系改版需求

## 一、背景

现在的会员体系上线已经两年，付费转化率长期停在 2% 左右，增长主要靠投放拉动。

TODO: 补充用户访谈的结论。

## 二、目标

本次要提升的指标有两个。

日活目标是 50 万。

付费转化率目标是 6%。

## 三、功能

本期要交付以下三点：

- 会员等级体系重构
- 积分商城
- 优惠券发放
- 会员专属客服

详见第 5 节。

## 四、方案

### 4.1 技术实现

接口超时设为 30 秒。

客户端侧，接口超时设为 60 秒。

经过评审，日活目标是 80 万。

### 4.2 上线节奏

灰度按城市分三批放量，先从一线城市开始。
\`describe\` 里保留 v1.2 这类版本号写法，不用改。
\`npm run build\` 是发布命令。

#### 4.2.1 回滚

`;

const PRD: Scenario = {
  id: 'prd-self-contradiction',
  title: '需求文档：数字打架、章节缺失、清单对不上',
  file: 'docs/需求文档.md',
  expectRules: ['D101', 'D103', 'D104', 'D108', 'D110', 'D111'],
  config: INCLUDE,
  seed: PRD_SEED,
};

/** S2: a design doc written entirely in half-width punctuation, with a repeat. */
const DESIGN_SEED = `---
doc_type: tech-design
---

# 搜索重构技术方案

## 一、背景

现有搜索基于 Elasticsearch 6.x,单索引,写入和查询共用一套 mapping.
每次全量重建需要 4 小时,期间查询延迟从 80 毫秒涨到 900 毫秒.

## 二、方案

新方案拆成读写两层,查询走内存索引,写入异步落盘.

| 指标 | 现状 | 目标 |
|---|---|---|
| 查询延迟 | 900 毫秒 | 100 毫秒 |
| 重建耗时 | 4 小时 | 20 分钟 |

## 三、风险

读路径和写路径最终一致,期间可能读到旧数据.这一点需要灰度验证.

读路径和写路径最终一致,期间可能读到旧数据.这一点需要灰度验证.

## 四、回滚

保留旧索引 7 天,出现异常时把流量切回去.

## 五、待补充

`;

const DESIGN: Scenario = {
  id: 'tech-design-halfwidth-and-repeat',
  title: '技术方案：整篇半角标点、重复段落、空章节',
  file: 'docs/技术方案.md',
  expectRules: ['D106', 'D109', 'D110'],
  config: INCLUDE,
  seed: DESIGN_SEED,
};

/** S3: a report with the wrong vocabulary, a broken cross-reference, an empty section. */
const REPORT_GLOSSARY = `version: 1
terms:
  - preferred: 客户
    forbidden: ["用户", "帐号"]
    definition: 面向付费的最终使用者，统一叫客户。
`;

const REPORT_SEED = `---
doc_type: report
---

# 第 12 周周报

## 一、结论

本周搜索重构的灰度已放开到第三批城市,查询延迟降到 100 毫秒,达成目标.

帐号侧的登录成功率有小幅回落,原因还在定位.

## 二、数据

- 登录成功率：99.2%
- 查询延迟：100 毫秒
- 客单价：38 元

## 三、下一步

下周继续扩大灰度,详见第 7 节.

### 3.2 遗留问题

`;

const REPORT: Scenario = {
  id: 'report-vocabulary-and-refs',
  title: '周报：术语不统一、悬空引用、空章节',
  file: 'docs/周报.md',
  expectRules: ['D102', 'D103', 'D106', 'D110'],
  config: INCLUDE,
  glossary: REPORT_GLOSSARY,
  seed: REPORT_SEED,
};

/**
 * S4: the control. A document that is already clean must produce nothing --
 * if the convergence here comes from the repairs being generous rather than
 * from the checker being right, this is the scenario that says so.
 */
const CLEAN_SEED = `---
doc_type: generic
---

# 部署手册

## 1. 环境

生产环境使用 Kubernetes 1.29，每个集群 6 个节点。

## 2. 发布

发布窗口是每周二和周四的凌晨两点，发布前先冻结代码合并。

## 3. 回滚

出现异常时把镜像标签切回上一个稳定版本，观察 30 分钟无异常再收工。
`;

const CLEAN: Scenario = {
  id: 'clean-control',
  title: '对照：本来就干净的文档，不该报任何东西',
  file: 'docs/部署手册.md',
  // The control has no expectations on purpose: anything the checker reports
  // here is a false positive, and the curve has to stay at zero.
  expectRules: [],
  config: INCLUDE,
  seed: CLEAN_SEED,
};

/**
 * S5: the fix that creates the next problem. Deleting a placeholder is the
 * right repair, and it leaves the section it was in empty -- so D110 has to
 * fire on the next round. The two-rule handshake is the point: a harness that
 * only ever saw one defect per document would not notice it.
 */
const TODO_SECTION_SEED = `---
doc_type: generic
---

# 迁移说明

## 1. 影响范围

这次迁移只影响后台的定时任务，不影响用户侧。

## 2. 切换步骤

TODO

## 3. 回滚

保留旧任务表 7 天，出现异常时把定时任务指向旧表。
`;

const TODO_SECTION: Scenario = {
  id: 'generic-todo-leaves-empty-section',
  title: '迁移说明：删掉占位符后留下空章节',
  file: 'docs/迁移说明.md',
  expectRules: ['D108', 'D110'],
  config: INCLUDE,
  seed: TODO_SECTION_SEED,
};

export const SCENARIOS: readonly Scenario[] = [PRD, DESIGN, REPORT, CLEAN, TODO_SECTION];

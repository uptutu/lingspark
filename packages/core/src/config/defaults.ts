import { AGENT_DIRS } from '../agents.js';
import { T_LOW, T_REPORT } from '../constants.js';
import type { DocType, PassId } from './schema.js';

/**
 * Every Markdown file an agent writes is a candidate, wherever it is (D-050).
 * A project can narrow that with its own `.lingspark/config.yaml`. The excludes
 * below carve out the files that are machine-generated or belong to a tool
 * rather than to a human reader.
 */
export const DEFAULT_INCLUDE: readonly string[] = ['**/*.md'];

/**
 * Build output inside a project. Outside any project the whole path is
 * matched, and a folder named build or dist anywhere above a document (say
 * ~/build/notes) would hide everything under it; there these do not apply.
 */
export const BUILD_OUTPUT_EXCLUDE: readonly string[] = ['**/dist/**', '**/build/**', '**/coverage/**'];

export const DEFAULT_EXCLUDE: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  ...BUILD_OUTPUT_EXCLUDE,
  '**/.lingspark/**',
  '**/CHANGELOG.md',
  // Instruction files for coding agents: prose, but not documents anyone reads
  // as documents, and editing them is exactly when a hook must stay out of the
  // way.
  '**/CLAUDE.md',
  '**/AGENTS.md',
  '**/GEMINI.md',
  '**/SKILL.md',
  // Agents' own directories: settings, memory, plans, skills, commands.
  ...[...AGENT_DIRS].map((d) => `**/${d}/**`),
];

/**
 * Required sections per doc type (design doc, section 6.2, rule D104).
 * Each inner array is a set of synonyms; one hit satisfies the group.
 */
export const DEFAULT_REQUIRED_SECTIONS: ReadonlyMap<DocType, readonly (readonly string[])[]> =
  new Map([
    [
      'prd',
      [
        ['背景', '问题'],
        ['目标'],
        ['方案', '需求', '功能'],
        ['范围', '不做', '非目标'],
        ['指标', '衡量', '验收'],
      ],
    ],
    [
      'tech-design',
      [
        ['背景', '目标'],
        ['方案', '设计', '架构'],
        ['风险', '取舍', '备选'],
        ['上线', '发布', '回滚', '迁移'],
      ],
    ],
    [
      'report',
      [
        ['结论', '摘要', '概述'],
        ['数据', '进展', '现状'],
        ['下一步', '计划', '建议'],
      ],
    ],
    ['generic', []],
  ]);

export const DEFAULT_PASSES = {
  /** Cheap and incremental: the write just happened, be quick about it. */
  hookPost: [0, 1, 2] as readonly PassId[],
  /** The real enforcement point, with a 60s budget. */
  hookStop: [0, 1, 2, 3, 4] as readonly PassId[],
  /** A human or CI asked, so run everything. */
  check: [0, 1, 2, 3, 4] as readonly PassId[],
} as const;

export const DEFAULT_JUDGE = {
  // No default backend. Every real backend costs money or needs a login, and
  // `mock` answers from a function -- a check that silently used it would
  // report fabricated findings. Pass 2 is skipped until the user chooses.
  backend: null,
  thresholdReport: T_REPORT,
  thresholdLow: T_LOW,
  /**
   * Backends that cannot give a calibrated probability have to clear a higher
   * bar before they are allowed to report (design doc, section 8.2).
   */
  uncalibratedBump: 0.1,
} as const;

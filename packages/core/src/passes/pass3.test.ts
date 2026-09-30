import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from '../check.js';
import { resolveConfig } from '../config/resolve.js';
import type { GenerateRequest, GenerateResponse, Generator, Judge, JudgeRequest, JudgeResponse } from '../judge/types.js';
import type { PathEnv } from '../paths.js';
import type { Rule } from '../rules/schema.js';
import { chunkForExtraction, runPass3, type Pass3Doc } from './pass3.js';

/**
 * A stand-in model. Extraction: every line that talks about review or launch
 * becomes a claim. Grouping: subjects that mention 退款 belong together
 * (named differently on purpose). Judging: a pair contradicts when one side
 * says 人工 and the other 自动.
 */
class FakeModel implements Generator, Judge {
  readonly id = 'fake:model';
  readonly calibrated = true;
  readonly slow = false;
  generateCalls = 0;
  judgeCalls = 0;

  generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.generateCalls++;
    if (req.prompt.includes('【文档】')) {
      const claims = [...req.prompt.matchAll(/^L(\d+): (.*)$/gmu)]
        .filter((m) => /审核|审批|上线/u.test(m[2] ?? ''))
        .map((m) => ({
          line: Number(m[1]),
          kind: 'constraint',
          subject: (m[2] ?? '').includes('上线') ? '上线日期' : (m[2] ?? '').includes('审批') ? '退款审批流程' : '退款审核方式',
          text: (m[2] ?? '').replace(/^[-#\s]+/u, ''),
        }));
      return Promise.resolve({ json: { claims }, usage: { inputTokens: 1, outputTokens: 1 } });
    }
    const subjects = [...req.prompt.matchAll(/^(\d+)\. (.*)$/gmu)];
    const refund = subjects.filter((m) => (m[2] ?? '').includes('退款')).map((m) => Number(m[1]));
    return Promise.resolve({ json: { groups: refund.length > 1 ? [refund] : [] }, usage: { inputTokens: 1, outputTokens: 1 } });
  }

  judge(req: JudgeRequest): Promise<JudgeResponse> {
    this.judgeCalls++;
    // The second look: original lines, the compared line marked with ▶.
    if (req.state.includes('【原文 1】')) {
      const marked = [...req.state.matchAll(/^▶ (.*)$/gmu)].map((m) => m[1] ?? '');
      const hit = marked.some((t) => t.includes('人工')) && marked.some((t) => t.includes('自动'));
      return Promise.resolve({ answers: { v: { type: 'noul', probability: hit ? 0.95 : 0.05 } }, usage: { inputTokens: 1, outputTokens: 1 } });
    }
    const claim = (n: string): string => new RegExp(`【声明 ${n}】[^\\n]*`, 'u').exec(req.state)?.[0] ?? '';
    const answers: JudgeResponse['answers'] = {};
    for (const [name, q] of Object.entries(req.questions)) {
      const [, a = '', b = ''] = /【声明 (\d+)】和【声明 (\d+)】/u.exec(q.instructions) ?? [];
      const pair = [claim(a), claim(b)];
      const hit = pair.some((t) => t.includes('人工')) && pair.some((t) => t.includes('自动'));
      Object.assign(answers, { [name]: { type: 'noul', probability: hit ? 0.95 : 0.05 } });
    }
    return Promise.resolve({ answers, usage: { inputTokens: 1, outputTokens: 1 } });
  }
}

const RULE: Rule = {
  id: 'G301',
  version: 1,
  name: '跨文档说法矛盾',
  pass: 3,
  kind: 'judge',
  severity: 'error',
  scope: 'claim_pair',
  doc_types: ['prd', 'tech-design', 'report', 'generic'],
  status: 'active',
  origin: 'builtin',
  question: { type: 'noul', instructions: '这两条声明是否相互矛盾？' },
  message: '同一件事在两处的说法互相矛盾',
  examples: { positive: [], negative: [] },
  sourcePath: 'G301.yaml',
};

const prd: Pass3Doc = {
  absPath: '/p/docs/prd.md',
  relPath: 'docs/prd.md',
  source: '# 退款改版\n\n## 规则\n\n所有退款申请都需要客服人工审核。\n\n功能计划 11 月 15 日上线。\n',
};
const design: Pass3Doc = {
  absPath: '/p/docs/design.md',
  relPath: 'docs/design.md',
  source: '# 技术方案\n\n```\n人工审核 这行在代码块里\n```\n\n小额退款由系统自动审批通过。\n',
};
const report: Pass3Doc = {
  absPath: '/p/docs/report.md',
  relPath: 'docs/report.md',
  source: '# 周报\n\n功能计划 11 月 15 日上线。\n',
};

let root: string;
let env: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-pass3-'));
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = resolveConfig({ projectRoot: '/p', project: null, user: null });
const run = (model: FakeModel, focus?: string[]) =>
  runPass3({
    docs: [prd, design, report],
    ...(focus !== undefined ? { focus: new Set(focus) } : {}),
    generator: model,
    judge: model,
    rule: RULE,
    config,
    pathEnv: env,
    budgetMs: 10_000,
  });

describe('chunkForExtraction', () => {
  it('numbers the real lines and leaves out code, front matter and blanks', () => {
    const [c] = chunkForExtraction('---\ntitle: x\n---\n# 标题\n\n```\ncode\n```\n正文。\n');
    expect(c?.text).toBe('L4: # 标题\nL9: 正文。');
  });

  it('splits a long document into pieces one call can read', () => {
    const long = Array.from({ length: 800 }, (_, i) => `## 第 ${String(i)} 节\n\n${'很长的正文。'.repeat(5)}`).join('\n\n');
    const chunks = chunkForExtraction(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 12_500)).toBe(true);
  });
});

describe('runPass3', () => {
  it('finds a contradiction between two documents, however each names the subject', async () => {
    const r = await run(new FakeModel(), [design.absPath]);
    expect(r.diagnostics).toHaveLength(1);
    const [d] = r.diagnostics;
    expect(d?.file).toBe(design.absPath);
    expect(d?.range.start.line).toBe(7);
    expect(d?.related?.[0]).toMatchObject({ file: prd.absPath, line: 5 });
    expect(d?.message).toContain('docs/prd.md 第 5 行');
  });

  it('ignores the code block and never pairs identical claims', async () => {
    const r = await run(new FakeModel());
    // The launch date appears twice, identically: not a contradiction, not even asked.
    expect(r.claims.some((c) => c.text.includes('代码块'))).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
  });

  it('asks nothing again for documents that have not changed', async () => {
    await run(new FakeModel(), [design.absPath]);
    const again = new FakeModel();
    const r = await run(again, [design.absPath]);
    expect(r.diagnostics).toHaveLength(1);
    expect(again.generateCalls).toBe(0);
    expect(again.judgeCalls).toBe(0);
  });

  it('drops a first-look contradiction the original text does not bear out', async () => {
    const skeptic = new FakeModel();
    const judge = skeptic.judge.bind(skeptic);
    // The first look flags the pair; the second, with context, clears it.
    skeptic.judge = (req) =>
      req.state.includes('【原文 1】')
        ? Promise.resolve({ answers: { v: { type: 'noul', probability: 0.1 } }, usage: { inputTokens: 0, outputTokens: 0 } })
        : judge(req);
    const r = await run(skeptic);
    expect(r.diagnostics).toEqual([]);
  });

  it('reports only contradictions involving the documents just written', async () => {
    const r = await run(new FakeModel(), [report.absPath]);
    expect(r.diagnostics).toEqual([]);
  });

  it('keeps a shadow rule quiet', async () => {
    const r = await runPass3({
      docs: [prd, design],
      generator: new FakeModel(),
      judge: new FakeModel(),
      rule: { ...RULE, status: 'shadow' },
      config,
      pathEnv: env,
      budgetMs: 10_000,
    });
    expect(r.diagnostics).toEqual([]);
    expect(r.shadowDiagnostics).toHaveLength(1);
  });

  it('drops claims that point at lines outside what the model was shown', async () => {
    const liar = new FakeModel();
    liar.generate = (req) =>
      Promise.resolve({
        json: req.prompt.includes('【文档】') ? { claims: [{ line: 999, kind: 'number', subject: 'x', text: 'y' }] } : { groups: [] },
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    const r = await run(liar);
    expect(r.claims).toEqual([]);
  });
});

describe('checkAcross with a corpus (D-050)', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'lingspark-across-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('compares the documents it is given, outside any project, and nothing else on disk', async () => {
    const write = (name: string, text: string): string => {
      const f = path.join(dir, name);
      writeFileSync(f, text);
      return f;
    };
    const a = write('prd.md', '# 退款改版\n\n所有退款申请都需要客服人工审核。\n');
    const b = write('design.md', '# 技术方案\n\n小额退款由系统自动审批通过。\n');
    const old = write('old.md', '# 旧方案\n\n退款一律自动审批。\n');
    const g301 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rules-builtin/rules/G301.yaml');
    const env: PathEnv = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(dir, 'data') }, homedir: dir };
    const checker = createChecker({
      builtinRules: [{ file: 'G301.yaml', yaml: readFileSync(g301, 'utf8') }],
      judge: new FakeModel(),
      pathEnv: env,
    });

    const together = await checker.checkAcross([a], { focus: true, corpus: [a, b] });
    // One report per contradiction, on the document just written, naming the other one.
    expect(together.diagnostics).toHaveLength(1);
    expect(together.diagnostics[0]?.file).toBe(a);
    expect(JSON.stringify(together.diagnostics[0])).toContain('design.md');
    // old.md contradicts prd.md too, but the session never wrote it.
    expect(together.diagnostics.some((d) => d.file === old)).toBe(false);

    const alone = await checker.checkAcross([a], { focus: true, corpus: [a] });
    expect(alone.diagnostics).toEqual([]);
  });
});

describe('grouping by identical wording', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'lingspark-same-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('compares claims under the very same subject even when the model groups nothing', async () => {
    // Found in a live test: 积分兑换率目标 in two documents, 30% against 25%,
    // was never compared because the subject list had it only once.
    class SameSubject extends FakeModel {
      override generate(req: GenerateRequest): Promise<GenerateResponse> {
        this.generateCalls++;
        if (req.prompt.includes('【文档】')) {
          const claims = [...req.prompt.matchAll(/^L(\d+): (.*%.*)$/gmu)].map((m) => ({
            line: Number(m[1]),
            kind: 'goal',
            subject: '积分兑换率目标',
            text: m[2] ?? '',
          }));
          return Promise.resolve({ json: { claims }, usage: { inputTokens: 1, outputTokens: 1 } });
        }
        return Promise.resolve({ json: { groups: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
      }
      override judge(req: JudgeRequest): Promise<JudgeResponse> {
        this.judgeCalls++;
        const answers: JudgeResponse['answers'] = {};
        for (const name of Object.keys(req.questions)) Object.assign(answers, { [name]: { type: 'noul', probability: 0.95 } });
        return Promise.resolve({ answers, usage: { inputTokens: 1, outputTokens: 1 } });
      }
    }
    const docs: Pass3Doc[] = [
      { absPath: path.join(dir, 'a.md'), relPath: 'a.md', source: '# 需求\n\n积分兑换率提升到 30%。\n' },
      { absPath: path.join(dir, 'b.md'), relPath: 'b.md', source: '# 方案\n\n目标是把积分兑换率提升到 25%。\n' },
    ];
    const model = new SameSubject();
    const env: PathEnv = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(dir, 'data') }, homedir: dir };
    const r = await runPass3({
      docs,
      generator: model,
      judge: model,
      rule: RULE,
      config: resolveConfig({ projectRoot: null, project: null, user: null }),
      pathEnv: env,
      budgetMs: 10_000,
    });
    expect(r.stats.pairs).toBe(1);
    expect(r.diagnostics).toHaveLength(1);
  });
});

describe('asking pairs in batches', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), 'lingspark-batch-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asks the pairs of one group together, eight to a call', async () => {
    // Five documents, each with a figure for two subjects: two groups of ten
    // cross-document pairs, which the priority order interleaves.
    let firstLookCalls = 0;
    class Counting extends FakeModel {
      override generate(req: GenerateRequest): Promise<GenerateResponse> {
        if (req.prompt.includes('【文档】')) {
          const claims = [...req.prompt.matchAll(/^L(\d+): (.*(?:%|小时).*)$/gmu)].map((m) => ({
            line: Number(m[1]),
            kind: 'goal',
            subject: (m[2] ?? '').includes('%') ? '核销率目标' : '到账时效',
            text: m[2] ?? '',
          }));
          return Promise.resolve({ json: { claims }, usage: { inputTokens: 1, outputTokens: 1 } });
        }
        return Promise.resolve({ json: { groups: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
      }
      override judge(req: JudgeRequest): Promise<JudgeResponse> {
        if (!req.state.includes('【原文 1】')) firstLookCalls++;
        const answers: JudgeResponse['answers'] = {};
        for (const name of Object.keys(req.questions)) Object.assign(answers, { [name]: { type: 'noul', probability: 0.01 } });
        return Promise.resolve({ answers, usage: { inputTokens: 1, outputTokens: 1 } });
      }
    }
    const docs: Pass3Doc[] = [20, 25, 30, 35, 40].map((n, i) => ({
      absPath: path.join(dir, `d${String(i)}.md`),
      relPath: `d${String(i)}.md`,
      // Both subjects move down the documents at different rates, so the line
      // distances of the two groups' pairs interleave in the priority order.
      source: `# 文档 ${String(i)}\n\n${'说明。\n\n'.repeat(i)}核销率目标是 ${String(n)}%。\n\n${'补充。\n\n'.repeat(2 * (4 - i))}积分 ${String(n)} 小时内到账。\n`,
    }));
    const model = new Counting();
    const env: PathEnv = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(dir, 'data') }, homedir: dir };
    const r = await runPass3({
      docs,
      generator: model,
      judge: model,
      rule: RULE,
      config: resolveConfig({ projectRoot: null, project: null, user: null }),
      pathEnv: env,
      budgetMs: 10_000,
    });
    expect(r.stats.pairs).toBe(20);
    expect(firstLookCalls).toBe(4);
  });
});

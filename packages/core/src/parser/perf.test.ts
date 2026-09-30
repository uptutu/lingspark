import { describe, it, expect } from 'vitest';
import { parseDocument } from './parse.js';

/**
 * Section 13: Pass 0 plus Pass 1 must stay under 300 ms for a 10k-character
 * document, process startup excluded. Pass 0 alone should leave most of that
 * budget for the rules.
 */
function buildDocument(targetChars: number): string {
  const parts: string[] = ['---\ndoc_type: prd\n---\n'];
  let n = 0;
  let section = 0;
  while (n < targetChars) {
    section++;
    parts.push(`\n## ${section}. 章节标题${section}\n`);
    for (let i = 0; i < 4; i++) {
      parts.push(
        `\n本段讨论第 ${section} 节的第 ${i + 1} 个要点。日活目标是 ${50 + i} 万，` +
          `留存率从 32% 提升到 38%。这里有 **强调**、\`代码\` 和[链接](https://example.com)。` +
          `我们认为这个方案是可行的，因为它不依赖任何外部服务。\n`,
      );
    }
    parts.push('\n- 列表项一\n- 列表项二\n- 列表项三\n');
    parts.push('\n| 指标 | 现状 | 目标 |\n|---|---|---|\n| 日活 | 50 万 | 80 万 |\n');
    parts.push('\n```ts\nconst x = 1;\n```\n');
    n = parts.join('').length;
  }
  return parts.join('');
}

describe('Pass 0 performance', () => {
  it('parses a 10k-character document well inside the budget', () => {
    const source = buildDocument(10_000);
    expect(source.length).toBeGreaterThanOrEqual(10_000);

    parseDocument(source, { file: 'perf.md' }); // warm up

    const runs = 10;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) parseDocument(source, { file: 'perf.md' });
    const perRun = (performance.now() - t0) / runs;

    // Generous: this asserts the parser is not accidentally quadratic, not
    // that it hits a particular number on a particular machine.
    expect(perRun).toBeLessThan(150);
    console.log(`Pass 0 on ${source.length} chars: ${perRun.toFixed(1)} ms/run`);
  });

  it('stays roughly linear as the document grows', () => {
    const small = buildDocument(10_000);
    const large = buildDocument(40_000);
    const time = (s: string) => {
      parseDocument(s, { file: 'x.md' });
      const t = performance.now();
      for (let i = 0; i < 5; i++) parseDocument(s, { file: 'x.md' });
      return (performance.now() - t) / 5;
    };
    const ratio = time(large) / Math.max(time(small), 0.01);
    const sizeRatio = large.length / small.length;
    console.log(`4x size -> ${ratio.toFixed(2)}x time (size ratio ${sizeRatio.toFixed(2)})`);
    expect(ratio).toBeLessThan(sizeRatio * 2.5);
  });
});

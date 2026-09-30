# hook-probe

核实一个代理的 hook 实际传给我们什么（开发文档第 15 节）。探针不挑代理：
只要代理支持"在某个事件上执行一条命令、把 JSON 从 stdin 传进来"，就能用它看清楚字段。

## 用法

1. 在代理的 hook 配置里，把"写完文件"和"结束"两个事件都指向：

   ```
   node <本仓库>/tools/hook-probe/probe.mjs <任意标签>
   ```

   各家配置文件的位置见 `packages/core/src/agents.ts`。对 hook 格式还没有官方文档的代理
   （Trae、WorkBuddy），这正是核实它的办法。

2. **新开**一个会话（代理的设置在会话启动时读取），让它写一个 `.md` 文件，然后结束一轮。

3. 回来运行：

   ```bash
   node tools/hook-probe/summarize.mjs
   ```

输出是每次调用的完整字段形状。对照 `packages/core/src/hook/input.ts` 看缺什么字段，
结论记进 `DECISIONS.md`，再把 `agents.ts` 里那家的 `verification` 改成 `docs`。

`captured.jsonl` 不进版本库：它含有真实路径和文件内容。核实完就删掉，并去掉探针条目。

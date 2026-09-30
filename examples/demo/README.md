# lingspark 演示项目

用来亲眼看一遍"代理写文档 → 被 lingspark 拦住 → 自己改好"这条链路。

## 一、安装（一次）

在终端里运行（`./lingspark` 换成你下载或构建出的程序路径）：

```bash
./lingspark install --agent claude-code --dry-run
```

看一眼它要改什么，确认没问题后去掉 `--dry-run` 再运行一次。原配置文件会自动备份。

## 二、开一个新会话

hook 在会话启动时加载，**必须在本目录下新开一个 Claude Code 会话**。

## 三、让它写一篇有问题的文档

把下面这段话原样发给它：

> 在 docs/ 下写一篇会员积分改版的 PRD，文件名 prd.md。要求：背景里说"以下三点需要确认"但只列两点；
> 第一节写日活目标是 50 万，方案一节再写一次日活目标是 80 万；方案一节最后留一句"TODO: 补充回滚方案"。
> 写完就结束，不要自己检查。

我们故意让它埋雷，看 lingspark 能不能拦住它。

## 四、你应该看到

1. 它写完文件后，会收到一段"lingspark 在 docs/prd.md 中发现 N 个问题"的提醒。
2. 它准备结束时会被拦住，被要求处理问题。
3. 它自己修改文档，直到问题消失，或者向你说明为什么认为某条是误报。

## 五、验证完之后

```bash
./lingspark doctor
```

想卸载：

```bash
./lingspark uninstall --agent claude-code
```

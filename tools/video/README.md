# 演示视频

`docs/guide/lingspark-demo.mp4` 由这里的三个文件生成，只用 macOS 自带的能力，不需要 ffmpeg，也不会在屏幕上弹出窗口。

- `stage.html`：1280×720 的舞台。右边是真实的 LingSpark 配置页，由页面脚本按时间线点击；左边的终端里显示的是真实挂钩当场的输出。
- `proxy.mjs`：把舞台和真实配置页放在同一个来源下，并提供 `/demo/*`，扮演 Agent 写文档、跑真实挂钩。
- `record.swift`：在全透明、不接收点击的窗口里加载舞台，逐帧截图，用 AVFoundation 编码成 MP4。

全程使用临时的 HOME 和数据目录，不会碰到本机的 Agent 配置。

```bash
V=$(mktemp -d); mkdir -p $V/home/{.claude,.codex,.cursor,.workbuddy} $V/data
S=$PWD/packages/cli/sea/lingspark   # 先 pnpm build:sea
(cd $V && HOME=$V/home LINGSPARK_DATA_DIR=$V/data $S ui --no-open > $V/ui.out &)   # 记下打印的地址和 t=
node tools/video/proxy.mjs --port 8790 --target http://127.0.0.1:<端口> --home $V/home --data $V/data --sea $S &
xcrun swiftc -O tools/video/record.swift -o /tmp/record
/tmp/record "http://127.0.0.1:8790/stage?t=<令牌>" docs/guide/lingspark-demo.mp4 24
```

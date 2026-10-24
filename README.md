# DSH 工位工具与技能

让 DeepSeek Harness（DSH）的 agent 能直接操作**你自己打开的浏览器窗口**，并把这份能力做成可版本化的技能包。

仓库里没有 DSH 本体代码，只有"工位侧"的东西：一个零依赖的 CDP 客户端，和把它包装成 DSH skill 的技能包。

## 目录结构

```
tools/cdp.mjs                          零依赖 CDP 客户端（读 / 点 / 填 / 截图 / 执行 JS）
.dsh/skills/cdp-page-control/
├── SKILL.md                           技能说明（触发场景、命令速查、操作纪律、排错）
└── scripts/cdp.mjs                    技能包内副本（与 tools/ 版字节一致）
```

## 它解决什么问题

DSH 内置的 `dsh_browser_*` 工具走插件的会话模型：每个会话开**自己的**标签页，看不见你手动打开的页。
`tools/cdp.mjs` 直连你自己那扇窗的调试端口（CDP），所以能读、能点**你正在看的那一页**。两条通道不冲突，可以同时用。

## 快速开始

前置：Node ≥ 22（脚本用全局 `fetch` / `WebSocket`）。DSH Desktop 可以直接用随包 Node：
`%APPDATA%\dsh-desktop\harness\.desktop-bin\node.cmd`（Electron 的 Node 24）。

1）启动带调试端口的窗口（桌面快捷方式「DSH 工作窗」的等价命令）：

```bat
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --user-data-dir="%APPDATA%\dsh-desktop\harness\dsh-builtin-browser-host\edge-profile" ^
  --remote-debugging-port=0 --no-first-run --no-default-browser-check --new-window about:blank
```

> 普通 Edge 窗口**没有**调试端口，操作不了；必须是带上面参数（或该快捷方式）启动的那一扇。
> 端口每次运行自动从 `<profile>\DevToolsActivePort` 重新读取，浏览器重启换端口也不会失效。

2）列出页面，然后读 / 点 / 填 / 截图：

```bash
N="$APPDATA/dsh-desktop/harness/.desktop-bin/node.cmd"
"$N" tools/cdp.mjs list
"$N" tools/cdp.mjs read  --match bing --chars 4000
"$N" tools/cdp.mjs type  --match bing --selector '#q' --value 'deepseek harness' --enter
"$N" tools/cdp.mjs click --match bing --text '登录'
"$N" tools/cdp.mjs shot  --match bing --out ./page.png --full
```

无参数运行即打印完整用法：`"$N" tools/cdp.mjs`。

## 技能（skill）的两个副本

| 位置 | 发现 rank | 作用 |
|---|---|---|
| `<项目根>/.dsh/skills/` | 100（优先） | 跟着仓库走、可版本化 —— 本仓库里的这一份 |
| `<DSH_HOME>/skills/` | 400 | 任何工作目录下的新会话都能用 |

DSH 的 skill 发现规则：**只扫一层**，形状必须是 `<root>/<name>/SKILL.md`，frontmatter 必填 `name`(kebab-case) 与 `description`；
watcher 会自动刷新目录，所以新增/修改技能**无需重启 DSH**。

两份副本互为镜像，改完任一侧后同步并校验：

```bash
P=.dsh/skills/cdp-page-control
U="$APPDATA/dsh-desktop/harness/skills/cdp-page-control"
cp "$P/SKILL.md" "$U/SKILL.md"; cp "$P/scripts/cdp.mjs" "$U/scripts/cdp.mjs"
sha256sum "$P/SKILL.md" "$U/SKILL.md" "$P/scripts/cdp.mjs" "$U/scripts/cdp.mjs"
```

## 边界与注意

- **能**：读正文 / HTML、点击、输入、按键、等待、截图（视口 / 整页）、执行 JS、导航、新开 / 切换 / 关闭页、列出标签页。
- **暂不支持**：文件上传、拖拽、下载落盘、cookie 导出、多步脚本串（多步用多次调用组合）。
- `click` / `type` 需要可见渲染表面，会**先把目标页切到前台**——它抢你的窗口焦点，别和 agent 同时操作同一页。
- 后台标签页的 `innerText` 会偏短（Chromium 不更新隐藏页布局），需要精确内容时才加 `--activate`。

## Clone

    git clone https://github.com/xianchen-jb/deepseek-harness.git
    cd deepseek-harness
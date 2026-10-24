---
name: cdp-page-control
description: 用 CDP 直接操作用户自己打开的浏览器标签页——读正文、点击、输入、按键、截图、执行 JS、导航。当用户说「看我现在这页 / 点这个按钮 / 在搜索框输入 X / 给我截个图 / 读一下这个网页」或任何要读取、操作用户当前页面的请求时使用。
whenToUse: 用户要求读取或操作用户自己窗口里的当前页面时。内置的 dsh_browser_* 工具只会新建自己的标签页，看不到用户手动打开的页；本技能补的正是这一块。
---

# cdp-page-control

用 CDP 直连用户自己的浏览器窗口（Edge「DSH 工作窗」），操作**用户正在看的那一页**：读正文、点击、输入、按键、截图、执行 JS、导航。

## 与内置浏览器工具的分工

| | `dsh_browser_*`（插件） | 本技能（CDP 直连） |
|---|---|---|
| 操作的页面 | 自己开的标签页（`taskKey = 会话 agent id`，一会话一页） | **用户当前看的页**，也能列出他所有标签页 |
| 适合 | 「给我开个页去查/抓数据」 | 「读我这页 / 点这个按钮 / 帮我填这里」 |
| 冲突 | 无 | 与用户手动操作抢同一页，动作要克制 |

两条通道可以同时用，互不干扰。

## 路径约定（可移植）

| 名字 | 含义 |
|---|---|
| `<技能目录>` | 加载本技能时给出的 Base directory，`SKILL.md` 与 `scripts/cdp.mjs` 都在其中 |
| `<DSH_HOME>` | 当前 harness 配置根；Windows DSH Desktop 默认 `%APPDATA%\dsh-desktop\harness` |
| `<edge-profile>` | `<DSH_HOME>\dsh-builtin-browser-host\edge-profile`（与内置浏览器插件共用的 profile） |

## 前置条件

1. **浏览器在跑**：桌面上的「DSH 工作窗」快捷方式。等价命令（Windows）：

   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
     --user-data-dir="<DSH_HOME>\dsh-builtin-browser-host\edge-profile"
     --remote-debugging-port=0 --no-first-run --no-default-browser-check --new-window about:blank
   ```

   注意：**普通 Edge 窗口没有调试端口**，操作不了；必须是带上面参数（或该快捷方式）启动的那一扇。

2. **运行环境**：Node ≥ 22（脚本用全局 `fetch` 与 `WebSocket`）。
   DSH Desktop 下直接用随包 Node：`<DSH_HOME>\.desktop-bin\node.cmd`（Electron 的 Node 24，无需另装）。

3. **脚本**：`<技能目录>\scripts\cdp.mjs`，零依赖单文件。端口每次运行都从 `<edge-profile>\DevToolsActivePort` 重新读取——**浏览器重启换端口也自动跟上**；连不上时会打印原因、端口文件写入时间与处理办法。

## 调用模板

bash：

```bash
B="<技能目录>"; N="<DSH_HOME>/.desktop-bin/node.cmd"      # Windows 下这两个都是绝对路径
"$N" "$B/scripts/cdp.mjs" list
```

pwsh：

```powershell
$B = "<技能目录>"; $N = "$env:APPDATA\dsh-desktop\harness\.desktop-bin\node.cmd"
& $N "$B\scripts\cdp.mjs" list
```

## 命令速查

```
port                                      显示调试端口与浏览器版本
list                                      列出浏览器里所有真实页面（含用户的标签页）
read   [--target X|--match K] [--selector css] [--chars N] [--html]
eval   [--target X|--match K] --expr "js" | --expr-file 文件
click  [--target X|--match K] (--selector css | --text 文本) [--index N] [--js]
type   [--target X|--match K] --selector css (--value 文本 | --value-file 文件) [--enter] [--clear]
keys   [--target X|--match K] --key Enter|Tab|Escape|ArrowUp|ArrowDown|...
wait   [--target X|--match K] (--selector css | --text 文本) [--timeout ms]
shot   [--target X|--match K] --out 文件.png [--full]
nav    [--target X|--match K] --url https://...      在选中页里导航
open   --url https://...                             新开标签页并返回 target id
activate [--target X|--match K]                      把该页切到前台
close  --target X                                    关闭该页（浏览器级）
```

通用选项：`--profile <目录>`（覆盖 profile，默认 DSH edge-profile，等价环境变量 `DSH_CDP_PROFILE`）、`--port <端口>`（跳过自动探测）、`--json`（结构化输出）。

页面选择：`--target <完整id|id前缀|#序号>` 或 `--match <url/标题关键字>`；都不给且只有一个候选页才自动选中，否则会列出候选要求指定——**不要绕过这一步去猜页**。

## 典型配方

```bash
# 1) 先看清有哪些页
"$N" "$B/scripts/cdp.mjs" list

# 2) 读用户当前页并总结（用标题/域名关键字锁定他的页）
"$N" "$B/scripts/cdp.mjs" read --match bing --chars 4000

# 3) 在搜索框输入并回车
"$N" "$B/scripts/cdp.mjs" type --match bing --selector '#q' --value 'deepseek harness' --enter

# 4) 点按钮（先 list 确认是哪一页）
"$N" "$B/scripts/cdp.mjs" click --match bing --text '登录'

# 5) 截图（--full 整页）
"$N" "$B/scripts/cdp.mjs" shot --match bing --out ./page.png --full

# 6) 抓结构化数据（返回可序列化 JSON）
"$N" "$B/scripts/cdp.mjs" eval --match bing --expr "Array.from(document.querySelectorAll('h2 a')).slice(0,5).map(a=>({t:a.textContent,h:a.href}))"

# 7) 用户新开了页、id 变了：用关键字重新锁定
"$N" "$B/scripts/cdp.mjs" read --match 4399 --chars 2000
```

## 操作纪律

- **先 `list`，再 `--match` 锁定页面**，永远不要在没有辨识的情况下对某一页操作。
- `click`/`type` 默认会**先把该页切到前台**（输入事件需要可见渲染表面）——这会把用户的窗口抢到前面，动作前先说明你要做什么。
- **别和用户抢**：他正在输入/滚动同一页时，先等一下或问一句；一次只做一件事，做完立刻报告结果。
- **后台标签页的正文会偏短**（Chromium 不更新隐藏页布局，工具会报 `visibilityState`）。要完整内容才加 `--activate`。
- `close` 只用于自己开的临时页；**不要关用户自己的标签页**。
- 只报告命令的**真实输出**；没跑成功就说没成功，不要替页面"补"内容。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `连不上 http://127.0.0.1:<port>/json/version`（工具会打印端口文件写入时间） | 带调试端口的窗口已关闭，端口文件是遗留的；或当前 Edge 不是用 `--remote-debugging-port` 启动 → 重新启动「DSH 工作窗」后重跑 |
| `找不到 …\DevToolsActivePort` | 那个 profile 从未被启动过 → 先启动窗口 |
| `fetch failed` 一闪而过 | 浏览器刚重启，端口文件尚未刷新 → 直接重跑一次 |
| 列出多个候选页 | 加 `--match <关键字>`（URL 或标题）或 `--target #序号` |
| `target not found` / id 失效 | 页面被关或换过 → 重新 `list`，改用 `--match` |
| 点击没反应 | 目标可能在 iframe 或需要真实鼠标序列 → 用 `--js` 退回 `el.click()`，或先用 `read --selector` 确认元素存在 |
| 输入框填了不生效 | 框架受控输入已被原生 setter + input/change 覆盖；若仍不生效，用 `eval` 手动派发事件 |

## 边界

能：读正文/HTML、点击、输入、按键、等待、截图（视口/整页）、执行 JS、导航、新开/切换/关闭页、列标签页。

暂不支持（需要时再扩）：文件上传、拖拽、下载落盘、cookie 导出、多步脚本串（多步用多次调用组合）。

## 这份技能的两个副本

同一份内容存在于两处，**互为镜像、应保持字节一致**：

| 位置 | 根 | 作用 |
|---|---|---|
| `<项目根>\.dsh\skills\cdp-page-control\` | rank 100（项目级，优先级更高） | 跟着仓库走、可版本化、可推到 GitHub |
| `<DSH_HOME>\skills\cdp-page-control\` | rank 400（用户级） | 任何工作目录的新会话都能用 |

同步（改完任一侧后跑一次，两份都应一致）：

```bash
P="<项目根>/.dsh/skills/cdp-page-control"; U="<DSH_HOME>/skills/cdp-page-control"
cp "$P/SKILL.md" "$U/SKILL.md"; cp "$P/scripts/cdp.mjs" "$U/scripts/cdp.mjs"
sha256sum "$P/SKILL.md" "$U/SKILL.md" "$P/scripts/cdp.mjs" "$U/scripts/cdp.mjs"
```
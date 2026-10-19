# 和官方 tldraw Codex 插件 v1.1.0 的差异

官方服务端是私有的。下面只对照技能说明、官方插件清单，以及 tldraw 公开仓库里的白板 MCP 工具（`apps/dotcom/sync-worker` 的 `boardTools.ts`）和 MCP App 示例。没有调用 `codex-app.tldraw.xyz` 或 tldraw.com 的登录接口。

工具名、参数名和技能里写明的返回字段保持一致。差异都是因为白板改成本机文件之后，原版里依赖 tldraw.com 账号的部分无法照搬。

## 存储和账号

| 点 | 官方 | 本复刻 | 原因 |
| --- | --- | --- | --- |
| 白板放哪 | tldraw.com，账号下的文件 | 本机 `.tldr`，默认 `%USERPROFILE%\.tldraw-codex-plugin\boards` | 不能调用 tldraw.com 的认证 API |
| 工作区 | Clerk / 团队成员关系 | 配置里的文件夹。个人工作区默认叫 `My workspace`。`TLDRAW_WORKSPACES` 增加别的文件夹 | 没有组织目录服务 |
| 谁可以改名 | 拥有该白板的工作区成员 | `access: member` 的本地白板可以改。`markShared` 标成链接分享后拒绝，文案与公开常量 `RENAME_BOARD_FORBIDDEN_MESSAGE` 相同 | 本机没有成员表。链接分享是显式标记，不是云端 ACL |
| 登录 | tldraw.com 会话。未登录时 `addComment` 抛错 | `TLDRAW_SIGNED_IN=0` 时同等抛错。默认视为已登录，名字来自 `TLDRAW_USER_NAME` | 没有 OAuth |
| 实时同步 | 所有打开 tldraw.com 上该文件的人 | 仅本机、连到这个进程的视图 | 同步用公开的 `TLSocketRoom` + `useSync`，房间在内存里 |
| 每工作区文件上限 | 公开代码里的 `MAX_NUMBER_OF_FILES`，具体数字不在技能里 | 500 | 原数字不在技能和已核对的公开片段里，选了一个明确上限并写进错误信息 |

`.tldr` 使用 tldraw 文件格式版本 1，只含文档记录。评论走对象通道，写在旁边的 `.sync.json`，这和 tldraw 5 对 comment 记录的说明一致（不进文档快照）。

## 工具表面

八个模型可见工具与技能一致：`search`、`search_boards`、`create_board`、`rename_board`、`open_board`、`list_open_boards`、`exec`、`screenshot`。

另外注册了两个只给画布调用的工具 `_exec_callback` 和 `_import_image`（`visibility: ['app']`）。官方插件的私有服务端可能用别的内部通道把 `exec` 送进视图。这里在 WebSocket 桥之外留了 MCP Apps 的 `tool-input` 回退：沙箱里如果不能连 `127.0.0.1` 的 WebSocket，视图仍可以通过 `_exec_callback` 交回结果。这两个名字带下划线，但 `tools/list` 里仍可能出现，因为当前 MCP SDK 不会按 visibility 把它们从列表里删掉。

公开的 dotcom MCP 还有 `list_workspaces`、`get_board_info` 等。技能没有这些，所以没有实现。公开 mcp-app 示例用 `canvasId` 和简化的形状方言；技能要求原始 SDK 记录和 `boardId`，本复刻按技能来。

`search_boards` 的分页、光标（`arrivedAt`、id、规范化 query 的 base64）、AND 匹配、大小写不敏感、每页 20、最多 8 个词 / 200 字符、排序（`addedAt` 降序再 id 降序），按公开 `boardTools.ts` 移植。`source` 为 `owned`、`workspace` 或 `shared`。只有 `workspace` 带 `workspaceName`。`boardCount` 是这一页的条数，不是总数。

`create_board` 每分钟 10 次。这个数字来自对插件的静态分析，不在已核对的 `createBoard.ts` 片段里；若官方文案不同，只有措辞不同，限额一致。名字规则与公开的 `parseCreateBoardInput` 一致。

`open_board` 的 `name` 只是提示。id 决定打开哪一块，名字不一致时不会顺便改名。返回值多了本机 `url`、`readOnly` 和 `uri`。官方把画布直接嵌进侧栏，不一定把 localhost URL 交给模型；Cursor 和 Hermes 没有 MCP Apps，必须有这个 URL。

`exec` 未打开时立刻失败，文案要求先 `list_open_boards` 或 `open_board`。只读白板立刻失败，不等待。可写白板会等到视图连上，默认 30 秒。

## exec 语义

- 一次 `exec` 用 `markHistoryStoppingPoint` 再 `squashToMark`，成功时合成一个撤销步骤。下一次 `editor.undo()` 撤掉整步。
- 抛错时 `bailToMark`。若期间有远端改动，再用 `mergeRemoteChanges` 把当时记下的远端记录写回去，避免把别人的修改一起撤掉。
- 冲突的定义：远端改了一条非评论记录，而这次 `exec` 也动过它。评论 id 不参与冲突。
- 传给脚本的 `editor` 是代理。`store.put` / `update` / `remove` / `delete` 如果碰到 `comment`、`comment-thread`、`comment-reaction` 就抛错。`helpers.addComment` 在写入前放开这一次。`window.__tldrawEditor` 仍是真编辑器，用户在界面上可以改、删、解决评论。服务端不能区分「脚本」和「用户点击」，所以没有在同步层禁止用户改评论。
- 评论用 `history: 'ignore'` 写入，撤销和 `bail` 都不会吃掉它们。这和技能一致。
- 已解决的线程不能回复。
- `getComments` 只看当前页（或传入的 `pageId`），旧的在前，已解决的也在，已删除的不要。
- 沙箱不挡住 `fetch` 或 `window`。技能写明临时 editor 只保护文档编辑，不保护浏览器副作用。`search` 则在 Node 的 `vm` 里，没有编辑器。

## 图片

官方把图片复制到 tldraw.com 的资源存储。这里复制到该白板目录的 `assets/`，形状的 `src` 指向本服务的 `/api/boards/.../assets/...`。

校验：仅 http(s)、无用户名密码、拒绝 localhost、`.local`、`metadata.google.internal`、回环、链路本地、CGNAT、RFC1918、IPv6 ULA / 链路本地，以及 DNS 解析到这些地址的主机。重定向手动跟随，最多 3 次，每一跳重新检查。只认 PNG、JPEG、GIF、WebP 的文件头，不收 SVG。超过 5 MB 拒绝。

## 画布和传输

| 点 | 官方 | 本复刻 |
| --- | --- | --- |
| MCP | `https://codex-app.tldraw.xyz/mcp` | `http://127.0.0.1:8791/mcp`，另有 stdio |
| 插件 id | `app-6ab242dbeb5c8191ba5277534ef0c570` | `tldraw-local`，避免和官方插件抢同一个 id |
| 作者 | tldraw | `local replica`。显示名仍是 tldraw，这样技能触发词不变。图标是几何图形，不是官方标志 |
| 资源 | 官方托管的 MCP App | `ui://tldraw/canvas.html`，单文件 HTML，CSP 的 connect / resource 域是本服务 origin 加 `blob:` |
| 侧栏协议 | `ui/update-model-context`、`ui/message`、`ui/request-display-mode`、tool-input | 用 `@modelcontextprotocol/ext-apps` 的同样几项。模型上下文每 2 秒更新：打开的白板、页、选区、是否只读 |
| 没有 MCP Apps 的宿主 | 侧栏即画布 | 必须打开 `open_board` 返回的 localhost 页面，否则 `exec` 会一直等到超时 |

HTTP 用无会话的 streamable HTTP（每个请求一个 `McpServer`，共享同一个 `Runtime`）。Express 的 host 设成 `0.0.0.0` 只是为了关掉 SDK 默认的「只允许 localhost Origin」中间件，否则 Codex 沙箱 iframe 的 Origin 会被 403。套接字仍然只绑 `127.0.0.1`。代价是本机上任意网页都能调用这个 API。没有做 `TLDRAW_EXTRA_ORIGINS` 白名单。

同步房间用 `InMemorySyncStorage`，不用 `better-sqlite3`，这样 Windows 上不必编译原生模块。

## 水印和许可证

未设置许可证 key，也没有隐藏 `.tl-watermark`。SDK 包的许可证以各自 `node_modules` 里的文件为准。本仓库自己的代码是 MIT，见 `LICENSE` 和 `NOTICE`。

## 已知缺口

- 不能打开、搜索或修改真正的 tldraw.com 白板，也不能用 `tldraw.com` 的分享链接把别人拉进来。`tldraw://board/<id>` 只在本机 id 空间里有效。
- 没有多设备同步、没有账号、没有官方那种「链接分享给另一个 tldraw 用户」。只读是本地标记。
- 每个工作区 500 块白板是本复刻选定的上限，不一定等于官方的 `MAX_NUMBER_OF_FILES`。
- 速率限制的英文句子是按含义写的，不一定与官方逐字相同。改名的禁止句是逐字的。
- `exec` 和截图走第二条 WebSocket（`/api/bridge`），不是把自定义消息塞进同步协议。行为对工具调用者相同：必须有已连接的视图，且只有一个可写视图执行脚本，避免两个视图各跑一遍。
- 侧栏 iframe 若被宿主禁止连接 `127.0.0.1`，MCP App 能显示页面但画布离线。这时用返回的浏览器 URL。
- 截图用编辑器的 `toImage`，依赖本机 Chromium 能栅格化。官方服务端可能在他们自己的浏览器里截。
- 搜索用的 SDK 说明来自当前安装的 tldraw 5.5.2 类型声明，签名是 TypeScript 打印结果，不是官方手写的文档站摘要。类别是按方法名归的。
- 应用专用工具可能出现在 `tools/list` 里。
- 本机 HTTP 没有鉴权。只监听回环地址，但同一台电脑上的网站可以调用它。

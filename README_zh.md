# tldraw Codex 插件本地复刻

这是官方 **tldraw Codex 桌面插件 v1.1.0** 的干净室复刻。工具名、参数和返回形状跟技能说明对齐：`search`、`search_boards`、`create_board`、`rename_board`、`open_board`、`list_open_boards`、`exec`、`screenshot`。

白板是本机的 `.tldr` 文件，不是 tldraw.com 上的文件。同一台机器上打开同一块白板的多个视图会实时同步。没有 tldraw 许可证时，画布上会保留 SDK 自带的水印，本项目不会去掉它。

## 环境

- Windows 10 / 11，或 macOS / Linux
- Node.js 22 LTS（22.12 或更新）。不要用 Bun
- 构建和测试需要能下载 npm 包；端到端测试会用 Playwright 的 Chromium

## Windows 上安装并运行

1. 安装 [Node.js 22 LTS](https://nodejs.org/)，安装时勾选加入 PATH。新开一个 PowerShell，确认：

   ```powershell
   node -v
   ```

2. 进入本仓库目录，安装依赖、构建、启动：

   ```powershell
   npm install
   npm run build
   npm start
   ```

   也可以直接运行 `scripts\start-windows.ps1`，它会在缺少 `node_modules` 时先安装再构建并启动。

3. 浏览器打开 [http://127.0.0.1:8791](http://127.0.0.1:8791)。这是白板目录。某块白板的地址形如 `http://127.0.0.1:8791/b/<boardId>`。

4. 跑测试：

   ```powershell
   npx playwright install chromium
   npm test
   ```

   或 `scripts\test-windows.ps1`。GitHub Actions 工作流 `.github/workflows/ci.yml` 在 Ubuntu 和 Windows 上跑同一套测试。

默认端口是 **8791**（`TLDRAW_PORT` 或 `PORT` 可改）。白板目录默认是：

- Windows：`%USERPROFILE%\.tldraw-codex-plugin\boards`
- 其他系统：`~/.tldraw-codex-plugin/boards`

用 `TLDRAW_BOARDS_DIR` 换目录。其他环境变量：

| 变量 | 作用 |
| --- | --- |
| `TLDRAW_USER_ID` | 本地用户 id，也是个人工作区 id，默认 `local-user` |
| `TLDRAW_USER_NAME` | 评论上显示的名字，默认 `Local` |
| `TLDRAW_SIGNED_IN` | 设为 `0` 时不能发评论，文档仍可编辑 |
| `TLDRAW_WORKSPACES` | 额外工作区名字，逗号分隔。每个工作区是白板目录下的一个文件夹 |
| `TLDRAW_VIEW_TIMEOUT_MS` | `exec` / `screenshot` 等待画布连上的时间，默认 30000 |
| `TLDRAW_OPEN_BROWSER` | 设为 `1` 时启动后用系统浏览器打开首页（Windows 用 `cmd /c start`） |

目录结构：`workspaces/<工作区id>/boards/<boardId>/` 里有 `meta.json`、`<boardId>.tldr`、`<boardId>.sync.json` 和 `assets/`。`.tldr` 只存文档记录。评论在 `.sync.json` 的对象通道里，不进 `.tldr`。

## 在 Codex 里安装插件

先让服务在 8791 端口跑起来（`npm start`）。Codex 的 `.mcp.json` 指向本机，不会自己拉起进程。

1. 把仓库里的 `plugin` 目录复制到 Codex 的插件目录，文件夹名可以用 `tldraw-local`。插件 id 是 `tldraw-local`，故意和官方的 `app-6ab242dbeb5c8191ba5277534ef0c570` 错开，两个可以同时装。
2. 插件里有 `plugin.json`、`.app.json`、`.mcp.json`、`assets/icon.svg`、`skills/tldraw/SKILL.md`。`.mcp.json` 的地址是 `http://127.0.0.1:8791/mcp`。
3. 在 Codex 里启用该插件。技能名仍然是 `tldraw`，触发方式和官方技能相同；正文只在「白板在本机」这一点上改过，见 `COMPARISON_zh.md`。
4. 让助手 `create_board`，再 `open_board`。侧栏能显示 MCP App 时会加载 `ui://tldraw/canvas.html`。侧栏连不上本机 WebSocket 时，打开工具返回的 `http://127.0.0.1:8791/b/...`。

不想用插件目录时，可以把 `config/codex.config.toml` 里的片段合并进 Codex 配置，效果同样是连 `http://127.0.0.1:8791/mcp`。

## Cursor

Cursor 没有 MCP Apps 侧栏。用 stdio，进程自己起画布服务，`open_board` 返回的地址用浏览器打开。

把 `config/cursor.mcp.json` 里的路径改成你机器上的 `dist\cli.js`，合并进 Cursor 的 MCP 设置（Settings → MCP，或项目的 `.cursor/mcp.json`）。环境变量里的 `%USERPROFILE%` 请写成绝对路径，Cursor 不一定会展开它。

改完后重启 MCP。然后在对话里让模型调用 `create_board` 和 `open_board`，并打开返回的 URL。

## Hermes

`config/hermes.yaml` 是一段要合并进 Hermes MCP 配置的示例：用 `node` 跑 `dist\cli.js stdio`。Hermes 各版本的键名可能是 `mcp_servers` 或别的字段，以你安装的版本文档为准；传输要是 stdio，或者在服务已经启动时改成 streamable HTTP，URL 为 `http://127.0.0.1:8791/mcp`。

Hermes 和 Cursor 一样，画布要在浏览器里打开 `open_board` 返回的地址。`exec` 会等到那个页面连上。

## 工具在做什么

- `search`：在安装好的 SDK 说明上跑一段 JavaScript。作用域里有 `spec.members`、`spec.types.shapes`、`spec.helpers`。说明由 `scripts/extract-spec.ts` 从当前安装的 `@tldraw/editor` 生成。
- `search_boards`：按名字找白板。每个词都要出现，忽略大小写，最多 8 个词、200 个字符。每页 20 条，按加入时间新到旧，再用 id 的 UTF-16 降序断开并列。空结果不是错误。
- `create_board`：新建空白板。名字必填、去空白、最长 200。`workspace` 省略则用个人工作区；可以给 id 或名字（大小写不敏感）；重名则报错并列出 id。每分钟最多 10 块。每个工作区最多 500 块。
- `rename_board`：返回新名字和旧名字。链接分享来的白板不能改名。
- `open_board`：`action` 为 `open` 或 `home`。`boardId` 可以是 id，也可以是 `tldraw://board/<id>`。`open` 把白板标成会话内已打开，并返回本机 URL。
- `list_open_boards`：本会话打开过的白板，以及各自连上的视图数。
- `exec`：在已连接的可写视图里跑 JavaScript。作用域有 `editor`、`helpers`、`signal`。一次编辑合成一个撤销步骤。脚本抛错，或并发改到了本次也改过的非评论记录，整次编辑丢弃，并发改动留下。评论的增删改被拒绝，只能 `helpers.addComment`。只读白板直接拒绝，不会干等。
- `screenshot`：`scope` 为 `page`、`viewport` 或 `selection`，可选 `page` 和 `theme`。返回 PNG。

`helpers`：`createShapeId`、`toRichText`、`createArrowBetweenShapes`、`addImage`、`createMermaidDiagram`、`getComments`、`addComment`。

`createMermaidDiagram` 只接受 `flowchart` / `graph`、`sequenceDiagram`、`stateDiagram-v2`、`mindmap`。`stateDiagram` v1 和其他类型会抛错，并且不会留下形状。

`addImage` 只接受公网 http(s)，DNS 解析到内网、回环、`.local`、`metadata.google.internal` 都会拒绝。重定向最多 3 次并重新检查。只收 png、jpeg、gif、webp，上限 5 MB，字节复制进该白板的 `assets/`。

## 传输

- **streamable HTTP**：`POST/GET/DELETE http://127.0.0.1:8791/mcp`。Codex 插件用这个。
- **stdio**：`node dist/cli.js stdio` 或 `npm run start:stdio`。stdio 进程同时在本机起 HTTP，用来提供画布和 WebSocket。日志在 stderr。

画布资源 URI 是 `ui://tldraw/canvas.html`，MIME 为 `text/html;profile=mcp-app`。侧栏里可以请求 inline、pip、fullscreen。

## 开发

```bash
npm run extract-spec   # 从已安装的 SDK 写出 src/generated/editor-spec.ts
npm run build:server   # tsc
npm run build:view     # 单文件画布 HTML
npm test               # 先构建，再跑 node:test
```

测试覆盖每个工具、四种 mermaid、撤销与丢弃、冲突、评论、图片策略。图片成功路径在测试里注入 fetch，不访问 tldraw.com。

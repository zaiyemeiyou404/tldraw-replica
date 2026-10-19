# tldraw Codex 插件的本地复刻

这是官方 tldraw Codex 插件（v1.1.0）的干净室复刻：同样的 8 个 MCP 工具、同样的 `exec` 辅助函数，白板存在本机 `.tldr` 文件里，不连接 tldraw.com。

完整说明、Windows 安装和与原版的差异见 [README_zh.md](README_zh.md) 与 [COMPARISON_zh.md](COMPARISON_zh.md)。

需要 Node.js 22.12 或更新。

```bash
npm install
npm run build
npm start
```

服务默认在 [http://127.0.0.1:8791](http://127.0.0.1:8791)。MCP 端点是 `http://127.0.0.1:8791/mcp`。stdio 模式：`npm run start:stdio`。

```bash
npm test
```

Codex 插件目录在 `plugin/`。Cursor 与 Hermes 的配置片段在 `config/`。Windows 启动脚本：`scripts/start-windows.ps1`。

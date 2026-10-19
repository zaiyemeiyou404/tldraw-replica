#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { injectBootstrap, startHttpServer } from './server.js'
import { createMcpServer } from './mcp.js'

function defaultBoardsDir() {
	return process.env.TLDRAW_BOARDS_DIR || path.join(os.homedir(), '.tldraw-codex-plugin', 'boards')
}

function extraWorkspaces() {
	return (process.env.TLDRAW_WORKSPACES ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean)
}

function canvasHtml() {
	const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'view', 'index.html')
	if (!existsSync(htmlPath)) {
		return '<!doctype html><title>tldraw</title><p>Canvas bundle missing. Run npm run build.</p>'
	}
	return readFileSync(htmlPath, 'utf8')
}

function openBrowser(url: string) {
	if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
	else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
	else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

async function main() {
	const mode = process.argv.includes('stdio') ? 'stdio' : 'http'
	const requested = Number(process.env.TLDRAW_PORT ?? process.env.PORT ?? (mode === 'http' ? 8791 : 0))
	const running = await startHttpServer({
		port: Number.isFinite(requested) ? requested : 8791,
		boardsDir: defaultBoardsDir(),
		userId: process.env.TLDRAW_USER_ID,
		userName: process.env.TLDRAW_USER_NAME,
		signedIn: process.env.TLDRAW_SIGNED_IN === '0' ? false : true,
		extraWorkspaces: extraWorkspaces(),
		viewTimeoutMs: Number(process.env.TLDRAW_VIEW_TIMEOUT_MS ?? 30_000),
		canvasHtml: canvasHtml(),
	})
	const log = mode === 'stdio' ? console.error : console.log
	log(`tldraw local canvas ${running.origin}`)
	log(`boards ${running.runtime.library.root}`)
	if (process.env.TLDRAW_OPEN_BROWSER === '1') openBrowser(running.origin)
	if (mode === 'stdio') {
		const html = canvasHtml()
		const mcp = createMcpServer({
			runtime: running.runtime,
			origin: running.origin,
			loadCanvasHtml: () => injectBootstrap(html, running.origin, running.runtime.library),
		})
		await mcp.connect(new StdioServerTransport())
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})

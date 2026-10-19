import { createServer as createHttpServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Request } from 'express'
import cors from 'cors'
import { WebSocketServer, type WebSocket } from 'ws'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { BoardLibrary } from './store.js'
import { Runtime } from './runtime.js'
import { createMcpServer, importImageForBoard, type McpHost } from './mcp.js'
import { parseBoardId } from './shared/ids.js'
import type { ImageLookup } from './images.js'

export interface RunningServer {
	port: number
	origin: string
	runtime: Runtime
	close: () => Promise<void>
}

export interface StartOptions {
	port?: number
	boardsDir: string
	userId?: string
	userName?: string
	signedIn?: boolean
	extraWorkspaces?: string[]
	createPerMinute?: number
	viewTimeoutMs?: number
	imageFetch?: typeof fetch
	imageLookup?: ImageLookup
	canvasHtml?: string
}

export async function startHttpServer(opts: StartOptions): Promise<RunningServer> {
	const library = new BoardLibrary({
		root: opts.boardsDir,
		userId: opts.userId,
		userName: opts.userName,
		signedIn: opts.signedIn,
		extraWorkspaces: opts.extraWorkspaces,
		createPerMinute: opts.createPerMinute,
	})
	const runtime = new Runtime(library, opts.viewTimeoutMs)
	const canvasTemplate = opts.canvasHtml ?? loadBuiltCanvas()

	const app = createMcpExpressApp({ host: '0.0.0.0', jsonLimit: '8mb' })
	app.use(cors())

	let origin = 'http://127.0.0.1'
	const host: McpHost = {
		runtime,
		get origin() {
			return origin
		},
		loadCanvasHtml: () => injectBootstrap(canvasTemplate, origin, library),
		imageFetch: opts.imageFetch,
		imageLookup: opts.imageLookup,
	}

	app.get('/health', (_req, res) => {
		res.json({ ok: true, version: '1.1.0' })
	})

	app.get('/', (req, res) => {
		res.type('html').send(injectBootstrap(canvasTemplate, publicOrigin(req, origin), library))
	})

	app.get('/b/:boardId', (req, res) => {
		try {
			parseBoardId(req.params.boardId)
		} catch (error) {
			res.status(400).type('text').send(error instanceof Error ? error.message : 'bad board id')
			return
		}
		res.type('html').send(injectBootstrap(canvasTemplate, publicOrigin(req, origin), library))
	})

	app.get('/api/catalog', (_req, res) => {
		res.json({
			userName: library.config.userName,
			signedIn: library.config.signedIn,
			workspaces: library.listWorkspaces(),
			boards: library.search([], null),
			openBoards: runtime.listOpen(),
		})
	})

	app.post('/api/boards/:boardId/assets/import', async (req, res) => {
		try {
			const boardId = parseBoardId(req.params.boardId)
			const url = typeof req.body?.url === 'string' ? req.body.url : ''
			const imported = await importImageForBoard(host, boardId, url)
			res.json(imported)
		} catch (error) {
			res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
		}
	})

	app.put('/api/boards/:boardId/assets/:assetId', express.raw({ type: '*/*', limit: '6mb' }), (req, res) => {
		try {
			const board = library.requireBoard(parseBoardId(req.params.boardId))
			if (board.sharing === 'view') throw new Error('This board is view-only.')
			const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? [])
			const mimeType = String(req.headers['content-type'] ?? 'application/octet-stream')
			library.writeAsset(board, req.params.assetId, bytes, mimeType)
			res.json({ src: `/api/boards/${board.id}/assets/${encodeURIComponent(req.params.assetId)}` })
		} catch (error) {
			res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
		}
	})

	app.get('/api/boards/:boardId/assets/:assetId', (req, res) => {
		try {
			const board = library.requireBoard(parseBoardId(req.params.boardId))
			const asset = library.readAsset(board, req.params.assetId)
			if (!asset) {
				res.status(404).end()
				return
			}
			res.setHeader('content-type', asset.mimeType)
			res.setHeader('cache-control', 'public, max-age=31536000, immutable')
			res.send(asset.bytes)
		} catch (error) {
			res.status(400).type('text').send(error instanceof Error ? error.message : 'bad request')
		}
	})

	app.all('/mcp', async (req, res) => {
		const mcp = createMcpServer(host)
		const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
		res.on('close', () => {
			transport.close().catch(() => {})
			mcp.close().catch(() => {})
		})
		try {
			await mcp.connect(transport)
			await transport.handleRequest(req, res, req.body)
		} catch (error) {
			console.error(error)
			if (!res.headersSent) {
				res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
			}
		}
	})

	const httpServer = createHttpServer(app)
	const wss = new WebSocketServer({ noServer: true })
	httpServer.on('upgrade', (request, socket, head) => {
		const url = new URL(request.url ?? '/', origin)
		if (!url.pathname.startsWith('/api/connect/') && !url.pathname.startsWith('/api/bridge/')) {
			socket.destroy()
			return
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			handleSocket(url, ws, runtime)
		})
	})

	await new Promise<void>((resolve, reject) => {
		httpServer.once('error', reject)
		httpServer.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
	})
	const address = httpServer.address()
	const port = typeof address === 'object' && address ? address.port : opts.port ?? 0
	origin = `http://127.0.0.1:${port}`

	return {
		port,
		origin,
		runtime,
		close: () => shutdown(httpServer, wss, runtime),
	}
}

function handleSocket(url: URL, ws: WebSocket, runtime: Runtime) {
	const connect = /^\/api\/connect\/([^/]+)$/.exec(url.pathname)
	const bridge = /^\/api\/bridge\/([^/]+)$/.exec(url.pathname)
	try {
		if (connect) {
			const board = runtime.library.requireBoard(parseBoardId(decodeURIComponent(connect[1])))
			const sessionId = url.searchParams.get('sessionId') || 'session'
			runtime.connectSync(board, sessionId, ws)
			return
		}
		if (bridge) {
			const boardId = parseBoardId(decodeURIComponent(bridge[1]))
			const board = runtime.library.requireBoard(boardId)
			runtime.connectView(boardId, ws, board.sharing === 'view')
			return
		}
	} catch (error) {
		ws.close(1008, error instanceof Error ? error.message.slice(0, 100) : 'bad request')
		return
	}
	ws.close(1008, 'unknown socket path')
}

export function injectBootstrap(html: string, origin: string, library: Pick<BoardLibrary, 'config'>) {
	const bootstrap = `<script>window.__TLDRAW_BOOTSTRAP__=${JSON.stringify({
		origin,
		userName: library.config.userName,
		userId: library.config.userId,
		signedIn: library.config.signedIn,
	})}</script>`
	// Insert after the real <head> so the document keeps its doctype. The
	// bundled script contains the characters "</head>", so that is not a safe
	// splice point, and prepending before the doctype turns the page into quirks mode.
	const head = /<head[^>]*>/i.exec(html)
	if (!head) return `<!doctype html><html><head>${bootstrap}</head>${html}`
	const at = head.index + head[0].length
	return html.slice(0, at) + bootstrap + html.slice(at)
}

function publicOrigin(req: Request, fallback: string) {
	const hostHeader = req.get('host')
	if (!hostHeader) return fallback
	return `http://${hostHeader}`
}

function loadBuiltCanvas(): string {
	const here = path.dirname(fileURLToPath(import.meta.url))
	const candidates = [
		path.join(here, 'view', 'index.html'),
		path.join(here, '..', 'dist', 'view', 'index.html'),
	]
	for (const candidate of candidates) {
		if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
	}
	return `<!doctype html><html><head><meta charset="utf-8"><title>tldraw</title></head><body><p>Canvas bundle is missing. Run npm run build.</p></body></html>`
}

async function shutdown(httpServer: Server, wss: WebSocketServer, runtime: Runtime) {
	await runtime.close()
	for (const client of wss.clients) client.close()
	wss.close()
	await new Promise<void>((resolve, reject) => {
		httpServer.close((error) => (error ? reject(error) : resolve()))
	})
}

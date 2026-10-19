import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computed } from '@tldraw/state'
import { useSync } from '@tldraw/sync'
import { commentSchemaRecords, createUserId, UserRecordType, type TLPageId } from '@tldraw/tlschema'
import { Tldraw, type Editor, type TLAssetStore } from 'tldraw'
import type { App as McpApp } from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import { runExec } from './execRunner'
import { type HelperContext } from './helpers'

interface Bootstrap {
	origin: string
	userName: string
	userId: string
	signedIn: boolean
}

interface CatalogBoard {
	boardId: string
	name: string
	source: string
	updatedAt: string
	workspaceName?: string
}

declare global {
	interface Window {
		__TLDRAW_BOOTSTRAP__?: Bootstrap
		__tldrawReady?: boolean
		__tldrawEditor?: Editor
		__cont?: () => void
		tlsync?: { fpsScheduler?: { flush: () => void } }
	}
}

function flushSyncNow() {
	window.tlsync?.fpsScheduler?.flush()
}

let navigateTo: (boardId: string | null) => void = () => {}

function bootstrap(): Bootstrap {
	return (
		window.__TLDRAW_BOOTSTRAP__ ?? {
			origin: location.origin,
			userName: 'Local',
			userId: 'local-user',
			signedIn: true,
		}
	)
}

function initialBoardId() {
	const fromPath = /^\/b\/([^/]+)$/.exec(location.pathname)
	if (fromPath) return decodeURIComponent(fromPath[1])
	return new URLSearchParams(location.search).get('board')
}

export function App() {
	const [boardId, setBoardId] = useState<string | null>(initialBoardId)
	const [app, setApp] = useState<McpApp | null>(null)
	navigateTo = setBoardId
	const embedded = window.parent !== window
	return (
		<div className="shell">
			{embedded ? <McpConnector onApp={setApp} /> : null}
			{boardId ? (
				<Board boardId={boardId} app={app} onHome={() => setBoardId(null)} />
			) : (
				<Home onOpen={setBoardId} />
			)}
		</div>
	)
}

function McpConnector({ onApp }: { onApp: (app: McpApp) => void }) {
	const { app, error } = useApp({
		appInfo: { name: 'tldraw', version: '1.1.0' },
		capabilities: {},
		onAppCreated: (created) => {
			created.ontoolinput = (params) => {
				const args = params.arguments ?? {}
				if (typeof args.code === 'string' && typeof args.boardId === 'string') {
					void runExecFromHost(String(args.boardId), String(args.code), created)
					return
				}
				if (args.action === 'home') {
					navigateTo(null)
					return
				}
				if (typeof args.boardId === 'string') navigateTo(String(args.boardId).replace(/^tldraw:\/\/board\//, ''))
			}
			created.onerror = (err) => console.error(err)
		},
	})
	useEffect(() => {
		if (app) onApp(app)
	}, [app, onApp])
	useEffect(() => {
		if (error) console.error(error)
	}, [error])
	return null
}

async function runExecFromHost(boardId: string, code: string, app: McpApp) {
	const editor = window.__tldrawEditor
	if (!editor) return
	const boot = bootstrap()
	const ctx: HelperContext = {
		origin: boot.origin,
		boardId,
		userId: boot.userId,
		userName: boot.userName,
		signedIn: boot.signedIn,
		allowCommentWrite: false,
	}
	try {
		const payload = await runExec(editor, code, ctx, new AbortController().signal)
		flushSyncNow()
		await app.callServerTool({
			name: '_exec_callback',
			arguments: { boardId, code, ok: true, result: payload.result, changes: payload.changes },
		})
	} catch (error) {
		flushSyncNow()
		await app.callServerTool({
			name: '_exec_callback',
			arguments: { boardId, code, ok: false, error: error instanceof Error ? error.message : String(error) },
		})
	}
}

function Home({ onOpen }: { onOpen: (boardId: string) => void }) {
	const [boards, setBoards] = useState<CatalogBoard[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		const origin = bootstrap().origin
		fetch(`${origin}/api/catalog`)
			.then((response) => response.json())
			.then((body) => setBoards(body.boards?.boards ?? []))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
	}, [])
	return (
		<main className="home">
			<h1>白板</h1>
			<p>本地 .tldr 文件。选一块已有的白板，或让助手用 create_board 新建。</p>
			{error ? <p className="status error">{error}</p> : null}
			{boards === null && !error ? <p className="status">正在读取白板…</p> : null}
			{boards && boards.length === 0 ? <p className="status">还没有白板。</p> : null}
			<ul className="board-list">
				{(boards ?? []).map((board) => (
					<li key={board.boardId}>
						<a
							href={`/b/${board.boardId}`}
							onClick={(event) => {
								event.preventDefault()
								onOpen(board.boardId)
							}}
						>
							<strong>{board.name || '未命名'}</strong>
							<span>
								{board.source}
								{board.workspaceName ? ` · ${board.workspaceName}` : ''} · {board.updatedAt.slice(0, 10)}
							</span>
						</a>
					</li>
				))}
			</ul>
		</main>
	)
}

function Board({ boardId, app, onHome }: { boardId: string; app: McpApp | null; onHome: () => void }) {
	const boot = bootstrap()
	const [name, setName] = useState(boardId)
	const [readOnly, setReadOnly] = useState(false)
	const nameRef = useRef(name)
	const readOnlyRef = useRef(readOnly)
	const appRef = useRef(app)
	nameRef.current = name
	readOnlyRef.current = readOnly
	appRef.current = app
	const users = useMemo(
		() => ({
			currentUser: computed(`user-${boot.userId}`, () =>
				UserRecordType.create({
					id: createUserId(boot.userId),
					name: boot.userName,
					color: '#4465e9',
				}),
			),
		}),
		[boot.userId, boot.userName],
	)
	const assets = useMemo<TLAssetStore>(
		() => ({
			async upload(_asset, file) {
				const id = `asset:${crypto.randomUUID()}`
				const response = await fetch(`${boot.origin}/api/boards/${boardId}/assets/${encodeURIComponent(id)}`, {
					method: 'PUT',
					headers: { 'content-type': file.type || 'application/octet-stream' },
					body: file,
				})
				if (!response.ok) throw new Error('upload failed')
				const body = (await response.json()) as { src: string }
				return { src: body.src.startsWith('/') ? boot.origin + body.src : body.src }
			},
			resolve(asset) {
				const src = asset.props.src
				if (!src) return null
				if (src.startsWith('/')) return boot.origin + src
				return src
			},
		}),
		[boardId, boot.origin],
	)
	const store = useSync({
		uri: `${boot.origin.replace(/^http/, 'ws')}/api/connect/${encodeURIComponent(boardId)}`,
		assets,
		users,
		records: commentSchemaRecords,
	})

	useEffect(() => {
		const origin = boot.origin
		fetch(`${origin}/api/catalog`)
			.then((response) => response.json())
			.then((body) => {
				const found = (body.boards?.boards ?? []).find((board: CatalogBoard) => board.boardId === boardId)
				if (found?.name) setName(found.name)
			})
			.catch(() => {})
	}, [boardId, boot.origin])

	const onMount = useCallback(
		(editor: Editor) => {
			window.__tldrawEditor = editor
			window.__tldrawReady = true
			const ctx: HelperContext = {
				origin: boot.origin,
				boardId,
				userId: boot.userId,
				userName: boot.userName,
				signedIn: boot.signedIn,
				allowCommentWrite: false,
			}
			const ws = new WebSocket(`${boot.origin.replace(/^http/, 'ws')}/api/bridge/${encodeURIComponent(boardId)}`)
			ws.onmessage = (event) => {
				void handleBridgeMessage(ws, editor, ctx, event.data, setReadOnly)
			}
			const publish = () => {
				const host = appRef.current
				if (!host) return
				const pageId = editor.getCurrentPageId()
				const page = editor.getPage(pageId as TLPageId)
				const selected = editor.getSelectedShapeIds()
				const text = [
					`Open board: ${nameRef.current}`,
					`boardId: ${boardId}`,
					`uri: tldraw://board/${boardId}`,
					`url: ${boot.origin}/b/${boardId}`,
					`page: ${page?.name ?? 'Page'} (${pageId})`,
					`readOnly: ${readOnlyRef.current}`,
					`selection: ${selected.length ? selected.join(', ') : '(none)'}`,
				].join('\n')
				host.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => {})
			}
			const timer = window.setInterval(publish, 2000)
			publish()
			return () => {
				window.clearInterval(timer)
				ws.close()
				if (window.__tldrawEditor === editor) {
					window.__tldrawReady = false
					window.__tldrawEditor = undefined
				}
			}
		},
		[boardId, boot.origin, boot.signedIn, boot.userId, boot.userName],
	)

	if (store.status === 'loading') return <p className="status">正在连接白板…</p>
	if (store.status === 'error') return <p className="status error">连接失败：{store.error.message}</p>

	return (
		<>
			<header className="topbar">
				<a
					href="/"
					onClick={(event) => {
						event.preventDefault()
						onHome()
					}}
				>
					全部
				</a>
				<h1>{name}</h1>
				{readOnly ? <span className="badge">只读</span> : null}
				{app ? (
					<>
						<button type="button" onClick={() => app.requestDisplayMode({ mode: 'inline' }).catch(() => {})}>
							侧栏
						</button>
						<button type="button" onClick={() => app.requestDisplayMode({ mode: 'pip' }).catch(() => {})}>
							浮窗
						</button>
						<button type="button" onClick={() => app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {})}>
							全屏
						</button>
					</>
				) : null}
			</header>
			<div className="canvas">
				<div className="fill">
					<Tldraw store={store.store} onMount={onMount} />
				</div>
			</div>
		</>
	)
}

async function handleBridgeMessage(
	ws: WebSocket,
	editor: Editor,
	ctx: HelperContext,
	data: unknown,
	setReadOnly: (value: boolean) => void,
) {
	let message: {
		type?: string
		code?: string
		requestId?: string
		readOnly?: boolean
		scope?: 'page' | 'viewport' | 'selection'
		page?: number | string
		theme?: 'light' | 'dark'
	}
	try {
		message = JSON.parse(String(data))
	} catch {
		return
	}
	if (message.type === 'welcome') {
		setReadOnly(Boolean(message.readOnly))
		return
	}
	if (message.type === 'exec' && message.code) {
		try {
			const payload = await runExec(editor, message.code, ctx, new AbortController().signal)
			flushSyncNow()
			ws.send(
				JSON.stringify({
					type: 'exec-result',
					code: message.code,
					ok: true,
					result: payload.result,
					changes: payload.changes,
				}),
			)
		} catch (error) {
			flushSyncNow()
			ws.send(
				JSON.stringify({
					type: 'exec-result',
					code: message.code,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
		return
	}
	if (message.type === 'screenshot' && message.requestId) {
		try {
			const image = await capture(editor, message.scope ?? 'viewport', message.page, message.theme)
			ws.send(
				JSON.stringify({
					type: 'screenshot-result',
					requestId: message.requestId,
					ok: true,
					boardId: ctx.boardId,
					scope: message.scope ?? 'viewport',
					pngBase64: image.pngBase64,
					width: image.width,
					height: image.height,
				}),
			)
		} catch (error) {
			ws.send(
				JSON.stringify({
					type: 'screenshot-result',
					requestId: message.requestId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
	}
}

async function capture(
	editor: Editor,
	scope: 'page' | 'viewport' | 'selection',
	page: number | string | undefined,
	theme: 'light' | 'dark' | undefined,
) {
	const previous = editor.user.getUserPreferences()
	if (theme) editor.user.updateUserPreferences({ colorScheme: theme })
	try {
		if (page != null) await showPage(editor, page)
		let ids = editor.getCurrentPageShapes().map((shape) => shape.id)
		let bounds = undefined as ReturnType<Editor['getViewportPageBounds']> | undefined
		if (scope === 'selection') {
			ids = [...editor.getSelectedShapeIds()]
			if (ids.length === 0) throw new Error('Nothing is selected.')
		} else if (scope === 'viewport') {
			bounds = editor.getViewportPageBounds()
			const viewport = bounds
			ids = editor.getCurrentPageShapes().flatMap((shape) => {
				const box = editor.getShapePageBounds(shape.id)
				if (!box) return []
				const hits = box.x < viewport.maxX && box.y < viewport.maxY && box.maxX > viewport.x && box.maxY > viewport.y
				return hits ? [shape.id] : []
			})
		}
		if (ids.length === 0) throw new Error('There is nothing on this page to screenshot.')
		const image = await editor.toImage(ids, {
			format: 'png',
			background: true,
			padding: scope === 'viewport' ? 0 : 16,
			scale: 1,
			pixelRatio: 1,
			bounds,
		})
		const pngBase64 = bufferToBase64(new Uint8Array(await image.blob.arrayBuffer()))
		return { pngBase64, width: image.width, height: image.height }
	} finally {
		if (theme) editor.user.updateUserPreferences({ colorScheme: previous.colorScheme })
	}
}

async function showPage(editor: Editor, page: number | string) {
	const pages = editor.getPages()
	const target =
		typeof page === 'string'
			? pages.find((item) => item.id === page)
			: pages[page]
	if (!target) throw new Error(`No page ${page} on this board.`)
	editor.setCurrentPage(target.id)
}

function bufferToBase64(bytes: Uint8Array) {
	let binary = ''
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	}
	return btoa(binary)
}

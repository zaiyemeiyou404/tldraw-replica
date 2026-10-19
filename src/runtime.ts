import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { WebSocket } from 'ws'
import {
	InMemorySyncStorage,
	TLSocketRoom,
	type RoomSnapshot,
} from '@tldraw/sync-core'
import {
	createTLSchema,
	defaultBindingSchemas,
	defaultShapeSchemas,
	commentSchemaRecords,
} from '@tldraw/tlschema'
import { BoardLibrary, type BoardMeta } from './store.js'
import { COMMENT_TYPE_NAMES, type ChangeCounts, type ExecPayload, type SessionMeta } from './shared/protocol.js'
import { createId } from './shared/ids.js'

const schema = createTLSchema({
	shapes: defaultShapeSchemas,
	bindings: defaultBindingSchemas,
	records: commentSchemaRecords,
})

export interface OpenBoard {
	boardId: string
	name: string
	openedAt: number
}

interface ConnectedView {
	id: string
	boardId: string
	socket: WebSocket
	readOnly: boolean
}

interface PendingExec {
	code: string
	resolve: (payload: ExecPayload) => void
	reject: (error: Error) => void
	timer: NodeJS.Timeout
}

export interface ScreenshotRequest {
	scope: 'page' | 'viewport' | 'selection'
	page?: number | string
	theme?: 'light' | 'dark'
}

export interface ScreenshotPayload {
	boardId: string
	scope: string
	png: Buffer
	width: number
	height: number
}

interface PendingShot {
	resolve: (payload: ScreenshotPayload) => void
	reject: (error: Error) => void
	timer: NodeJS.Timeout
}

interface EarlyExec {
	code: string
	payload?: ExecPayload
	error?: string
}

export class Runtime {
	readonly library: BoardLibrary
	private readonly rooms = new Map<string, TLSocketRoom<any, SessionMeta>>()
	private readonly saveTimers = new Map<string, NodeJS.Timeout>()
	private readonly openBoards = new Map<string, OpenBoard>()
	private readonly views = new Map<string, ConnectedView>()
	private readonly pendingExec = new Map<string, PendingExec>()
	private readonly earlyExec = new Map<string, EarlyExec>()
	private readonly pendingShot = new Map<string, PendingShot>()
	readonly viewTimeoutMs: number
	homeViews = 0

	constructor(library: BoardLibrary, viewTimeoutMs = 30_000) {
		this.library = library
		this.viewTimeoutMs = viewTimeoutMs
	}

	get signedIn() {
		return this.library.config.signedIn
	}

	get userId() {
		return this.library.config.userId
	}

	get userName() {
		return this.library.config.userName
	}

	sessionMeta(): SessionMeta {
		return { userId: this.userId, userName: this.userName, signedIn: this.signedIn }
	}

	markOpen(board: BoardMeta) {
		this.openBoards.set(board.id, { boardId: board.id, name: board.name, openedAt: Date.now() })
	}

	renameOpen(boardId: string, name: string) {
		const open = this.openBoards.get(boardId)
		if (open) open.name = name
	}

	listOpen() {
		return [...this.openBoards.values()].map((open) => {
			const board = this.library.getBoard(open.boardId)
			const connected = [...this.views.values()].filter((view) => view.boardId === open.boardId)
			return {
				boardId: open.boardId,
				name: board?.name ?? open.name,
				readOnly: board?.sharing === 'view',
				connectedViews: connected.length,
				openedAt: new Date(open.openedAt).toISOString(),
			}
		})
	}

	isOpen(boardId: string) {
		return this.openBoards.has(boardId)
	}

	connectSync(board: BoardMeta, sessionId: string, socket: WebSocket) {
		const room = this.roomFor(board)
		const readOnly = board.sharing === 'view'
		room.handleSocketConnect({
			sessionId,
			socket: socket as unknown as WebSocket,
			isReadonly: readOnly,
			objectAccess: readOnly || !this.signedIn ? 'read' : 'write',
			meta: this.sessionMeta(),
		})
	}

	connectView(boardId: string, socket: WebSocket, readOnly: boolean): ConnectedView {
		const view: ConnectedView = { id: createId('view_'), boardId, socket, readOnly }
		this.views.set(view.id, view)
		socket.on('message', (data) => {
			this.onViewMessage(view, String(data))
		})
		socket.on('close', () => {
			if (this.views.get(view.id) === view) this.views.delete(view.id)
		})
		socket.send(JSON.stringify({ type: 'welcome', viewId: view.id, boardId, readOnly }))
		const pending = this.pendingExec.get(boardId)
		if (pending && !readOnly && !this.writableView(boardId, view.id)) {
			socket.send(JSON.stringify({ type: 'exec', requestId: view.id, code: pending.code }))
		}
		return view
	}

	private onViewMessage(view: ConnectedView, raw: string) {
		let message: any
		try {
			message = JSON.parse(raw)
		} catch {
			return
		}
		if (message?.type === 'exec-result') {
			this.settleExec(view.boardId, message.code, message.ok ? undefined : message.error, message.ok ? {
				boardId: view.boardId,
				result: message.result,
				changes: message.changes,
			} : undefined)
		} else if (message?.type === 'screenshot-result') {
			this.settleShot(message.requestId, message)
		}
	}

	async exec(boardId: string, code: string, signal?: AbortSignal): Promise<ExecPayload> {
		if (!this.isOpen(boardId)) {
			throw new Error(
				'The board is not open. Call list_open_boards, or open it with open_board; do not claim the drawing was made.',
			)
		}
		const board = this.library.requireBoard(boardId)
		if (board.sharing === 'view') {
			throw new Error(
				'This board is view-only, so exec cannot run. getComments does not run on a view-only board.',
			)
		}
		const early = this.earlyExec.get(boardId)
		if (early && early.code === code) {
			this.earlyExec.delete(boardId)
			if (early.error) throw new Error(early.error)
			return early.payload!
		}
		return await new Promise<ExecPayload>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingExec.delete(boardId)
				reject(
					new Error(
						'exec waited for the view to connect, but no canvas is connected for this board. Open the board URL in a browser, or load the tldraw view in the side panel, then retry.',
					),
				)
			}, this.viewTimeoutMs)
			const onAbort = () => {
				clearTimeout(timer)
				this.pendingExec.delete(boardId)
				reject(new Error('exec was cancelled.'))
			}
			if (signal?.aborted) {
				onAbort()
				return
			}
			signal?.addEventListener('abort', onAbort, { once: true })
			this.pendingExec.set(boardId, {
				code,
				timer,
				resolve: (payload) => {
					signal?.removeEventListener('abort', onAbort)
					resolve(payload)
				},
				reject: (error) => {
					signal?.removeEventListener('abort', onAbort)
					reject(error)
				},
			})
			const view = this.writableView(boardId)
			if (view) view.socket.send(JSON.stringify({ type: 'exec', requestId: view.id, code }))
		})
	}

	/** App-only path: the sandboxed view finished an exec that was delivered as tool input. */
	callbackExec(boardId: string, code: string, ok: boolean, payload?: ExecPayload, error?: string) {
		const pending = this.pendingExec.get(boardId)
		if (!pending || pending.code !== code) {
			this.earlyExec.set(boardId, ok && payload ? { code, payload } : { code, error: error ?? 'exec failed' })
			return { ok: true, buffered: true }
		}
		this.settleExec(boardId, code, ok ? undefined : error, ok ? payload : undefined)
		return { ok: true, buffered: false }
	}

	private settleExec(boardId: string, code: string | undefined, error: string | undefined, payload?: ExecPayload) {
		const pending = this.pendingExec.get(boardId)
		if (!pending) return
		if (code && pending.code !== code) return
		clearTimeout(pending.timer)
		this.pendingExec.delete(boardId)
		const room = this.rooms.get(boardId)
		let finished = false
		let quiet: NodeJS.Timeout
		let cap: NodeJS.Timeout
		let unlisten: (() => void) | undefined
		const finish = () => {
			if (finished) return
			finished = true
			unlisten?.()
			clearTimeout(quiet)
			clearTimeout(cap)
			// The view pushes document changes on a different socket from the
			// exec result. Wait until that push has landed, then write the file
			// before the tool returns.
			this.flush(boardId)
			if (error || !payload) pending.reject(new Error(error || 'exec failed'))
			else pending.resolve(payload)
		}
		quiet = setTimeout(finish, 60)
		cap = setTimeout(finish, 1000)
		unlisten = room?.storage.onChange?.(() => {
			clearTimeout(quiet)
			quiet = setTimeout(finish, 40)
		})
	}

	async screenshot(boardId: string, request: ScreenshotRequest): Promise<ScreenshotPayload> {
		if (!this.isOpen(boardId)) {
			throw new Error('The board is not open. Open it with open_board before taking a screenshot.')
		}
		this.library.requireBoard(boardId)
		const view = [...this.views.values()].find((item) => item.boardId === boardId && item.socket.readyState === 1)
		if (!view) {
			await this.waitForView(boardId)
		}
		const target = [...this.views.values()].find((item) => item.boardId === boardId && item.socket.readyState === 1)
		if (!target) {
			throw new Error('screenshot waited for the view to connect, but no canvas is connected for this board.')
		}
		const requestId = createId('shot_')
		return await new Promise<ScreenshotPayload>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingShot.delete(requestId)
				reject(new Error('screenshot timed out waiting for the canvas.'))
			}, this.viewTimeoutMs)
			this.pendingShot.set(requestId, { resolve, reject, timer })
			target.socket.send(JSON.stringify({ type: 'screenshot', requestId, ...request }))
		})
	}

	private settleShot(requestId: string, message: any) {
		const pending = this.pendingShot.get(requestId)
		if (!pending) return
		clearTimeout(pending.timer)
		this.pendingShot.delete(requestId)
		if (!message.ok) {
			pending.reject(new Error(message.error || 'screenshot failed'))
			return
		}
		pending.resolve({
			boardId: message.boardId,
			scope: message.scope,
			png: Buffer.from(message.pngBase64, 'base64'),
			width: message.width,
			height: message.height,
		})
	}

	private writableView(boardId: string, exceptId?: string) {
		return [...this.views.values()].find(
			(view) =>
				view.boardId === boardId &&
				view.id !== exceptId &&
				!view.readOnly &&
				view.socket.readyState === 1,
		)
	}

	private async waitForView(boardId: string) {
		const started = Date.now()
		while (Date.now() - started < this.viewTimeoutMs) {
			if ([...this.views.values()].some((view) => view.boardId === boardId && view.socket.readyState === 1)) return
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	}

	roomFor(board: BoardMeta): TLSocketRoom<any, SessionMeta> {
		const existing = this.rooms.get(board.id)
		if (existing && !existing.isClosed()) return existing
		const snapshot = this.readSnapshot(board)
		const storage = new InMemorySyncStorage({
			snapshot,
			objectTypes: COMMENT_TYPE_NAMES,
		})
		storage.onChange(() => this.scheduleSave(board.id))
		const room = new TLSocketRoom<any, SessionMeta>({
			storage,
			schema: schema as any,
			objectTypes: COMMENT_TYPE_NAMES,
			clientTimeout: 120_000,
			onSessionRemoved: (_room, args) => {
				if (args.numSessionsRemaining === 0) this.flush(board.id)
			},
		})
		this.rooms.set(board.id, room)
		if (!snapshot) this.scheduleSave(board.id)
		return room
	}

	private readSnapshot(board: BoardMeta): RoomSnapshot | undefined {
		const syncFile = this.library.syncPath(board)
		if (existsSync(syncFile)) {
			const saved = JSON.parse(readFileSync(syncFile, 'utf8')) as { snapshot?: RoomSnapshot }
			return saved.snapshot
		}
		const tldr = this.library.tldrPath(board)
		if (!existsSync(tldr)) return undefined
		const file = JSON.parse(readFileSync(tldr, 'utf8')) as { records?: any[]; schema?: any }
		if (!file.records) return undefined
		return {
			documents: file.records.map((state, index) => ({ state, lastChangedClock: index + 1 })),
			schema: file.schema,
		}
	}

	private scheduleSave(boardId: string) {
		const existing = this.saveTimers.get(boardId)
		if (existing) clearTimeout(existing)
		this.saveTimers.set(
			boardId,
			setTimeout(() => {
				this.saveTimers.delete(boardId)
				this.flush(boardId)
			}, 80),
		)
	}

	flush(boardId?: string) {
		const ids = boardId ? [boardId] : [...this.rooms.keys()]
		for (const id of ids) {
			const timer = this.saveTimers.get(id)
			if (timer) {
				clearTimeout(timer)
				this.saveTimers.delete(id)
			}
			const room = this.rooms.get(id)
			const board = this.library.getBoard(id)
			if (!room || !board) continue
			const snapshot = room.storage.getSnapshot?.()
			if (!snapshot) continue
			const objects = room.storage.getObjectsSnapshot?.() ?? []
			const combined: RoomSnapshot = {
				...snapshot,
				documents: [...snapshot.documents, ...objects],
			}
			writeFileSync(this.library.syncPath(board), JSON.stringify({ snapshot: combined }))
			const records = snapshot.documents.map((document) => document.state)
			writeFileSync(
				this.library.tldrPath(board),
				JSON.stringify({
					tldrawFileFormatVersion: 1,
					schema: snapshot.schema,
					records,
				}),
			)
			this.library.touch(id)
		}
	}

	async close() {
		for (const id of [...this.rooms.keys()]) this.flush(id)
		for (const room of this.rooms.values()) {
			try {
				room.close()
			} catch {
				/* already closed */
			}
		}
		this.rooms.clear()
		for (const pending of this.pendingExec.values()) {
			clearTimeout(pending.timer)
			pending.reject(new Error('server closed'))
		}
		this.pendingExec.clear()
	}
}

export function emptyChangeCounts(): ChangeCounts {
	return { added: 0, updated: 0, removed: 0 }
}

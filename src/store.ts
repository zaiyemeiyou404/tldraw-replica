import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
	BOARD_NAME_MAX_LENGTH,
	CREATE_BOARD_PER_MINUTE,
	MAX_BOARDS_PER_WORKSPACE,
	MAX_IMAGE_BYTES,
} from './shared/protocol.js'
import { createId } from './shared/ids.js'
import {
	boardMatchesTerms,
	compareBoardSearchOrder,
	isAfterBoardSearchCursor,
	pageBoardSearch,
	type BoardSearchCursor,
	type BoardSearchRow,
} from './searchBoards.js'

export interface WorkspaceRecord {
	id: string
	name: string
	personal: boolean
	role: 'owner' | 'admin' | 'editor' | 'viewer'
}

export interface BoardMeta {
	id: string
	name: string
	workspaceId: string
	createdAt: number
	updatedAt: number
	addedAt: number
	/** `shared` means this profile is not a member of the owning workspace. */
	access: 'member' | 'shared'
	sharing: 'private' | 'edit' | 'view'
}

export interface LibraryConfig {
	userId: string
	userName: string
	signedIn: boolean
	workspaces: WorkspaceRecord[]
}

export class BoardLibrary {
	readonly root: string
	readonly config: LibraryConfig
	private readonly creates: number[] = []
	readonly createPerMinute: number

	constructor(opts: {
		root: string
		userId?: string
		userName?: string
		signedIn?: boolean
		extraWorkspaces?: string[]
		createPerMinute?: number
	}) {
		this.root = opts.root
		this.createPerMinute = opts.createPerMinute ?? CREATE_BOARD_PER_MINUTE
		mkdirSync(this.root, { recursive: true })
		const configPath = path.join(this.root, 'config.json')
		if (existsSync(configPath)) {
			this.config = JSON.parse(readFileSync(configPath, 'utf8')) as LibraryConfig
		} else {
			const userId = opts.userId ?? 'local-user'
			this.config = {
				userId,
				userName: opts.userName ?? 'Local',
				signedIn: opts.signedIn !== false,
				workspaces: [
					{ id: userId, name: 'My workspace', personal: true, role: 'owner' },
				],
			}
		}
		if (opts.userName) this.config.userName = opts.userName
		if (opts.signedIn !== undefined) this.config.signedIn = opts.signedIn
		for (const name of opts.extraWorkspaces ?? []) {
			const trimmed = name.trim()
			if (!trimmed) continue
			if (this.config.workspaces.some((workspace) => workspace.name.toLowerCase() === trimmed.toLowerCase())) {
				continue
			}
			this.config.workspaces.push({
				id: createId('ws_'),
				name: trimmed,
				personal: false,
				role: 'owner',
			})
		}
		this.saveConfig()
		for (const workspace of this.config.workspaces) {
			mkdirSync(this.workspaceDir(workspace.id), { recursive: true })
		}
	}

	private saveConfig() {
		writeFileSync(path.join(this.root, 'config.json'), JSON.stringify(this.config, null, 2))
	}

	workspaceDir(workspaceId: string): string {
		return path.join(this.root, 'workspaces', workspaceId)
	}

	boardDir(meta: BoardMeta): string {
		return path.join(this.workspaceDir(meta.workspaceId), 'boards', meta.id)
	}

	private metaPath(meta: Pick<BoardMeta, 'workspaceId' | 'id'>): string {
		return path.join(this.workspaceDir(meta.workspaceId), 'boards', meta.id, 'meta.json')
	}

	listWorkspaces(): WorkspaceRecord[] {
		return [...this.config.workspaces].sort(
			(a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name),
		)
	}

	creatableWorkspaces(): WorkspaceRecord[] {
		return this.listWorkspaces().filter((workspace) => workspace.role !== 'viewer')
	}

	resolveWorkspace(requested: string | null): WorkspaceRecord {
		const creatable = this.creatableWorkspaces()
		if (requested === null) {
			const personal = creatable.find((workspace) => workspace.personal)
			if (personal) return personal
			throw new Error(
				`Your personal workspace could not be found. ${describeWorkspaces(creatable)}`,
			)
		}
		const byId = creatable.find((workspace) => workspace.id === requested)
		if (byId) return byId
		const wanted = requested.toLowerCase()
		const byName = creatable.filter((workspace) => workspace.name.trim().toLowerCase() === wanted)
		if (byName.length === 1) return byName[0]
		if (byName.length > 1) {
			throw new Error(
				`More than one of your workspaces is named "${requested}". Pass the id of the one you mean as workspace: ${byName.map(formatWorkspace).join(', ')}.`,
			)
		}
		throw new Error(
			`No workspace you can create boards in matches "${requested}". ${describeWorkspaces(creatable)}`,
		)
	}

	listBoards(): BoardMeta[] {
		const boards: BoardMeta[] = []
		for (const workspace of this.config.workspaces) {
			const dir = path.join(this.workspaceDir(workspace.id), 'boards')
			if (!existsSync(dir)) continue
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue
				const metaFile = path.join(dir, entry.name, 'meta.json')
				if (!existsSync(metaFile)) continue
				boards.push(JSON.parse(readFileSync(metaFile, 'utf8')) as BoardMeta)
			}
		}
		return boards
	}

	getBoard(boardId: string): BoardMeta | undefined {
		return this.listBoards().find((board) => board.id === boardId)
	}

	requireBoard(boardId: string): BoardMeta {
		const board = this.getBoard(boardId)
		if (!board) {
			throw new Error(
				'No board was found with this id, or this account does not have access to it. Boards in your own workspace, boards owned by a workspace you belong to, and boards shared with you via link are supported.',
			)
		}
		return board
	}

	sourceOf(board: BoardMeta): BoardSearchRow['source'] {
		if (board.access === 'shared') return 'shared'
		const workspace = this.config.workspaces.find((item) => item.id === board.workspaceId)
		return workspace?.personal ? 'owned' : 'workspace'
	}

	search(terms: string[], cursor: BoardSearchCursor | null) {
		const rows = this.listBoards()
			.filter((board) => boardMatchesTerms(board.name, terms))
			.map((board) => this.toRow(board))
			.sort(compareBoardSearchOrder)
			.filter((row) => (cursor ? isAfterBoardSearchCursor(row, cursor) : true))
		return pageBoardSearch(rows, terms)
	}

	private toRow(board: BoardMeta): BoardSearchRow {
		const workspace = this.config.workspaces.find((item) => item.id === board.workspaceId)
		return {
			id: board.id,
			arrivedAt: board.addedAt,
			name: board.name,
			createdAt: board.createdAt,
			updatedAt: board.updatedAt,
			workspaceName: workspace?.name ?? '',
			source: this.sourceOf(board),
		}
	}

	createBoard(name: string, workspaceRequested: string | null, now = Date.now()): BoardMeta {
		this.consumeCreateRate(now)
		const workspace = this.resolveWorkspace(workspaceRequested)
		const title = parseBoardName(name, 'the title for the new board')
		const existing = this.listBoards().filter((board) => board.workspaceId === workspace.id)
		if (existing.length >= MAX_BOARDS_PER_WORKSPACE) {
			throw new Error(
				`The workspace "${workspace.name}" already has the maximum of ${MAX_BOARDS_PER_WORKSPACE} boards. Delete boards there or choose a different workspace.`,
			)
		}
		const board: BoardMeta = {
			id: createId(),
			name: title,
			workspaceId: workspace.id,
			createdAt: now,
			updatedAt: now,
			addedAt: now,
			access: 'member',
			sharing: 'private',
		}
		mkdirSync(this.boardDir(board), { recursive: true })
		mkdirSync(path.join(this.boardDir(board), 'assets'), { recursive: true })
		this.writeMeta(board)
		return board
	}

	renameBoard(boardId: string, name: string, now = Date.now()): { board: BoardMeta; previousName: string } {
		const board = this.requireBoard(boardId)
		if (board.access === 'shared') {
			throw new Error(
				'This board is shared with you by link, but only members of the workspace that owns it can rename it.',
			)
		}
		const title = parseBoardName(name, 'the new title for the board')
		const previousName = board.name
		board.name = title
		board.updatedAt = now
		this.writeMeta(board)
		return { board, previousName }
	}

	touch(boardId: string, now = Date.now()) {
		const board = this.getBoard(boardId)
		if (!board) return
		board.updatedAt = now
		this.writeMeta(board)
	}

	/**
	 * Test and file-level hook: a board that lives in a workspace folder but is only
	 * reachable by link (and optionally view-only).
	 */
	markShared(boardId: string, sharing: 'edit' | 'view') {
		const board = this.requireBoard(boardId)
		board.access = 'shared'
		board.sharing = sharing
		this.writeMeta(board)
		return board
	}

	writeMeta(board: BoardMeta) {
		mkdirSync(this.boardDir(board), { recursive: true })
		writeFileSync(this.metaPath(board), JSON.stringify(board, null, 2))
	}

	tldrPath(board: BoardMeta): string {
		return path.join(this.boardDir(board), `${board.id}.tldr`)
	}

	syncPath(board: BoardMeta): string {
		return path.join(this.boardDir(board), `${board.id}.sync.json`)
	}

	assetPath(board: BoardMeta, assetId: string): string {
		const safe = assetId.replace(/[^A-Za-z0-9_.:-]/g, '_')
		return path.join(this.boardDir(board), 'assets', safe)
	}

	writeAsset(board: BoardMeta, assetId: string, bytes: Buffer, mimeType: string) {
		if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('The image is over 5 MB.')
		const file = this.assetPath(board, assetId)
		mkdirSync(path.dirname(file), { recursive: true })
		writeFileSync(file, bytes)
		writeFileSync(`${file}.json`, JSON.stringify({ mimeType, bytes: bytes.byteLength }))
		return file
	}

	readAsset(board: BoardMeta, assetId: string): { bytes: Buffer; mimeType: string } | undefined {
		const file = this.assetPath(board, assetId)
		if (!existsSync(file)) return undefined
		const meta = existsSync(`${file}.json`)
			? (JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { mimeType?: string })
			: {}
		return { bytes: readFileSync(file), mimeType: meta.mimeType ?? 'application/octet-stream' }
	}

	deleteBoard(boardId: string) {
		const board = this.getBoard(boardId)
		if (!board) return
		rmSync(this.boardDir(board), { recursive: true, force: true })
	}

	private consumeCreateRate(now: number) {
		while (this.creates.length && now - this.creates[0] >= 60_000) this.creates.shift()
		if (this.creates.length >= this.createPerMinute) {
			throw new Error(
				`Too many boards created. This account can create at most ${this.createPerMinute} boards per minute. Wait and try again.`,
			)
		}
		this.creates.push(now)
	}
}

export function parseBoardName(value: unknown, purpose: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`name is required: ${purpose}`)
	}
	const name = value.trim()
	if (name.length > BOARD_NAME_MAX_LENGTH) {
		throw new Error(`name must be at most ${BOARD_NAME_MAX_LENGTH} characters`)
	}
	return name
}

export function parseWorkspaceArg(value: unknown): string | null {
	if (value === undefined || value === null) return null
	if (typeof value !== 'string') throw new Error('workspace must be a workspace name or id')
	const trimmed = value.trim()
	return trimmed || null
}

function describeWorkspaces(workspaces: WorkspaceRecord[]) {
	if (!workspaces.length) return 'This account has no workspaces it can create boards in.'
	return `Workspaces you can create boards in: ${workspaces.map(formatWorkspace).join(', ')}. Pass one of these as workspace, or omit it to use your personal workspace.`
}

function formatWorkspace(workspace: WorkspaceRecord) {
	return `"${workspace.name}" (id: ${workspace.id}${workspace.personal ? ', personal' : ''})`
}

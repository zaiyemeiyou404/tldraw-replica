import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { CANVAS_RESOURCE_URI, SERVER_NAME, SERVER_VERSION } from './shared/protocol.js'
import { parseBoardId } from './shared/ids.js'
import { parseSearchBoardsInput } from './searchBoards.js'
import { parseBoardName, parseWorkspaceArg } from './store.js'
import { runSearch } from './runSearch.js'
import type { Runtime } from './runtime.js'
import { importPublicImage, type ImageLookup } from './images.js'
import { createId } from './shared/ids.js'

const INSTRUCTIONS = [
	'Local tldraw canvas. Boards are .tldr files on this machine, not tldraw.com.',
	'Find a board with search_boards, open it with open_board (action "open"), then draw with exec.',
	'exec waits for the canvas view to connect. Pass boardId to every exec and screenshot.',
	'search runs JavaScript over spec.members, spec.types.shapes, and spec.helpers from the installed SDK.',
	'For a flowchart, sequence diagram, state machine, or mindmap, call helpers.createMermaidDiagram inside exec.',
].join(' ')

export interface McpHost {
	runtime: Runtime
	origin: string
	loadCanvasHtml: () => string
	imageFetch?: typeof fetch
	imageLookup?: ImageLookup
}

export function createMcpServer(host: McpHost): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS },
	)
	const ui = { resourceUri: CANVAS_RESOURCE_URI }

	server.registerTool(
		'search',
		{
			title: 'Search the tldraw SDK',
			description:
				'Query the installed tldraw SDK API with JavaScript. The code runs against `spec`: spec.members (name, signature, description, category, examples), spec.types.shapes (shape types and props), and spec.helpers. Return only the relevant entries, for example `return spec.members.filter(m => /createShape|alignShapes/.test(m.name))`.',
			inputSchema: z.object({
				code: z.string().describe('JavaScript function body. `spec` is in scope. Return the entries you need.'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
		},
		async ({ code }) => {
			try {
				return jsonResult(await runSearch(code))
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	server.registerTool(
		'search_boards',
		{
			title: 'Search tldraw boards',
			description:
				'Find local boards by name: boards in the personal workspace, boards in other workspaces on this machine, and link-shared boards that were opened here. Every term must appear in the name, in any order, ignoring case. Omit the query to list the boards that arrived most recently. Returns up to 20 boards with boardId, name, addedAt, createdAt, updatedAt, and source (owned, workspace, or shared). Pass nextCursor with the same query for the next page.',
			inputSchema: z.object({
				query: z.string().optional().describe('Words to match against board names. Omit to list the newest boards.'),
				cursor: z.string().optional().describe('nextCursor from the previous page. Keep the query the same.'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
		},
		async (args) => {
			try {
				const { terms, cursor } = parseSearchBoardsInput(args)
				return jsonResult(host.runtime.library.search(terms, cursor))
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	server.registerTool(
		'create_board',
		{
			title: 'Create tldraw board',
			description:
				'Create a new, empty local board and return its boardId and url. The board goes in the personal workspace unless you name another workspace (a name or id). At most 10 boards can be created per minute. Open the board with open_board before drawing.',
			inputSchema: z.object({
				name: z.string().describe('The title for the new board.'),
				workspace: z.string().optional().describe('Workspace name or id. Omit for the personal workspace.'),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
		},
		async ({ name, workspace }) => {
			try {
				const title = parseBoardName(name, 'the title for the new board')
				const board = host.runtime.library.createBoard(title, parseWorkspaceArg(workspace))
				host.runtime.roomFor(board)
				host.runtime.flush(board.id)
				const workspaceRecord = host.runtime.library.listWorkspaces().find((item) => item.id === board.workspaceId)
				return jsonResult({
					boardId: board.id,
					name: board.name,
					url: boardUrl(host.origin, board.id),
					workspace: workspaceRecord
						? { id: workspaceRecord.id, name: workspaceRecord.name, personal: workspaceRecord.personal }
						: { id: board.workspaceId, name: '', personal: false },
				})
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	server.registerTool(
		'rename_board',
		{
			title: 'Rename tldraw board',
			description:
				'Rename a local board and return its new and previous names. Members of the workspace that owns the board can rename it. A board shared by link cannot be renamed.',
			inputSchema: z.object({
				boardId: z.string().describe('Board id, or a tldraw://board/<id> URI.'),
				name: z.string().describe('The new title.'),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
		},
		async ({ boardId, name }) => {
			try {
				const id = parseBoardId(boardId)
				const { board, previousName } = host.runtime.library.renameBoard(id, name)
				host.runtime.renameOpen(board.id, board.name)
				return jsonResult({ boardId: board.id, name: board.name, previousName })
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	registerAppTool(
		server,
		'open_board',
		{
			title: 'Open tldraw board',
			description:
				'Open a board in the side panel, or open the board browser with action "home". action "open" requires boardId (an id or tldraw://board/<id>) and may include the board name. Returns the localhost URL for hosts that cannot render the MCP Apps canvas. exec waits until that view connects, so call exec right after opening.',
			inputSchema: z.object({
				action: z.enum(['open', 'home']).describe('open a board, or home to browse boards.'),
				boardId: z.string().optional().describe('Board id or tldraw://board/<id>. Required when action is open.'),
				name: z.string().optional().describe('Board name, when you have it. The id is what is opened.'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
			_meta: { ui },
		},
		async ({ action, boardId, name }) => {
			try {
				if (action === 'home') {
					host.runtime.homeViews += 1
					return jsonResult({
						action: 'home',
						url: `${host.origin}/`,
						boards: host.runtime.library.search([], null),
					})
				}
				if (!boardId) throw new Error('boardId is required when action is open')
				const id = parseBoardId(boardId)
				const board = host.runtime.library.requireBoard(id)
				if (name && name.trim() && name.trim() !== board.name) {
					// The id wins. The name is a hint from the caller, not a rename.
				}
				host.runtime.markOpen(board)
				host.runtime.roomFor(board)
				return jsonResult({
					action: 'open',
					boardId: board.id,
					name: board.name,
					url: boardUrl(host.origin, board.id),
					readOnly: board.sharing === 'view',
					uri: `tldraw://board/${board.id}`,
				})
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	server.registerTool(
		'list_open_boards',
		{
			title: 'List open tldraw boards',
			description:
				'List boards opened in this session and how many canvas views are connected to each. If exec says a board is not open, call this or open_board.',
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
		},
		async () => {
			return jsonResult({ boards: host.runtime.listOpen() })
		},
	)

	registerAppTool(
		server,
		'exec',
		{
			title: 'Execute on a tldraw board',
			description:
				'Run JavaScript against an open board. The code has `editor` (the tldraw Editor), `helpers` (createShapeId, toRichText, createArrowBetweenShapes, addImage, createMermaidDiagram, getComments, addComment), and `signal`. Await async work. Edits commit as one undo step. An error, or a concurrent change to a record the edit touches, discards the edit. The result includes boardId, the return value, and record-change counts. exec refuses comment edits and deletes. A view-only board is rejected. Pass boardId.',
			inputSchema: z.object({
				boardId: z.string().describe('Board id or tldraw://board/<id> of an open board.'),
				code: z.string().describe('JavaScript function body. Return a small JSON value.'),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
			_meta: { ui },
		},
		async ({ boardId, code }, extra) => {
			try {
				const id = parseBoardId(boardId)
				const payload = await host.runtime.exec(id, code, extra.mcpReq.signal)
				host.runtime.flush(id)
				return jsonResult(payload)
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	registerAppTool(
		server,
		'screenshot',
		{
			title: 'Screenshot a tldraw board',
			description:
				'Explicitly inspect an open board. scope is page (everything on the page), viewport (what the camera shows), or selection. No screenshots are taken automatically. Returns a PNG.',
			inputSchema: z.object({
				boardId: z.string().describe('Board id or tldraw://board/<id> of an open board.'),
				scope: z.enum(['page', 'viewport', 'selection']).optional().describe('What to capture. Defaults to viewport.'),
				page: z.union([z.number(), z.string()]).optional().describe('Page ordinal or page id. Defaults to the current page.'),
				theme: z.enum(['light', 'dark']).optional(),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
			_meta: { ui },
		},
		async ({ boardId, scope, page, theme }) => {
			try {
				const id = parseBoardId(boardId)
				const shot = await host.runtime.screenshot(id, { scope: scope ?? 'viewport', page, theme })
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ boardId: shot.boardId, scope: shot.scope, width: shot.width, height: shot.height }),
						},
						{ type: 'image' as const, data: shot.png.toString('base64'), mimeType: 'image/png' },
					],
				}
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	registerAppTool(
		server,
		'_exec_callback',
		{
			title: 'Exec callback',
			description: 'App-only. The canvas calls this to finish an exec when it cannot use the local websocket.',
			inputSchema: z.object({
				boardId: z.string(),
				code: z.string(),
				ok: z.boolean(),
				result: z.unknown().optional(),
				error: z.string().optional(),
				changes: z
					.object({ added: z.number(), updated: z.number(), removed: z.number() })
					.optional(),
			}),
			_meta: { ui: { resourceUri: CANVAS_RESOURCE_URI, visibility: ['app'] } },
		},
		async ({ boardId, code, ok, result, error, changes }) => {
			const id = parseBoardId(boardId)
			host.runtime.callbackExec(
				id,
				code,
				ok,
				ok ? { boardId: id, result: result ?? null, changes: changes ?? { added: 0, updated: 0, removed: 0 } } : undefined,
				error,
			)
			return jsonResult({ ok: true })
		},
	)

	registerAppTool(
		server,
		'_import_image',
		{
			title: 'Import image',
			description: 'App-only. Copy a public http(s) image into the board asset store. Max 5 MB.',
			inputSchema: z.object({
				boardId: z.string(),
				url: z.string(),
			}),
			_meta: { ui: { resourceUri: CANVAS_RESOURCE_URI, visibility: ['app'] } },
		},
		async ({ boardId, url }) => {
			try {
				const id = parseBoardId(boardId)
				const imported = await importImageForBoard(host, id, url)
				return jsonResult(imported)
			} catch (error) {
				return toolError(messageOf(error))
			}
		},
	)

	registerAppResource(
		server,
		'tldraw canvas',
		CANVAS_RESOURCE_URI,
		{
			title: 'tldraw canvas',
			description: 'Interactive tldraw canvas for the open board.',
			mimeType: RESOURCE_MIME_TYPE,
		},
		async () => {
			const html = host.loadCanvasHtml()
			return {
				contents: [
					{
						uri: CANVAS_RESOURCE_URI,
						mimeType: RESOURCE_MIME_TYPE,
						text: html,
						_meta: {
							ui: {
								csp: {
									connectDomains: [host.origin],
									resourceDomains: [host.origin, 'blob:'],
								},
								permissions: { clipboardWrite: {} },
							},
						},
					},
				],
			}
		},
	)

	return server
}

export async function importImageForBoard(host: McpHost, boardId: string, url: string) {
	const board = host.runtime.library.requireBoard(boardId)
	if (board.sharing === 'view') throw new Error('This board is view-only.')
	const image = await importPublicImage(url, { fetch: host.imageFetch, lookup: host.imageLookup })
	const assetId = `asset:${createId()}`
	host.runtime.library.writeAsset(board, assetId, image.bytes, image.mimeType)
	return {
		assetId,
		src: `/api/boards/${board.id}/assets/${encodeURIComponent(assetId)}`,
		w: image.w,
		h: image.h,
		mimeType: image.mimeType,
	}
}

function boardUrl(origin: string, boardId: string) {
	return `${origin}/b/${boardId}`
}

function jsonResult(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function toolError(text: string) {
	return { isError: true as const, content: [{ type: 'text' as const, text }] }
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

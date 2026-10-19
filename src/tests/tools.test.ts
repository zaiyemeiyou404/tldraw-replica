import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { chromium, type Browser, type Page } from 'playwright'
import { callTool, connectClient, openCanvas, startTestServer, stopTestServer, type TestServer } from './harness.js'

declare global {
	interface Window {
		__tldrawEditor: {
			getCurrentPageShapes: () => Array<{ id: string }>
			getShape: (id: string) => { x: number } | undefined
			updateShape: (partial: { id: string; type: string; x: number }) => void
			store: {
				allRecords: () => Array<{ typeName: string; id: string }>
				put: (records: unknown[]) => void
			}
		}
		__tldrawReady?: boolean
		__cont?: () => void
	}
}

const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
)

const GEO = `{ geo: 'rectangle', w: 120, h: 70, richText: helpers.toRichText('Label') }`

let server: TestServer
let client: Client
let browser: Browser

before(async () => {
	server = await startTestServer({
		extraWorkspaces: ['设计组'],
		userName: 'Local',
		imageLookup: async () => [{ address: '93.184.216.34' }],
		imageFetch: async (input) => {
			const url = String(input)
			if (url.includes('huge.example')) {
				return new Response(new Uint8Array(8), {
					status: 200,
					headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
				})
			}
			return new Response(PNG_1X1, {
				status: 200,
				headers: { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) },
			})
		},
	})
	client = await connectClient(server.origin)
	browser = await chromium.launch({ headless: true })
})

after(async () => {
	await client?.close().catch(() => {})
	await browser?.close().catch(() => {})
	if (server) await stopTestServer(server)
})

async function newPage() {
	return browser.newPage({ viewport: { width: 420, height: 800 } })
}

async function boardWithView(name: string) {
	const created = await callTool(client, 'create_board', { name })
	const opened = await callTool(client, 'open_board', {
		action: 'open',
		boardId: `tldraw://board/${created.json.boardId}`,
		name,
	})
	const page = await newPage()
	await openCanvas(page, opened.json.url)
	return { created: created.json, opened: opened.json, page }
}

test('lists the eight plugin tools and the canvas resource', async () => {
	const listed = await client.listTools()
	const names = listed.tools.map((tool) => tool.name).sort()
	for (const name of [
		'search',
		'search_boards',
		'create_board',
		'rename_board',
		'open_board',
		'list_open_boards',
		'exec',
		'screenshot',
	]) {
		assert.ok(names.includes(name), name)
	}
	const resources = await client.listResources()
	assert.ok(resources.resources.some((resource) => resource.uri === 'ui://tldraw/canvas.html'))
	const read = await client.readResource({ uri: 'ui://tldraw/canvas.html' })
	const html = read.contents.map((item) => ('text' in item ? item.text : '')).join('')
	assert.match(html, /__TLDRAW_BOOTSTRAP__/)
	assert.match(html, /tldraw/)
})

test('search, search_boards, create_board, rename_board, open_board, and list_open_boards', async () => {
	const found = await callTool(client, 'search', {
		code: `return spec.helpers.filter(h => h.name === 'createMermaidDiagram').map(h => h.name)`,
	})
	assert.deepEqual(found.json, ['createMermaidDiagram'])

	const home = await callTool(client, 'open_board', { action: 'home' })
	assert.equal(home.json.action, 'home')
	assert.match(home.json.url, /\/$/)

	const created = await callTool(client, 'create_board', { name: 'Roadmap', workspace: '设计组' })
	assert.equal(created.json.name, 'Roadmap')
	assert.equal(created.json.workspace.name, '设计组')
	assert.equal(created.json.workspace.personal, false)
	assert.match(created.json.url, /\/b\//)

	const personal = await callTool(client, 'create_board', { name: 'Personal sketch' })
	assert.equal(personal.json.workspace.personal, true)

	const renamed = await callTool(client, 'rename_board', { boardId: personal.json.boardId, name: 'Sketch v2' })
	assert.equal(renamed.json.previousName, 'Personal sketch')
	assert.equal(renamed.json.name, 'Sketch v2')

	const page1 = await callTool(client, 'search_boards', { query: 'sketch' })
	assert.equal(page1.json.boardCount, 1)
	assert.equal(page1.json.boards[0].source, 'owned')
	assert.equal(page1.json.boards[0].workspaceName, undefined)

	const team = await callTool(client, 'search_boards', { query: 'roadmap' })
	assert.equal(team.json.boards[0].source, 'workspace')
	assert.equal(team.json.boards[0].workspaceName, '设计组')

	server.runtime.library.markShared(created.json.boardId, 'view')
	const shared = await callTool(client, 'search_boards', { query: 'roadmap' })
	assert.equal(shared.json.boards[0].source, 'shared')
	assert.equal(shared.json.boards[0].workspaceName, undefined)
	await assert.rejects(
		callTool(client, 'rename_board', { boardId: created.json.boardId, name: 'stolen' }),
		/shared with you by link/,
	)

	const empty = await callTool(client, 'search_boards', { query: 'no-such-board' })
	assert.equal(empty.json.boardCount, 0)
	assert.equal(empty.json.boards.length, 0)

	const opened = await callTool(client, 'open_board', {
		action: 'open',
		boardId: personal.json.boardId,
		name: 'this name is only a hint',
	})
	assert.equal(opened.json.boardId, personal.json.boardId)
	assert.equal(opened.json.name, 'Sketch v2')
	assert.equal(opened.json.readOnly, false)
	assert.equal(opened.json.uri, `tldraw://board/${personal.json.boardId}`)

	const listed = await callTool(client, 'list_open_boards', {})
	assert.ok(listed.json.boards.some((board: { boardId: string }) => board.boardId === personal.json.boardId))

	await assert.rejects(callTool(client, 'open_board', { action: 'open' }), /boardId is required/)
	await assert.rejects(
		callTool(client, 'open_board', { action: 'open', boardId: 'https://example.com/nope' }),
		/not a URL/,
	)
})

test('search_boards pages 20 at a time', async () => {
	for (let i = 0; i < 21; i++) {
		await callTool(client, 'create_board', { name: `Paging ${String(i).padStart(2, '0')}` })
	}
	const first = await callTool(client, 'search_boards', { query: 'paging' })
	assert.equal(first.json.boardCount, 20)
	assert.ok(first.json.nextCursor)
	const second = await callTool(client, 'search_boards', { query: 'paging', cursor: first.json.nextCursor })
	assert.equal(second.json.boardCount, 1)
	assert.equal(second.json.nextCursor, undefined)
	const ids = new Set([
		...first.json.boards.map((board: { boardId: string }) => board.boardId),
		second.json.boards[0].boardId,
	])
	assert.equal(ids.size, 21)
})

test('create_board rate limit is 10 per minute', async () => {
	const limited = await startTestServer({ createPerMinute: 10, userId: 'rate-user' })
	const local = await connectClient(limited.origin)
	try {
		for (let i = 0; i < 10; i++) await callTool(local, 'create_board', { name: `rate ${i}` })
		await assert.rejects(callTool(local, 'create_board', { name: 'rate overflow' }), /per minute/)
	} finally {
		await local.close()
		await stopTestServer(limited)
	}
})

test('exec draws, squashes undo, discards errors, and screenshots', async () => {
	const { created, page } = await boardWithView('Draw')
	const boardId = created.boardId
	try {
		await assert.rejects(
			callTool(client, 'exec', { boardId: 'not-open-board', code: 'return 1' }),
			/not open|No board was found/,
		)

		const drawn = await callTool(client, 'exec', {
			boardId,
			code: `
				const a = helpers.createShapeId('a')
				const b = helpers.createShapeId('b')
				editor.createShape({ id: a, type: 'geo', x: 40, y: 40, props: ${GEO} })
				editor.createShape({ id: b, type: 'geo', x: 40, y: 160, props: ${GEO} })
				const arrow = helpers.createArrowBetweenShapes('a', 'b', { text: 'next' })
				return { count: editor.getCurrentPageShapes().length, arrow }
			`,
		})
		assert.equal(drawn.json.boardId, boardId)
		assert.equal(drawn.json.result.count, 3)
		assert.ok(drawn.json.changes.added >= 3)
		assert.equal(await page.evaluate(() => window.__tldrawEditor.getCurrentPageShapes().length), 3)

		const undone = await callTool(client, 'exec', {
			boardId,
			code: `editor.undo(); return editor.getCurrentPageShapes().length`,
		})
		assert.equal(undone.json.result, 0)

		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `
					editor.createShape({ id: helpers.createShapeId('gone'), type: 'geo', x: 0, y: 0, props: ${GEO} })
					throw new Error('discard me')
				`,
			}),
			/discard me/,
		)
		assert.equal(await page.evaluate(() => window.__tldrawEditor.getCurrentPageShapes().length), 0)

		await callTool(client, 'exec', {
			boardId,
			code: `editor.createShape({ id: helpers.createShapeId('shot'), type: 'geo', x: 20, y: 20, props: ${GEO} }); return true`,
		})
		const shot = await callTool(client, 'screenshot', { boardId, scope: 'page' })
		assert.equal(shot.json.boardId, boardId)
		assert.equal(shot.image?.mimeType, 'image/png')
		assert.ok(shot.image && Buffer.from(shot.image.data, 'base64').subarray(0, 8).toString('hex').startsWith('89504e47'))

		await callTool(client, 'exec', {
			boardId,
			code: `editor.select(helpers.createShapeId('shot')); return editor.getSelectedShapeIds().length`,
		})
		const selection = await callTool(client, 'screenshot', { boardId, scope: 'selection' })
		assert.equal(selection.json.scope, 'selection')
		assert.ok(selection.image)

		const viewport = await callTool(client, 'screenshot', { boardId, scope: 'viewport', theme: 'dark' })
		assert.equal(viewport.json.scope, 'viewport')
	} finally {
		await page.close()
	}
})

test('a concurrent edit to a touched record discards the exec and keeps the remote change', async () => {
	const { created, page: pageA } = await boardWithView('Conflict')
	const pageB = await newPage()
	const boardId = created.boardId
	try {
		await openCanvas(pageB, `${server.origin}/b/${boardId}`)
		const pending = callTool(client, 'exec', {
			boardId,
			code: `
				const id = helpers.createShapeId('box')
				editor.createShape({ id, type: 'geo', x: 10, y: 10, props: ${GEO} })
				await new Promise((resolve) => { window.__cont = resolve })
				const shape = editor.getShape(id)
				editor.updateShape({ id, type: 'geo', x: shape.x + 5 })
				return editor.getShape(id).x
			`,
		})
		const failure = pending.then(
			() => null,
			(error: Error) => error,
		)
		await pageB.waitForFunction(
			() => window.__tldrawEditor?.getCurrentPageShapes().some((shape) => shape.id === 'shape:box'),
			undefined,
			{ timeout: 20_000 },
		)
		await pageB.evaluate(() => {
			window.__tldrawEditor.updateShape({ id: 'shape:box', type: 'geo', x: 999 })
		})
		await pageA.waitForFunction(() => window.__tldrawEditor?.getShape('shape:box')?.x === 999, undefined, {
			timeout: 20_000,
		})
		await pageA.evaluate(() => window.__cont?.())
		const error = await failure
		assert.ok(error)
		assert.match(error.message, /discarded|concurrent/)
		const x = await pageA.evaluate(() => window.__tldrawEditor.getShape('shape:box')?.x)
		assert.equal(x, 999)
	} finally {
		await pageA.close()
		await pageB.close()
	}
})

test('comments survive undo and a thrown exec, refuse edits, and reject resolved replies', async () => {
	const { created, page } = await boardWithView('Comments')
	const boardId = created.boardId
	try {
		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `
					const id = helpers.createShapeId('card')
					editor.createShape({ id, type: 'geo', x: 0, y: 0, props: ${GEO} })
					const posted = helpers.addComment('keep me', { shapeId: 'card' })
					throw new Error('shape goes, comment stays')
				`,
			}),
			/comment stays/,
		)
		assert.equal(await page.evaluate(() => window.__tldrawEditor.getCurrentPageShapes().length), 0)
		const read = await callTool(client, 'exec', {
			boardId,
			code: `return helpers.getComments().map(t => ({ text: t.comments.map(c => c.text).join(''), resolved: t.resolved, shapeId: t.anchor.shapeId }))`,
		})
		assert.equal(read.json.result.length, 1)
		assert.equal(read.json.result[0].text, 'keep me')
		assert.equal(read.json.result[0].resolved, false)
		assert.equal(read.json.result[0].shapeId, 'shape:card')

		await callTool(client, 'exec', {
			boardId,
			code: `editor.createShape({ id: helpers.createShapeId('undo-me'), type: 'geo', x: 0, y: 200, props: ${GEO} }); return 1`,
		})
		const undone = await callTool(client, 'exec', {
			boardId,
			code: `
				editor.undo()
				return { shapes: editor.getCurrentPageShapes().length, comments: helpers.getComments().length }
			`,
		})
		assert.equal(undone.json.result.shapes, 0)
		assert.equal(undone.json.result.comments, 1)

		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `
					const thread = helpers.getComments()[0]
					editor.store.remove([thread.id])
					return 'should not'
				`,
			}),
			/refuses to change or remove comment/,
		)
		const still = await callTool(client, 'exec', { boardId, code: `return helpers.getComments().length` })
		assert.equal(still.json.result, 1)

		await page.evaluate(() => {
			const editor = window.__tldrawEditor
			const thread = editor.store.allRecords().find((record) => record.typeName === 'comment-thread')
			editor.store.put([{ ...thread, resolved: { at: Date.now(), by: 'local-user' } }])
		})
		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `
					const thread = helpers.getComments()[0]
					return helpers.addComment('too late', { threadId: thread.id })
				`,
			}),
			/resolved/,
		)
	} finally {
		await page.close()
	}
})

test('a signed-out connection cannot add comments', async () => {
	const signedOut = await startTestServer({ signedIn: false, userId: 'guest' })
	const local = await connectClient(signedOut.origin)
	const page = await newPage()
	try {
		const created = await callTool(local, 'create_board', { name: 'Guest' })
		const opened = await callTool(local, 'open_board', { action: 'open', boardId: created.json.boardId })
		await openCanvas(page, opened.json.url)
		await assert.rejects(
			callTool(local, 'exec', {
				boardId: created.json.boardId,
				code: `return helpers.addComment('nope', { x: 10, y: 10 })`,
			}),
			/not signed in/,
		)
		const drawn = await callTool(local, 'exec', {
			boardId: created.json.boardId,
			code: `editor.createShape({ id: helpers.createShapeId('ok'), type: 'geo', x: 0, y: 0, props: ${GEO} }); return editor.getCurrentPageShapes().length`,
		})
		assert.equal(drawn.json.result, 1)
	} finally {
		await page.close()
		await local.close()
		await stopTestServer(signedOut)
	}
})

test('a view-only board rejects exec and still opens', async () => {
	const created = await callTool(client, 'create_board', { name: 'Locked' })
	server.runtime.library.markShared(created.json.boardId, 'view')
	const opened = await callTool(client, 'open_board', { action: 'open', boardId: created.json.boardId })
	assert.equal(opened.json.readOnly, true)
	const started = Date.now()
	await assert.rejects(callTool(client, 'exec', { boardId: created.json.boardId, code: 'return 1' }), /view-only/)
	assert.ok(Date.now() - started < 5_000)
})

test('mermaid kinds draw, and an unsupported kind draws nothing', async () => {
	const { created, page } = await boardWithView('Mermaid')
	const boardId = created.boardId
	const sources = {
		flowchart: 'flowchart TD\n  A[Write] --> B[Test]',
		sequence: 'sequenceDiagram\n  Alice->>Bob: hello',
		state: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Done',
		mindmap: 'mindmap\n  root\n    a\n    b',
	}
	try {
		for (const source of Object.values(sources)) {
			const drawn = await callTool(client, 'exec', {
				boardId,
				code: `
					const before = editor.getCurrentPageShapes().length
					const diagram = await helpers.createMermaidDiagram(${JSON.stringify(source)}, { blueprintRender: { position: { x: 0, y: before * 40 }, centerOnPosition: false } })
					return { before, after: editor.getCurrentPageShapes().length, root: diagram.rootShapeId, n: diagram.shapeIds.length }
				`,
			})
			assert.ok(drawn.json.result.n > 0, source)
			assert.ok(drawn.json.result.after > drawn.json.result.before, source)
			assert.ok(drawn.json.result.root)
		}
		const before = await callTool(client, 'exec', { boardId, code: `return editor.getCurrentPageShapes().length` })
		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `await helpers.createMermaidDiagram('classDiagram\\n  class Animal'); return 'drew'`,
			}),
			/classDiagram/,
		)
		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `await helpers.createMermaidDiagram('stateDiagram\\n  [*] --> Idle'); return 'drew'`,
			}),
			/stateDiagram/,
		)
		const after = await callTool(client, 'exec', { boardId, code: `return editor.getCurrentPageShapes().length` })
		assert.equal(after.json.result, before.json.result)
	} finally {
		await page.close()
	}
})

test('addImage copies a public image into local assets and rejects the rest', async () => {
	const { created, page } = await boardWithView('Images')
	const boardId = created.boardId
	try {
		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `await helpers.addImage('http://localhost/secret.png'); return 'no'`,
			}),
			/public http/,
		)
		await assert.rejects(
			callTool(client, 'exec', {
				boardId,
				code: `await helpers.addImage('https://huge.example/big.png'); return 'no'`,
			}),
			/5 MB/,
		)
		assert.equal(await page.evaluate(() => window.__tldrawEditor.getCurrentPageShapes().length), 0)

		const placed = await callTool(client, 'exec', {
			boardId,
			code: `return await helpers.addImage('https://example.com/pixel.png', { x: 12, y: 24, w: 40, id: 'pixel' })`,
		})
		assert.equal(placed.json.result.shapeId, 'shape:pixel')
		assert.equal(placed.json.result.bounds.w, 40)
		assert.equal(placed.json.result.bounds.h, 40)
		assert.equal(placed.json.result.bounds.x, 12)
		assert.equal(placed.json.result.bounds.y, 24)
		const meta = server.runtime.library.requireBoard(boardId)
		const assetFile = server.runtime.library.assetPath(meta, placed.json.result.assetId)
		assert.equal(existsSync(assetFile), true)
		assert.equal(readFileSync(assetFile).length, PNG_1X1.length)

		const tldr = JSON.parse(readFileSync(server.runtime.library.tldrPath(meta), 'utf8'))
		assert.equal(tldr.tldrawFileFormatVersion, 1)
		assert.ok(tldr.records.some((record: { typeName: string }) => record.typeName === 'shape'))
		assert.ok(!tldr.records.some((record: { typeName: string }) => String(record.typeName).startsWith('comment')))
	} finally {
		await page.close()
	}
})

test('stdio transport lists the same tools', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'tldraw-stdio-'))
	const stdio = new Client({ name: 'stdio-test', version: '1.1.0' })
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.resolve('dist/cli.js'), 'stdio'],
		env: {
			...process.env,
			TLDRAW_BOARDS_DIR: dir,
			TLDRAW_PORT: '0',
		} as Record<string, string>,
		stderr: 'pipe',
	})
	try {
		await stdio.connect(transport)
		const listed = await stdio.listTools()
		const names = listed.tools.map((tool) => tool.name)
		assert.ok(names.includes('exec'))
		assert.ok(names.includes('open_board'))
		const health = await callTool(stdio, 'search', { code: 'return spec.types.shapes.length > 0' })
		assert.equal(health.json, true)
	} finally {
		await stdio.close().catch(() => {})
		await rm(dir, { recursive: true, force: true })
	}
})

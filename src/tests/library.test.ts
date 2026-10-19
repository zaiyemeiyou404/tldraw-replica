import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { importPublicImage } from '../images.js'
import { detectMermaidKind } from '../shared/mermaidKind.js'
import { runSearch } from '../runSearch.js'
import { BoardLibrary } from '../store.js'

const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
)

test('search reads spec.members, spec.types.shapes, and spec.helpers', async () => {
	const members = (await runSearch(
		`return spec.members.filter(m => m.name === 'createShape').map(m => m.name)`,
	)) as string[]
	assert.deepEqual(members, ['createShape'])
	const helpers = (await runSearch(`return spec.helpers.map(h => h.name)`)) as string[]
	assert.deepEqual(helpers, [
		'createShapeId',
		'toRichText',
		'createArrowBetweenShapes',
		'addImage',
		'createMermaidDiagram',
		'getComments',
		'addComment',
	])
	const shapes = (await runSearch(`return spec.types.shapes.map(s => s.type)`)) as string[]
	assert.ok(shapes.includes('geo'))
	assert.ok(shapes.includes('arrow'))
	await assert.rejects(runSearch(`while (true) {}`), /timed out|Script execution timed out/)
})

test('mermaid kinds match the skill and reject the rest', () => {
	assert.equal(detectMermaidKind('flowchart TD\nA-->B'), 'flowchart')
	assert.equal(detectMermaidKind('graph LR\nA-->B'), 'flowchart')
	assert.equal(detectMermaidKind('sequenceDiagram\nAlice->>Bob: hi'), 'sequenceDiagram')
	assert.equal(detectMermaidKind('stateDiagram-v2\n[*] --> Idle'), 'stateDiagram-v2')
	assert.equal(detectMermaidKind('mindmap\nroot\n  a'), 'mindmap')
	assert.throws(() => detectMermaidKind('stateDiagram\n[*] --> Idle'), /stateDiagram/)
	assert.throws(() => detectMermaidKind('classDiagram\nclass Animal'), /classDiagram/)
	assert.throws(() => detectMermaidKind('erDiagram\nA ||--o{ B : has'), /erDiagram/)
	assert.throws(() => detectMermaidKind('pie\n"a" : 1'), /pie/)
})

test('boards: workspace resolution, rate limit, rename, and search pages', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'tldraw-lib-'))
	try {
		const library = new BoardLibrary({
			root,
			userId: 'local-user',
			extraWorkspaces: ['设计组', '设计组'],
			createPerMinute: 10,
		})
		assert.equal(library.listWorkspaces().filter((workspace) => workspace.name === '设计组').length, 1)
		const personal = library.createBoard('  Home notes  ', null, 1_000)
		assert.equal(personal.name, 'Home notes')
		const team = library.createBoard('评审', '设计组', 2_000)
		assert.equal(library.sourceOf(team), 'workspace')
		assert.equal(library.sourceOf(personal), 'owned')
		assert.throws(() => library.resolveWorkspace('没有'), /No workspace/)
		library.config.workspaces.push({
			id: 'ws_dup',
			name: '设计组',
			personal: false,
			role: 'owner',
		})
		assert.throws(() => library.resolveWorkspace('设计组'), /More than one/)
		assert.throws(() => library.createBoard('   ', null), /name is required/)
		assert.throws(() => library.createBoard('x'.repeat(201), null), /200/)

		const renamed = library.renameBoard(personal.id, 'Renamed')
		assert.equal(renamed.previousName, 'Home notes')
		assert.equal(renamed.board.name, 'Renamed')
		library.markShared(team.id, 'view')
		assert.throws(() => library.renameBoard(team.id, 'nope'), /shared with you by link/)
		assert.throws(() => library.renameBoard('missing-board', 'nope'), /No board was found/)

		const limited = new BoardLibrary({ root: path.join(root, 'rate'), createPerMinute: 10, userId: 'rate-user' })
		for (let i = 0; i < 10; i++) limited.createBoard(`n${i}`, null, 10_000 + i)
		assert.throws(() => limited.createBoard('overflow', null, 10_100), /per minute/)

		const paging = new BoardLibrary({ root: path.join(root, 'page'), createPerMinute: 100, userId: 'page-user' })
		for (let i = 0; i < 21; i++) paging.createBoard(`Alpha ${String(i).padStart(2, '0')}`, null, 50_000 + i)
		const first = paging.search(['alpha'], null)
		assert.equal(first.boardCount, 20)
		assert.ok(first.nextCursor)
		const { parseSearchBoardsInput } = await import('../searchBoards.js')
		const parsed = parseSearchBoardsInput({ query: 'alpha', cursor: first.nextCursor })
		const next = paging.search(parsed.terms, parsed.cursor)
		assert.equal(next.boardCount, 1)
		assert.equal(next.nextCursor, undefined)
		assert.equal(paging.search(['zzz'], null).boardCount, 0)
		assert.throws(() => parseSearchBoardsInput({ query: 'one two three four five six seven eight nine' }), /8 words/)
		assert.throws(() => parseSearchBoardsInput({ query: 'a'.repeat(201) }), /200/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('images accept a public http(s) bitmap and reject private or oversized URLs', async () => {
	const lookup = async () => [{ address: '93.184.216.34' }]
	const imported = await importPublicImage('https://example.com/pixel.png', {
		lookup,
		fetch: async () =>
			new Response(PNG_1X1, {
				status: 200,
				headers: { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) },
			}),
	})
	assert.equal(imported.mimeType, 'image/png')
	assert.equal(imported.w, 1)
	assert.equal(imported.h, 1)
	assert.equal(imported.bytes.length, PNG_1X1.length)

	await assert.rejects(importPublicImage('http://127.0.0.1/a.png', { lookup, fetch: async () => new Response() }), /public http/)
	await assert.rejects(importPublicImage('http://localhost/a.png'), /public http/)
	await assert.rejects(importPublicImage('file:///etc/passwd'), /public http/)
	await assert.rejects(
		importPublicImage('https://example.com/huge.png', {
			lookup,
			fetch: async () =>
				new Response(new Uint8Array(8), {
					status: 200,
					headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
				}),
		}),
		/5 MB/,
	)
	await assert.rejects(
		importPublicImage('https://example.com/secret.png', {
			lookup: async () => [{ address: '10.1.2.3' }],
			fetch: async () => new Response(PNG_1X1),
		}),
		/public http/,
	)
	await assert.rejects(
		importPublicImage('https://example.com/page.html', {
			lookup,
			fetch: async () =>
				new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
		}),
		/public http/,
	)
})

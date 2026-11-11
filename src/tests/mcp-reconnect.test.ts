import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startHttpServer, type RunningServer } from '../server.js'

const ACCEPT = 'application/json, text/event-stream'

async function start() {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'tldraw-mcp-'))
	const server = await startHttpServer({
		port: 0,
		boardsDir: dir,
		canvasHtml: '<!doctype html><html><head></head><body></body></html>',
	})
	return { dir, server }
}

async function stop(server: RunningServer | undefined, dir: string) {
	await server?.close()
	await rm(dir, { recursive: true, force: true })
}

test('GET and DELETE /mcp are 405 so Codex does not reconnect an empty SSE stream', async () => {
	const { dir, server } = await start()
	try {
		const headers = {
			accept: 'text/event-stream, application/json',
			'mcp-session-id': 'stale-session',
			'mcp-protocol-version': '2025-11-25',
		}
		for (const method of ['GET', 'DELETE'] as const) {
			const started = Date.now()
			const response = await fetch(`${server.origin}/mcp`, {
				method,
				headers,
				signal: AbortSignal.timeout(1000),
			})
			const body = (await response.json()) as { error?: { message?: string } }
			assert.equal(response.status, 405, method)
			assert.equal(response.headers.get('allow'), 'POST')
			assert.match(body.error?.message ?? '', /Method not allowed/)
			assert.ok(Date.now() - started < 1000, `${method} hung`)
		}
		const probe = await fetch(`${server.origin}/mcp`, {
			method: 'GET',
			headers: { accept: '*/*' },
			signal: AbortSignal.timeout(1000),
		})
		assert.equal(probe.status, 405)
	} finally {
		await stop(server, dir)
	}
})

test('initialize issues an Mcp-Session-Id and later requests echo it', async () => {
	const { dir, server } = await start()
	try {
		const init = await fetch(`${server.origin}/mcp`, {
			method: 'POST',
			headers: { accept: ACCEPT, 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					clientInfo: { name: 'gpt', version: '0' },
				},
			}),
		})
		const issued = init.headers.get('mcp-session-id')
		assert.equal(init.status, 200)
		assert.match(init.headers.get('content-type') ?? '', /^application\/json/)
		assert.ok(issued)
		const body = await init.json()
		assert.equal(body.result.serverInfo.name, 'tldraw-local')

		const again = await fetch(`${server.origin}/mcp`, {
			method: 'POST',
			headers: {
				accept: ACCEPT,
				'content-type': 'application/json',
				'mcp-session-id': issued!,
				'mcp-protocol-version': '2025-11-25',
			},
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		})
		assert.equal(again.status, 202)
		assert.equal(again.headers.get('mcp-session-id'), issued)
	} finally {
		await stop(server, dir)
	}
})

test('Codex can initialize again after the previous client closes', async () => {
	const { dir, server } = await start()
	const clients: Client[] = []
	try {
		for (const name of ['first', 'reconnect']) {
			const client = new Client({ name, version: '1.1.0' })
			const transport = new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`))
			clients.push(client)
			await client.connect(transport)
			assert.ok(transport.sessionId, `${name} received no session id`)
			const listed = await client.listTools()
			assert.ok(listed.tools.some((tool) => tool.name === 'search_boards'))
		}
		const listed = await fetch(`${server.origin}/mcp`, {
			method: 'POST',
			headers: {
				accept: ACCEPT,
				'content-type': 'application/json',
				'mcp-session-id': 'session-from-a-previous-process',
				'mcp-protocol-version': '2025-11-25',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
			signal: AbortSignal.timeout(5000),
		})
		assert.equal(listed.status, 200)
		assert.match(listed.headers.get('content-type') ?? '', /^application\/json/)
		const text = await listed.text()
		assert.match(text, /search_boards/)
		assert.equal(listed.headers.get('mcp-session-id'), 'session-from-a-previous-process')
	} finally {
		await Promise.all(clients.map((client) => client.close().catch(() => {})))
		await stop(server, dir)
	}
})

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

test('the canvas origin follows the proxy that forwarded the request', async () => {
	const { dir, server } = await start()
	try {
		const response = await fetch(`${server.origin}/`, {
			headers: { 'x-forwarded-host': '127.0.0.1:8791', 'x-forwarded-proto': 'http' },
		})
		const html = await response.text()
		assert.match(html, /http:\/\/127\.0\.0\.1:8791/)
	} finally {
		await stop(server, dir)
	}
})

test('GET /mcp stays open and writes a comment before the proxy would reconnect', async () => {
	const { dir, server } = await start()
	try {
		const started = Date.now()
		const response = await fetch(`${server.origin}/mcp`, {
			method: 'GET',
			headers: {
				accept: 'text/event-stream, application/json',
				'mcp-session-id': 'stale-session',
				'mcp-protocol-version': '2025-11-25',
			},
		})
		assert.equal(response.status, 200)
		assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
		const reader = response.body?.getReader()
		assert.ok(reader)
		const first = await reader.read()
		assert.equal(first.done, false)
		assert.match(new TextDecoder().decode(first.value), /: connected/)
		assert.ok(Date.now() - started < 1000)
		await reader.cancel()

		const probe = await fetch(`${server.origin}/mcp`, {
			method: 'GET',
			headers: { accept: '*/*' },
		})
		assert.equal(probe.status, 200)
		await probe.body?.cancel()
	} finally {
		await stop(server, dir)
	}
})

test('DELETE /mcp is 405', async () => {
	const { dir, server } = await start()
	try {
		const response = await fetch(`${server.origin}/mcp`, {
			method: 'DELETE',
			headers: { accept: 'text/event-stream, application/json', 'mcp-session-id': 'stale-session' },
			signal: AbortSignal.timeout(1000),
		})
		const body = (await response.json()) as { error?: { message?: string } }
		assert.equal(response.status, 405)
		assert.equal(response.headers.get('allow'), 'POST')
		assert.match(body.error?.message ?? '', /Method not allowed/)
	} finally {
		await stop(server, dir)
	}
})

test('POST does not mint a session id, and echoes one the client already sent', async () => {
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
		assert.equal(init.status, 200)
		assert.match(init.headers.get('content-type') ?? '', /^application\/json/)
		assert.equal(init.headers.get('mcp-session-id'), null)
		const body = (await init.json()) as {
			result: {
				serverInfo: { name: string }
				capabilities: { tools?: { listChanged?: boolean }; resources?: { listChanged?: boolean } }
			}
		}
		assert.equal(body.result.serverInfo.name, 'tldraw-local')
		assert.notEqual(body.result.capabilities.tools?.listChanged, true)
		assert.notEqual(body.result.capabilities.resources?.listChanged, true)

		const listed = await fetch(`${server.origin}/mcp`, {
			method: 'POST',
			headers: {
				accept: ACCEPT,
				'content-type': 'application/json',
				'mcp-protocol-version': '2025-11-25',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
		})
		assert.equal(listed.status, 200)
		assert.equal(listed.headers.get('mcp-session-id'), null)
		await listed.text()

		const echoed = await fetch(`${server.origin}/mcp`, {
			method: 'POST',
			headers: {
				accept: ACCEPT,
				'content-type': 'application/json',
				'mcp-session-id': 'session-from-the-client',
				'mcp-protocol-version': '2025-11-25',
			},
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		})
		assert.equal(echoed.status, 202)
		assert.equal(echoed.headers.get('mcp-session-id'), 'session-from-the-client')
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
			assert.equal(transport.sessionId, undefined)
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

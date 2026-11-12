import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as syncCore from '@tldraw/sync-core'
import {
	commentSchemaRecords,
	createTLSchema,
	defaultBindingSchemas,
	defaultShapeSchemas,
} from '@tldraw/tlschema'
import { WebSocket } from 'ws'
import { startHttpServer, type RunningServer } from '../server.js'

const schema = createTLSchema({
	shapes: defaultShapeSchemas,
	bindings: defaultBindingSchemas,
	records: commentSchemaRecords,
})

function connectMessage() {
	return JSON.stringify({
		type: 'connect',
		connectRequestId: `req-${Math.random().toString(16).slice(2)}`,
		schema: schema.serialize(),
		protocolVersion: (syncCore as unknown as { getTlsyncProtocolVersion(): number }).getTlsyncProtocolVersion(),
		lastServerClock: 0,
	})
}

function openSocket(url: string) {
	const ws = new WebSocket(url)
	const messages: string[] = []
	ws.on('message', (data) => messages.push(String(data)))
	return {
		ws,
		messages,
		opened: new Promise<void>((resolve, reject) => {
			ws.once('open', () => resolve())
			ws.once('error', reject)
		}),
	}
}

async function waitFor(check: () => boolean, timeoutMs = 1000) {
	const started = Date.now()
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error('timed out')
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

test('a replaced sync socket can close without dropping the new session', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'tldraw-reconnect-'))
	let server: RunningServer | undefined
	try {
		server = await startHttpServer({
			port: 0,
			boardsDir: dir,
			canvasHtml: '<!doctype html><html><head></head><body></body></html>',
		})
		const board = server.runtime.library.createBoard('reconnect', null)
		const url = `${server.origin.replace(/^http/, 'ws')}/api/connect/${board.id}?sessionId=tab-1`
		const first = openSocket(url)
		await first.opened
		first.ws.send(connectMessage())
		await waitFor(() => first.messages.some((message) => message.includes('"type":"connect"')))

		const second = openSocket(url)
		await second.opened
		second.ws.send(connectMessage())
		await waitFor(() => second.messages.some((message) => message.includes('"type":"connect"')))

		first.ws.close()
		await new Promise((resolve) => setTimeout(resolve, 300))
		assert.equal(second.ws.readyState, WebSocket.OPEN)

		second.ws.send(JSON.stringify({ type: 'ping' }))
		await waitFor(() => second.messages.some((message) => message.includes('"type":"pong"')))
		assert.equal(second.ws.readyState, WebSocket.OPEN)
		second.ws.close()
	} finally {
		await server?.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('the exec bridge accepts a new socket after the previous one closes', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'tldraw-bridge-'))
	let server: RunningServer | undefined
	try {
		server = await startHttpServer({
			port: 0,
			boardsDir: dir,
			canvasHtml: '<!doctype html><html><head></head><body></body></html>',
			viewTimeoutMs: 2000,
		})
		const board = server.runtime.library.createBoard('bridge', null)
		server.runtime.markOpen(board)
		const url = `${server.origin.replace(/^http/, 'ws')}/api/bridge/${board.id}`
		const first = openSocket(url)
		await first.opened
		await waitFor(() => first.messages.some((message) => message.includes('"type":"welcome"')))
		assert.equal(server.runtime.listOpen()[0]?.connectedViews, 1)

		first.ws.close()
		await waitFor(() => server?.runtime.listOpen()[0]?.connectedViews === 0)

		const execPromise = server.runtime.exec(board.id, 'return 1')
		const second = openSocket(url)
		await second.opened
		await waitFor(() => second.messages.some((message) => message.includes('"type":"exec"')))
		second.ws.send(
			JSON.stringify({
				type: 'exec-result',
				code: 'return 1',
				ok: true,
				result: 1,
				changes: { added: 0, updated: 0, removed: 0 },
			}),
		)
		const payload = await execPromise
		assert.equal(payload.result, 1)
		assert.equal(server.runtime.listOpen()[0]?.connectedViews, 1)
		second.ws.close()
	} finally {
		await server?.close()
		await rm(dir, { recursive: true, force: true })
	}
})

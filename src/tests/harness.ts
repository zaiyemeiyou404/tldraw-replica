import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Page } from 'playwright'
import { startHttpServer, type RunningServer, type StartOptions } from '../server.js'

export interface TestServer extends RunningServer {
	dir: string
}

export async function startTestServer(
	opts: Partial<StartOptions> & { dir?: string } = {},
): Promise<TestServer> {
	const dir = opts.dir ?? (await mkdtemp(path.join(os.tmpdir(), 'tldraw-replica-')))
	const running = await startHttpServer({
		port: 0,
		createPerMinute: 1_000,
		viewTimeoutMs: 20_000,
		...opts,
		boardsDir: dir,
	})
	return Object.assign(running, { dir })
}

export async function stopTestServer(server: TestServer) {
	await server.close()
	await rm(server.dir, { recursive: true, force: true })
}

export async function connectClient(origin: string) {
	const client = new Client({ name: 'tldraw-replica-test', version: '1.1.0' })
	const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`))
	await client.connect(transport)
	return client
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args })
	const blocks = Array.isArray(result.content) ? result.content : []
	const text = blocks
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
	const image = blocks.find(
		(block): block is { type: 'image'; data: string; mimeType: string } => block.type === 'image',
	)
	if (result.isError) {
		throw new Error(text || `${name} failed`)
	}
	let json: any = null
	if (text) {
		try {
			json = JSON.parse(text)
		} catch {
			json = text
		}
	}
	return { json, text, image, result }
}

export async function openCanvas(page: Page, url: string) {
	page.on('pageerror', (error) => {
		console.error('pageerror', error.message)
	})
	page.on('console', (msg) => {
		if (msg.type() === 'error' || msg.type() === 'warning') {
			console.error('browser', msg.type(), msg.text())
		}
	})
	await page.goto(url, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(
		() => (window as unknown as { __tldrawReady?: boolean }).__tldrawReady === true || document.body.innerText.includes('连接失败'),
		undefined,
		{ timeout: 90_000 },
	)
	const ready = await page.evaluate(() => (window as unknown as { __tldrawReady?: boolean }).__tldrawReady === true)
	if (!ready) {
		const text = await page.locator('body').innerText()
		throw new Error(`canvas did not become ready:\n${text.slice(0, 800)}`)
	}
}

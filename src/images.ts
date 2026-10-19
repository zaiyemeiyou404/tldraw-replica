import { lookup } from 'node:dns/promises'
import { MAX_IMAGE_BYTES } from './shared/protocol.js'

export interface ImageLookup {
	(hostname: string): Promise<Array<{ address: string }>>
}

export interface ImportedImage {
	bytes: Buffer
	mimeType: string
	w: number
	h: number
}

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal'])

export async function importPublicImage(
	rawUrl: string,
	deps?: { fetch?: typeof fetch; lookup?: ImageLookup },
): Promise<ImportedImage> {
	const fetchImpl = deps?.fetch ?? fetch
	const lookupImpl = deps?.lookup ?? defaultLookup
	let current = parsePublicHttpUrl(rawUrl)
	await assertPublicHost(current.hostname, lookupImpl)

	for (let hop = 0; hop < 3; hop++) {
		let response: Response
		try {
			response = await fetchImpl(current.href, {
				redirect: 'manual',
				headers: { accept: 'image/*', 'user-agent': 'tldraw-local-replica/1.1.0' },
			})
		} catch {
			throw new Error(`The host refused the image request (${current.hostname}).`)
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location')
			if (!location) throw new Error('The host refused the image request (redirect with no location).')
			current = parsePublicHttpUrl(new URL(location, current).href)
			await assertPublicHost(current.hostname, lookupImpl)
			continue
		}
		if (!response.ok) {
			throw new Error(`The host refused the image request (HTTP ${response.status}).`)
		}
		const declared = Number(response.headers.get('content-length') ?? '0')
		if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
			throw new Error('The image is over 5 MB.')
		}
		const bytes = await readCapped(response)
		const sniffed = sniffImage(bytes)
		const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
		if (!sniffed) {
			throw new Error('The URL is not a public http(s) image.')
		}
		if (headerType && !headerType.startsWith('image/')) {
			throw new Error('The URL is not a public http(s) image.')
		}
		return { bytes, mimeType: sniffed.mimeType, w: sniffed.w, h: sniffed.h }
	}
	throw new Error('The host refused the image request (too many redirects).')
}

export function parsePublicHttpUrl(raw: string): URL {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error('The URL is not a public http(s) image.')
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('The URL is not a public http(s) image.')
	}
	if (url.username || url.password) {
		throw new Error('The URL is not a public http(s) image.')
	}
	const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
	if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
		throw new Error('The URL is not a public http(s) image.')
	}
	if (isPrivateAddress(host)) {
		throw new Error('The URL is not a public http(s) image.')
	}
	return url
}

async function assertPublicHost(hostname: string, lookupImpl: ImageLookup) {
	const host = hostname.replace(/^\[|\]$/g, '')
	if (isPrivateAddress(host)) {
		throw new Error('The URL is not a public http(s) image.')
	}
	let addresses: Array<{ address: string }>
	try {
		addresses = await lookupImpl(host)
	} catch {
		throw new Error(`The host refused the image request (${host} did not resolve).`)
	}
	if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new Error('The URL is not a public http(s) image.')
	}
}

async function defaultLookup(hostname: string) {
	const results = await lookup(hostname, { all: true, verbatim: true })
	return results.map((entry) => ({ address: entry.address }))
}

async function readCapped(response: Response): Promise<Buffer> {
	if (!response.body) throw new Error('The host refused the image request (empty body).')
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > MAX_IMAGE_BYTES) {
			await reader.cancel()
			throw new Error('The image is over 5 MB.')
		}
		chunks.push(value)
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

export function isPrivateAddress(address: string): boolean {
	const host = address.toLowerCase().replace(/^\[|\]$/g, '')
	if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
	const v4 = mapped ? mapped[1] : host
	const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)
	if (!parts) {
		// Unique-local and link-local IPv6.
		if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
		return false
	}
	const octets = parts.slice(1).map((part) => Number(part))
	if (octets.some((n) => n > 255)) return true
	const [a, b] = octets
	if (a === 0 || a === 10 || a === 127) return true
	if (a === 169 && b === 254) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a === 100 && b >= 64 && b <= 127) return true
	if (a === 255) return true
	return false
}

function sniffImage(bytes: Buffer): { mimeType: string; w: number; h: number } | null {
	if (bytes.length >= 24 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') {
		return { mimeType: 'image/png', w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		const size = jpegSize(bytes)
		if (!size) return null
		return { mimeType: 'image/jpeg', ...size }
	}
	if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
		return { mimeType: 'image/gif', w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) }
	}
	if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
		const size = webpSize(bytes)
		if (!size) return null
		return { mimeType: 'image/webp', ...size }
	}
	return null
}

function jpegSize(bytes: Buffer): { w: number; h: number } | null {
	let offset = 2
	while (offset + 8 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++
			continue
		}
		const marker = bytes[offset + 1]
		const length = bytes.readUInt16BE(offset + 2)
		if (marker >= 0xc0 && marker <= 0xc3) {
			return { h: bytes.readUInt16BE(offset + 5), w: bytes.readUInt16BE(offset + 7) }
		}
		if (length < 2) return null
		offset += 2 + length
	}
	return null
}

function webpSize(bytes: Buffer): { w: number; h: number } | null {
	const chunk = bytes.toString('ascii', 12, 16)
	if (chunk === 'VP8X' && bytes.length >= 30) {
		const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
		const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
		return { w, h }
	}
	if (chunk === 'VP8 ' && bytes.length >= 30) {
		return { w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff }
	}
	if (chunk === 'VP8L' && bytes.length >= 25) {
		const b0 = bytes[21]
		const b1 = bytes[22]
		const b2 = bytes[23]
		const b3 = bytes[24]
		const w = 1 + (((b1 & 0x3f) << 8) | b0)
		const h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
		return { w, h }
	}
	return null
}

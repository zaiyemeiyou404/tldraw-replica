/** Board ids are filesystem-safe. `tldraw://board/<id>` is accepted everywhere a boardId is. */

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export function parseBoardId(value: unknown, label = 'boardId'): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${label} is required`)
	}
	const uri = /^tldraw:\/\/board\/([^/?#]+)$/.exec(value)
	const id = uri ? decodeURIComponent(uri[1]) : value
	if (!uri && (value.includes('://') || value.includes('/'))) {
		throw new Error(
			`${label} must be a board id or a tldraw://board/<id> URI, not a URL`,
		)
	}
	if (!ID_RE.test(id)) {
		throw new Error(`${label} must be a board id, not a URL`)
	}
	return id
}

export function boardUri(boardId: string): string {
	return `tldraw://board/${boardId}`
}

export function createId(prefix?: string): string {
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	const body = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
	return prefix ? `${prefix}${body}` : body
}

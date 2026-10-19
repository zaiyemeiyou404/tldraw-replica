import {
	BOARD_SEARCH_MAX_QUERY_LENGTH,
	BOARD_SEARCH_MAX_TERMS,
	BOARD_SEARCH_PAGE_SIZE,
} from './shared/protocol.js'

export interface BoardSearchCursor {
	arrivedAt: number
	id: string
}

export interface BoardSearchRow extends BoardSearchCursor {
	name: string
	createdAt: number
	updatedAt: number
	workspaceName: string
	source: 'owned' | 'workspace' | 'shared'
}

export function parseSearchBoardsInput(input: unknown): {
	terms: string[]
	cursor: BoardSearchCursor | null
} {
	const value = requireObject(input ?? {})
	const terms = parseSearchTerms(value.query)
	return { terms, cursor: parseBoardSearchCursor(value.cursor, terms) }
}

function parseSearchTerms(value: unknown): string[] {
	if (value === undefined || value === null) return []
	if (typeof value !== 'string') throw new Error('query must be a string')
	if (value.length > BOARD_SEARCH_MAX_QUERY_LENGTH) {
		throw new Error(`query must be ${BOARD_SEARCH_MAX_QUERY_LENGTH} characters or fewer`)
	}
	const terms = value.split(/\s+/).filter((term) => term.length > 0)
	if (terms.length > BOARD_SEARCH_MAX_TERMS) {
		throw new Error(`query must be ${BOARD_SEARCH_MAX_TERMS} words or fewer`)
	}
	return terms
}

function parseBoardSearchCursor(value: unknown, terms: string[]): BoardSearchCursor | null {
	if (value === undefined || value === null) return null
	if (typeof value !== 'string') {
		throw new Error('cursor must be a string: the nextCursor from a previous search_boards result')
	}
	const invalid = new Error(
		'cursor is not valid. Omit it to start from the first page, or pass the nextCursor from a previous search_boards result.',
	)
	let decoded: string
	try {
		decoded = atob(value)
	} catch {
		throw invalid
	}
	const parts = decoded.split(':')
	if (parts.length !== 3) throw invalid
	const [timestampPart, idPart, queryPart] = parts
	if (!/^\d+$/.test(timestampPart)) throw invalid
	const arrivedAt = Number(timestampPart)
	let id: string
	let query: string
	try {
		id = decodeURIComponent(idPart)
		query = decodeURIComponent(queryPart)
	} catch {
		throw invalid
	}
	if (query !== normalizeSearchQuery(terms)) {
		throw new Error(
			'cursor is from a different query. Repeat the query it came from, or omit the cursor to start this one from its first page.',
		)
	}
	if (!Number.isSafeInteger(arrivedAt) || id.length === 0) throw invalid
	return { arrivedAt, id }
}

export function encodeBoardSearchCursor(cursor: BoardSearchCursor, terms: string[]): string {
	return btoa(
		`${cursor.arrivedAt}:${encodeURIComponent(cursor.id)}:${encodeURIComponent(normalizeSearchQuery(terms))}`,
	)
}

function normalizeSearchQuery(terms: string[]): string {
	return terms.map((term) => term.toLowerCase()).join(' ')
}

export function compareBoardSearchOrder(a: BoardSearchCursor, b: BoardSearchCursor): number {
	if (a.arrivedAt !== b.arrivedAt) return b.arrivedAt - a.arrivedAt
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

export function isAfterBoardSearchCursor(row: BoardSearchCursor, cursor: BoardSearchCursor): boolean {
	return compareBoardSearchOrder(row, cursor) > 0
}

export function boardMatchesTerms(name: string, terms: string[]): boolean {
	const haystack = name.toLowerCase()
	return terms.every((term) => haystack.includes(term.toLowerCase()))
}

export function pageBoardSearch(rows: BoardSearchRow[], terms: string[]) {
	const boards = rows.slice(0, BOARD_SEARCH_PAGE_SIZE)
	const lastBoard = boards.at(-1)
	const hasMore = rows.length > boards.length
	return {
		boardCount: boards.length,
		...(hasMore && lastBoard ? { nextCursor: encodeBoardSearchCursor(lastBoard, terms) } : {}),
		boards: boards.map((row) => ({
			boardId: row.id,
			name: row.name.trim(),
			addedAt: new Date(row.arrivedAt).toISOString(),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			source: row.source,
			...(row.source === 'workspace' ? { workspaceName: row.workspaceName } : {}),
		})),
	}
}

function requireObject(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('Tool arguments must be an object')
	}
	return input as Record<string, unknown>
}

export const CANVAS_RESOURCE_URI = 'ui://tldraw/canvas.html'

export const SERVER_NAME = 'tldraw-local'
export const SERVER_VERSION = '1.1.0'

export const BOARD_SEARCH_PAGE_SIZE = 20
export const BOARD_SEARCH_MAX_QUERY_LENGTH = 200
export const BOARD_SEARCH_MAX_TERMS = 8
export const BOARD_NAME_MAX_LENGTH = 200
export const CREATE_BOARD_PER_MINUTE = 10
export const MAX_BOARDS_PER_WORKSPACE = 500
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const COMMENT_TYPE_NAMES = ['comment', 'comment-thread', 'comment-reaction'] as const

export interface ChangeCounts {
	added: number
	updated: number
	removed: number
}

export interface ExecPayload {
	boardId: string
	result: unknown
	changes: ChangeCounts
}

export interface SessionMeta {
	userId: string
	userName: string
	signedIn: boolean
}

export function isCommentTypeName(typeName: unknown): boolean {
	return (
		typeName === 'comment' || typeName === 'comment-thread' || typeName === 'comment-reaction'
	)
}

export function isCommentRecordId(id: unknown): boolean {
	if (typeof id !== 'string') return false
	return (
		id.startsWith('comment:') ||
		id.startsWith('comment-thread:') ||
		id.startsWith('comment-reaction:')
	)
}

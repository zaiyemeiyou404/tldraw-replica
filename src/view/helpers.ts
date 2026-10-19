import { createShapeId, toRichText, type Editor, type TLAssetId, type TLPageId, type TLShapeId } from 'tldraw'
import {
	createComment,
	createCommentThread,
	type TLCommentAnchor,
	type TLRichText,
} from '@tldraw/tlschema'
import { createMermaidDiagram } from '@tldraw/mermaid'
import { detectMermaidKind } from '../shared/mermaidKind.js'

export interface HelperContext {
	origin: string
	boardId: string
	userId: string
	userName: string
	signedIn: boolean
	/** Set while helpers.addComment writes, so the exec guard allows that one write. */
	allowCommentWrite: boolean
}

type Bounds = { x: number; y: number; w: number; h: number }

export function createHelpers(editor: Editor, ctx: HelperContext) {
	return {
		createShapeId,
		toRichText,
		createArrowBetweenShapes(fromId: string, toId: string, opts?: { text?: string; bend?: number }) {
			const from = resolveShape(editor, fromId)
			const to = resolveShape(editor, toId)
			const id = createShapeId()
			editor.createShape({
				id,
				type: 'arrow',
				props: {
					...(opts?.text ? { richText: toRichText(opts.text) } : {}),
					...(opts?.bend != null ? { bend: opts.bend } : {}),
				},
			})
			const binding = (terminal: 'start' | 'end', toId: TLShapeId) => {
				editor.createBinding({
					type: 'arrow',
					fromId: id,
					toId,
					props: {
						terminal,
						normalizedAnchor: { x: 0.5, y: 0.5 },
						isExact: false,
						isPrecise: false,
						snap: 'none',
					},
				})
			}
			binding('start', from)
			binding('end', to)
			return id
		},
		async addImage(
			url: string,
			opts?: { x?: number; y?: number; w?: number; h?: number; id?: string },
		) {
			const response = await fetch(`${ctx.origin}/api/boards/${ctx.boardId}/assets/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url }),
			})
			const body = (await response.json()) as {
				error?: string
				assetId?: string
				src?: string
				w?: number
				h?: number
				mimeType?: string
			}
			if (!response.ok || !body.assetId || !body.src || !body.w || !body.h) {
				throw new Error(body.error || 'The URL is not a public http(s) image.')
			}
			const fitted = fitImage(body.w, body.h, opts)
			const position = placeImage(editor, fitted.w, fitted.h, opts)
			const assetId = body.assetId as TLAssetId
			const src = body.src.startsWith('/') ? ctx.origin + body.src : body.src
			editor.createAssets([
				{
					id: assetId,
					type: 'image',
					typeName: 'asset',
					meta: {},
					props: {
						name: fileName(url),
						src,
						w: body.w,
						h: body.h,
						mimeType: body.mimeType ?? 'image/png',
						isAnimated: false,
					},
				},
			])
			const shapeId = opts?.id ? createShapeId(opts.id) : createShapeId()
			const defaults = editor.getShapeUtil('image').getDefaultProps()
			editor.createShape({
				id: shapeId,
				type: 'image',
				x: position.x,
				y: position.y,
				props: { ...defaults, w: fitted.w, h: fitted.h, assetId },
			})
			return { shapeId, assetId, bounds: boundsOf(editor, shapeId) ?? { ...position, ...fitted } }
		},
		async createMermaidDiagram(
			source: string,
			options?: {
				blueprintRender?: { position?: { x: number; y: number }; centerOnPosition?: boolean }
			},
		) {
			detectMermaidKind(source)
			const before = new Set(editor.getCurrentPageShapes().map((shape) => shape.id))
			try {
				await createMermaidDiagram(editor, source, {
					blueprintRender: options?.blueprintRender,
				})
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error)
				throw new Error(text || 'mermaid could not parse this diagram')
			}
			const created = editor.getCurrentPageShapes().filter((shape) => !before.has(shape.id))
			if (created.length === 0) {
				throw new Error('mermaid parsed the diagram but drew nothing')
			}
			const createdIds = new Set(created.map((shape) => shape.id))
			const roots = created.filter((shape) => !createdIds.has(shape.parentId))
			const root = roots.find((shape) => shape.type === 'group') ?? roots[0] ?? created[0]
			let bounds: Bounds | null = null
			for (const shape of created) {
				const box = editor.getShapePageBounds(shape.id)
				if (!box) continue
				const next = { x: box.x, y: box.y, w: box.w, h: box.h }
				bounds = bounds ? unionBounds(bounds, next) : next
			}
			return {
				rootShapeId: root.id,
				shapeIds: created.map((shape) => shape.id),
				bounds: bounds ?? { x: root.x, y: root.y, w: 0, h: 0 },
			}
		},
		getComments(opts?: { pageId?: string }) {
			const pageId = (opts?.pageId ?? editor.getCurrentPageId()) as TLPageId
			const records = editor.store.allRecords()
			const threads = records
				.filter(
					(record) =>
						record.typeName === 'comment-thread' &&
						record.pageId === pageId &&
						record.isDeleted !== true,
				)
				.sort((a, b) => a.createdAt - b.createdAt)
			return threads.map((thread) => {
				const comments = records
					.filter(
						(record) =>
							record.typeName === 'comment' &&
							record.threadId === thread.id &&
							record.isDeleted !== true,
					)
					.sort((a, b) => a.createdAt - b.createdAt)
					.map((comment) => ({
						id: comment.id,
						text: plainRichText(comment.body),
						authorId: comment.authorId,
						authorName: comment.authorId === ctx.userId ? ctx.userName : comment.authorId,
						createdAt: new Date(comment.createdAt).toISOString(),
					}))
				return {
					id: thread.id,
					resolved: thread.resolved != null,
					pageId: thread.pageId,
					createdAt: new Date(thread.createdAt).toISOString(),
					anchor: anchorView(editor, thread.anchor),
					comments,
				}
			})
		},
		addComment(text: string, target: { threadId?: string; shapeId?: string; x?: number; y?: number }) {
			if (!ctx.signedIn) {
				throw new Error(
					'This connection cannot post comments because it is not signed in. Tell the user rather than working around it.',
				)
			}
			if (typeof text !== 'string' || !text.trim()) throw new Error('comment text is required')
			const pageId = editor.getCurrentPageId()
			ctx.allowCommentWrite = true
			try {
				if (target?.threadId) {
					const thread = editor.store.get(target.threadId as TLShapeId)
					if (!thread || thread.typeName !== 'comment-thread') throw new Error('No comment thread with that id.')
					if (thread.resolved) {
						throw new Error('This thread is resolved and takes no replies. Start a new thread.')
					}
					const comment = createComment({
						authorId: ctx.userId,
						body: toRichText(text),
						pageId: thread.pageId,
						threadId: thread.id,
					})
					editor.run(() => editor.store.put([comment]), { history: 'ignore' })
					return { threadId: thread.id, commentId: comment.id }
				}
				const anchor = anchorFromTarget(editor, target)
				const thread = createCommentThread({
					anchor,
					createdBy: ctx.userId,
					pageId,
				})
				const comment = createComment({
					authorId: ctx.userId,
					body: toRichText(text),
					pageId,
					threadId: thread.id,
				})
				editor.run(() => editor.store.put([thread, comment]), { history: 'ignore' })
				return { threadId: thread.id, commentId: comment.id }
			} finally {
				ctx.allowCommentWrite = false
			}
		},
	}
}

export type Helpers = ReturnType<typeof createHelpers>

function resolveShape(editor: Editor, id: string): TLShapeId {
	const shapeId = (id.startsWith('shape:') ? id : createShapeId(id)) as TLShapeId
	if (!editor.getShape(shapeId)) throw new Error(`No shape with id ${shapeId}`)
	return shapeId
}

function fitImage(natW: number, natH: number, opts?: { w?: number; h?: number }) {
	if (opts?.w != null && opts?.h != null) return { w: opts.w, h: opts.h }
	if (opts?.w != null) return { w: opts.w, h: (natH * opts.w) / natW }
	if (opts?.h != null) return { w: (natW * opts.h) / natH, h: opts.h }
	const scale = Math.min(1, 800 / Math.max(natW, natH))
	return { w: natW * scale, h: natH * scale }
}

function placeImage(editor: Editor, w: number, h: number, opts?: { x?: number; y?: number }) {
	if (opts?.x != null && opts?.y != null) return { x: opts.x, y: opts.y }
	const viewport = editor.getViewportPageBounds()
	return {
		x: opts?.x ?? viewport.x + viewport.w / 2 - w / 2,
		y: opts?.y ?? viewport.y + viewport.h / 2 - h / 2,
	}
}

function boundsOf(editor: Editor, id: TLShapeId): Bounds | null {
	const box = editor.getShapePageBounds(id)
	if (!box) return null
	return { x: box.x, y: box.y, w: box.w, h: box.h }
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
	const x = Math.min(a.x, b.x)
	const y = Math.min(a.y, b.y)
	const right = Math.max(a.x + a.w, b.x + b.w)
	const bottom = Math.max(a.y + a.h, b.y + b.h)
	return { x, y, w: right - x, h: bottom - y }
}

function fileName(url: string) {
	try {
		const name = new URL(url).pathname.split('/').pop()
		return name || 'image'
	} catch {
		return 'image'
	}
}

function plainRichText(body: TLRichText | string | undefined): string {
	if (!body) return ''
	if (typeof body === 'string') return body
	const parts: string[] = []
	const walk = (node: unknown) => {
		if (!node || typeof node !== 'object') return
		const record = node as { text?: string; type?: string; content?: unknown[] }
		if (typeof record.text === 'string') parts.push(record.text)
		if (Array.isArray(record.content)) {
			for (const child of record.content) walk(child)
			if (record.type === 'paragraph') parts.push('\n')
		}
	}
	walk(body)
	return parts.join('').replace(/\n+$/, '')
}

function anchorView(editor: Editor, anchor: TLCommentAnchor) {
	if (anchor.type === 'shape') {
		const box = editor.getShapePageBounds(anchor.shapeId)
		const position = box
			? { x: box.x + anchor.x * box.w, y: box.y + anchor.y * box.h }
			: { x: 0, y: 0 }
		return { type: 'shape' as const, shapeId: anchor.shapeId, x: anchor.x, y: anchor.y, position }
	}
	if (anchor.type === 'point') {
		return { type: 'point' as const, x: anchor.x, y: anchor.y, position: { x: anchor.x, y: anchor.y } }
	}
	if (anchor.type === 'region') {
		return {
			type: 'region' as const,
			x: anchor.x,
			y: anchor.y,
			w: anchor.w,
			h: anchor.h,
			position: { x: anchor.x, y: anchor.y },
		}
	}
	return { type: 'page' as const, x: 0, y: 0, position: { x: 0, y: 0 } }
}

function anchorFromTarget(
	editor: Editor,
	target: { shapeId?: string; x?: number; y?: number },
): TLCommentAnchor {
	if (target.shapeId) {
		const shapeId = resolveShape(editor, target.shapeId)
		const precise = typeof target.x === 'number' && typeof target.y === 'number'
		return {
			type: 'shape',
			shapeId,
			x: precise ? target.x! : 1,
			y: precise ? target.y! : 0,
			isPrecise: precise,
		}
	}
	if (typeof target.x === 'number' && typeof target.y === 'number') {
		return { type: 'point', x: target.x, y: target.y }
	}
	throw new Error('addComment needs a threadId, a shapeId, or page coordinates x and y.')
}

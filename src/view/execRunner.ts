import type { Editor, TLStore } from 'tldraw'
import { isCommentRecordId, isCommentTypeName, type ChangeCounts } from '../shared/protocol.js'
import { createHelpers, type HelperContext, type Helpers } from './helpers.js'

const COMMENT_REFUSAL =
	'exec refuses to change or remove comment records. Resolving, editing, and deleting comments are for the user. Add a comment with helpers.addComment.'

export async function runExec(editor: Editor, code: string, ctx: HelperContext, signal: AbortSignal) {
	const helpers = createHelpers(editor, ctx)
	const guarded = guardEditor(editor, ctx)
	const mark = editor.markHistoryStoppingPoint('exec')
	const counts: ChangeCounts = { added: 0, updated: 0, removed: 0 }
	const touched = new Set<string>()
	const remote = new Map<string, unknown>()
	let conflict = false

	const unlisten = editor.store.listen(
		(entry) => {
			const added = Object.keys(entry.changes.added)
			const updated = Object.keys(entry.changes.updated)
			const removed = Object.keys(entry.changes.removed)
			const ids = [...added, ...updated, ...removed]
			if (entry.source === 'user') {
				counts.added += added.length
				counts.updated += updated.length
				counts.removed += removed.length
				for (const id of ids) {
					if (isCommentRecordId(id)) continue
					touched.add(id)
					if (remote.has(id)) conflict = true
				}
			} else {
				for (const id of ids) {
					if (isCommentRecordId(id)) continue
					const current = editor.store.get(id as never)
					remote.set(id, current ? structuredClone(current) : null)
					if (touched.has(id)) conflict = true
				}
			}
		},
		{ source: 'all', scope: 'document' },
	)

	const discard = () => {
		try {
			editor.bailToMark(mark)
		} catch {
			/* The mark can already be gone if the store reset. */
		}
		if (remote.size === 0) return
		// history:'ignore' keeps this out of the undone edit, but the change is
		// still a user change so the sync client pushes the surviving records.
		// A remote-sourced put would stay on this view and then be deleted by
		// the server's copy of the bail.
		editor.run(
			() => {
				const put: unknown[] = []
				const remove: string[] = []
				for (const [id, record] of remote) {
					if (record) put.push(record)
					else remove.push(id)
				}
				if (put.length) editor.store.put(put as never)
				if (remove.length) editor.store.remove(remove as never)
			},
			{ history: 'ignore' },
		)
	}

	try {
		if (signal.aborted) throw new Error('exec was cancelled.')
		const value = await invoke(guarded, helpers, signal, code)
		if (signal.aborted) throw new Error('exec was cancelled.')
		await flushStoreHistory(editor)
		if (conflict) {
			throw new Error(
				'A concurrent change touched records this edit also changed, so the edit was discarded. Reread the board before retrying.',
			)
		}
		const history = (editor as Editor & { history?: { getMarkIdMatching?: (part: string) => string | null } }).history
		if (history?.getMarkIdMatching?.(mark)) {
			try {
				editor.squashToMark(mark)
			} catch {
				/* Nothing was recorded, so there is no mark to squash. */
			}
		}
		return { result: jsonable(value), changes: counts }
	} catch (error) {
		discard()
		throw error
	} finally {
		unlisten()
	}
}

async function invoke(editor: Editor, helpers: Helpers, signal: AbortSignal, code: string) {
	const AsyncFunction = Object.getPrototypeOf(async function () {
		return undefined
	}).constructor as new (...args: string[]) => (editor: Editor, helpers: Helpers, signal: AbortSignal) => Promise<unknown>
	const fn = new AsyncFunction('editor', 'helpers', 'signal', `"use strict";\n${code}`)
	return await fn(editor, helpers, signal)
}

async function flushStoreHistory(editor: Editor) {
	await new Promise<void>((resolve) => {
		let done = false
		const finish = () => {
			if (done) return
			done = true
			resolve()
		}
		requestAnimationFrame(finish)
		setTimeout(finish, 50)
	})
	const store = editor.store as Editor['store'] & { _flushHistory?: () => void }
	store._flushHistory?.()
}

function jsonable(value: unknown): unknown {
	if (value === undefined) return null
	return JSON.parse(
		JSON.stringify(value, (_key, item) => {
			if (typeof item === 'bigint') return item.toString()
			if (item instanceof Map) return Object.fromEntries(item)
			if (item instanceof Set) return [...item]
			return item
		}),
	)
}

function guardEditor(editor: Editor, ctx: HelperContext): Editor {
	const store = guardStore(editor.store, ctx)
	return new Proxy(editor, {
		get(target, prop, receiver) {
			if (prop === 'store') return store
			const value = Reflect.get(target, prop, receiver)
			if (typeof value === 'function') return (value as (...args: unknown[]) => unknown).bind(target)
			return value
		},
	})
}

function guardStore(store: TLStore, ctx: HelperContext) {
	return new Proxy(store, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver)
			if (prop === 'put' || prop === 'update' || prop === 'remove' || prop === 'delete') {
				return (...args: unknown[]) => {
					if (!ctx.allowCommentWrite && args.some(mentionsComment)) throw new Error(COMMENT_REFUSAL)
					return (value as (...inner: unknown[]) => unknown).apply(target, args)
				}
			}
			if (typeof value === 'function') return (value as (...args: unknown[]) => unknown).bind(target)
			return value
		},
	})
}

function mentionsComment(value: unknown): boolean {
	if (typeof value === 'string') return isCommentRecordId(value)
	if (Array.isArray(value)) return value.some(mentionsComment)
	if (value && typeof value === 'object') {
		const record = value as { id?: unknown; typeName?: unknown }
		if (isCommentTypeName(record.typeName) || isCommentRecordId(record.id)) return true
	}
	return false
}

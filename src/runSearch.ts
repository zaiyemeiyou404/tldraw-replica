import vm from 'node:vm'
import { editorSpec } from './generated/editor-spec.js'

export async function runSearch(code: string): Promise<unknown> {
	if (typeof code !== 'string' || !code.trim()) {
		throw new Error('code is required: JavaScript that reads spec and returns the entries you need.')
	}
	const context = vm.createContext({
		JSON,
		Math,
		Object,
		Array,
		String,
		Number,
		Boolean,
		RegExp,
		Date,
		Map,
		Set,
	})
	vm.runInContext(`const spec = ${JSON.stringify(editorSpec)};`, context, { timeout: 1000 })
	const script = new vm.Script(`"use strict"; (async () => {\n${code}\n})()`, { filename: 'search.js' })
	const result = script.runInContext(context, { timeout: 1000 })
	const value = await Promise.race([
		Promise.resolve(result),
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error('search timed out')), 2000)
		}),
	])
	return JSON.parse(JSON.stringify(value ?? null))
}

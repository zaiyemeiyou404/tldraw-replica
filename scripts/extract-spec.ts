import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { defaultShapeSchemas } from '@tldraw/tlschema'

const require = createRequire(import.meta.url)
const editorEntry = require.resolve('@tldraw/editor')
const dtsPath = path.join(path.dirname(editorEntry), 'index.d.ts')

const program = ts.createProgram([dtsPath], { skipLibCheck: true, target: ts.ScriptTarget.Latest })
const source = program.getSourceFile(dtsPath)
const checker = program.getTypeChecker()
if (!source) throw new Error(`Could not read ${dtsPath}`)

function findEditor(node: ts.Node): ts.ClassDeclaration | undefined {
	if (ts.isClassDeclaration(node) && node.name?.text === 'Editor') return node
	let found: ts.ClassDeclaration | undefined
	ts.forEachChild(node, (child) => {
		if (!found) found = findEditor(child)
	})
	return found
}

const editor = findEditor(source)
if (!editor) throw new Error('Editor class was not found in the installed @tldraw/editor declarations')

const EXAMPLES: Record<string, string[]> = {
	createShape: [
		"editor.createShape({ id: createShapeId('box1'), type: 'geo', x: 100, y: 100, props: { geo: 'rectangle', w: 300, h: 200, richText: toRichText('Label') } })",
	],
	updateShape: ["editor.updateShape({ id: 'shape:box1', type: 'geo', x: 40 })"],
	select: ["editor.select('shape:box1')"],
	zoomToSelection: ['editor.zoomToSelection()'],
	alignShapes: ["editor.alignShapes(editor.getSelectedShapeIds(), 'left')"],
	distributeShapes: ["editor.distributeShapes(editor.getSelectedShapeIds(), 'horizontal')"],
	getCurrentPageShapes: ['return editor.getCurrentPageShapes()'],
	getShapePageBounds: ["return editor.getShapePageBounds('shape:box1')"],
	createBinding: [
		"editor.createBinding({ type: 'arrow', fromId: arrowId, toId: targetId, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } })",
	],
	undo: ['editor.undo()'],
	markHistoryStoppingPoint: ["const mark = editor.markHistoryStoppingPoint('exec')"],
}

function category(name: string): string {
	if (/^(create|update|delete|get)?(Shape|Binding)/i.test(name) || /shape|binding/i.test(name)) return 'shapes'
	if (/page/i.test(name)) return 'pages'
	if (/camera|zoom|viewport/i.test(name)) return 'camera'
	if (/select|hover|brush/i.test(name)) return 'selection'
	if (/history|undo|redo|mark|squash|bail/i.test(name)) return 'history'
	if (/group|align|distribute|flip|rotate|pack|stack|duplicate/i.test(name)) return 'layout'
	if (/text|font|richText/i.test(name)) return 'text'
	if (/asset|image/i.test(name)) return 'assets'
	if (/comment/i.test(name)) return 'comments'
	return 'editor'
}

function docOf(node: ts.Node): string {
	const text = ts.getJSDocCommentsAndTags(node)
		.filter(ts.isJSDoc)
		.map((doc) => doc.comment)
		.filter((comment): comment is string => typeof comment === 'string')
		.join('\n')
		.trim()
	return text.replace(/\s+/g, ' ').slice(0, 500)
}

const members: Array<{
	name: string
	signature: string
	description: string
	category: string
	examples?: string[]
}> = []

for (const member of editor.members) {
	if (!ts.isMethodDeclaration(member) && !ts.isGetAccessor(member)) continue
	if (!member.name || !ts.isIdentifier(member.name)) continue
	const name = member.name.text
	if (name.startsWith('_') || name.startsWith('#')) continue
	const signature = checker.getSignatureFromDeclaration(member)
	const rendered = signature
		? checker.signatureToString(signature, editor, ts.TypeFormatFlags.NoTruncation)
		: name
	const examples = EXAMPLES[name]
	members.push({
		name,
		signature: rendered,
		description: docOf(member),
		category: category(name),
		...(examples ? { examples } : {}),
	})
}

members.sort((a, b) => a.name.localeCompare(b.name))

const shapes = Object.entries(defaultShapeSchemas).map(([type, schema]) => {
	const props = schema && typeof schema === 'object' && 'props' in schema ? Object.keys((schema as { props: object }).props) : []
	return { type, props }
})

const helpers = [
	{
		name: 'createShapeId',
		signature: 'createShapeId(id?: string): TLShapeId',
		description: 'Mint a stable shape id. Pass a name to refer to the shape from a later exec.',
		category: 'helpers',
		examples: ["createShapeId('box1')"],
	},
	{
		name: 'toRichText',
		signature: 'toRichText(text: string): TLRichText',
		description: 'Turn a plain string into the rich text document stored on geo, text, and arrow shapes.',
		category: 'helpers',
		examples: ["toRichText('Label')"],
	},
	{
		name: 'createArrowBetweenShapes',
		signature: 'createArrowBetweenShapes(fromId: string, toId: string, opts?: { text?: string; bend?: number }): TLShapeId',
		description: 'Create an arrow bound to two shapes so it follows them.',
		category: 'helpers',
	},
	{
		name: 'addImage',
		signature: 'addImage(url: string, opts?: { x?: number; y?: number; w?: number; h?: number; id?: string }): Promise<{ shapeId: string; assetId: string; bounds: { x: number; y: number; w: number; h: number } }>',
		description: 'Copy a public http(s) image (max 5 MB) into the board asset store and place it.',
		category: 'helpers',
	},
	{
		name: 'createMermaidDiagram',
		signature: 'createMermaidDiagram(source: string, options?: { blueprintRender?: { position?: { x: number; y: number }; centerOnPosition?: boolean } }): Promise<{ rootShapeId: string; shapeIds: string[]; bounds: { x: number; y: number; w: number; h: number } }>',
		description: 'Draw flowchart/graph, sequenceDiagram, stateDiagram-v2, or mindmap mermaid as editable shapes. Anything else throws.',
		category: 'helpers',
	},
	{
		name: 'getComments',
		signature: 'getComments(opts?: { pageId?: string }): Array<{ id: string; resolved: boolean; anchor: object; comments: Array<{ id: string; text: string }> }>',
		description: 'Current page comment threads, oldest first, including resolved threads.',
		category: 'helpers',
	},
	{
		name: 'addComment',
		signature: 'addComment(text: string, target: { threadId: string } | { shapeId: string; x?: number; y?: number } | { x: number; y: number }): { threadId: string; commentId: string }',
		description: 'Post a comment as the local user. Not undone with the edit. Refuses resolved threads.',
		category: 'helpers',
	},
]

const spec = { members, types: { shapes }, helpers }
const outDir = path.resolve('src/generated')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'editor-spec.ts')
writeFileSync(
	outFile,
	`/* Generated from the installed tldraw SDK by scripts/extract-spec.ts. Do not edit by hand. */\n` +
		`export const editorSpec = ${JSON.stringify(spec)} as {\n` +
		`  members: Array<{ name: string; signature: string; description: string; category: string; examples?: string[] }>\n` +
		`  types: { shapes: Array<{ type: string; props: string[] }> }\n` +
		`  helpers: Array<{ name: string; signature: string; description: string; category: string; examples?: string[] }>\n` +
		`}\n`,
)
console.error(`wrote ${members.length} editor members and ${shapes.length} shape types to ${outFile}`)

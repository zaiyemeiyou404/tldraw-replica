/**
 * The diagram families helpers.createMermaidDiagram will draw.
 * `stateDiagram` (v1) is intentionally rejected: the skill allows only `stateDiagram-v2`.
 */
export type SupportedMermaidKind = 'flowchart' | 'sequenceDiagram' | 'stateDiagram-v2' | 'mindmap'

const FRONTMATTER = /^---\s*[\r\n][\s\S]*?[\r\n]---\s*[\r\n]*/
const DIRECTIVE = /^%%\{[\s\S]*?\}%%\s*/
const COMMENT = /^%%[^\n]*\n\s*/

const KEYWORD =
	/^(flowchart|graph|sequenceDiagram|stateDiagram-v2|stateDiagram|mindmap|classDiagram|erDiagram|gantt|pie|gitGraph|journey|timeline|sankey|xychart(?:-beta)?|block(?:-beta)?|quadrantChart|requirement(?:Diagram)?|kanban|architecture(?:-beta)?|treemap|radar|packet|info|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/

export function stripMermaidPreamble(source: string): string {
	let text = source.replace(/^\uFEFF/, '').trim()
	if (FRONTMATTER.test(text)) text = text.replace(FRONTMATTER, '')
	let guard = 0
	while (guard++ < 50) {
		if (DIRECTIVE.test(text)) {
			text = text.replace(DIRECTIVE, '')
			continue
		}
		if (COMMENT.test(text)) {
			text = text.replace(COMMENT, '')
			continue
		}
		break
	}
	return text.trim()
}

export function detectMermaidKind(source: string): SupportedMermaidKind {
	const cleaned = stripMermaidPreamble(source)
	const match = KEYWORD.exec(cleaned)
	if (!match) {
		throw new Error(
			'Unsupported or unrecognised mermaid diagram. helpers.createMermaidDiagram supports flowchart (or graph), sequenceDiagram, stateDiagram-v2, and mindmap.',
		)
	}
	const kind = match[1]
	if (kind === 'flowchart' || kind === 'graph') return 'flowchart'
	if (kind === 'sequenceDiagram') return 'sequenceDiagram'
	if (kind === 'stateDiagram-v2') return 'stateDiagram-v2'
	if (kind === 'mindmap') return 'mindmap'
	throw new Error(
		`Unsupported mermaid diagram type "${kind}". helpers.createMermaidDiagram supports flowchart (or graph), sequenceDiagram, stateDiagram-v2, and mindmap. Build other diagrams from shapes.`,
	)
}

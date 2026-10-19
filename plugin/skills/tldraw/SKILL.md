---
name: tldraw
description: Draw and diagram on a tldraw canvas with the tldraw plugin. Use when the user asks for a diagram, flowchart, sequence diagram, state machine, mindmap, sketch, or board, gives you mermaid to draw, or wants to edit shapes on a canvas.
---

# tldraw canvas

The plugin gives you a real tldraw editor. You draw by writing JavaScript that runs against it. For a flowchart, sequence diagram, state machine, or mindmap, that JavaScript can be one call: write the diagram as mermaid and draw it with the `helpers.createMermaidDiagram` editor helper (see Diagrams from mermaid).

Every board is a local `.tldr` file on this machine, in the personal workspace folder unless it lives in another local workspace folder. Find one with `search_boards`, then open it with `open_board` (`action: "open"`), passing its `boardId` and name, before writing drawing code. When the host can show an MCP App, the canvas opens in the thread side panel; otherwise open the localhost URL `open_board` returns. Then call `exec` to draw on it. `exec` waits for the view to connect, so call it right after opening. `open_board` with `action: "home"` lets the user browse; the user can also open the board browser from that URL.

The board is the real one, live on this machine: `exec` edits are written to the local file at once and any other view of that board on this machine sees them. Change it only as the user asked. A view-only board opens read-only. These boards are not tldraw.com boards and are not synced to other computers.

To start a new board, call `create_board` with a name, and the workspace if the user named one (it defaults to their personal workspace). Then open it with `open_board` (`action: "open"`), passing the returned `boardId` and name. Only create a board when the user asks for a new one; otherwise find the existing board with `search_boards`. At most 10 boards can be created per minute.

To rename a board, call `rename_board` with its `boardId` and the new name. Only rename when the user asks. Only members of the workspace that owns a board can rename it; a board shared by link cannot be renamed, so tell the user why.

If the user @-mentions a board, the message contains a `tldraw://board/<id>` link. Pass that URI (or the id) as `boardId` to `open_board`, then edit with `exec`.

Use the tldraw tools yourself, in the main thread; do not hand the drawing to a sub-agent. A board a sub-agent opens cannot load, because Codex does not let that view call this plugin.

Pass the board's `boardId` to every `exec` and `screenshot` call; `open_board` returns it, and the model context lists each open board. Do not reopen the board for each edit. If `exec` reports that the board is not open, use `list_open_boards`, or open it with `open_board`; do not claim the drawing was made.

## Tools

- `search` — query the installed SDK's API documentation with JavaScript. Use `spec.members` (names, signatures, descriptions, categories, examples), `spec.types.shapes` (shape types and props), and `spec.helpers`. Return only the relevant entries, e.g. `return spec.members.filter(m => /createShape|alignShapes/.test(m.name))`.
- `search_boards` — find the user's local boards by name; returns IDs for `open_board`.
- `create_board` — create a new, empty local board in the user's personal workspace or a named workspace; returns its `boardId` for `open_board`.
- `rename_board` — rename a local board, by `boardId`; returns the new and previous names.
- `exec` — run JavaScript against an open board, named by `boardId`, with the full `editor` API and `helpers`: `createShapeId`, `toRichText`, `createArrowBetweenShapes(fromId, toId, { text?, bend? })`, which binds an arrow to two shapes so it follows them, `addImage(url, { x?, y?, w?, h?, id? })`, which puts an image from the web on the board (see Images), `createMermaidDiagram(source, options?)`, which draws a mermaid diagram as editable shapes (see Diagrams from mermaid), and the comment helpers `getComments` and `addComment` (see Comments). Return a small JSON value to inspect the board. The result includes the board ID, return value, and record-change counts. Document edits commit together as one undo step. Errors discard the proposed edit, as does a change made meanwhile to anything the edit touches; reread the board before retrying a conflict.
- `screenshot` — explicitly inspect a board's page, viewport, or selection. No screenshots are taken automatically. Use this when visual inspection is needed.

Await all asynchronous work in `exec`. Do not retain editor references, schedule work after returning, access browser globals, or perform external side effects. The temporary editor protects document edits, not network or browser side effects. Use `signal` to cooperate with cancellation. Prefer short, bounded operations. User-facing dialogs, undo history, and DOM-dependent operations belong in the app UI, not in scripts.

## Diagrams from mermaid

For a whole diagram drawn from its structure (a flowchart, sequence diagram, state machine, or mindmap), write mermaid and let `helpers.createMermaidDiagram(source, options?)` draw it rather than placing nodes and arrows by hand. It makes real, editable shapes: geo shapes and arrows bound to them, usually all in one group. A subgraph (or a compound state) is a rectangle geo shape with its nodes as children and its title in `richText`. Await it.

```js
const diagram = await helpers.createMermaidDiagram(`flowchart TD
  A[Write the change] --> B{Tests pass?}
  B -->|Yes| C[Open a PR]
  B -->|No| A`)
return diagram.bounds
```

- Supported kinds: `flowchart` (or `graph`), `sequenceDiagram`, `stateDiagram-v2`, and `mindmap`. Anything else (class, ER, gantt, pie, …) throws; build those from shapes.
- In the portrait side panel, a flowchart reads best top-down: `flowchart TD`, not `LR`.
- The diagram lands centred on the viewport. `options.blueprintRender.position` centres it on a page point instead, or puts its top-left corner there with `centerOnPosition: false`. It returns `{ rootShapeId, shapeIds, bounds }`: `rootShapeId` is the diagram's top-level shape: usually a group, or the one shape a diagram has at the top (a lone node, or a subgraph holding the rest). A second diagram placed from the first one's `bounds` does not overlap it; or put both in one source as `subgraph`s. A diagram placed wholly inside a frame goes into it; keep diagrams clear of frame edges, where one can be clipped by the frame or left beside it.
- Invalid source throws mermaid's parse error and draws nothing, which discards the whole `exec`; fix the source and run it again.
- When the user gives you mermaid (pasted into the chat, or from a file or doc), draw it with `createMermaidDiagram` as it is rather than rebuilding it by hand.
- It draws a new diagram. To change a diagram already on the board, edit its shapes.
- Users can paste mermaid onto the board themselves; it becomes shapes the same way.

## Images

To put an image from the web on the board, use `helpers.addImage(url, options?)`. Await it. It copies the image into the board's local asset folder, so it shows in this view and in other local views of the same board. Do not create an image asset whose `src` is another site's URL: this view cannot load it, and it shows as broken.

```js
const urls = ['https://example.com/a.jpg', 'https://example.com/b.jpg']
let y = 0
for (const url of urls) {
	const { bounds } = await helpers.addImage(url, { x: 0, y, w: 300 })
	y += bounds.h + 40
}
```

- `x`, `y` is the image's top-left corner; without them it is centred on the viewport. `w` or `h` sets its size, keeping the aspect ratio; with neither, the longer side is at most 800.
- It returns `{ shapeId, assetId, bounds }`. Pass `id` to name the shape.
- It throws when the URL is not a public http(s) image, is over 5 MB, or its host refuses, which discards the rest of that `exec`. When adding many images, add them in their own `exec` calls, or catch each failure and report which ones did not load.
- Use a direct image URL (one that serves the image itself), not the page it appears on.

## Comments

People leave comments on a board as pinned threads: each thread has an anchor saying what it is about (a shape, a point, or a region) and a conversation of comments. They are stored with the local board, in a file next to the `.tldr`, and other views on this machine see them.

- `helpers.getComments()` returns the current page's threads, oldest first, resolved ones included (pass `{ pageId }` for another page). Read the anchor before the words: `anchor.shapeId` is the shape under discussion, and `position` is the pin's page point (a shape anchor's own `x`, `y` are 0–1 within the shape).
- `helpers.addComment(text, target)` posts as the local user named by `TLDRAW_USER_NAME`. `{ threadId }` replies in an open thread (a resolved one takes no replies: start a new thread); `{ shapeId }` starts a thread on a shape, and adding page coordinates `x`, `y` pins that spot on it; `{ x, y }` starts one at a page point. It returns `{ threadId, commentId }`.

```js
const threads = helpers.getComments()
return threads
	.filter((t) => !t.resolved)
	.map((t) => ({ id: t.id, on: t.anchor.shapeId, said: t.comments.map((c) => c.text) }))
```

```js
helpers.addComment('I widened both boxes to fit their labels.', { threadId: 'comment-thread:…' })
```

Comment only when the user asks you to, or to answer a thread you acted on. A comment is visible to every local view of the board and is not undone with the edit. Post it in its own `exec` call once the edit has landed: when `addComment` throws, the whole script's edit is discarded with it. It throws when this connection cannot post comments (`TLDRAW_SIGNED_IN=0`, so the local profile is not signed in); tell the user rather than working around it. `exec` can only add comments this way: it refuses to change or remove comment records, so resolving, editing and deleting comments are for the user to do. Like every `exec`, `getComments` does not run on a view-only board.

## Shape format

Raw tldraw SDK records. No agent dialect.

```js
const { createShapeId, toRichText } = helpers
editor.createShape({
	id: createShapeId('box1'),
	type: 'geo',
	x: 100,
	y: 100,
	props: { geo: 'rectangle', w: 300, h: 200, richText: toRichText('Label') },
})
```

- The board usually opens in the thread side panel, which is tall and narrow: stack content vertically (flows top-to-bottom, columns over rows) so the whole drawing fits the panel without horizontal panning.
- A card and its words are one shape: put the text in the geo's `richText`.
- Choose your own ids with `createShapeId('name')` so later calls can refer to what you drew.
- Connect shapes with `helpers.createArrowBetweenShapes('box1', 'box2', { text: 'next' })` rather than positioning arrow endpoints by hand; the arrow stays attached when either shape moves.

## Valid style values

- `color`: black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, red, white
- `fill`: none, semi, solid, pattern, fill, lined-fill
- `size`: s, m, l, xl · `font`: draw, sans, serif, mono
- `geo`: rectangle, ellipse, triangle, diamond, pentagon, hexagon, octagon, star, rhombus, oval, trapezoid, cloud, heart, x-box, check-box

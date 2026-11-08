/**
 * Prompt Snippets — mix and match single-purpose prompt rules.
 *
 * Each snippet is a markdown file with frontmatter (name, description,
 * placement, order, persistent), stored in `~/.pi/agent/snippets/`.
 *
 * - Press alt+s or run /snippets to open the toggle menu (space: cycle state,
 *   tab: preview, enter: apply, esc: cancel). The menu is a bordered,
 *   scrollable view.
 * - Active snippets are displayed as a widget above the editor, with visual
 *   distinction between prepend and append groups.
 * - On message submit, active snippet bodies are added to the beginning/end
 *   of the message text in order (prepend group sorted by `order` first, then
 *   user text, then append group sorted by `order`).
 * - Manual toggles reset after submit. Persistent snippets automatically apply
 *   only until the session records its first user message (excluding JSON mode).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

interface Snippet {
	/** Filename, e.g. "concise.md" */
	id: string;
	name: string;
	description: string;
	placement: "prepend" | "append";
	order: number;
	body: string;
	/** Automatically enabled for the session's first recorded user message. */
	persistent?: boolean;
}

interface SnippetState {
	enabled: boolean;
	persistent: boolean;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const snippetsDir = join(homedir(), ".pi", "agent", "snippets");
const WIDGET_ID = "prompt-snippets";

function parseSnippet(filename: string, raw: string): Snippet | null {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return null;

	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}

	const body = match[2].trim();
	if (!body) return null;

	const parsedOrder = Number.parseInt(meta.order ?? "", 10);
	const parsedPersistent = meta.persistent?.toLowerCase() === "true";

	return {
		id: filename,
		name: meta.name || filename.replace(/\.md$/i, ""),
		description: meta.description ?? "",
		placement: meta.placement === "prepend" ? "prepend" : "append",
		order: Number.isFinite(parsedOrder) ? parsedOrder : 9999,
		body,
		persistent: parsedPersistent,
	};
}

/** Copy default snippets on first run */
function copyDefaultSnippets() {
	// Source entry lives at the package root; the compiled entry lives in dist/.
	const defaultSnippetsDir = [join(extensionDir, "snippets"), join(extensionDir, "..", "snippets")]
		.find((path) => existsSync(path));
	if (!defaultSnippetsDir) return;
	if (!existsSync(defaultSnippetsDir)) return;
	if (!existsSync(snippetsDir)) mkdirSync(snippetsDir, { recursive: true });

	for (const file of readdirSync(defaultSnippetsDir)) {
		if (!file.toLowerCase().endsWith(".md")) continue;
		const target = join(snippetsDir, file);
		if (!existsSync(target)) {
			try {
				copyFileSync(join(defaultSnippetsDir, file), target);
			} catch {
				// Skip files that failed to copy
			}
		}
	}
}

/** Load all snippets, sorted: prepend group first, append group last, each by (order, name). */
function loadSnippets(): Snippet[] {
	if (!existsSync(snippetsDir)) return [];
	const snippets: Snippet[] = [];
	for (const file of readdirSync(snippetsDir)) {
		if (!file.toLowerCase().endsWith(".md")) continue;
		try {
			const snippet = parseSnippet(file, readFileSync(join(snippetsDir, file), "utf8"));
			if (snippet) snippets.push(snippet);
		} catch {
			// Skip unreadable files
		}
	}
	const byOrder = (a: Snippet, b: Snippet) => a.order - b.order || a.name.localeCompare(b.name);
	return [
		...snippets.filter((s) => s.placement === "prepend").sort(byOrder),
		...snippets.filter((s) => s.placement === "append").sort(byOrder),
	];
}

export default function (pi: ExtensionAPI) {
	// Snippets last seen on disk (sorted). Refreshed when menu opens or message submits.
	let snippets: Snippet[] = [];
	// IDs of currently enabled snippets. Reset to empty after each submit and on session start.
	let enabled = new Set<string>();
	// Automatic selection survives rejected/intercepted input, unlike manual toggles.
	let automaticSelection = false;

	function hasRecordedUserMessage(ctx: ExtensionContext): boolean {
		// Deliberately inspect all history, including abandoned/compacted branches.
		return ctx.sessionManager.getEntries().some((entry) =>
			entry.type === "message" && entry.message.role === "user");
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const active = snippets.filter((s) => enabled.has(s.id));
		const prepends = active.filter((s) => s.placement === "prepend");
		const appends = active.filter((s) => s.placement === "append");

		if (prepends.length === 0 && appends.length === 0) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const lines: string[] = [];
		if (prepends.length > 0) {
			lines.push(theme.fg("accent", `↑ prepend: ${prepends.map((s) => s.name).join(" · ")}`));
		}
		if (appends.length > 0) {
			lines.push(theme.fg("warning", `↓ append: ${appends.map((s) => s.name).join(" · ")}`));
		}
		ctx.ui.setWidget(WIDGET_ID, lines);
	}

	function updateSnippetPersistent(snippetId: string, persistent: boolean) {
		const path = join(snippetsDir, snippetId);
		if (!existsSync(path)) return;

		try {
			const content = readFileSync(path, "utf8");
			const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
			if (!match) return;

			const frontmatter = match[1];
			const body = match[2];

			// Parse frontmatter into lines
			const lines = frontmatter.split(/\r?\n/);
			let persistentLineIndex = -1;

			for (let i = 0; i < lines.length; i++) {
				if (lines[i].match(/^persistent\s*:/i)) {
					persistentLineIndex = i;
					break;
				}
			}

			if (persistentLineIndex >= 0) {
				// Update existing persistent field
				lines[persistentLineIndex] = `persistent: ${persistent}`;
			} else {
				// Add persistent field
				lines.push(`persistent: ${persistent}`);
			}

			const newContent = `---\n${lines.join("\n")}\n---\n${body}`;
			writeFileSync(path, newContent, "utf8");
		} catch (err) {
			// Skip files that can't be updated
		}
	}

	async function openMenu(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Snippet menu requires interactive mode", "warning");
			return;
		}

		snippets = loadSnippets();
		// Remove toggles for snippets no longer on disk.
		enabled = new Set([...enabled].filter((id) => snippets.some((s) => s.id === id)));

		if (snippets.length === 0) {
			ctx.ui.notify(`No snippets found in ${snippetsDir}`, "warning");
			updateWidget(ctx);
			return;
		}

		// Working copy of snippet states; committed to `enabled` only on confirm.
		const working = new Map<string, SnippetState>();
		for (const snippet of snippets) {
			working.set(snippet.id, {
				enabled: enabled.has(snippet.id),
				persistent: snippet.persistent ?? false,
			});
		}

		const confirmed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
			const prepends = snippets.filter((s) => s.placement === "prepend");
			const appends = snippets.filter((s) => s.placement === "append");
			const items = [...prepends, ...appends];

			let mode: "list" | "preview" = "list";
			let cursor = 0;
			let listScroll = 0;
			let previewScroll = 0;

			const itemRow = (snippet: Snippet, idx: number, width: number): string => {
				const pointer = idx === cursor ? theme.fg("accent", "> ") : "  ";
				const state = working.get(snippet.id)!;
				const checkbox =
					!state.enabled ? theme.fg("dim", "[ ]") :
					state.persistent ? theme.fg("accent", "[🔒]") :
					theme.fg("success", "[x]");
				const desc = snippet.description ? theme.fg("dim", ` — ${snippet.description}`) : "";
				return truncateToWidth(`${pointer}${checkbox} ${theme.bold(snippet.name)}${desc}`, width);
			};

			/** List rows with the item index each row corresponds to (null for headers/empty). */
			const buildListRows = (width: number): { text: string; itemIndex: number | null }[] => {
				const rows: { text: string; itemIndex: number | null }[] = [];
				rows.push({ text: theme.fg("dim", "↑ PREPEND — inserted before your message"), itemIndex: null });
				prepends.forEach((s, i) => rows.push({ text: itemRow(s, i, width), itemIndex: i }));
				rows.push({ text: "", itemIndex: null });
				rows.push({ text: theme.fg("dim", "↓ APPEND — inserted after your message"), itemIndex: null });
				appends.forEach((s, i) => rows.push({ text: itemRow(s, prepends.length + i, width), itemIndex: prepends.length + i }));
				return rows;
			};

			const buildPreviewRows = (snippet: Snippet, width: number): string[] => {
				const rows: string[] = [];
				const state = working.get(snippet.id)!;
				const statusLabel =
					!state.enabled ? "" :
					state.persistent ? " 🔒 persistent" :
					" (temporary)";
				rows.push(truncateToWidth(theme.bold(snippet.name) + statusLabel, width));
				rows.push(truncateToWidth(theme.fg("dim", `${snippet.placement} · order ${snippet.order} · ${snippet.id}`), width));
				rows.push(theme.fg("dim", "─".repeat(Math.min(width, 40))));
				for (const line of snippet.body.split("\n")) {
					for (const wrapped of wrapTextWithAnsi(line, width)) {
						rows.push(truncateToWidth(wrapped, width));
					}
				}
				return rows;
			};

			/**
			 * Slice `lines` into a scrollable viewport of at most `maxView` rows,
			 * reserving indicator slots when clipping. Returns visible rows
			 * plus clamped scroll position. When `focusRow` is given, scrolls
			 * to keep it visible.
			 */
			const viewport = (
				lines: string[],
				scroll: number,
				maxView: number,
				focusRow?: number,
			): { out: string[]; scroll: number } => {
				const clipped = lines.length > maxView;
				const view = clipped ? Math.max(1, maxView - 2) : maxView;

				let s = Math.min(Math.max(0, scroll), Math.max(0, lines.length - view));
				if (focusRow !== undefined) {
					if (focusRow < s) s = focusRow;
					else if (focusRow >= s + view) s = focusRow - view + 1;
				}

				const visible = lines.slice(s, s + view);
				if (!clipped) return { out: visible, scroll: s };

				const above = s;
				const below = lines.length - (s + view);
				return {
					out: [
						above > 0 ? theme.fg("dim", `  ↑ ${above} more`) : "",
						...visible,
						below > 0 ? theme.fg("dim", `  ↓ ${below} more`) : "",
					],
					scroll: s,
				};
			};

			return {
				render(width: number): string[] {
					// Reserve lines for: top border, title, empty, empty, hints, bottom border.
					const maxView = Math.max(5, tui.terminal.rows - 10);

					let content: string[];
					let title: string;
					let hints: string;
					if (mode === "list") {
						const rows = buildListRows(width);
						const cursorRow = rows.findIndex((r) => r.itemIndex === cursor);
						const v = viewport(rows.map((r) => r.text), listScroll, maxView, cursorRow);
						content = v.out;
						listScroll = v.scroll;
						title = "Prompt snippets";
						hints = "↑↓ navigate • Space cycle (off/temp/lock) • Tab preview • Enter apply • Esc cancel";
					} else {
						const snippet = items[cursor];
						const rows = buildPreviewRows(snippet, width);
						const v = viewport(rows, previewScroll, maxView);
						content = v.out;
						previewScroll = v.scroll;
						title = `Preview: ${snippet.name}`;
						hints = "↑↓ scroll • Tab/Esc back";
					}

					return [
						theme.fg("accent", "─".repeat(width)),
						truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, width),
						"",
						...content,
						"",
						truncateToWidth(theme.fg("dim", ` ${hints}`), width),
						theme.fg("accent", "─".repeat(width)),
					];
				},
				invalidate() {},
				handleInput(data: string) {
					if (mode === "list") {
						if (matchesKey(data, Key.up)) {
							cursor = (cursor - 1 + items.length) % items.length;
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							cursor = (cursor + 1) % items.length;
							tui.requestRender();
						} else if (matchesKey(data, Key.space)) {
							const snippet = items[cursor];
							const state = working.get(snippet.id)!;
							// Cycle: off → temp → persistent → off
							if (!state.enabled) {
								state.enabled = true;
								state.persistent = false;
							} else if (!state.persistent) {
								state.persistent = true;
							} else {
								state.enabled = false;
								state.persistent = false;
							}
							tui.requestRender();
						} else if (matchesKey(data, Key.tab)) {
							mode = "preview";
							previewScroll = 0;
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							done(true);
						} else if (matchesKey(data, Key.escape)) {
							done(false);
						}
					} else {
						if (matchesKey(data, Key.up)) {
							previewScroll--;
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							previewScroll++;
							tui.requestRender();
						} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
							mode = "list";
							tui.requestRender();
						}
					}
				},
			};
		});

		if (confirmed) {
			// Even an explicit empty selection overrides automatic defaults.
			automaticSelection = false;
			// Update enabled set from working states
			enabled = new Set(
				[...working.entries()]
					.filter(([_, state]) => state.enabled)
					.map(([id, _]) => id)
			);

			// Write persistent flags back to disk
			for (const snippet of snippets) {
				const state = working.get(snippet.id)!;
				if (state.persistent !== (snippet.persistent ?? false)) {
					updateSnippetPersistent(snippet.id, state.persistent);
				}
			}

			// Reload snippets to reflect the changes
			snippets = loadSnippets();
		}
		updateWidget(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		// Copy default snippets on first run
		copyDefaultSnippets();

		// Load snippets
		snippets = loadSnippets();

		// A resumed/reloaded/forked session is eligible only if its retained history
		// has no user message. Startup reason alone cannot establish eligibility.
		automaticSelection = ctx.mode !== "json" && !hasRecordedUserMessage(ctx);
		if (automaticSelection) {
			enabled = new Set(snippets.filter((s) => s.persistent).map((s) => s.id));
		} else {
			enabled = new Set();
		}

		if (!existsSync(snippetsDir)) mkdirSync(snippetsDir, { recursive: true });
		updateWidget(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "user" || !automaticSelection) return;
		// Unlike manual input transforms, automatic snippets wrap finalized,
		// expanded content. Pi's documented replacement API updates agent state
		// and persists the returned message after this hook. Queued messages are
		// therefore counted in recording order, not input/queue order.
		const eligible = !hasRecordedUserMessage(ctx);
		snippets = loadSnippets();
		const active = eligible ? snippets.filter((s) => enabled.has(s.id)) : [];
		automaticSelection = false;
		enabled = new Set();
		updateWidget(ctx);
		if (active.length === 0) return;

		const prepend = active.filter((s) => s.placement === "prepend").map((s) => s.body);
		const append = active.filter((s) => s.placement === "append").map((s) => s.body);
		const content = event.message.content;
		return {
			message: {
				...event.message,
				content: typeof content === "string"
					? [...prepend, content, ...append].join("\n\n")
					: [
						...prepend.map((text) => ({ type: "text" as const, text: `${text}\n\n` })),
						...content,
						...append.map((text) => ({ type: "text" as const, text: `\n\n${text}` })),
					],
			},
		};
	});

	pi.on("input", async (event, ctx) => {
		// Also catch user entries inserted directly by another extension.
		if (automaticSelection && hasRecordedUserMessage(ctx)) {
			automaticSelection = false;
			enabled = new Set();
			updateWidget(ctx);
		}
		// Automatic selection is applied at the recording boundary, not here.
		if (automaticSelection || enabled.size === 0) return;

		snippets = loadSnippets();
		const active = snippets.filter((s) => enabled.has(s.id));

		// Manual selections remain one-shot. Automatic defaults are consumed only
		// when a user message is recorded, not when a preflight attempt begins.
		if (!automaticSelection) {
			enabled = new Set();
			updateWidget(ctx);
		}

		if (active.length === 0) return; // all enabled snippets disappeared from disk

		const prependBodies = active.filter((s) => s.placement === "prepend").map((s) => s.body);
		const appendBodies = active.filter((s) => s.placement === "append").map((s) => s.body);
		return {
			action: "transform",
			text: [...prependBodies, event.text, ...appendBodies].join("\n\n"),
		};
	});

	pi.registerShortcut("alt+s", {
		description: "Toggle prompt snippets",
		handler: async (ctx) => {
			await openMenu(ctx);
		},
	});

	pi.registerCommand("snippets", {
		description: "Open prompt snippet toggle menu",
		handler: async (_args, ctx) => {
			await openMenu(ctx);
		},
	});
}

/**
 * Prompt Snippets — mix and match single-purpose prompt rules.
 *
 * Each snippet is a markdown file with frontmatter (name, description,
 * placement, order, persistent), stored in `~/.pi/agent/snippets/`.
 *
 * - Press alt+s or run /snippets to open the selection UI. Space or Enter
 *   cycles snippet state (off -> temporary -> persistent -> off). Esc saves
 *   and applies changes.
 * - Active snippets are displayed as a widget above the editor, with visual
 *   distinction between prepend and append groups.
 * - The unified Visibility setting controls injection mode:
 *   - Visible: injected through input before display (default)
 *   - Hidden: injected through message_end after initial display
 * - Manual toggles reset on input transform (Visible) or recording (Hidden).
 *   Persistent snippets automatically apply until the first user recording
 *   (excluding JSON mode). Multiple pre-record Visible inputs may all receive them.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	SectionedSettings,
	type SectionedSettingItem,
	type SettingsSection,
	getSettingsTheme,
} from "@aliou/pi-utils-settings";

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

type VisibilityMode = "visible" | "hidden";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const snippetsDir = join(homedir(), ".pi", "agent", "snippets");
const configPath = join(homedir(), ".pi", "agent", "prompt-snippets-config.json");
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
	// Try multiple possible locations for bundled snippets
	const possibleLocations = [
		join(extensionDir, "snippets"),       // Same directory (source case)
		join(extensionDir, "..", "snippets"), // Parent directory (compiled case)
	];

	const defaultSnippetsDir = possibleLocations.find((path) => existsSync(path));
	if (!defaultSnippetsDir) return;

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

function loadVisibility(): VisibilityMode {
	try {
		if (existsSync(configPath)) {
			const config = JSON.parse(readFileSync(configPath, "utf8"));
			return config.visibility === "hidden" ? "hidden" : "visible";
		}
	} catch {
		// Fall through to default
	}
	return "visible";
}

function saveVisibility(visibility: VisibilityMode) {
	try {
		const dir = dirname(configPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ visibility }, null, 2), "utf8");
	} catch {
		// Ignore save errors
	}
}

export default function (pi: ExtensionAPI) {
	// Snippets last seen on disk (sorted). Refreshed when menu opens or message submits.
	let snippets: Snippet[] = [];
	// Manual selection: Visible consumes on transform; Hidden consumes on recording.
	let manualEnabled = new Set<string>();
	// Automatic eligibility: survives rejected inputs, consumed only at message_end
	let automaticEligible = false;
	// Automatic selection IDs: what persistent snippets to apply on first recorded message
	let automaticEnabled = new Set<string>();
	// IDs actually inserted by Visible input since the last user recording.
	// A mid-flight switch to Hidden must not insert those IDs a second time.
	let visiblyApplied = new Set<string>();
	// Visibility mode: visible (inject through input) or hidden (inject through message_end)
	let visibility: VisibilityMode = "visible";

	function hasRecordedUserMessage(ctx: ExtensionContext): boolean {
		// Deliberately inspect all history, including abandoned/compacted branches.
		return ctx.sessionManager.getEntries().some((entry) =>
			entry.type === "message" && entry.message.role === "user");
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		// Show both manual and automatic selections
		const allEnabled = new Set([...manualEnabled, ...automaticEnabled]);
		const active = snippets.filter((s) => allEnabled.has(s.id));
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
		visibility = loadVisibility();
		// Remove toggles for snippets no longer on disk.
		manualEnabled = new Set([...manualEnabled].filter((id) => snippets.some((s) => s.id === id)));
		automaticEnabled = new Set([...automaticEnabled].filter((id) => snippets.some((s) => s.id === id)));

		// Working copy; changed snippet states are applied on close (Esc).
		const working = new Map<string, SnippetState>();
		for (const snippet of snippets) {
			const isEnabled = manualEnabled.has(snippet.id) || (automaticEligible && automaticEnabled.has(snippet.id));
			working.set(snippet.id, {
				enabled: isEnabled,
				persistent: snippet.persistent ?? false,
			});
		}

		// Compare final intent with the menu-open snapshot, not live state: an
		// input or recording can consume selections while this screen is open.
		const initial = new Map([...working].map(([id, state]) => [id, { ...state }]));
		let workingVisibility = visibility;
		let previewSnippet: Snippet | null = null;
		let previewScroll = 0;

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const settingsTheme = getSettingsTheme(theme);
			const prepends = snippets.filter((s) => s.placement === "prepend");
			const appends = snippets.filter((s) => s.placement === "append");

			const buildSections = (): SettingsSection[] => {
				const prependItems: SectionedSettingItem[] = prepends.map((snippet) => {
					const state = working.get(snippet.id)!;
					const status = !state.enabled ? "off" : state.persistent ? "persistent" : "temporary";
					return {
						id: snippet.id,
						label: snippet.name,
						description: snippet.description,
						currentValue: status,
						values: ["off", "temporary", "persistent"],
					};
				});

				const appendItems: SectionedSettingItem[] = appends.map((snippet) => {
					const state = working.get(snippet.id)!;
					const status = !state.enabled ? "off" : state.persistent ? "persistent" : "temporary";
					return {
						id: snippet.id,
						label: snippet.name,
						description: snippet.description,
						currentValue: status,
						values: ["off", "temporary", "persistent"],
					};
				});

				const settingsItems: SectionedSettingItem[] = [
					{
						id: "visibility",
						label: "Visibility",
						description: "Visible: inject before display (input transform). Hidden: inject after display (message_end). Model receives full content in both modes.",
						currentValue: workingVisibility === "visible" ? "Visible" : "Hidden",
						values: ["Visible", "Hidden"],
					},
				];

				return [
					{ label: "Prepend — inserted before your message", items: prependItems },
					{ label: "Append — inserted after your message", items: appendItems },
					{ label: "Settings", items: settingsItems },
				];
			};

			let settingsComponent: SectionedSettings | null = null;
			let mode: "list" | "preview" = "list";
			// Search is disabled; own navigation so Tab can use the same public
			// selectItem API as the list, without inspecting library internals.
			const itemIds = [...prepends, ...appends].map((snippet) => snippet.id).concat("visibility");
			let selectedIndex = 0;

			const rebuildSettings = () => {
				if (settingsComponent) {
					settingsComponent.updateSections(buildSections());
					return;
				}
				settingsComponent = new SectionedSettings({
					sections: buildSections(),
					theme: settingsTheme,
					onChange: (id: string, newValue: string) => {
						if (id === "visibility") {
							workingVisibility = newValue === "Hidden" ? "hidden" : "visible";
							return;
						}

						const snippet = snippets.find((s) => s.id === id);
						if (!snippet) return;

						const state = working.get(id)!;
						if (newValue === "off") {
							state.enabled = false;
							state.persistent = false;
						} else if (newValue === "temporary") {
							state.enabled = true;
							state.persistent = false;
						} else if (newValue === "persistent") {
							state.enabled = true;
							state.persistent = true;
						}
						rebuildSettings();
					},
					onCancel: () => done(),
					maxVisible: 15,
					enableSearch: false,
					hideHint: true,
				});
			};

			rebuildSettings();

			const buildPreviewRows = (snippet: Snippet, width: number): string[] => {
				const rows: string[] = [];
				const state = working.get(snippet.id)!;
				const statusLabel =
					!state.enabled ? "" :
					state.persistent ? " (persistent)" :
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

			const viewport = (
				lines: string[],
				scroll: number,
				maxView: number,
			): { out: string[]; scroll: number } => {
				const clipped = lines.length > maxView;
				const view = clipped ? Math.max(1, maxView - 2) : maxView;

				let s = Math.min(Math.max(0, scroll), Math.max(0, lines.length - view));

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
					const maxView = Math.max(5, tui.terminal.rows - 10);

					let content: string[];
					let title: string;
					let hints: string;

					if (mode === "list") {
						content = settingsComponent!.render(width);
						title = "Prompt snippets";
						hints = "↑↓ navigate • Space/Enter cycle • Tab preview • Esc save & apply";
					} else {
						const rows = buildPreviewRows(previewSnippet!, width);
						const v = viewport(rows, previewScroll, maxView);
						content = v.out;
						previewScroll = v.scroll;
						title = `Preview: ${previewSnippet!.name}`;
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
					].map((line) => truncateToWidth(line, width));
				},
				invalidate() {
					settingsComponent?.invalidate();
				},
				handleInput(data: string) {
					if (mode === "list") {
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							selectedIndex = (selectedIndex + (matchesKey(data, Key.up) ? -1 : 1) + itemIds.length) % itemIds.length;
							settingsComponent?.selectItem(itemIds[selectedIndex]);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.tab)) {
							const selectedId = itemIds[selectedIndex];
							if (selectedId && selectedId !== "visibility") {
								const snippet = snippets.find((s) => s.id === selectedId);
								if (snippet) {
									previewSnippet = snippet;
									previewScroll = 0;
									mode = "preview";
									tui.requestRender();
									return;
								}
							}
							// If Tab pressed on Visibility, do nothing (no preview)
							return;
						} else if (matchesKey(data, Key.escape)) {
							done();
							return;
						} else {
							settingsComponent?.handleInput(data);
							tui.requestRender();
						}
					} else {
						// Preview mode
						if (matchesKey(data, Key.up)) {
							previewScroll = Math.max(0, previewScroll - 1);
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

		// Apply only actual snippet edits. Opening/closing the menu or changing
		// Visibility must neither promote automatic defaults to manual selections
		// nor restore a selection consumed while the menu was open.
		for (const [id, state] of working) {
			const before = initial.get(id)!;
			if (state.enabled === before.enabled && state.persistent === before.persistent) continue;
			automaticEnabled.delete(id);
			if (state.enabled) manualEnabled.add(id);
			else manualEnabled.delete(id);
		}

		// Write persistent flags back to disk
		for (const snippet of snippets) {
			const state = working.get(snippet.id)!;
			if (state.persistent !== (snippet.persistent ?? false)) {
				updateSnippetPersistent(snippet.id, state.persistent);
			}
		}

		// Save visibility setting
		if (workingVisibility !== visibility) {
			visibility = workingVisibility;
			saveVisibility(visibility);
		}

		// Reload snippets to reflect the changes
		snippets = loadSnippets();
		updateWidget(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		// Copy default snippets on first run
		copyDefaultSnippets();

		// Load snippets and config
		snippets = loadSnippets();
		visibility = loadVisibility();

		// A resumed/reloaded/forked session is eligible only if its retained history
		// has no user message. Startup reason alone cannot establish eligibility.
		automaticEligible = ctx.mode !== "json" && !hasRecordedUserMessage(ctx);
		if (automaticEligible) {
			automaticEnabled = new Set(snippets.filter((s) => s.persistent).map((s) => s.id));
		} else {
			automaticEnabled = new Set();
		}
		manualEnabled = new Set();
		visiblyApplied = new Set();

		if (!existsSync(snippetsDir)) mkdirSync(snippetsDir, { recursive: true });
		updateWidget(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "user") return;

		const content = event.message.content;
		const ids = new Set<string>();
		if (visibility === "hidden") {
			for (const id of manualEnabled) ids.add(id);
			if (automaticEligible && !hasRecordedUserMessage(ctx)) {
				for (const id of automaticEnabled) ids.add(id);
			}
			manualEnabled = new Set();
			for (const id of visiblyApplied) ids.delete(id);
		}
		visiblyApplied = new Set();
		// Only a finalized user message consumes automatic eligibility. Visible
		// inputs transformed before this recording retain their automatic snippets.
		automaticEligible = false;
		automaticEnabled = new Set();
		updateWidget(ctx);
		if (ids.size === 0) return;

		snippets = loadSnippets();
		const active = snippets.filter((snippet) => ids.has(snippet.id));
		if (active.length === 0) return;
		const prepend = active.filter((s) => s.placement === "prepend").map((s) => s.body);
		const append = active.filter((s) => s.placement === "append").map((s) => s.body);
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
		if (automaticEligible && hasRecordedUserMessage(ctx)) {
			automaticEligible = false;
			automaticEnabled = new Set();
			updateWidget(ctx);
		}

		// When visibility is "hidden", don't transform input - let message_end handle it
		if (visibility === "hidden") {
			return;
		}

		// Determine which snippets to apply: manual (one-shot) or automatic (eligible)
		const hasManual = manualEnabled.size > 0;
		const hasAutomatic = automaticEligible && automaticEnabled.size > 0;
		if (!hasManual && !hasAutomatic) return;

		snippets = loadSnippets();
		// Combine manual and automatic selections for this transform
		const allEnabled = new Set([...manualEnabled, ...automaticEnabled]);
		const active = snippets.filter((s) => allEnabled.has(s.id));

		// Manual selections are one-shot: clear immediately after transform
		if (hasManual) {
			manualEnabled = new Set();
			updateWidget(ctx);
		}

		if (active.length === 0) return; // all enabled snippets disappeared from disk
		for (const snippet of active) visiblyApplied.add(snippet.id);

		const prependBodies = active.filter((s) => s.placement === "prepend").map((s) => s.body);
		const appendBodies = active.filter((s) => s.placement === "append").map((s) => s.body);
		const transformed = [...prependBodies, event.text, ...appendBodies].join("\n\n");

		return {
			action: "transform",
			text: transformed,
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

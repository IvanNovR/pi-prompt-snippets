/**
 * Interactive snippet selection menu
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	SectionedSettings,
	type SectionedSettingItem,
	type SettingsSection,
	getSettingsTheme,
} from "@aliou/pi-utils-settings";
import type { Snippet } from "./snippets.js";
import type { RuntimeState, SnippetState, VisibilityMode } from "./state.js";
import { loadSnippets, updateSnippetPersistent } from "./snippets.js";
import { loadVisibility, saveVisibility } from "./settings.js";

export async function openMenu(
	ctx: ExtensionContext,
	state: RuntimeState,
	snippetsDir: string,
	configPath: string
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Snippet menu requires interactive mode", "warning");
		return;
	}

	state.snippets = loadSnippets(snippetsDir);
	state.visibility = loadVisibility(configPath);
	state.cleanupStaleSelections();

	// Working copy; changed snippet states are applied on close (Esc).
	const working = new Map<string, SnippetState>();
	for (const snippet of state.snippets) {
		// Saved persistent configuration remains selected after its session
		// application is consumed; runtime sets alone drive injection/widget.
		const isEnabled = !!snippet.persistent || state.manualEnabled.has(snippet.id) || (state.automaticEligible && state.automaticEnabled.has(snippet.id));
		working.set(snippet.id, {
			enabled: isEnabled,
			persistent: snippet.persistent ?? false,
		});
	}

	// Compare final intent with the menu-open snapshot, not live state: an
	// input or recording can consume selections while this screen is open.
	const initial = new Map([...working].map(([id, state]) => [id, { ...state }]));
	let workingVisibility = state.visibility;
	let previewSnippet: Snippet | null = null;
	let previewScroll = 0;

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const settingsTheme = getSettingsTheme(theme);
		const prepends = state.snippets.filter((s) => s.placement === "prepend");
		const appends = state.snippets.filter((s) => s.placement === "append");

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

					const snippet = state.snippets.find((s) => s.id === id);
					if (!snippet) return;

					const snippetState = working.get(id)!;
					if (newValue === "off") {
						snippetState.enabled = false;
						snippetState.persistent = false;
					} else if (newValue === "temporary") {
						snippetState.enabled = true;
						snippetState.persistent = false;
					} else if (newValue === "persistent") {
						snippetState.enabled = true;
						snippetState.persistent = true;
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
			const snippetState = working.get(snippet.id)!;
			const statusLabel =
				!snippetState.enabled ? "" :
				snippetState.persistent ? " (persistent)" :
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
							const snippet = state.snippets.find((s) => s.id === selectedId);
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
	for (const [id, snippetState] of working) {
		const before = initial.get(id)!;
		if (snippetState.enabled === before.enabled && snippetState.persistent === before.persistent) continue;
		state.automaticEnabled.delete(id);
		if (snippetState.enabled) state.manualEnabled.add(id);
		else state.manualEnabled.delete(id);
	}

	// Write persistent flags back to disk
	for (const snippet of state.snippets) {
		const snippetState = working.get(snippet.id)!;
		if (snippetState.persistent !== (snippet.persistent ?? false)) {
			updateSnippetPersistent(snippetsDir, snippet.id, snippetState.persistent);
		}
	}

	// Save visibility setting
	if (workingVisibility !== state.visibility) {
		state.visibility = workingVisibility;
		saveVisibility(configPath, state.visibility);
	}

	// Reload snippets to reflect the changes
	state.snippets = loadSnippets(snippetsDir);
}

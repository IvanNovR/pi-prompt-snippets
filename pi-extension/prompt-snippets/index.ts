/**
 * Prompt Snippets — mix and match single-purpose prompt rules.
 *
 * Each snippet is a markdown file with frontmatter (name, description,
 * placement, order, persistent), stored in `~/.pi/agent/snippets/`.
 *
 * - Press alt+s or run /snippets (or /snippets settings) to open settings. Space or Enter
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

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { seedDefaultSnippets, restoreDefaultSnippets } from "./defaults.js";
import { loadSnippets } from "./snippets.js";
import { RuntimeState } from "./state.js";
import { loadVisibility } from "./settings.js";
import { openMenu } from "./menu.js";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const snippetsDir = join(homedir(), ".pi", "agent", "snippets");
const configPath = join(homedir(), ".pi", "agent", "prompt-snippets-config.json");
const WIDGET_ID = "prompt-snippets";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
	ctx.ui.notify(message, level);
	// Print/JSON UI notifications are no-ops. Keep failures visible on stderr.
	if (!ctx.hasUI && level !== "info") console.error(`[prompt-snippets] ${message}`);
}

function updateWidget(ctx: ExtensionContext, state: RuntimeState) {
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	// Show both manual and automatic selections
	const active = state.getActiveSnippets();
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

export default function (pi: ExtensionAPI) {
	const state = new RuntimeState();

	pi.on("session_start", (_event, ctx) => {
		// Seed default snippets (non-destructive, ledger-based)
		try {
			const result = seedDefaultSnippets(extensionDir, snippetsDir);
			for (const warning of result.warnings) notify(ctx, warning, "warning");
			if (result.failed.length) notify(ctx, `Default snippet seeding failed (will retry): ${result.failed.join("; ")}`, "warning");
		} catch (error) {
			// Existing snippets remain usable even if seeding or ledger writes fail.
			notify(ctx, `Could not seed default snippets: ${String(error)}`, "error");
		}

		// Load snippets and config
		state.snippets = loadSnippets(snippetsDir);
		state.visibility = loadVisibility(configPath);

		// A resumed/reloaded/forked session is eligible only if its retained history
		// has no user message. Startup reason alone cannot establish eligibility.
		state.automaticEligible = ctx.mode !== "json" && !state.hasRecordedUserMessage(ctx);
		if (state.automaticEligible) {
			state.automaticEnabled = new Set(state.snippets.filter((s) => s.persistent).map((s) => s.id));
		} else {
			state.automaticEnabled = new Set();
		}
		state.manualEnabled = new Set();
		state.visiblyApplied = new Set();

		updateWidget(ctx, state);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "user") return;

		const content = event.message.content;
		const ids = new Set<string>();
		if (state.visibility === "hidden") {
			for (const id of state.manualEnabled) ids.add(id);
			if (state.automaticEligible && !state.hasRecordedUserMessage(ctx)) {
				for (const id of state.automaticEnabled) ids.add(id);
			}
			state.manualEnabled = new Set();
			for (const id of state.visiblyApplied) ids.delete(id);
		}
		state.visiblyApplied = new Set();
		// Only a finalized user message consumes automatic eligibility. Visible
		// inputs transformed before this recording retain their automatic snippets.
		state.automaticEligible = false;
		state.automaticEnabled = new Set();
		updateWidget(ctx, state);
		if (ids.size === 0) return;

		state.snippets = loadSnippets(snippetsDir);
		const active = state.snippets.filter((snippet) => ids.has(snippet.id));
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
		if (state.automaticEligible && state.hasRecordedUserMessage(ctx)) {
			state.automaticEligible = false;
			state.automaticEnabled = new Set();
			updateWidget(ctx, state);
		}

		// When visibility is "hidden", don't transform input - let message_end handle it
		if (state.visibility === "hidden") {
			return;
		}

		// Determine which snippets to apply: manual (one-shot) or automatic (eligible)
		const hasManual = state.manualEnabled.size > 0;
		const hasAutomatic = state.automaticEligible && state.automaticEnabled.size > 0;
		if (!hasManual && !hasAutomatic) return;

		state.snippets = loadSnippets(snippetsDir);
		// Combine manual and automatic selections for this transform
		const allEnabled = state.getActiveSnippetIds();
		const active = state.snippets.filter((s) => allEnabled.has(s.id));

		// Manual selections are one-shot: clear immediately after transform
		if (hasManual) {
			state.manualEnabled = new Set();
			updateWidget(ctx, state);
		}

		if (active.length === 0) return; // all enabled snippets disappeared from disk
		for (const snippet of active) state.visiblyApplied.add(snippet.id);

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
			await openMenu(ctx, state, snippetsDir, configPath);
			updateWidget(ctx, state);
		},
	});

	pi.registerCommand("snippets", {
		description: "Open snippet settings (default) or restore bundled defaults",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const argument = prefix.trimStart();
			if (!/\s/.test(argument)) {
				const items = [
					{ value: "settings", label: "settings", description: "Open snippet settings (default)" },
					{ value: "restore", label: "restore", description: "Restore bundled default snippets" },
				].filter((item) => item.value.startsWith(argument));
				return items.length > 0 ? items : null;
			}
			// Native completion replaces the entire argument prefix, not its last token.
			const match = argument.match(/^restore\s+(\S*)$/);
			if (match && "--yes".startsWith(match[1])) {
				return [{ value: "restore --yes", label: "--yes", description: "Skip confirmation prompt" }];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "" || trimmed === "settings") {
				// Settings are the default action; the explicit alias opens the same menu.
				await openMenu(ctx, state, snippetsDir, configPath);
				updateWidget(ctx, state);
				return;
			}

			// Parse restore command
			const parts = trimmed.split(/\s+/);
			const command = parts[0];

			if (command === "restore") {
				const hasYesFlag = parts.includes("--yes");
				const unknownArgs = parts.slice(1).filter(p => p !== "--yes");

				if (unknownArgs.length > 0) {
					notify(ctx, `Unknown arguments: ${unknownArgs.join(", ")}`, "error");
					return;
				}

				// In non-interactive mode, require --yes
				if (!ctx.hasUI && !hasYesFlag) {
					notify(ctx, "Restore requires --yes flag without UI", "error");
					return;
				}

				// Confirm if interactive and no --yes flag
				if (ctx.hasUI && !hasYesFlag) {
					const confirmed = await ctx.ui.confirm(
						"Restore default snippets",
						"This will overwrite custom edits to current bundled snippets with shipped originals (saved selection modes are retained). Missing bundled files will be restored. Other custom files will be preserved. Continue?"
					);
					if (!confirmed) {
						return; // User cancelled, no writes
					}
				}

				// Prune against actual files BEFORE recreating missing defaults. A stale
				// pending ID must not automatically activate a newly restored file.
				state.snippets = loadSnippets(snippetsDir);
				state.cleanupStaleSelections();

				// Perform restore
				let result;
				try {
					result = restoreDefaultSnippets(extensionDir, snippetsDir);
				} catch (error) {
					notify(ctx, `Could not restore default snippets: ${String(error)}`, "error");
					updateWidget(ctx, state);
					return;
				}

				if (result.failed.length > 0) {
					notify(ctx,
						`Restored ${result.success.length} snippets, ${result.failed.length} failed: ${result.failed.join(", ")}`,
						"warning"
					);
				} else if (result.success.length > 0) {
					notify(ctx, `Restored ${result.success.length} default snippets`, "info");
				} else {
					notify(ctx, "No bundled snippets found to restore", "warning");
				}

				// Reload files and update state
				state.snippets = loadSnippets(snippetsDir);
				// Preserve current selected state for existing snippets
				state.cleanupStaleSelections();
				// Do NOT autoactivate newly restored snippets
				// Do NOT modify sent messages
				updateWidget(ctx, state);
			} else {
				notify(ctx, `Unknown command: ${command}`, "error");
			}
		},
	});
}

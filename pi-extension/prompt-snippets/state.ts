/**
 * Runtime state management
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Snippet } from "./snippets.js";

export interface SnippetState {
	enabled: boolean;
	persistent: boolean;
}

export type VisibilityMode = "visible" | "hidden";

export class RuntimeState {
	// Snippets last seen on disk (sorted). Refreshed when menu opens or message submits.
	snippets: Snippet[] = [];
	// Manual selection: Visible consumes on transform; Hidden consumes on recording.
	manualEnabled = new Set<string>();
	// Automatic eligibility: survives rejected inputs, consumed only at message_end
	automaticEligible = false;
	// Automatic selection IDs: what persistent snippets to apply on first recorded message
	automaticEnabled = new Set<string>();
	// IDs actually inserted by Visible input since the last user recording.
	// A mid-flight switch to Hidden must not insert those IDs a second time.
	visiblyApplied = new Set<string>();
	// Visibility mode: visible (inject through input) or hidden (inject through message_end)
	visibility: VisibilityMode = "visible";

	hasRecordedUserMessage(ctx: ExtensionContext): boolean {
		// Deliberately inspect all history, including abandoned/compacted branches.
		return ctx.sessionManager.getEntries().some((entry) =>
			entry.type === "message" && entry.message.role === "user");
	}

	getActiveSnippetIds(): Set<string> {
		return new Set([...this.manualEnabled, ...this.automaticEnabled]);
	}

	getActiveSnippets(): Snippet[] {
		const allEnabled = this.getActiveSnippetIds();
		return this.snippets.filter((s) => allEnabled.has(s.id));
	}

	cleanupStaleSelections() {
		// Remove toggles for snippets no longer on disk.
		this.manualEnabled = new Set([...this.manualEnabled].filter((id) => this.snippets.some((s) => s.id === id)));
		this.automaticEnabled = new Set([...this.automaticEnabled].filter((id) => this.snippets.some((s) => s.id === id)));
	}
}

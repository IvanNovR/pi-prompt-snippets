/**
 * Visibility setting persistence
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VisibilityMode } from "./state.js";

export function loadVisibility(configPath: string): VisibilityMode {
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

export function saveVisibility(configPath: string, visibility: VisibilityMode) {
	try {
		const dir = dirname(configPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ visibility }, null, 2), "utf8");
	} catch {
		// Ignore save errors
	}
}

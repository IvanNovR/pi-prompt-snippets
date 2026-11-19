/** Bundled defaults are seeded once per filename, independently of installation. */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readPersistent, withPersistent } from "./snippets.js";

interface Ledger {
	seen: string[];
	pending: string[];
}

export interface DefaultResult {
	success: string[];
	failed: string[];
	warnings: string[];
}

function loadLedger(path: string, warnings: string[]): Ledger {
	if (!existsSync(path)) return { seen: [], pending: [] };
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(value.seen) || !value.seen.every((name: unknown) => typeof name === "string") ||
			(value.pending !== undefined && (!Array.isArray(value.pending) || !value.pending.every((name: unknown) => typeof name === "string")))) {
			throw new Error("Invalid ledger format");
		}
		return { seen: value.seen, pending: value.pending ?? [] };
	} catch (error) {
		warnings.push(`Could not read defaults ledger; rebuilding as a first launch (deleted defaults may return): ${String(error)}`);
		return { seen: [], pending: [] };
	}
}

function saveLedger(path: string, ledger: Ledger) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(ledger, null, 2), "utf8");
	renameSync(temporary, path);
}

function bundledDirectory(extensionDir: string): string {
	// Source: pi-extension/prompt-snippets; compiled: dist/pi-extension/prompt-snippets.
	const candidates = [join(extensionDir, "..", "..", "snippets"), join(extensionDir, "..", "..", "..", "snippets")];
	const directory = candidates.find((path) => existsSync(path));
	if (!directory) throw new Error("Bundled snippets directory not found");
	return directory;
}

function bundledFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((file) => file.isFile() && file.name.toLowerCase().endsWith(".md"))
		.map((file) => file.name).sort();
}

export function seedDefaultSnippets(extensionDir: string, snippetsDir: string): DefaultResult {
	const result: DefaultResult = { success: [], failed: [], warnings: [] };
	const directory = bundledDirectory(extensionDir);
	const path = join(homedir(), ".pi", "agent", "prompt-snippets-defaults-ledger.json");
	const ledger = loadLedger(path, result.warnings);
	const unseen = bundledFiles(directory).filter((file) => !ledger.seen.includes(file));
	if (unseen.length === 0) return result;

	// Persist retry intent before touching snippets. A failed copy remains pending,
	// unlike a completed filename deliberately deleted by the user later.
	ledger.pending = [...new Set([...ledger.pending, ...unseen])];
	saveLedger(path, ledger);
	mkdirSync(snippetsDir, { recursive: true });
	for (const file of unseen) {
		try {
			try {
				copyFileSync(join(directory, file), join(snippetsDir, file), constants.COPYFILE_EXCL);
				result.success.push(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// A collision is known too: deleting it must not restore a default.
			}
			ledger.seen.push(file);
			ledger.pending = ledger.pending.filter((name) => name !== file);
		} catch (error) {
			result.failed.push(`${file}: ${String(error)}`);
		}
	}
	saveLedger(path, ledger);
	return result;
}

/** Replace current bundled filenames only, retaining existing saved selection modes. */
export function restoreDefaultSnippets(extensionDir: string, snippetsDir: string): DefaultResult {
	const directory = bundledDirectory(extensionDir);
	const result: DefaultResult = { success: [], failed: [], warnings: [] };
	mkdirSync(snippetsDir, { recursive: true });
	for (const file of bundledFiles(directory)) {
		try {
			const target = join(snippetsDir, file);
			const original = readFileSync(join(directory, file), "utf8");
			// Persistence is configured in frontmatter, separate from runtime use.
			const existing = existsSync(target) ? readPersistent(readFileSync(target, "utf8")) : undefined;
			const content = existing !== undefined && existing !== readPersistent(original)
				? withPersistent(original, existing) : original;
			writeFileSync(target, content, "utf8");
			result.success.push(file);
		} catch (error) {
			result.failed.push(`${file}: ${String(error)}`);
		}
	}
	return result;
}

/**
 * Snippet data model and file operations
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Snippet {
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

export function parseSnippet(filename: string, raw: string): Snippet | null {
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

/** Load all snippets, sorted: prepend group first, append group last, each by (order, name). */
export function loadSnippets(snippetsDir: string): Snippet[] {
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

/** Read the configured mode even when the edited body is empty/invalid. */
export function readPersistent(raw: string): boolean | undefined {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return undefined;
	let value = "false";
	for (const line of match[1].split(/\r?\n/)) {
		const field = line.match(/^persistent\s*:\s*(.*)$/i);
		if (field) value = field[1].trim().replace(/^["']|["']$/g, "");
	}
	return value.toLowerCase() === "true";
}

export function updateSnippetPersistent(snippetsDir: string, snippetId: string, persistent: boolean) {
	const path = join(snippetsDir, snippetId);
	if (!existsSync(path)) return;

	try {
		const content = readFileSync(path, "utf8");
		writeFileSync(path, withPersistent(content, persistent), "utf8");
	} catch {
		// Skip files that can't be updated
	}
}

/** Change only the saved persistent flag, preserving the snippet body. */
export function withPersistent(content: string, persistent: boolean): string {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return content;
	const lines = match[1].split(/\r?\n/);
	const index = lines.findIndex((line) => /^persistent\s*:/i.test(line));
	if (index >= 0) lines[index] = `persistent: ${persistent}`;
	else lines.push(`persistent: ${persistent}`);
	return `---\n${lines.join("\n")}\n---\n${match[2]}`;
}

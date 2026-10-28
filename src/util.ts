const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sorts "page2.jpg" before "page10.jpg". */
export function naturalCompare(a: string, b: string): number {
	return collator.compare(a, b);
}

/** Turns an HTML snippet into plain text without running any of it. */
export function htmlToText(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Removes characters Obsidian or the OS do not allow in file names. */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	return cleaned.slice(0, 150) || "Untitled comic";
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Archive metadata fields can be a string, a list of strings or missing. */
export function firstText(value: unknown): string {
	if (Array.isArray(value)) return value.map(firstText).filter(Boolean).join(", ");
	return typeof value === "string" ? value.trim() : "";
}

export function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

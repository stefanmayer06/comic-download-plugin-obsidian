import type { ComicFile } from "./sources/types";

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

/** A readable reason from anything a promise can reject with. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	const message = (error as { message?: unknown } | null)?.message;
	if (typeof message === "string" && message) return message;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

export function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** A comic file's format from its first bytes, whatever its name says. */
export function detectComicExtension(data: ArrayBuffer): ComicFile["extension"] | null {
	const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
	if (bytes.length >= 6 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1a && bytes[5] === 0x07) {
		return "cbr";
	}
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08))
	) {
		return "cbz";
	}
	for (let i = 0; i <= bytes.length - 5; i++) {
		if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
			return "pdf";
		}
	}
	return null;
}

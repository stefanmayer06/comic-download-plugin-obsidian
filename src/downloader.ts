import { App, normalizePath, requestUrl, TFile } from "obsidian";
import type { ComicFile } from "./sources/types";
import { sanitizeFileName } from "./util";

/** Creates every missing folder along `path`. */
async function ensureFolder(app: App, path: string): Promise<void> {
	let current = "";
	for (const part of path.split("/")) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}

export function comicPath(folder: string, name: string, file: ComicFile): string {
	return normalizePath(`${folder}/${sanitizeFileName(name)}.${file.extension}`);
}

/**
 * Saves a comic file into the comics folder. If a file with the same name is
 * already there, that file is returned instead of downloading it again.
 */
export async function downloadComic(app: App, folder: string, name: string, file: ComicFile): Promise<TFile> {
	const requestedPath = comicPath(folder, name, file);
	const existing = app.vault.getAbstractFileByPath(requestedPath);
	if (existing instanceof TFile) return existing;

	const response = await requestUrl({ url: file.url });
	const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
	if (/text\/html/i.test(contentType)) throw new Error("The download link returned a web page instead of a comic");
	const data = response.arrayBuffer;
	if (data.byteLength === 0) throw new Error("The download was empty");

	// Some sources use opaque redirect URLs, so their stated extension is only
	// a hint. Use the file signature to avoid saving a RAR archive as CBZ.
	const detected = detectComicExtension(data);
	if (!detected) throw new Error("The download was not a CBZ, CBR or PDF file");
	const path = comicPath(folder, name, { ...file, extension: detected });
	if (path !== requestedPath) {
		const existingActual = app.vault.getAbstractFileByPath(path);
		if (existingActual instanceof TFile) return existingActual;
	}

	await ensureFolder(app, normalizePath(folder));
	return app.vault.createBinary(path, data);
}

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

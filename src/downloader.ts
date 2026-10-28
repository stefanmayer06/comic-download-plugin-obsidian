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
	const path = comicPath(folder, name, file);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) return existing;

	const response = await requestUrl({ url: file.url });
	const data = response.arrayBuffer;
	if (data.byteLength === 0) throw new Error("The download was empty");

	await ensureFolder(app, normalizePath(folder));
	return app.vault.createBinary(path, data);
}

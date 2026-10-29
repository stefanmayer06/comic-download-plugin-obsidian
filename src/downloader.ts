import { App, DataAdapter, normalizePath, RequestUrlResponse, TFile } from "obsidian";
import { bodyPreview, fetchUrl, HttpError, pageTitle, responseHeader } from "./http";
import { log } from "./log";
import type { ComicFile } from "./sources/types";
import { detectComicExtension, errorMessage, formatBytes, sanitizeFileName } from "./util";

/**
 * Comics are fetched in pieces of this size. On mobile each response is
 * handed from the native app to Obsidian in one go, which a single 150 MB
 * response may never finish; pieces also give progress to show and a point
 * where a download can be cancelled.
 */
const PIECE_SIZE = 8 * 1024 * 1024;
/**
 * Tries per piece before the download fails after server errors. Waits
 * between tries grow from 5 seconds to 40, riding out a file server's brief
 * outages: a slow download can take half an hour, which shouldn't be lost
 * to one error.
 */
const SERVER_ERROR_ATTEMPTS = 5;
/**
 * The longest wait, in seconds, before trying a piece again without a
 * connection. Those tries never run out, as phones cut off apps in the
 * background until they're opened again.
 */
const MAX_WAIT = 60;

/** Thrown when a download is cancelled, or stopped to carry on later. */
class DownloadStopped extends Error {
	constructor() {
		super("The download was stopped");
		this.name = "DownloadStopped";
	}
}

/** What the first piece of a file showed. */
export interface FoundFile {
	/** Size in bytes. */
	total: number;
	/** The format its first bytes show, which may not be the one listed. */
	extension: ComicFile["extension"];
}

export interface DownloadOptions {
	/** Where the pieces fetched so far are kept. */
	pieces: SavedPieces;
	/** What the first piece showed, when carrying on a download that stopped after it. */
	found?: FoundFile;
	/** Called once the first piece is saved, so the download can carry on from there later. */
	onFound?: (found: FoundFile) => Promise<void>;
	/** Called after each piece, and when a download carries on. `total` is the file size in bytes. */
	onProgress?: (received: number, total: number) => void;
	/** Called after a failed try, before waiting `seconds` to try again. */
	onWaiting?: (reason: string, seconds: number) => void;
	/** Checked between pieces and while waiting; a true result stops with DownloadStopped. */
	isStopped?: () => boolean;
}

/**
 * The pieces of a download fetched so far, each in its own file named
 * after its first byte, e.g. `8388608.part`. They are kept in the plugin
 * folder, so a download carries on from where it stopped after Obsidian is
 * closed, and are joined into the comic once they're all there.
 */
export class SavedPieces {
	constructor(
		private adapter: DataAdapter,
		readonly folder: string,
	) {}

	/** How many bytes from the start of the file are saved. */
	async size(): Promise<number> {
		const pieces = await this.inOrder();
		const last = pieces[pieces.length - 1];
		return last ? last.start + last.size : 0;
	}

	async add(start: number, data: ArrayBuffer): Promise<void> {
		if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
		await this.adapter.writeBinary(`${this.folder}/${start}.part`, data);
	}

	/** The whole file, from pieces that should add up to `total` bytes. */
	async join(total: number): Promise<ArrayBuffer> {
		const bytes = new Uint8Array(total);
		let joined = 0;
		for (const piece of await this.inOrder()) {
			const data = await this.adapter.readBinary(piece.path);
			if (piece.start + data.byteLength > total) break;
			bytes.set(new Uint8Array(data), piece.start);
			joined = piece.start + data.byteLength;
		}
		if (joined !== total) throw new Error(`The saved pieces hold ${formatBytes(joined)} of the ${formatBytes(total)} file`);
		return bytes.buffer;
	}

	/** Deletes the pieces. A failure is logged, as it only leaves files that the next start tidies up. */
	async clear(): Promise<void> {
		try {
			if (await this.adapter.exists(this.folder)) await this.adapter.rmdir(this.folder, true);
		} catch (error) {
			log.warn(`Could not delete the pieces in ${this.folder}`, error);
		}
	}

	/**
	 * The pieces that follow on from each other from the first byte. A piece
	 * cut short by Obsidian closing while it was written is fetched again from
	 * where it ends, so pieces can overlap; they hold the same bytes where
	 * they do, and pieces with nothing new are skipped.
	 */
	private async inOrder(): Promise<{ path: string; start: number; size: number }[]> {
		if (!(await this.adapter.exists(this.folder))) return [];
		const pieces: { path: string; start: number; size: number }[] = [];
		for (const path of (await this.adapter.list(this.folder)).files) {
			const start = Number(path.match(/(\d+)\.part$/)?.[1]);
			const stat = Number.isFinite(start) ? await this.adapter.stat(path) : null;
			if (stat) pieces.push({ path, start, size: stat.size });
		}
		pieces.sort((a, b) => a.start - b.start);
		const chain: typeof pieces = [];
		let end = 0;
		for (const piece of pieces) {
			if (piece.start > end) break;
			if (piece.start + piece.size <= end) continue;
			chain.push(piece);
			end = piece.start + piece.size;
		}
		return chain;
	}
}

/** Creates every missing folder along `path`. */
async function ensureFolder(app: App, path: string): Promise<void> {
	let current = "";
	for (const part of path.split("/")) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			log.info(`Creating folder ${current}`);
			await app.vault.createFolder(current);
		}
	}
}

export function comicPath(folder: string, name: string, file: ComicFile): string {
	return normalizePath(`${folder}/${sanitizeFileName(name)}.${file.extension}`);
}

/**
 * Saves a comic file into the comics folder, carrying on from the pieces
 * saved before if there are any. If a file with the same name is already
 * there, that file is returned instead of downloading it again.
 */
export async function downloadComic(app: App, folder: string, name: string, file: ComicFile, options: DownloadOptions): Promise<TFile> {
	const { pieces } = options;
	const requestedPath = comicPath(folder, name, file);
	const existing = app.vault.getAbstractFileByPath(requestedPath);
	if (existing instanceof TFile) {
		log.info(`${existing.path} is already in the vault, so it isn't downloaded again`);
		return existing;
	}

	let found = options.found;
	let path: string;
	let received: number;
	if (found) {
		path = comicPath(folder, name, { ...file, extension: found.extension });
		const existingActual = app.vault.getAbstractFileByPath(path);
		if (existingActual instanceof TFile) {
			log.info(`${existingActual.path} is already in the vault, so it isn't saved again`);
			return existingActual;
		}
		received = await pieces.size();
		log.info(`Carrying on with "${name}" from ${formatBytes(received)} of ${formatBytes(found.total)}, to ${path}`);
	} else {
		log.info(`Downloading "${name}" as ${file.extension.toUpperCase()}${file.size ? ` (about ${formatBytes(file.size)})` : ""} to ${requestedPath}`);
		const response = await fetchRange(file.url, 0, PIECE_SIZE - 1, options);
		checkNotWebPage(response);
		const head = response.arrayBuffer;
		if (head.byteLength === 0) throw new Error("The download was empty");

		// Some sources use opaque redirect URLs, so their stated extension is only
		// a hint. Use the file signature to avoid saving a RAR archive as CBZ.
		const detected = detectComicExtension(head);
		if (!detected) {
			const contentType = responseHeader(response.headers, "content-type");
			log.error(`Unknown file type (${contentType || "no content type"}). It starts with: ${firstBytes(head)}`);
			throw new Error("The download was not a CBZ, CBR or PDF file");
		}
		if (detected !== file.extension) {
			log.info(`The file is a ${detected.toUpperCase()} rather than ${file.extension.toUpperCase()} as listed`);
		}
		path = comicPath(folder, name, { ...file, extension: detected });
		if (path !== requestedPath) {
			const existingActual = app.vault.getAbstractFileByPath(path);
			if (existingActual instanceof TFile) {
				log.info(`${existingActual.path} is already in the vault, so it isn't saved again`);
				return existingActual;
			}
		}

		if (response.status !== 206) {
			log.info("The server sent the whole file at once");
			return save(app, folder, path, head, options);
		}
		const total = Number(responseHeader(response.headers, "content-range").split("/")[1]);
		if (!Number.isFinite(total) || total <= 0) throw new Error("The server sent part of the file without saying how big it is");
		if (total <= head.byteLength) return save(app, folder, path, head, options);

		log.info(`The file is ${formatBytes(total)}; fetching the rest in pieces of ${formatBytes(PIECE_SIZE)}`);
		await pieces.add(0, head);
		found = { total, extension: detected };
		await options.onFound?.(found);
		received = head.byteLength;
	}

	const { total } = found;
	options.onProgress?.(received, total);
	while (received < total) {
		const piece = await fetchPiece(file.url, received, Math.min(received + PIECE_SIZE, total) - 1, total, options);
		// A piece that arrives after the plugin stopped is left to the next start, which fetches it again.
		if (options.isStopped?.()) throw new DownloadStopped();
		await pieces.add(received, piece);
		received += piece.byteLength;
		options.onProgress?.(received, total);
	}
	return save(app, folder, path, await pieces.join(total), options);
}

async function save(app: App, folder: string, path: string, data: ArrayBuffer, { isStopped }: DownloadOptions): Promise<TFile> {
	if (isStopped?.()) throw new DownloadStopped();
	await ensureFolder(app, normalizePath(folder));
	const saved = await app.vault.createBinary(path, data);
	log.info(`Saved ${formatBytes(data.byteLength)} to ${saved.path}`);
	return saved;
}

/** Fetches bytes `start` to `end` (inclusive) of a file of `total` bytes whose first piece has arrived. */
async function fetchPiece(url: string, start: number, end: number, total: number, options: DownloadOptions): Promise<ArrayBuffer> {
	const response = await fetchRange(url, start, end, options);
	checkNotWebPage(response);
	const range = responseHeader(response.headers, "content-range");
	const data = response.arrayBuffer;
	if (
		response.status === 206 &&
		range.startsWith(`bytes ${start}-`) &&
		range.endsWith(`/${total}`) &&
		data.byteLength > 0 &&
		data.byteLength <= end - start + 1
	) {
		return data;
	}
	throw new Error(`Asked for bytes ${start}-${end} of ${total} but got HTTP ${response.status}, ${range || "no range"}, ${formatBytes(data.byteLength)}`);
}

/** Fails if the server sent a web page, e.g. a sign-in or check page, instead of the file. */
function checkNotWebPage(response: RequestUrlResponse): void {
	if (!/text\/html/i.test(responseHeader(response.headers, "content-type"))) return;
	const title = pageTitle(response);
	log.error("Got a web page instead of a comic:", bodyPreview(response));
	throw new Error(`The download link returned a web page${title ? ` ("${title}")` : ""} instead of a comic`);
}

/**
 * Asks for bytes `start` to `end` (inclusive). Server errors are tried
 * again a few times; dropped connections until the connection is back.
 */
async function fetchRange(url: string, start: number, end: number, { isStopped, onWaiting }: DownloadOptions): Promise<RequestUrlResponse> {
	let serverErrors = 0;
	/** Failed tries since the last wait was cut short, which sets how long the next wait is. */
	let failures = 0;
	for (;;) {
		if (isStopped?.()) throw new DownloadStopped();
		try {
			return await fetchUrl(url, { Range: `bytes=${start}-${end}` });
		} catch (error) {
			// fetchUrl throws an HttpError for every answer, so anything else means there was none.
			const offline = !(error instanceof HttpError);
			// A 404 or 403 won't go away by asking again.
			const lasting = error instanceof HttpError && error.status < 500 && error.status !== 429;
			if (lasting || isStopped?.()) throw error;
			if (!offline && ++serverErrors >= SERVER_ERROR_ATTEMPTS) throw error;
			failures++;
			const wait = Math.min(5 * 2 ** (failures - 1), MAX_WAIT);
			log.warn(
				offline
					? `Trying bytes ${start}-${end} again in ${wait}s, or when back online or in the foreground, after: ${errorMessage(error)}`
					: `Trying bytes ${start}-${end} again in ${wait}s (try ${serverErrors + 1} of ${SERVER_ERROR_ATTEMPTS}) after: ${errorMessage(error)}`,
			);
			onWaiting?.(offline ? "No connection" : "The server had a problem", wait);
			if (await waitToRetry(wait, isStopped)) failures = 0;
		}
	}
}

/**
 * Waits `seconds`, checking each second whether to stop. Returns true if
 * the wait was cut short because the device went online or Obsidian came
 * back to the foreground: phones cut off apps in the background, so that is
 * when the connection is likely to be back.
 */
async function waitToRetry(seconds: number, isStopped?: () => boolean): Promise<boolean> {
	let woken = false;
	const wake = () => (woken = true);
	const wakeIfShown = () => {
		if (!document.hidden) woken = true;
	};
	window.addEventListener("online", wake);
	document.addEventListener("visibilitychange", wakeIfShown);
	try {
		for (let second = 0; second < seconds && !woken && !isStopped?.(); second++) await sleep(1000);
	} finally {
		window.removeEventListener("online", wake);
		document.removeEventListener("visibilitychange", wakeIfShown);
	}
	return woken;
}

/** The first bytes as hex and text, e.g. `52 61 72 21 1a 07 01 00 "Rar!...."`. */
function firstBytes(data: ArrayBuffer): string {
	const bytes = [...new Uint8Array(data, 0, Math.min(data.byteLength, 16))];
	const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
	const text = bytes.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
	return `${hex} "${text}"`;
}

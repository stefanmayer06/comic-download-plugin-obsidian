import { App, normalizePath, RequestUrlResponse, TFile } from "obsidian";
import { bodyPreview, fetchUrl, HttpError, pageTitle, responseHeader } from "./http";
import { log } from "./log";
import type { ComicFile } from "./sources/types";
import { errorMessage, formatBytes, sanitizeFileName } from "./util";

/**
 * Comics are fetched in pieces of this size. On mobile each response is
 * handed from the native app to Obsidian in one go, which a single 150 MB
 * response may never finish; pieces also give progress to show and a point
 * where a download can be cancelled.
 */
const PIECE_SIZE = 8 * 1024 * 1024;
/**
 * Tries per piece before the download fails, after dropped connections and
 * server errors. Waits between tries grow from 5 seconds to 40, riding out
 * a file server's brief outages: a slow download can take half an hour,
 * which shouldn't be lost to one error.
 */
const PIECE_ATTEMPTS = 5;

class DownloadCancelled extends Error {
	constructor() {
		super("The download was cancelled");
		this.name = "DownloadCancelled";
	}
}

export interface DownloadOptions {
	/** Called after each piece. `total` is the file size in bytes. */
	onProgress?: (received: number, total: number) => void;
	/** Checked between pieces; a true result stops with DownloadCancelled. */
	isCancelled?: () => boolean;
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
 * Saves a comic file into the comics folder. If a file with the same name is
 * already there, that file is returned instead of downloading it again.
 */
export async function downloadComic(app: App, folder: string, name: string, file: ComicFile, options: DownloadOptions = {}): Promise<TFile> {
	const requestedPath = comicPath(folder, name, file);
	const existing = app.vault.getAbstractFileByPath(requestedPath);
	if (existing instanceof TFile) {
		log.info(`${existing.path} is already in the vault, so it isn't downloaded again`);
		return existing;
	}

	log.info(`Downloading "${name}" as ${file.extension.toUpperCase()}${file.size ? ` (about ${formatBytes(file.size)})` : ""} to ${requestedPath}`);
	const response = await fetchRange(file.url, 0, PIECE_SIZE - 1, options.isCancelled);
	const contentType = responseHeader(response.headers, "content-type");
	if (/text\/html/i.test(contentType)) {
		const title = pageTitle(response);
		log.error("Got a web page instead of a comic:", bodyPreview(response));
		throw new Error(`The download link returned a web page${title ? ` ("${title}")` : ""} instead of a comic`);
	}
	const head = response.arrayBuffer;
	if (head.byteLength === 0) throw new Error("The download was empty");

	// Some sources use opaque redirect URLs, so their stated extension is only
	// a hint. Use the file signature to avoid saving a RAR archive as CBZ.
	const detected = detectComicExtension(head);
	if (!detected) {
		log.error(`Unknown file type (${contentType || "no content type"}). It starts with: ${firstBytes(head)}`);
		throw new Error("The download was not a CBZ, CBR or PDF file");
	}
	if (detected !== file.extension) {
		log.info(`The file is a ${detected.toUpperCase()} rather than ${file.extension.toUpperCase()} as listed`);
	}
	const path = comicPath(folder, name, { ...file, extension: detected });
	if (path !== requestedPath) {
		const existingActual = app.vault.getAbstractFileByPath(path);
		if (existingActual instanceof TFile) {
			log.info(`${existingActual.path} is already in the vault, so it isn't saved again`);
			return existingActual;
		}
	}

	let data = head;
	if (response.status === 206) {
		const total = Number(responseHeader(response.headers, "content-range").split("/")[1]);
		if (!Number.isFinite(total) || total <= 0) throw new Error("The server sent part of the file without saying how big it is");
		if (total > head.byteLength) data = await fetchRest(file.url, head, total, options);
	} else {
		log.info("The server sent the whole file at once");
	}

	if (options.isCancelled?.()) throw new DownloadCancelled();
	await ensureFolder(app, normalizePath(folder));
	const saved = await app.vault.createBinary(path, data);
	log.info(`Saved ${formatBytes(data.byteLength)} to ${saved.path}`);
	return saved;
}

/** Fetches the rest of a file after its first piece, `head`. */
async function fetchRest(url: string, head: ArrayBuffer, total: number, { onProgress, isCancelled }: DownloadOptions): Promise<ArrayBuffer> {
	log.info(`The file is ${formatBytes(total)}; fetching the rest in pieces of ${formatBytes(PIECE_SIZE)}`);
	const bytes = new Uint8Array(total);
	bytes.set(new Uint8Array(head));
	let received = head.byteLength;
	onProgress?.(received, total);
	while (received < total) {
		const piece = await fetchPiece(url, received, Math.min(received + PIECE_SIZE, total) - 1, isCancelled);
		bytes.set(new Uint8Array(piece), received);
		received += piece.byteLength;
		onProgress?.(received, total);
	}
	return bytes.buffer;
}

/** Fetches bytes `start` to `end` (inclusive) of a file whose first piece has arrived. */
async function fetchPiece(url: string, start: number, end: number, isCancelled?: () => boolean): Promise<ArrayBuffer> {
	const response = await fetchRange(url, start, end, isCancelled);
	const range = responseHeader(response.headers, "content-range");
	const data = response.arrayBuffer;
	if (response.status === 206 && range.startsWith(`bytes ${start}-`) && data.byteLength > 0 && data.byteLength <= end - start + 1) {
		return data;
	}
	throw new Error(`Asked for bytes ${start}-${end} but got HTTP ${response.status}, ${range || "no range"}, ${formatBytes(data.byteLength)}`);
}

/** Asks for bytes `start` to `end` (inclusive), trying again after dropped connections and server errors. */
async function fetchRange(url: string, start: number, end: number, isCancelled?: () => boolean): Promise<RequestUrlResponse> {
	for (let attempt = 1; ; attempt++) {
		if (isCancelled?.()) throw new DownloadCancelled();
		try {
			return await fetchUrl(url, { Range: `bytes=${start}-${end}` });
		} catch (error) {
			// A 404 or 403 won't go away by asking again.
			const lasting = error instanceof HttpError && error.status < 500 && error.status !== 429;
			if (lasting || attempt >= PIECE_ATTEMPTS || isCancelled?.()) throw error;
			const wait = 5 * 2 ** (attempt - 1);
			log.warn(`Trying bytes ${start}-${end} again in ${wait}s (try ${attempt + 1} of ${PIECE_ATTEMPTS}) after: ${errorMessage(error)}`);
			for (let second = 0; second < wait && !isCancelled?.(); second++) await sleep(1000);
		}
	}
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

/** The first bytes as hex and text, e.g. `52 61 72 21 1a 07 01 00 "Rar!...."`. */
function firstBytes(data: ArrayBuffer): string {
	const bytes = [...new Uint8Array(data, 0, Math.min(data.byteLength, 16))];
	const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
	const text = bytes.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
	return `${hex} "${text}"`;
}

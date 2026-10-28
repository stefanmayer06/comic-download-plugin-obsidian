/*!
 * CBR support uses node-unrar-js, Copyright (c) 2017 Jianrong Yu, MIT
 * licence (licenses/node-unrar-js.txt), which bundles UnRAR by Alexander
 * Roshal compiled to WebAssembly. UnRAR's licence is in licenses/UnRAR.txt:
 *
 * UnRAR source code may be used in any software to handle RAR archives
 * without limitations free of charge, but cannot be used to develop RAR
 * (WinRAR) compatible archiver and to re-create RAR compression algorithm,
 * which is proprietary. Distribution of modified UnRAR source code in
 * separate form or as a part of other software is permitted, provided that
 * full text of this paragraph, starting from "UnRAR source code" words, is
 * included in license, or in documentation if license is not available,
 * and in source code comments of resulting package.
 */
import { createExtractorFromData, FileHeader, UnrarError } from "node-unrar-js";
// unrar compiled to WebAssembly, bundled into main.js as base64 by esbuild.
import unrarWasmBase64 from "node-unrar-js/esm/js/unrar.wasm";

let unrarWasm: ArrayBuffer | null = null;

function wasmBinary(): ArrayBuffer {
	if (!unrarWasm) {
		const text = atob(unrarWasmBase64);
		const bytes = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
		unrarWasm = bytes.buffer;
	}
	return unrarWasm;
}

/**
 * Every extractor talks to one shared unrar instance, which serves the
 * extractor created last, so one extraction must finish before the next
 * extractor is created.
 */
let lastTask: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
	const result = lastTask.then(task, task);
	lastTask = result.catch(() => undefined);
	return result;
}

/**
 * Reads a RAR (CBR) archive, RAR4 or RAR5, and extracts single files on
 * demand. The archive stays in memory as it is; unrar reads from it in
 * small pieces.
 */
export class RarArchive {
	private constructor(
		private data: ArrayBuffer,
		readonly entries: FileHeader[],
	) {}

	static async open(data: ArrayBuffer): Promise<RarArchive> {
		const entries = await oneAtATime(async () => {
			const extractor = await createExtractorFromData({ wasmBinary: wasmBinary(), data });
			const { arcHeader, fileHeaders } = extractor.getFileList();
			if (arcHeader.flags.volume) throw new Error("This CBR file is one part of an archive split into several files");
			return [...fileHeaders];
		}).catch(explain);
		return new RarArchive(data, entries);
	}

	/** Whether getting a file means decompressing every file before it. */
	get isSolid(): boolean {
		return this.entries.some((entry) => entry.flags.solid);
	}

	read(entry: FileHeader): Promise<Uint8Array<ArrayBuffer>> {
		if (entry.flags.encrypted) return Promise.reject(new Error(`"${entry.name}" is password protected`));
		return oneAtATime(async () => {
			// A new extractor each time: an extractor keeps every file it has extracted.
			const extractor = await createExtractorFromData({ wasmBinary: wasmBinary(), data: this.data });
			const [file] = [...extractor.extract({ files: [entry.name] }).files];
			if (!file?.extraction) throw new Error(`"${entry.name}" is missing from the archive`);
			return file.extraction as Uint8Array<ArrayBuffer>;
		}).catch(explain);
	}
}

function explain(error: unknown): never {
	if (error instanceof UnrarError) {
		if (error.reason === "ERAR_MISSING_PASSWORD" || error.reason === "ERAR_BAD_PASSWORD") throw new Error("This CBR file is password protected");
		const damaged = ["ERAR_BAD_ARCHIVE", "ERAR_UNKNOWN_FORMAT", "ERAR_BAD_DATA", "ERAR_EREAD"].includes(error.reason);
		throw new Error(`${damaged ? "This CBR file is damaged or incomplete" : "Could not read this CBR file"} (${error.reason}${error.file ? `, ${error.file}` : ""})`);
	}
	throw error;
}

import { inflateSync } from "fflate";

export interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	localHeaderOffset: number;
	encrypted: boolean;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX_32 = 0xffffffff;

function readUint64(view: DataView, offset: number): number {
	return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
}

/**
 * Reads a ZIP (CBZ) archive's table of contents up front and inflates single
 * entries on demand, so opening a large comic only decompresses the pages
 * actually viewed.
 */
export class ZipArchive {
	readonly entries: ZipEntry[];
	private bytes: Uint8Array<ArrayBuffer>;
	private view: DataView;

	constructor(data: ArrayBuffer) {
		this.bytes = new Uint8Array(data);
		this.view = new DataView(data);
		this.entries = this.readCentralDirectory();
	}

	private findEndOfCentralDirectory(): number {
		// The record is 22 bytes plus a comment of up to 65535 bytes.
		const stop = Math.max(0, this.bytes.length - 22 - 0xffff);
		for (let i = this.bytes.length - 22; i >= stop; i--) {
			if (this.view.getUint32(i, true) === EOCD) return i;
		}
		throw new Error("Not a ZIP/CBZ file");
	}

	private readCentralDirectory(): ZipEntry[] {
		const view = this.view;
		const eocd = this.findEndOfCentralDirectory();
		let count = view.getUint16(eocd + 10, true);
		let offset = view.getUint32(eocd + 16, true);

		if (offset === MAX_32 || count === 0xffff) {
			const locator = eocd - 20;
			if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) throw new Error("Broken ZIP64 archive");
			const zip64 = readUint64(view, locator + 8);
			if (view.getUint32(zip64, true) !== ZIP64_EOCD) throw new Error("Broken ZIP64 archive");
			count = readUint64(view, zip64 + 32);
			offset = readUint64(view, zip64 + 48);
		}

		const decoder = new TextDecoder();
		const entries: ZipEntry[] = [];
		for (let i = 0; i < count; i++) {
			if (view.getUint32(offset, true) !== CENTRAL_ENTRY) throw new Error("Broken ZIP directory");
			const flags = view.getUint16(offset + 8, true);
			const nameLength = view.getUint16(offset + 28, true);
			const extraLength = view.getUint16(offset + 30, true);
			const commentLength = view.getUint16(offset + 32, true);
			const entry: ZipEntry = {
				name: decoder.decode(this.bytes.subarray(offset + 46, offset + 46 + nameLength)),
				method: view.getUint16(offset + 10, true),
				compressedSize: view.getUint32(offset + 20, true),
				size: view.getUint32(offset + 24, true),
				localHeaderOffset: view.getUint32(offset + 42, true),
				encrypted: (flags & 1) === 1,
			};
			this.applyZip64Extra(entry, offset + 46 + nameLength, extraLength);
			entries.push(entry);
			offset += 46 + nameLength + extraLength + commentLength;
		}
		return entries;
	}

	/** Large entries keep their real sizes and offset in a ZIP64 extra field. */
	private applyZip64Extra(entry: ZipEntry, start: number, length: number): void {
		const view = this.view;
		for (let pos = start; pos + 4 <= start + length; ) {
			const id = view.getUint16(pos, true);
			const size = view.getUint16(pos + 2, true);
			if (id === 0x0001) {
				let field = pos + 4;
				if (entry.size === MAX_32) {
					entry.size = readUint64(view, field);
					field += 8;
				}
				if (entry.compressedSize === MAX_32) {
					entry.compressedSize = readUint64(view, field);
					field += 8;
				}
				if (entry.localHeaderOffset === MAX_32) {
					entry.localHeaderOffset = readUint64(view, field);
				}
				return;
			}
			pos += 4 + size;
		}
	}

	read(entry: ZipEntry): Uint8Array<ArrayBuffer> {
		if (entry.encrypted) throw new Error(`"${entry.name}" is password protected`);
		const header = entry.localHeaderOffset;
		if (this.view.getUint32(header, true) !== LOCAL_HEADER) throw new Error(`Broken ZIP entry "${entry.name}"`);
		const start = header + 30 + this.view.getUint16(header + 26, true) + this.view.getUint16(header + 28, true);
		const data = this.bytes.subarray(start, start + entry.compressedSize);
		if (entry.method === 0) return data;
		if (entry.method === 8) {
			const out = new Uint8Array(entry.size);
			return out.subarray(0, inflateSync(data, { out }).length);
		}
		throw new Error(`"${entry.name}" uses an unsupported compression method (${entry.method})`);
	}
}

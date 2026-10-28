import { requestUrl } from "obsidian";
import { fileExtension, firstText, htmlToText, naturalCompare } from "../util";
import type { ComicFile, ComicSource, ComicSummary, SearchPage } from "./types";

/**
 * - golden-age: golden age comics (1930s-50s), most of which are now public domain
 * - open: any comic marked public domain or Creative Commons
 * - public-domain: any comic marked public domain
 */
export type SearchScope = "golden-age" | "open" | "public-domain";

const SEARCH_URL = "https://archive.org/advancedsearch.php";
const FIELDS = ["identifier", "title", "creator", "publisher", "description", "licenseurl"];
const PUBLIC_DOMAIN = "licenseurl:*publicdomain*";
const OPEN_LICENSE = `(${PUBLIC_DOMAIN} OR licenseurl:*creativecommons*)`;
// Golden age scans on the Archive are tagged with this subject or uploaded to this collection.
const GOLDEN_AGE = `(subject:("golden age") OR collection:(webcomicuniverse))`;
const FORMAT_RANK: Record<ComicFile["extension"], number> = { cbz: 0, pdf: 1, cbr: 2 };

/** Lucene treats these as operators; escaping keeps the license filter intact. */
function escapeQuery(text: string): string {
	return text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
}

interface ArchiveFile {
	name: string;
	format?: string;
	size?: string;
}

/**
 * Comics from the Internet Archive's comics collection, limited to items
 * whose uploader marked them as public domain or Creative Commons licensed.
 */
export class InternetArchiveSource implements ComicSource {
	id = "internet-archive";
	name = "Internet Archive";
	description = "Only comics marked public domain or Creative Commons are listed.";

	constructor(private getSettings: () => { searchScope: SearchScope; resultsPerPage: number }) {}

	buildQuery(text: string): string {
		const { searchScope } = this.getSettings();
		const parts = ["collection:(comics)", "mediatype:texts"];
		if (searchScope === "public-domain") parts.push(PUBLIC_DOMAIN);
		else parts.push(OPEN_LICENSE);
		if (searchScope === "golden-age") parts.push(GOLDEN_AGE);
		const terms = text.trim();
		if (terms) parts.unshift(`(${escapeQuery(terms)})`);
		return parts.join(" AND ");
	}

	async search(query: string, page: number): Promise<SearchPage> {
		const rows = this.getSettings().resultsPerPage;
		const params = new URLSearchParams({
			q: this.buildQuery(query),
			rows: String(rows),
			page: String(page),
			output: "json",
		});
		for (const field of FIELDS) params.append("fl[]", field);
		// Without search words, show the most popular comics first.
		if (!query.trim()) params.append("sort[]", "downloads desc");

		const data = (await requestUrl(`${SEARCH_URL}?${params.toString()}`)).json;
		const response = data?.response;
		if (!response || !Array.isArray(response.docs)) {
			throw new Error("Unexpected response from the Internet Archive");
		}
		const results: ComicSummary[] = response.docs.map((doc: Record<string, unknown>) => {
			const id = String(doc.identifier);
			return {
				id,
				sourceId: this.id,
				name: firstText(doc.title) || id,
				author: firstText(doc.creator),
				publisher: firstText(doc.publisher),
				description: htmlToText(firstText(doc.description)),
				license: describeLicense(firstText(doc.licenseurl)),
				coverUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
				pageUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
			};
		});
		return { results, hasMore: page * rows < Number(response.numFound ?? 0) };
	}

	async listFiles(comic: ComicSummary): Promise<ComicFile[]> {
		const data = (await requestUrl(`https://archive.org/metadata/${encodeURIComponent(comic.id)}`)).json;
		const files: ArchiveFile[] = Array.isArray(data?.files) ? data.files : [];

		// An item can hold several issues, each as CBZ/CBR plus derived PDFs.
		// Keep one file per issue, in the format the reader handles best.
		const best = new Map<string, ComicFile>();
		for (const file of files) {
			const extension = toComicExtension(file);
			if (!extension) continue;
			const base = file.name.slice(0, file.name.length - extension.length - 1);
			const candidate: ComicFile = {
				label: base.split("/").pop() ?? base,
				url: `https://archive.org/download/${encodeURIComponent(comic.id)}/${file.name
					.split("/")
					.map(encodeURIComponent)
					.join("/")}`,
				extension,
				size: file.size ? Number(file.size) : null,
			};
			const current = best.get(base);
			if (!current || FORMAT_RANK[extension] < FORMAT_RANK[current.extension]) {
				best.set(base, candidate);
			}
		}
		return [...best.values()].sort((a, b) => naturalCompare(a.label, b.label));
	}
}

/** "http://creativecommons.org/licenses/by-nc/3.0/" -> "CC BY-NC 3.0" */
export function describeLicense(url: string): string {
	if (!url) return "";
	if (url.includes("publicdomain")) return "Public domain";
	const match = url.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
	if (match) return `CC ${match[1].toUpperCase()} ${match[2]}`;
	return "Creative Commons";
}

function toComicExtension(file: ArchiveFile): ComicFile["extension"] | null {
	const extension = fileExtension(file.name);
	if (extension === "cbz" || extension === "cbr") return extension;
	if (extension === "pdf") {
		// "_text.pdf" is a lower quality OCR copy of the original PDF.
		if (file.format === "Additional Text PDF" || file.name.endsWith("_text.pdf")) return null;
		return "pdf";
	}
	return null;
}

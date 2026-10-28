import { fetchJson } from "../http";
import { log } from "../log";
import { fileExtension, firstText, htmlToText, naturalCompare } from "../util";
import { ComicFile, ComicSource, ComicSummary, filterValue, FilterValues, SearchFilter, SearchPage } from "./types";

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

/**
 * Publishers to filter by, with the words that identify them. Golden age
 * uploads name the publisher as the creator ("Quality", "Charlton Comics",
 * "MLJ/Archie Comics"); other uploads use the publisher field.
 */
const PUBLISHERS: { label: string; words: string[] }[] = [
	{ label: "American Comics Group (ACG)", words: ["acg", "american comics group"] },
	{ label: "Avon", words: ["avon"] },
	{ label: "Canadian Comics", words: ["canadian comics"] },
	{ label: "Centaur", words: ["centaur"] },
	{ label: "Charlton Comics", words: ["charlton"] },
	{ label: "Columbia Comics", words: ["columbia"] },
	{ label: "Comic Media", words: ["comic media"] },
	{ label: "Dell", words: ["dell"] },
	{ label: "Holyoke", words: ["holyoke"] },
	{ label: "Lev Gleason", words: ["lev gleason"] },
	{ label: "Magazine Enterprises", words: ["magazine enterprises"] },
	{ label: "MLJ / Archie", words: ["mlj", "archie"] },
	{ label: "Novelty Press", words: ["novelty press"] },
	{ label: "Parents' Magazine", words: ["parents magazine"] },
	{ label: "Prize Comics", words: ["prize"] },
	{ label: "Quality Comics", words: ["quality"] },
	{ label: "Rural Home", words: ["rural home"] },
];

const SORTS: Record<string, string | null> = {
	// Ranked by the search words; without any, the most downloaded come first.
	relevance: null,
	downloads: "downloads desc",
	"title-az": "titleSorter asc",
	"title-za": "titleSorter desc",
	added: "addeddate desc",
};

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
	filters: SearchFilter[] = [
		{
			id: "publisher",
			name: "Publisher",
			options: [{ value: "", label: "All publishers" }, ...PUBLISHERS.map((publisher) => ({ value: publisherValue(publisher), label: publisher.label }))],
		},
		{
			id: "sort",
			name: "Sort",
			options: [
				{ value: "relevance", label: "Best match" },
				{ value: "downloads", label: "Most downloaded" },
				{ value: "title-az", label: "Title A–Z" },
				{ value: "title-za", label: "Title Z–A" },
				{ value: "added", label: "Recently added" },
			],
		},
	];

	constructor(private getSettings: () => { searchScope: SearchScope; resultsPerPage: number }) {}

	buildQuery(text: string, filters: FilterValues = {}): string {
		const { searchScope } = this.getSettings();
		const parts = ["collection:(comics)", "mediatype:texts"];
		if (searchScope === "public-domain") parts.push(PUBLIC_DOMAIN);
		else parts.push(OPEN_LICENSE);
		if (searchScope === "golden-age") parts.push(GOLDEN_AGE);
		const publisher = PUBLISHERS.find((candidate) => publisherValue(candidate) === filterValue(this.filters, filters, "publisher"));
		if (publisher) {
			const words = publisher.words.map((word) => (word.includes(" ") ? `"${word}"` : word)).join(" OR ");
			parts.push(`(creator:(${words}) OR publisher:(${words}))`);
		}
		const terms = text.trim();
		if (terms) parts.unshift(`(${escapeQuery(terms)})`);
		return parts.join(" AND ");
	}

	async search(query: string, page: number, filters: FilterValues): Promise<SearchPage> {
		const rows = this.getSettings().resultsPerPage;
		const params = new URLSearchParams({
			q: this.buildQuery(query, filters),
			rows: String(rows),
			page: String(page),
			output: "json",
		});
		for (const field of FIELDS) params.append("fl[]", field);
		const sort = SORTS[filterValue(this.filters, filters, "sort")] ?? (query.trim() ? null : SORTS.downloads);
		if (sort) params.append("sort[]", sort);

		const data = (await fetchJson(`${SEARCH_URL}?${params.toString()}`)) as { response?: { docs?: unknown; numFound?: number } } | null;
		const response = data?.response;
		if (!response || !Array.isArray(response.docs)) {
			log.error("The Internet Archive sent no search results:", data);
			throw new Error("Unexpected response from the Internet Archive");
		}
		const results: ComicSummary[] = response.docs.map((doc: Record<string, unknown>) => {
			const id = String(doc.identifier);
			const creator = firstText(doc.creator);
			const creatorPublisher = PUBLISHERS.find((publisher) => publisherPattern(publisher).test(creator));
			return {
				id,
				sourceId: this.id,
				name: firstText(doc.title) || id,
				author: creatorPublisher ? "" : creator,
				publisher: firstText(doc.publisher) || creatorPublisher?.label || "",
				description: htmlToText(firstText(doc.description)),
				license: describeLicense(firstText(doc.licenseurl)),
				coverUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
				pageUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
			};
		});
		return { results, hasMore: page * rows < Number(response.numFound ?? 0) };
	}

	async listFiles(comic: ComicSummary): Promise<ComicFile[]> {
		const data = (await fetchJson(`https://archive.org/metadata/${encodeURIComponent(comic.id)}`)) as { files?: unknown } | null;
		const files: ArchiveFile[] = Array.isArray(data?.files) ? data.files : [];
		if (files.length === 0) log.warn(`Internet Archive item ${comic.id} lists no files`, data);

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
		if (files.length > 0 && best.size === 0) {
			log.warn(`None of the ${files.length} files in ${comic.id} is a CBZ, CBR or PDF: ${files.map((file) => file.name).join(", ")}`);
		}
		return [...best.values()].sort((a, b) => naturalCompare(a.label, b.label));
	}
}

function publisherValue(publisher: { words: string[] }): string {
	return publisher.words[0].replace(/\s+/g, "-");
}

function publisherPattern(publisher: { words: string[] }): RegExp {
	return new RegExp(`\\b(${publisher.words.join("|")})\\b`, "i");
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

/** One search result, shown as a card in the download menu. */
export interface ComicSummary {
	/** Stable id within its source, used to remember what was downloaded. */
	id: string;
	sourceId: string;
	name: string;
	author: string;
	publisher: string;
	description: string;
	/** Licence as stated by the source, e.g. "Public domain" or "CC BY 3.0". */
	license: string;
	coverUrl: string | null;
	/** Link to the comic's page on the source site. */
	pageUrl: string;
}

/** A downloadable file belonging to a comic (an item can hold several issues). */
export interface ComicFile {
	/** Human readable label, e.g. the issue's file name without extension. */
	label: string;
	url: string;
	extension: "cbz" | "pdf" | "cbr";
	/** Size in bytes, when the source reports it. */
	size: number | null;
}

export interface SearchPage {
	results: ComicSummary[];
	hasMore: boolean;
}

/**
 * A place comics can be pulled from. Only sources that distribute comics
 * with the rights holder's permission (public domain or openly licensed)
 * belong here.
 */
export interface ComicSource {
	id: string;
	name: string;
	search(query: string, page: number): Promise<SearchPage>;
	/** Lists the readable files of a comic, best format first. */
	listFiles(comic: ComicSummary): Promise<ComicFile[]>;
}

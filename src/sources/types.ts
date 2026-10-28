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

/** A dropdown above the results that narrows or orders them, e.g. publisher or sort order. */
export interface SearchFilter {
	id: string;
	name: string;
	/** The first option is the default. */
	options: { value: string; label: string }[];
}

/** The chosen option value for each filter id. */
export type FilterValues = Record<string, string>;

/** The chosen value of a filter, or its first option if none (or one no longer offered) is chosen. */
export function filterValue(filters: SearchFilter[], values: FilterValues, id: string): string {
	const filter = filters.find((candidate) => candidate.id === id);
	if (!filter) return "";
	return filter.options.some((option) => option.value === values[id]) ? values[id] : filter.options[0].value;
}

/**
 * A place comics can be pulled from. Sources expose the licence metadata
 * available from the site so users can check their downloading rights.
 */
export interface ComicSource {
	id: string;
	name: string;
	/** Short source-specific note shown below the source picker. */
	description: string;
	/** Dropdowns shown next to the source picker. */
	filters: SearchFilter[];
	search(query: string, page: number, filters: FilterValues): Promise<SearchPage>;
	/** Lists the readable files of a comic, best format first. */
	listFiles(comic: ComicSummary): Promise<ComicFile[]>;
}

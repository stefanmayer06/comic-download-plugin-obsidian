/** A cover's URL, or a function that finds one, called when the card first scrolls into view. */
export type Cover = string | null | (() => Promise<string | null>);

/** A comic card: details on the left, buttons below them and the cover on the right. */
export function createCard(parent: HTMLElement, name: string, cover: Cover): { info: HTMLElement; actions: HTMLElement } {
	const card = parent.createDiv({ cls: "comic-card" });
	const info = card.createDiv({ cls: "comic-card-info" });
	const actions = card.createDiv({ cls: "comic-card-actions" });

	const coverEl = card.createDiv({ cls: "comic-card-cover" });
	const show = (url: string | null) => {
		coverEl.empty();
		if (!url) {
			coverEl.setText("No cover");
			return;
		}
		const img = coverEl.createEl("img", { attr: { src: url, alt: `Cover of ${name}`, loading: "lazy" } });
		img.addEventListener("error", () => show(null));
	};
	if (typeof cover === "function") {
		// Finding a cover can mean opening the comic, so only do it for cards that are seen.
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			cover().then(show, () => show(null));
		});
		observer.observe(coverEl);
	} else {
		show(cover);
	}
	return { info, actions };
}

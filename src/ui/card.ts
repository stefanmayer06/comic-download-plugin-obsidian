/** A comic card: details on the left, buttons below them and the cover on the right. */
export function createCard(parent: HTMLElement, name: string, coverUrl: string | null): { info: HTMLElement; actions: HTMLElement } {
	const card = parent.createDiv({ cls: "comic-card" });
	const info = card.createDiv({ cls: "comic-card-info" });
	const actions = card.createDiv({ cls: "comic-card-actions" });

	const cover = card.createDiv({ cls: "comic-card-cover" });
	if (coverUrl) {
		const img = cover.createEl("img", { attr: { src: coverUrl, alt: `Cover of ${name}`, loading: "lazy" } });
		img.addEventListener("error", () => {
			img.remove();
			cover.setText("No cover");
		});
	} else {
		cover.setText("No cover");
	}
	return { info, actions };
}

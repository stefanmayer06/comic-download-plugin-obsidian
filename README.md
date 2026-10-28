# Comic Downloader for Obsidian

Search free comics, download them into a `Comics` folder in your vault, and
read them one page at a time.

## What it does

- **Download button.** A ribbon button (and the command *Download comics*)
  opens the download menu.
- **Download menu.** A search box above a scrolling list of comics. Each card
  shows the name, author, publisher, licence and description, a **Download**
  button and the cover. *Load more* fetches the next page of results.
- **Comics folder.** Downloads are saved to `Comics/` (configurable). If an
  item contains several issues, you pick which one to download. Downloaded
  comics show **Read** instead of **Download**.
- **Comic reader.** Opens `.cbz` and `.pdf` comics one page at a time instead
  of scrolling, which suits e-ink screens:
  - tap the right or left third of the page, swipe, or use the arrow keys,
    Page Up/Down or Space to turn pages;
  - tap the middle to show or hide the toolbar;
  - the toolbar has previous/next buttons, a page counter, a slider to jump
    to any page and a *whole page / fit width* toggle;
  - the last page you read is remembered for every comic;
  - *Next page* and *Previous page* are commands, so you can bind them to
    hotkeys or hardware page-turn buttons.

`.cbz` files open in the reader directly. For PDFs, right-click the file and
choose **Open in comic reader**, or run *Open current file in comic reader*.

## Where comics come from

Comics are pulled from the [Internet Archive](https://archive.org)'s comics
collection, using its public search API. Only items marked **public domain**
or **Creative Commons** are listed. By default the search is limited to
golden age comics (roughly 1938–1955: Quality, Fawcett, ACG, Avon, Lev
Gleason and others), most of which are now public domain.

Licences on the Internet Archive are set by the person who uploaded each
item, so the wider search options in settings can include items with the
wrong licence. Each card shows the licence it was uploaded with. Check it
before downloading.

New sources can be added by implementing `ComicSource` in
`src/sources/types.ts`. Only add sites that distribute comics with the rights
holders' permission.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Comics folder | `Comics` | Where downloads are saved. |
| Comics to search | Golden age comics | Or all comics marked public domain / Creative Commons. |
| Results per page | 20 | |
| Page fit | Whole page | Or fit width (scroll within a page). |
| Reading direction | Left to right | Right to left swaps tap zones and arrow keys. |

## Formats

| Format | Download | Reader |
| --- | --- | --- |
| CBZ | ✓ (preferred) | ✓ |
| PDF | ✓ | ✓ (rendered with Obsidian's built-in pdf.js) |
| CBR | only when no CBZ or PDF exists | not yet |

## Install

```sh
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/comic-downloader/`, then enable
**Comic Downloader** under *Settings → Community plugins*.

For development, `npm run dev` rebuilds `main.js` on every change.

## Project layout

```
src/
  main.ts                    plugin entry: ribbon button, commands, file menu
  settings.ts                settings and settings tab
  downloader.ts              saves comic files into the comics folder
  sources/
    types.ts                 ComicSource interface
    internetArchive.ts       Internet Archive search and file listing
  ui/
    ComicBrowserModal.ts     the download menu
    FilePickerModal.ts       issue picker for items with several files
  reader/
    ComicReaderView.ts       paginated reader view
    pages.ts                 CBZ and PDF page loading
    zip.ts                   reads single pages out of a CBZ on demand
```

# Comic Downloader for Obsidian

Search free comics, download them into a `Comics` folder in your vault, and
read them one page at a time.

## What it does

- **Comics menu.** A ribbon button opens the menu on the page you used last.
  The commands *Download comics* and *Show installed comics* open it on
  **Browse** or **Installed**, the two pages you switch between with the
  side-by-side selector at the top.
- **Browse.** A search box, and pickers for the source, publisher, type
  (comics or graphic novels) and sort order, above a scrolling list of
  comics. Each card shows the name, author, publisher, licence and
  description, a **Download** button and the cover. *Load more* fetches the
  next page. Your picks are remembered for each source.
- **Installed.** Downloads in progress (with **Cancel**), then every comic in
  your comics folder with its publisher, format, size, when it was downloaded
  and how far you've read. Filter by name or publisher, sort by most recently
  downloaded or by title, and **Read** or **Delete** each one (press
  **Confirm delete** to move the file to the trash).
- **Comics folder.** Downloads are saved to `Comics/` (configurable). If an
  item contains several issues, you pick which one to download. Downloaded
  comics show **Read** instead of **Download**.
- **Background downloads.** Downloads keep going after you close the
  comics menu. A notice shows each one's progress and time left, with a
  **Cancel** link, and another notice tells you when it's finished. Several
  downloads wait their turn and run one at a time. Comics are fetched in
  8 MB pieces, and a piece that fails is tried again up to four times, so
  a slow half-hour download isn't lost to one dropped connection. On
  Android and iOS, keep Obsidian open: if you switch to another app, the
  system may pause the download until you come back.
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

## When a download fails

The failure notice says why, for example
`getcomics.org answered with HTTP 403 ("Just a moment...")`, and has a
**Show log** link. You can also run *Comic Downloader: Show log* from the
command palette at any time.

The log lists every search, file listing and download step: each URL the
plugin requested, the HTTP status, content type, size and time it took, the
files found for a comic, and the full error when something goes wrong. Use
**Copy** to paste it into a bug report, or **Clear** to start fresh.

The log is also written to `.obsidian/plugins/comic-downloader/debug.log`,
so it survives a restart or crash and keeps the latest 2000 lines. It
contains your search words and the URLs you downloaded from.

## Where comics come from

Use the **Source** picker on the Browse page to switch between:

- [Internet Archive](https://archive.org): comics from its public search API.
  Only items marked **public domain** or **Creative Commons** are listed. By
  default the search is limited to golden age comics (roughly 1938–1955:
  Quality, Charlton, ACG, Avon, Lev Gleason and others), most of which are now
  public domain. Uploaders set these licences, so check the licence on each
  card before downloading. Filter by publisher (golden age uploads name it as
  the creator) and sort by best match, downloads, title or date added. The
  Archive's comics are single issues, so there is no type picker.
- [GetComics](https://getcomics.org): search and cover metadata come from its
  public WordPress API. Direct CBZ, CBR and PDF downloads are supported when a
  post provides them. Filter by publisher (DC, Marvel, Image and about 25
  others that GetComics tags) and by type: comics are single issues, graphic
  novels are posts tagged TPB (trade paperbacks, omnibuses, compendiums).
  Sort by date, title or best match. News posts and weekly packs (ZIPs of
  many comics) are left out. GetComics does not supply licence metadata, so
  check that you have the right to download a comic before doing so.

New sources can be added by implementing `ComicSource` in
`src/sources/types.ts`.

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

### With BRAT

1. Install and enable the **BRAT** community plugin.
2. Run *BRAT: Add a beta plugin for testing* and enter
   `stefanmayer06/comic-download-plugin-obsidian`.
3. Enable **Comic Downloader** under *Settings → Community plugins*.

BRAT installs the latest GitHub release and picks up new releases when you
check for updates.

### By hand

```sh
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/comic-downloader/`, then enable
**Comic Downloader** under *Settings → Community plugins*.

For development, `npm run dev` rebuilds `main.js` on every change.

## Releasing

```sh
npm version patch   # or minor / major
git push --follow-tags
```

`npm version` updates the version in `package.json`, `manifest.json` and
`versions.json`, commits it and creates a matching tag (e.g. `0.1.1`, with
no `v`). Pushing the tag runs `.github/workflows/release.yml`, which builds
the plugin and publishes a GitHub release with `main.js`, `manifest.json`
and `styles.css` attached. The workflow fails if the tag doesn't match the
version in `manifest.json`.

You can also release without pushing a tag:

- on GitHub open *Actions → Release → Run workflow*. It tags the selected
  branch with the version in `manifest.json` and publishes the release. It
  stops if that version has already been released.
- or create a release on GitHub's website with the version as its tag. The
  workflow builds the plugin and attaches the files to that release.

## Project layout

```
src/
  main.ts                    plugin entry: ribbon button, commands, file menu
  settings.ts                settings and settings tab
  downloader.ts              fetches a comic in pieces and saves it
  downloads.ts               background download queue and progress notices
  http.ts                    requests that are written to the log
  log.ts                     the log behind "Show log"
  sources/
    types.ts                 ComicSource interface
    internetArchive.ts       Internet Archive search and file listing
    getComics.ts             GetComics search and direct file listing
  ui/
    ComicBrowserModal.ts     the comics menu and its Browse page
    InstalledView.ts         the Installed page
    card.ts                  comic card layout shared by both pages
    FilePickerModal.ts       issue picker for items with several files
    LogModal.ts              shows, copies and clears the log
    notices.ts               "download finished" and error notices
  reader/
    ComicReaderView.ts       paginated reader view
    pages.ts                 CBZ and PDF page loading
    zip.ts                   reads single pages out of a CBZ on demand
```

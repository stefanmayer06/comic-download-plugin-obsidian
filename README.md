# Comic Downloader for Obsidian

Search free comics, download them into a `Comics` folder in your vault, and
read them one page at a time.

## What it does

- **Download button.** A ribbon button (and the command *Download comics*)
  opens the download menu.
- **Download menu.** A source picker and search box above a scrolling list of
  comics. Each card shows the name, author, publisher, licence and description,
  a **Download** button and the cover. *Load more* fetches the next page.
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

Use the **Source** picker in the download menu to switch between:

- [Internet Archive](https://archive.org): comics from its public search API.
  Only items marked **public domain** or **Creative Commons** are listed. By
  default the search is limited to golden age comics (roughly 1938–1955:
  Quality, Fawcett, ACG, Avon, Lev Gleason and others), most of which are now
  public domain. Uploaders set these licences, so check the licence on each
  card before downloading.
- [GetComics](https://getcomics.org): search and cover metadata come from its
  public WordPress API. Direct CBZ, CBR and PDF downloads are supported when a
  post provides them. GetComics does not supply licence metadata, so check
  that you have the right to download a comic before doing so.

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
  downloader.ts              saves comic files into the comics folder
  http.ts                    requests that are written to the log
  log.ts                     the log behind "Show log"
  sources/
    types.ts                 ComicSource interface
    internetArchive.ts       Internet Archive search and file listing
    getComics.ts             GetComics search and direct file listing
  ui/
    ComicBrowserModal.ts     the download menu
    FilePickerModal.ts       issue picker for items with several files
    LogModal.ts              shows, copies and clears the log
  reader/
    ComicReaderView.ts       paginated reader view
    pages.ts                 CBZ and PDF page loading
    zip.ts                   reads single pages out of a CBZ on demand
```

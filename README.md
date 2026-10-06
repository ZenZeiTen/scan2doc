# Scan2Doc

Converts PDF scans into editable Microsoft Office (.docx, .xlsx, .pptx) and OpenDocument
(.odt, .ods, .odp) files. Everything runs locally: PDFium renders the pages and Tesseract (both
compiled to WebAssembly) reads them, so no document leaves the machine.

- **27 languages**, Asian and European, including Indonesian, Japanese, Korean, Chinese, Thai,
  Arabic, Hindi and Russian. Each page's language is detected (`scan2doc languages` lists them).
- **Digital PDFs** are read from their own text layer when it is trustworthy (visible, correctly
  encoded, upright, covering the page). That is exact and fast. Anything else goes through OCR.
- **Layout:** headings, paragraphs, ruled tables (with merged cells), pictures and reading
  order. Each document is classified as a document, spreadsheet or presentation.
- **Quality gates** flag pages that were read poorly. `scan2doc mcp` hands those pages to an AI
  model through the Model Context Protocol, for example from Claude Desktop.

## Download

Windows x64: `scan2doc-win-x64.exe` from the
[latest release](https://github.com/ZenZeiTen/scan2doc/releases/latest). It is a single
executable with the engines and all language models built in, and needs no Node.js. It is not
code-signed, so Windows SmartScreen may warn the first time. Check the SHA-256 in the release
notes.

## The app

Double-click `scan2doc-win-x64.exe` to open Scan2Doc in its own window. It uses Microsoft Edge's
app mode: no address bar, nothing sent anywhere. Closing the window stops it.

- **Tabs:** Home (open files, drop zone, recent files and tasks), Tools, and one tab per open
  PDF.
- **Viewer:** page thumbnails, zoom, page navigation, and search with highlighted matches.
- **Export PDF:** to Word, Excel, PowerPoint or OpenDocument, next to the PDF by default, never
  over an existing file.
- **Scan & OCR:** recognises scanned text and lays it invisibly under the page images, so the PDF
  can be searched and copied from.
- **Organize Pages:** reorder (drag), rotate, delete and extract pages.
- **Combine Files**, **Split PDF** (by page count or ranges), and **Export Images** (PNG or JPG).
- **Save and Save As** use the Windows dialogs. Shortcuts: Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+F,
  Ctrl+W, Ctrl+= / Ctrl+-.

`scan2doc ui` starts the same app from a terminal. Add `--no-open` to print its private address
instead of opening a window.

## Command line

```
scan2doc convert report.pdf                     # format picked by document type
scan2doc convert scan.pdf -f docx odt -o out    # several formats, into ./out
scan2doc convert scan.pdf -l jpn+eng -p 1-3,5   # languages and pages
scan2doc convert scan.pdf --json --strict       # JSON summary; exit 3 if pages need review
scan2doc languages
scan2doc mcp --root C:\scans                    # MCP server over stdio, for AI hosts
```

Existing files are never overwritten without `--force`. For an encrypted PDF, pass
`--password`, or set `SCAN2DOC_PASSWORD` to keep the password out of shell history.

Exit codes: 0 done, 1 failed, 2 bad usage, 3 converted but some pages need review (`--strict`).

## Building from source

Needs Node.js 24 and pnpm (via corepack).

```
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test          # Vitest suite
corepack pnpm build:bin     # dist/bin/scan2doc-win-x64.exe (Node single executable application)
corepack pnpm verify:bin    # runs the exe with no Node on PATH against sample PDFs
```

`scripts/verify-office.ps1` opens the generated files in real Word, Excel and PowerPoint
through COM, when Office is installed.

Packages: `@scan2doc/core` (document model, reading order, classifier),
`@scan2doc/vision-wasm` (rendering, OCR, layout), `@scan2doc/writer-openxml`,
`@scan2doc/writer-opendocument`, `@scan2doc/mcp` and `@scan2doc/cli`.

## Licence

MIT, see [LICENSE](LICENSE). The executable bundles third-party software (PDFium, Tesseract,
its trained language data and npm packages) under their own licences. These are listed in
`THIRD_PARTY_NOTICES.txt`, which is attached to each release.

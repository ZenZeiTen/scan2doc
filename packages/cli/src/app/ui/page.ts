import { SCRIPT } from './script.js';
import { STYLE } from './style.js';

/** The app's single page: everything inline (no other origin is ever contacted). */
export function renderApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan2Doc</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23c4761a'/%3E%3Ctext x='16' y='22' font-family='Segoe UI,Arial' font-size='15' font-weight='800' fill='white' text-anchor='middle'%3ES2D%3C/text%3E%3C/svg%3E">
<style>${STYLE}</style>
</head>
<body>
<header id="bar">
  <div id="brand"><span class="logo">S2D</span>Scan2Doc</div>
  <nav id="tabs" role="tablist"></nav>
  <div id="bar-actions"></div>
</header>
<main id="view"></main>
<div id="toasts" role="status" aria-live="polite"></div>
<div id="dropcover">Drop PDF files to open them</div>
<div id="stopped"><div><h2>Scan2Doc has closed.</h2><p class="muted">Double-click scan2doc.exe to start it again.</p></div></div>
<input type="file" id="file-input" accept=".pdf,application/pdf" multiple hidden>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

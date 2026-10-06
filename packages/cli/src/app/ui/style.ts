export const STYLE = String.raw`
:root {
  --bg: #f3f2ef; --chrome: #ffffff; --panel: #ffffff; --text: #1d1c1a; --muted: #67645e; --faint: #9a968f;
  --line: #e2dfd9; --hover: #f1eee8; --accent: #c4761a; --accent-strong: #a8600f; --accent-soft: #fbefdd;
  --ok: #2f7d4f; --bad: #b3372f; --viewer: #e4e2de; --shadow: 0 1px 3px rgba(0,0,0,.12), 0 6px 18px rgba(0,0,0,.06);
  --hit: rgba(255, 196, 0, .38); --hit-active: rgba(255, 132, 0, .55);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #171615; --chrome: #201f1d; --panel: #22211f; --text: #ecebe8; --muted: #a8a49c; --faint: #75716a;
    --line: #34322e; --hover: #2b2a27; --accent: #e3a13b; --accent-strong: #f0b45a; --accent-soft: #3a2d1a;
    --ok: #6cc28f; --bad: #ef7d74; --viewer: #121110; --shadow: 0 1px 3px rgba(0,0,0,.5), 0 6px 18px rgba(0,0,0,.35);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; overflow: hidden; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 1px solid transparent; border-radius: 7px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
button:hover:not(:disabled) { background: var(--hover); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--accent-strong); }
button.outline { border-color: var(--line); background: var(--panel); }
button.danger { color: var(--bad); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input[type=text], input[type=number], input[type=password], select { background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 5px 8px; min-width: 0; }
svg.i { width: 18px; height: 18px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }

/* title bar and tabs */
#bar { display: flex; align-items: stretch; background: var(--chrome); border-bottom: 1px solid var(--line); height: 46px; flex: none; }
#brand { display: flex; align-items: center; gap: 8px; padding: 0 16px; font-weight: 700; letter-spacing: -.01em; font-size: 15px; }
#brand .logo { width: 22px; height: 22px; border-radius: 6px; background: var(--accent); color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 800; }
#tabs { display: flex; align-items: stretch; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tab { display: flex; align-items: center; gap: 6px; padding: 0 12px 0 14px; border-right: 1px solid var(--line); cursor: pointer; max-width: 240px; min-width: 0; color: var(--muted); position: relative; user-select: none; }
.tab:first-child { border-left: 1px solid var(--line); }
.tab:hover { background: var(--hover); color: var(--text); }
.tab.active { color: var(--text); background: var(--bg); font-weight: 600; }
.tab.active::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--accent); }
.tab .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab .dot { color: var(--accent); font-size: 18px; line-height: 0; }
.tab .x { padding: 2px; border-radius: 5px; opacity: .6; }
.tab .x:hover { opacity: 1; background: var(--line); }
.tab .x svg { width: 14px; height: 14px; }
#bar-actions { display: flex; align-items: center; gap: 4px; padding: 0 10px; }
#view { flex: 1; min-height: 0; display: flex; }

/* home and tools */
.page-scroll { flex: 1; overflow: auto; }
.home { max-width: 1120px; margin: 0 auto; padding: 28px 24px 48px; }
.home h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -.01em; }
.home h2 { font-size: 15px; margin: 30px 0 10px; }
.hero { display: flex; gap: 18px; align-items: stretch; flex-wrap: wrap; margin-top: 18px; }
.drop { flex: 1 1 380px; border: 2px dashed var(--line); border-radius: 14px; padding: 26px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; background: var(--panel); }
.drop strong { font-size: 16px; }
.quick { flex: 1 1 420px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; text-align: left; display: flex; gap: 12px; align-items: flex-start; cursor: pointer; width: 100%; }
.card:hover { border-color: var(--accent); background: var(--panel); box-shadow: var(--shadow); }
.card .ic { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-strong); flex: none; }
.card .ic svg { width: 21px; height: 21px; }
.card b { display: block; margin-bottom: 2px; }
.card span.d { color: var(--muted); font-size: 12.5px; white-space: normal; }
.tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
table.list { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
table.list td, table.list th { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); }
table.list th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--hover); }
table.list tr:last-child td { border-bottom: 0; }
table.list tr.row { cursor: pointer; }
table.list tr.row:hover td { background: var(--hover); }
.file-name { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.file-name svg { color: var(--bad); }
.empty { padding: 22px; text-align: center; color: var(--muted); background: var(--panel); border: 1px dashed var(--line); border-radius: 12px; }

/* document */
.doc { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.doc-bar { display: flex; align-items: center; gap: 4px; padding: 5px 10px; background: var(--chrome); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.doc-bar .sep { width: 1px; height: 22px; background: var(--line); margin: 0 6px; }
.doc-bar input.pg { width: 46px; text-align: center; }
.doc-bar .zoom { min-width: 52px; text-align: center; }
.doc-bar .search { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
.doc-bar .search input { width: 210px; }
.spacer { flex: 1; }
.doc-body { flex: 1; display: flex; min-height: 0; }
.rail { width: 168px; flex: none; border-right: 1px solid var(--line); background: var(--chrome); overflow-y: auto; padding: 12px 0; }
.rail.hidden { display: none; }
.thumb { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 0; cursor: pointer; color: var(--muted); font-size: 12px; }
.thumb .frame { width: 112px; background: #fff; box-shadow: var(--shadow); border: 2px solid transparent; border-radius: 2px; overflow: hidden; }
.thumb .frame img { width: 100%; display: block; }
.thumb.active .frame { border-color: var(--accent); }
.thumb.active { color: var(--text); font-weight: 600; }
.viewer { flex: 1; overflow: auto; background: var(--viewer); position: relative; scrollbar-gutter: stable; }
.pages { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 18px; min-width: min-content; }
.sheet { background: #fff; box-shadow: var(--shadow); position: relative; flex: none; }
.sheet img { width: 100%; height: 100%; display: block; }
.sheet .hl { position: absolute; background: var(--hit); mix-blend-mode: multiply; border-radius: 2px; pointer-events: none; }
.sheet .hl.active { background: var(--hit-active); outline: 2px solid var(--hit-active); }
.sheet .num { position: absolute; right: -2px; bottom: -20px; font-size: 11px; color: var(--faint); }
.panel { width: 330px; flex: none; border-left: 1px solid var(--line); background: var(--chrome); display: flex; min-height: 0; }
.panel.hidden { display: none; }
.toolstrip { width: 52px; border-right: 1px solid var(--line); display: flex; flex-direction: column; align-items: center; padding: 8px 0; gap: 2px; }
.toolstrip button { width: 40px; height: 40px; justify-content: center; padding: 0; color: var(--muted); }
.toolstrip button.on { background: var(--accent-soft); color: var(--accent-strong); }
.toolpane { flex: 1; overflow-y: auto; padding: 16px; min-width: 0; }
.toolpane h3 { margin: 0 0 4px; font-size: 16px; }
.toolpane p.lead { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.field { margin-bottom: 14px; }
.field > label, .field > .label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: .03em; }
.field select, .field input[type=text], .field input[type=number] { width: 100%; }
.choices { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.choice { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; cursor: pointer; background: var(--panel); font-size: 13px; }
.choice:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.choice input { margin: 0; accent-color: var(--accent); }
.choice.wide { grid-column: span 2; }
.folder { display: flex; gap: 6px; align-items: center; }
.folder code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; background: var(--hover); padding: 6px 8px; border-radius: 6px; direction: rtl; text-align: left; }
.go { width: 100%; justify-content: center; padding: 9px; margin-top: 4px; }
.jobs { margin-top: 18px; display: flex; flex-direction: column; gap: 8px; }
.job { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
.job .t { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.job .t .st { margin-left: auto; font-weight: 500; font-size: 12px; color: var(--muted); }
.job .t .st.done { color: var(--ok); }
.job .t .st.failed { color: var(--bad); }
.bar { height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; margin: 8px 0 4px; }
.bar > div { height: 100%; background: var(--accent); transition: width .25s; }
.job .out { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 13px; }
.job .out .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job .note { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
.job .err { font-size: 13px; color: var(--bad); margin-top: 6px; }
dl.info { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 13px; }
dl.info dt { color: var(--muted); }
dl.info dd { margin: 0; overflow-wrap: anywhere; }

/* organize */
.organize { flex: 1; overflow: auto; background: var(--viewer); display: flex; flex-direction: column; }
.org-bar { display: flex; align-items: center; gap: 4px; padding: 8px 14px; background: var(--chrome); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
.org-grid { display: flex; flex-wrap: wrap; gap: 22px; padding: 22px; align-content: flex-start; }
.org-page { width: 150px; display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 12px; color: var(--muted); }
.org-page .frame { width: 150px; height: 190px; display: grid; place-items: center; border: 2px solid transparent; border-radius: 6px; padding: 6px; }
.org-page .frame img { max-width: 100%; max-height: 100%; background: #fff; box-shadow: var(--shadow); transition: transform .2s; }
.org-page.sel .frame { border-color: var(--accent); background: var(--accent-soft); }
.org-page.drop-before .frame { box-shadow: -4px 0 0 var(--accent); }
.org-page.dragging { opacity: .4; }

/* overlays */
#toasts { position: fixed; right: 18px; bottom: 18px; display: flex; flex-direction: column; gap: 8px; z-index: 50; max-width: 420px; }
.toast { background: var(--text); color: var(--bg); padding: 10px 14px; border-radius: 9px; box-shadow: var(--shadow); font-size: 13.5px; display: flex; gap: 10px; align-items: center; }
.toast.error { background: var(--bad); color: #fff; }
.toast button { color: inherit; border: 1px solid currentColor; padding: 2px 8px; }
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: grid; place-items: center; z-index: 40; }
.dialog { background: var(--panel); border-radius: 14px; box-shadow: var(--shadow); width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow: auto; padding: 20px; }
.dialog h3 { margin: 0 0 6px; }
.dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.combine-list { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.combine-item { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.combine-item .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#dropcover { position: fixed; inset: 0; background: rgba(196, 118, 26, .14); border: 3px dashed var(--accent); display: none; place-items: center; z-index: 45; font-size: 22px; font-weight: 700; color: var(--accent-strong); pointer-events: none; }
body.dragging #dropcover { display: grid; }
#stopped { position: fixed; inset: 0; background: var(--bg); display: none; place-items: center; z-index: 60; text-align: center; padding: 24px; }
body.stopped #stopped { display: grid; }
@media (max-width: 900px) { .panel { width: 280px; } .rail { display: none; } }
`;

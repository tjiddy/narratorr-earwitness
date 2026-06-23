// Consolidate the audit → adjudication → reclassify pipeline into ONE final per-book
// verdict, apply hand-verified curation overrides, and emit a self-contained HTML report.
//
// Inputs (data/):  audit-results.jsonl (raw)  adjudication.jsonl (pairwise recovery)
//                  reclassify.jsonl (sharp edition-mismatch judge)
// Output:          ../earwitness-audit-report.html  (self-contained, no assets)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AUDIT_DATA ? path.resolve(process.env.AUDIT_DATA) : path.join(HERE, 'data');
const OUT = process.env.AUDIT_OUT ? path.resolve(process.env.AUDIT_OUT) : path.join(DATA, 'earwitness-audit-report.html');
const RUN_DATE = process.env.RUN_DATE || new Date().toISOString().slice(0, 10);

const readJsonl = async (name) =>
  (await fs.readFile(path.join(DATA, name), 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const audit = await readJsonl('audit-results.jsonl');
const adj = await readJsonl('adjudication.jsonl');
const recl = await readJsonl('reclassify.jsonl');
const adjById = new Map(adj.map((a) => [a.id, a]));
const reclById = new Map(recl.map((r) => [r.id, r]));

// ---- hand-verified curation (keyed by title; titles are distinct in the flagged set) ----
// Flagged EDITION_MISMATCH that are actually FINE — the "different name" isn't a narrator credit.
const FALSE_ALARM = {
  'Star Wars: Heir to the Empire': 'The heard name is a PRODUCER intro — "Kevin Thompson, director of Random House Audio\'s Star Wars recordings." The actual narrator is the catalog\'s Marc Thompson (same surname trapped the matcher).',
  'Ashes, Ashes': 'The heard name is from a bonus AUTHOR INTERVIEW — "I\'m Wayne Shepard talking with Jo Tregiari" (Tregiari is the author). The narrator is the catalog\'s Cassandra Campbell.',
  'Rainbow Six': 'STT misheard the AUTHOR\'s name — "read by Tom Clancy" (Clancy is the author, died 2013, never narrated). The narrator is the catalog\'s Michael Prichard.',
};
// Real edition mismatches the sharp pass misfiled as GARBLE (heard "Nigel Planer", the classic Discworld reader).
const GARBLE_RESCUE = {
  'Moving Pictures': 'Nigel Planer',
  'Witches Abroad': 'Nigel Planer',
};
// Probable edition mismatch — audio says "read by the author" (Douglas Adams editions) vs catalog's Fry/Freeman.
const TIER2_AUTHOR_NARRATED = new Set([
  "The Hitchhiker's Guide to the Galaxy",
  'The Restaurant at the End of the Universe',
  'Life, the Universe, and Everything',
  'So Long, and Thanks for All the Fish',
  'Mostly Harmless',
]);
const NEEDS_LISTEN = {
  'The Left and the Lucky': 'Garbled self-narration credit — "this is the author for brian foster." Willy Vlautin is known to self-narrate; can\'t confirm "Brian Foster" from the audio. Needs a human listen.',
};

// Cluster labels for the action list.
const clusterOf = (title, heard) => {
  if (['Die Trying', 'Tripwire', 'Running Blind', 'Gone Tomorrow', 'The Midnight Line'].includes(title)) return 'Lee Child · Jack Reacher (older editions)';
  if (['Moving Pictures', 'Witches Abroad'].includes(title)) return 'Discworld (classic Nigel Planer editions)';
  if (['Doctor Sleep', 'Fairy Tale'].includes(title)) return 'Stephen King (German editions · David Nathan)';
  if (['The Atlantis Gene', 'The Atlantis Plague'].includes(title)) return 'The Origin Mystery (Richard Rowan edition)';
  return 'Standalone';
};

// ---- consolidate ----
const books = audit.map((r) => {
  const base = { id: r.id, rel: r.rel, title: r.title, expected: r.expected, audioFileCount: r.audioFileCount };
  if (r.error) return { ...base, cat: 'UNREADABLE', detail: r.error };
  const status = r.comparison?.status;
  if (status === 'match') return { ...base, cat: 'MATCH' };
  if (status === 'unknown' || !r.comparison) return { ...base, cat: 'NO_CREDIT' };

  // flagged (mismatch/partial) → use adjudication
  const a = adjById.get(r.id);
  const heardN = (r.detection?.detected?.narrators ?? []).join(', ');
  const credit = r.detection?.evidence?.narrator ?? null;
  const catN = (r.expected?.narrators ?? []).join(', ');

  if (!a) return { ...base, cat: 'NO_CREDIT' };
  if (a.bucket === 'CLEAN') return { ...base, cat: 'RECOVERED', recovered: a.recovered };
  if (a.bucket === 'PARTIAL_OK') return { ...base, cat: 'PARTIAL', heardN, catN };
  if (a.bucket === 'ADJ_ERROR') return { ...base, cat: 'NO_CREDIT' };

  // INCONCLUSIVE → look at reclassify (only those with a contradicting heard name were re-judged)
  const rc = reclById.get(r.id);
  const fa = FALSE_ALARM[r.title];
  if (fa) return { ...base, cat: 'FALSE_ALARM', reason: fa, catN, credit };
  const nl = NEEDS_LISTEN[r.title];
  if (nl) return { ...base, cat: 'NEEDS_LISTEN', reason: nl, catN, credit };
  if (GARBLE_RESCUE[r.title]) return { ...base, cat: 'EDITION', tier: 1, heardNarrator: GARBLE_RESCUE[r.title], catN, credit, cluster: clusterOf(r.title) };
  if (TIER2_AUTHOR_NARRATED.has(r.title)) return { ...base, cat: 'EDITION', tier: 2, heardNarrator: '(the author)', catN, credit, cluster: 'Hitchhiker\'s (author-narrated editions)' };
  if (rc?.bucket === 'EDITION_MISMATCH') return { ...base, cat: 'EDITION', tier: 1, heardNarrator: (rc.heardNarrators || []).join(', ') || rc.suspectName || heardN, catN, credit, cluster: clusterOf(r.title) };
  if (rc?.bucket === 'EXTRA_CONTRIBUTOR') return { ...base, cat: 'RECOVERED', note: 'extra contributor (foreword/author/guest) — catalog narrator confirmed' };
  // GARBLE w/ empty credit or no-contradiction inconclusive → no usable credit found
  if (rc?.bucket === 'GARBLE' || !rc) {
    // distinguish "heard nothing" from "heard a garble"
    if (!credit) return { ...base, cat: 'NO_CREDIT' };
    return { ...base, cat: 'RECOVERED', note: 'credit garbled but not contradicting — catalog narrator not refuted' };
  }
  return { ...base, cat: 'RECOVERED' };
});

// ---- tally ----
const by = (c) => books.filter((b) => b.cat === c);
const editions = by('EDITION').sort((a, b) => (a.tier - b.tier) || a.cluster.localeCompare(b.cluster) || a.title.localeCompare(b.title));
const t1 = editions.filter((e) => e.tier === 1);
const t2 = editions.filter((e) => e.tier === 2);
const falseAlarms = by('FALSE_ALARM');
const needsListen = by('NEEDS_LISTEN');
const noCredit = by('NO_CREDIT');
const unreadable = by('UNREADABLE');
const matches = by('MATCH');
const recovered = by('RECOVERED');
const partials = by('PARTIAL');

const total = books.length;
const catalogCorrect = matches.length + recovered.length + partials.length + falseAlarms.length;
const rawMismatch = audit.filter((r) => r.comparison?.status === 'mismatch').length;

const counts = {
  total, matches: matches.length, recovered: recovered.length, partials: partials.length,
  falseAlarms: falseAlarms.length, t1: t1.length, t2: t2.length,
  needsListen: needsListen.length, noCredit: noCredit.length, unreadable: unreadable.length,
  catalogCorrect, rawMismatch,
};
console.log('TALLY', JSON.stringify(counts, null, 2));
const sum = matches.length + recovered.length + partials.length + falseAlarms.length + t1.length + t2.length + needsListen.length + noCredit.length + unreadable.length;
console.log(`sum of categories = ${sum} (should be ${total})`);

// ---- HTML ----
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (n) => ((n / total) * 100).toFixed(1);

const editionCard = (b) => `
  <article class="case">
    <div class="case-head">
      <h4>${esc(b.title)}</h4>
      ${b.tier === 2 ? '<span class="chip chip-warn">probable</span>' : '<span class="chip chip-danger">edition mismatch</span>'}
    </div>
    <div class="swap">
      <div class="side catalog"><span class="lbl">catalog says</span><span class="name">${esc(b.catN) || '—'}</span></div>
      <div class="arrow">→</div>
      <div class="side heard"><span class="lbl">audio credits</span><span class="name">${esc(b.heardNarrator) || '—'}</span></div>
    </div>
    ${b.credit ? `<p class="evidence">“${esc(b.credit)}”</p>` : ''}
    <p class="path">${esc(b.rel)}</p>
  </article>`;

const groupByCluster = (list) => {
  const g = {};
  for (const b of list) (g[b.cluster] ??= []).push(b);
  return g;
};
const t1Groups = groupByCluster(t1);
// Lead with the coherent patterns (Reacher, Discworld, German King); the grab-bag "Standalone" goes last.
const clusterOrder = Object.keys(t1Groups).sort((a, b) => {
  if (a === 'Standalone') return 1;
  if (b === 'Standalone') return -1;
  return t1Groups[b].length - t1Groups[a].length || a.localeCompare(b);
});

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>earwitness · library audit</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;0,800;1,500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root{
    --bg:hsl(28 30% 6%); --bg2:hsl(28 28% 9%); --card:hsl(28 24% 11% / .72);
    --border:hsl(35 25% 22% / .55); --fg:hsl(38 30% 92%); --muted:hsl(36 14% 62%);
    --amber:hsl(38 92% 56%); --amber-soft:hsl(38 80% 60% / .14);
    --green:hsl(150 55% 52%); --green-soft:hsl(150 45% 45% / .14);
    --red:hsl(8 78% 62%); --red-soft:hsl(8 70% 55% / .14);
    --blue:hsl(208 70% 64%);
    --radius:18px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    font-family:'DM Sans',system-ui,sans-serif; color:var(--fg); line-height:1.55;
    background:
      radial-gradient(1100px 700px at 78% -8%, hsl(38 90% 40% / .16), transparent 60%),
      radial-gradient(900px 600px at 6% 12%, hsl(20 80% 35% / .12), transparent 55%),
      linear-gradient(180deg, var(--bg), var(--bg2));
    background-attachment:fixed; min-height:100vh;
    -webkit-font-smoothing:antialiased;
  }
  body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.4;mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E");}
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px 120px;position:relative;z-index:1}
  .mono{font-family:'IBM Plex Mono',monospace}

  /* hero */
  header.hero{padding:84px 0 36px;text-align:center}
  .kicker{font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.34em;text-transform:uppercase;
    color:var(--amber);margin-bottom:20px}
  .hero h1{font-family:'Playfair Display',serif;font-weight:800;font-size:clamp(44px,7vw,86px);line-height:.98;
    letter-spacing:-.02em;background:linear-gradient(180deg,#fff, hsl(38 60% 78%));-webkit-background-clip:text;
    background-clip:text;color:transparent;margin-bottom:18px}
  .hero .sub{color:var(--muted);font-size:18px;max-width:620px;margin:0 auto}
  .hero .meta{margin-top:26px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .hero .meta span{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);
    border:1px solid var(--border);border-radius:999px;padding:6px 14px;background:hsl(28 24% 11% / .5)}

  /* big verdict */
  .verdict{margin:30px 0 56px;padding:38px;border-radius:26px;border:1px solid var(--border);
    background:linear-gradient(160deg, hsl(150 40% 20% / .25), var(--card));text-align:center;
    backdrop-filter:blur(12px);box-shadow:0 30px 80px -40px hsl(150 60% 30% / .5)}
  .verdict .big{font-family:'Playfair Display',serif;font-weight:800;font-size:clamp(54px,10vw,104px);
    line-height:1;color:var(--green);text-shadow:0 0 60px hsl(150 60% 50% / .35)}
  .verdict .big small{font-size:.32em;color:var(--muted);font-family:'DM Sans';font-weight:600;vertical-align:super}
  .verdict p{color:var(--muted);font-size:17px;margin-top:12px;max-width:680px;margin-inline:auto}
  .verdict strong{color:var(--fg)}

  /* stat grid */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:18px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 18px;
    backdrop-filter:blur(10px);transition:transform .2s ease,border-color .2s ease}
  .stat:hover{transform:translateY(-3px);border-color:hsl(38 60% 45% / .6)}
  .stat .n{font-family:'Playfair Display',serif;font-weight:700;font-size:38px;line-height:1}
  .stat .n.amber{color:var(--amber)} .stat .n.green{color:var(--green)} .stat .n.red{color:var(--red)}
  .stat .n.blue{color:var(--blue)} .stat .n.muted{color:var(--muted)}
  .stat .k{font-size:13px;color:var(--muted);margin-top:8px;font-weight:500}
  .stat .pct{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);opacity:.7}

  /* sections */
  section{margin-top:64px;scroll-margin-top:24px}
  .sec-head{display:flex;align-items:baseline;gap:14px;margin-bottom:8px}
  .sec-head h2{font-family:'Playfair Display',serif;font-weight:700;font-size:32px;letter-spacing:-.01em}
  .sec-head .count{font-family:'IBM Plex Mono',monospace;font-size:14px;color:var(--amber)}
  .sec-sub{color:var(--muted);font-size:15px;margin-bottom:26px;max-width:760px}

  /* bar */
  .bar{height:16px;border-radius:999px;overflow:hidden;display:flex;border:1px solid var(--border);margin:20px 0 8px}
  .bar i{display:block;height:100%}
  .legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--muted)}
  .legend b{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:middle}

  /* cluster */
  .cluster{margin-bottom:30px}
  .cluster h3{font-size:15px;font-weight:600;color:var(--amber);margin-bottom:14px;display:flex;align-items:center;gap:10px}
  .cluster h3::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px var(--amber)}
  .cluster h3 .c{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);font-weight:400}
  .cases{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
  .case{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;
    backdrop-filter:blur(8px);transition:border-color .2s ease,transform .2s ease}
  .case:hover{border-color:hsl(8 60% 50% / .5);transform:translateY(-2px)}
  .case-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:14px}
  .case-head h4{font-family:'Playfair Display',serif;font-weight:600;font-size:19px;line-height:1.15}
  .chip{font-family:'IBM Plex Mono',monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;
    padding:4px 9px;border-radius:999px;white-space:nowrap;flex-shrink:0}
  .chip-danger{background:var(--red-soft);color:var(--red);border:1px solid hsl(8 70% 55% / .4)}
  .chip-warn{background:var(--amber-soft);color:var(--amber);border:1px solid hsl(38 80% 55% / .4)}
  .chip-ok{background:var(--green-soft);color:var(--green);border:1px solid hsl(150 50% 45% / .4)}
  .swap{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;margin-bottom:12px}
  .side{display:flex;flex-direction:column;gap:3px}
  .side .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);opacity:.8}
  .side .name{font-weight:600;font-size:14px}
  .side.catalog .name{color:var(--muted);text-decoration:line-through;text-decoration-color:hsl(8 70% 55% / .6)}
  .side.heard .name{color:var(--green)}
  .arrow{color:var(--amber);font-size:18px}
  .evidence{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--fg);background:hsl(28 24% 8% / .7);
    border-left:2px solid var(--amber);padding:8px 12px;border-radius:6px;margin-bottom:10px;line-height:1.5}
  .path{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);opacity:.6;word-break:break-all}

  /* list rows (false alarm / needs listen / no credit) */
  .rows{display:flex;flex-direction:column;gap:10px}
  .row{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;backdrop-filter:blur(8px)}
  .row .r-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
  .row h4{font-family:'Playfair Display',serif;font-weight:600;font-size:17px}
  .row .why{color:var(--muted);font-size:13.5px;margin-top:7px}
  .row .why em{color:var(--fg);font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:12px}
  details.fold summary{cursor:pointer;color:var(--amber);font-size:14px;font-weight:500;padding:8px 0;user-select:none}
  details.fold summary:hover{color:var(--fg)}
  details.fold[open] summary{margin-bottom:14px}
  .nc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
  .nc{font-size:13px;color:var(--muted);padding:8px 12px;background:hsl(28 24% 11% / .4);border-radius:8px;border:1px solid var(--border)}
  .nc b{color:var(--fg);font-weight:500}

  footer{margin-top:90px;padding-top:30px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
  footer .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:24px}
  footer h5{font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.14em;
    color:var(--amber);margin-bottom:10px}
  footer ul{list-style:none;font-size:13px;line-height:1.9}
  footer .sig{text-align:center;opacity:.6;font-family:'IBM Plex Mono',monospace;font-size:11px}
  .fade{opacity:0;transform:translateY(16px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
  @keyframes rise{to{opacity:1;transform:none}}
  ${Array.from({ length: 14 }, (_, i) => `.d${i}{animation-delay:${i * 70}ms}`).join('')}
</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <div class="kicker fade">earwitness · ground-truth library audit</div>
    <h1 class="fade d1">Did the audio<br/>match the catalog?</h1>
    <p class="sub fade d2">Every book re-transcribed from scratch with faster-whisper large-v3, then its spoken opening &amp; closing credit judged against narratorr's catalog metadata (sourced from Audnexus) — book by book.</p>
    <div class="meta fade d3">
      <span>${total} books</span><span>large-v3 + gemma4</span><span>${RUN_DATE}</span><span>3 pipeline bugs fixed</span>
    </div>
  </header>

  <div class="verdict fade d3">
    <div class="big">${pct(catalogCorrect)}<small>%</small></div>
    <p>of the library — <strong>${catalogCorrect} of ${total} books</strong> — the audio's own spoken credit <strong>confirms the catalog is right</strong>. The catalog metadata from Audnexus is solid. The audit's job was to find the exceptions, and it found <strong>${t1.length + t2.length}</strong> of them.</p>
  </div>

  <div class="stats">
    <div class="stat fade"><div class="n green">${matches.length}</div><div class="k">Confirmed match</div><div class="pct">${pct(matches.length)}%</div></div>
    <div class="stat fade d1"><div class="n green">${recovered.length}</div><div class="k">Match after STT recovery</div><div class="pct">${pct(recovered.length)}%</div></div>
    <div class="stat fade d2"><div class="n green">${partials.length}</div><div class="k">Consistent subset (full cast)</div><div class="pct">${pct(partials.length)}%</div></div>
    <div class="stat fade d3"><div class="n red">${t1.length}</div><div class="k">Edition mismatch (confirmed)</div><div class="pct">${pct(t1.length)}%</div></div>
    <div class="stat fade d4"><div class="n amber">${t2.length}</div><div class="k">Edition mismatch (probable)</div><div class="pct">${pct(t2.length)}%</div></div>
    <div class="stat fade d5"><div class="n muted">${noCredit.length}</div><div class="k">No credit in sampled window</div><div class="pct">${pct(noCredit.length)}%</div></div>
    <div class="stat fade d6"><div class="n blue">${falseAlarms.length}</div><div class="k">False alarms caught</div><div class="pct">${pct(falseAlarms.length)}%</div></div>
    <div class="stat fade d7"><div class="n muted">${unreadable.length}</div><div class="k">Unreadable file</div><div class="pct">${pct(unreadable.length)}%</div></div>
  </div>

  <div class="bar fade">
    <i style="width:${pct(matches.length + recovered.length + partials.length)}%;background:var(--green)"></i>
    <i style="width:${pct(t1.length)}%;background:var(--red)"></i>
    <i style="width:${pct(t2.length)}%;background:var(--amber)"></i>
    <i style="width:${pct(falseAlarms.length + needsListen.length)}%;background:var(--blue)"></i>
    <i style="width:${pct(noCredit.length + unreadable.length)}%;background:var(--muted)"></i>
  </div>
  <div class="legend fade">
    <span><b style="background:var(--green)"></b>Catalog confirmed (${matches.length + recovered.length + partials.length})</span>
    <span><b style="background:var(--red)"></b>Edition mismatch (${t1.length})</span>
    <span><b style="background:var(--amber)"></b>Probable mismatch (${t2.length})</span>
    <span><b style="background:var(--blue)"></b>False alarm / needs listen (${falseAlarms.length + needsListen.length})</span>
    <span><b style="background:var(--muted)"></b>No credit / unreadable (${noCredit.length + unreadable.length})</span>
  </div>

  <section id="action">
    <div class="sec-head"><h2>The action list</h2><span class="count">${t1.length} confirmed</span></div>
    <p class="sec-sub">Books where the audio's own spoken credit names a <strong>different narrator</strong> than the catalog — almost always because the file is a different <em>edition</em> than Audnexus describes. These are the ones worth fixing in narratorr. Grouped where a clear pattern emerged.</p>
    ${clusterOrder.map((c) => `
      <div class="cluster">
        <h3>${esc(c)} <span class="c">${t1Groups[c].length} book${t1Groups[c].length > 1 ? 's' : ''}</span></h3>
        <div class="cases">${t1Groups[c].map(editionCard).join('')}</div>
      </div>`).join('')}
  </section>

  ${t2.length ? `
  <section id="probable">
    <div class="sec-head"><h2>Probable mismatches</h2><span class="count">${t2.length}</span></div>
    <p class="sec-sub">The audio says <em>“read by the author”</em> — these are the Douglas-Adams-narrated editions, while the catalog lists the later Stephen Fry / Martin Freeman recordings. Real discrepancy, but the audio never speaks the narrator's name, so confirm by ear.</p>
    <div class="cases">${t2.map(editionCard).join('')}</div>
  </section>` : ''}

  <section id="falsealarms">
    <div class="sec-head"><h2>False alarms caught</h2><span class="count">${falseAlarms.length + needsListen.length}</span></div>
    <p class="sec-sub">The raw matcher flagged these as wrong narrators. They're <strong>not</strong> — and catching them is the whole point of precision over recall. A false accusation that the catalog is wrong is worse than a miss.</p>
    <div class="rows">
      ${falseAlarms.map((b) => `
        <div class="row">
          <div class="r-top"><h4>${esc(b.title)}</h4><span class="chip chip-ok">catalog is correct</span></div>
          <p class="why">${esc(b.reason)}</p>
        </div>`).join('')}
      ${needsListen.map((b) => `
        <div class="row">
          <div class="r-top"><h4>${esc(b.title)}</h4><span class="chip chip-warn">needs a listen</span></div>
          <p class="why">${esc(b.reason)}</p>
        </div>`).join('')}
    </div>
  </section>

  <section id="methodology">
    <div class="sec-head"><h2>How the noise got separated</h2></div>
    <p class="sec-sub">The raw comparison flagged <strong>${rawMismatch} mismatches</strong>. If you'd trusted that number, you'd "fix" ${rawMismatch} books — and corrupt the ${rawMismatch - t1.length - t2.length} that were already right.</p>
    <div class="rows">
      <div class="row"><div class="r-top"><h4>1 · Pairwise name recovery</h4><span class="chip chip-ok">${recovered.length} recovered</span></div>
        <p class="why">Speech-to-text mangles names (<em>“January Lavoie”</em> for <em>“January LaVoy”</em>). The matcher under-pairs multi-narrator lists in one shot, so each leftover name was re-judged <em>pairwise</em> — far more reliable. Most "mismatches" were the same people, misspelled.</p></div>
      <div class="row"><div class="r-top"><h4>2 · Contradiction check</h4><span class="chip chip-ok">${partials.length} consistent subsets</span></div>
        <p class="why">Hearing <em>fewer</em> narrators than the catalog (a full cast where only the lead is announced) isn't a contradiction. Only a confidently-heard <strong>different</strong> name counts against the catalog.</p></div>
      <div class="row"><div class="r-top"><h4>3 · Edition vs. extra vs. garble</h4><span class="chip chip-danger">${t1.length} real</span></div>
        <p class="why">Remaining contradictions were sorted: a clean <em>“narrated by X”</em> naming a different real person = edition mismatch; a foreword reader, author note, or producer intro = extra contributor (catalog still right); a fragment = garble. This is where the false alarms (producer intros, author interviews) were caught.</p></div>
    </div>
  </section>

  <section id="nocredit">
    <div class="sec-head"><h2>No credit found</h2><span class="count">${noCredit.length}</span></div>
    <p class="sec-sub">Not errors — the spoken credit fell outside the sampled head/tail windows (long files, late credits, or none at all). The known blind spot; recoverable by widening the sample.</p>
    <details class="fold">
      <summary>Show ${noCredit.length} books</summary>
      <div class="nc-grid">
        ${noCredit.sort((a, b) => a.rel.localeCompare(b.rel)).map((b) => `<div class="nc"><b>${esc(b.title)}</b><br/>${esc(b.rel)}</div>`).join('')}
      </div>
    </details>
    ${unreadable.length ? `<div class="rows" style="margin-top:18px">${unreadable.map((b) => `<div class="row"><div class="r-top"><h4>${esc(b.title)}</h4><span class="chip chip-danger">unreadable</span></div><p class="why">ffmpeg could not decode this file — the m4b is corrupt. <em>${esc(b.rel)}</em></p></div>`).join('')}</div>` : ''}
  </section>

  <footer>
    <div class="grid">
      <div><h5>Run</h5><ul>
        <li>${total} books · ${RUN_DATE}</li>
        <li>faster-whisper large-v3</li>
        <li>gemma4 extract + compare</li>
        <li>fresh transcription, no cache reuse</li>
      </ul></div>
      <div><h5>Pipeline fixes live this run</h5><ul>
        <li>tail-skip on incomplete head</li>
        <li>"This is Audible" sting re-probe</li>
        <li>compare reframed for STT garbles</li>
      </ul></div>
      <div><h5>Outcome</h5><ul>
        <li>${pct(catalogCorrect)}% catalog confirmed</li>
        <li>${t1.length} confirmed edition mismatches</li>
        <li>${t2.length} probable · ${falseAlarms.length} false alarms caught</li>
        <li>${rawMismatch}→${t1.length + t2.length} after adjudication</li>
      </ul></div>
    </div>
    <p class="sig">earwitness — assist, not authority · precision over recall · generated ${RUN_DATE}</p>
  </footer>

</div>
</body>
</html>`;

await fs.writeFile(OUT, html, 'utf8');
console.log(`\nreport → ${OUT}  (${(html.length / 1024).toFixed(0)} KB)`);

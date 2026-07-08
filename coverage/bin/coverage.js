#!/usr/bin/env node
'use strict';
// coverage - the fidelity gate. Did the build absorb its source?
//
// usage:
//   coverage check <manifest.json>        one destination
//   coverage all [manifests-dir]          every manifest, exit 1 if any fails
//   coverage explain <manifest.json>      show every element, present and absent
const fs = require('fs');
const path = require('path');
const { checkManifest } = require('../lib/check');

const args = process.argv.slice(2);
const cmd = args[0];
const out = (s) => process.stdout.write(s + '\n');
const MANIFEST_DIR = path.join(__dirname, '..', 'manifests');

function report(r, verbose) {
  const s = r.summary;
  out(`\n${r.destination}`);
  out('-'.repeat(r.destination.length));
  out(`  prompts : ${s.absorbed} ABSORBED / ${s.partial} PARTIAL / ${s.missing} MISSING  of ${s.totalPrompts}`);
  out(`  elements: ${r.present}/${r.total} present`);
  if (r.missingFiles.length) out(`  MISSING FILES: ${r.missingFiles.join(', ')}`);
  if (verbose) {
    for (const p of r.prompts.sort((a, b) => Number(a.prompt) - Number(b.prompt))) {
      out(`   [#${p.prompt}] ${p.verdict} (${p.present}/${p.total})`);
    }
  }
  if (r.absent.length) {
    out('  ABSENT ELEMENTS:');
    for (const a of r.absent) out(`    [#${a.prompt}] ${a.name}${a.error ? '  (' + a.error + ')' : ''}`);
  }
  out(`  => ${r.ok ? 'PASS' : 'FAIL'}`);
  return r.ok;
}

function loadManifest(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

switch (cmd) {
  case 'check': {
    const f = args[1];
    if (!f || !fs.existsSync(f)) { out('usage: coverage check <manifest.json>'); process.exit(2); }
    process.exit(report(checkManifest(loadManifest(f)), false) ? 0 : 1);
    break;
  }
  case 'explain': {
    const f = args[1];
    if (!f || !fs.existsSync(f)) { out('usage: coverage explain <manifest.json>'); process.exit(2); }
    process.exit(report(checkManifest(loadManifest(f)), true) ? 0 : 1);
    break;
  }
  case 'all': {
    const dir = args[1] || MANIFEST_DIR;
    if (!fs.existsSync(dir)) { out('no manifests dir: ' + dir); process.exit(2); }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    let allOk = true;
    const rows = [];
    for (const f of files) {
      const r = checkManifest(loadManifest(path.join(dir, f)));
      allOk = report(r, false) && allOk;
      rows.push(r);
    }
    out('\n================ TOTAL ================');
    const t = rows.reduce((a, r) => ({
      absorbed: a.absorbed + r.summary.absorbed,
      partial: a.partial + r.summary.partial,
      missing: a.missing + r.summary.missing,
      prompts: a.prompts + r.summary.totalPrompts,
      el: a.el + r.total, elp: a.elp + r.present,
    }), { absorbed: 0, partial: 0, missing: 0, prompts: 0, el: 0, elp: 0 });
    out(`prompts : ${t.absorbed} ABSORBED / ${t.partial} PARTIAL / ${t.missing} MISSING  of ${t.prompts}`);
    out(`elements: ${t.elp}/${t.el} present`);
    out(allOk ? 'COVERAGE GATE: PASS' : 'COVERAGE GATE: FAIL');
    process.exit(allOk ? 0 : 1);
    break;
  }
  default:
    out('coverage - did the build absorb its source?');
    out('');
    out('  coverage check <manifest.json>     one destination, exit 1 on any absent element');
    out('  coverage explain <manifest.json>   per-prompt verdicts and every absent element');
    out('  coverage all [dir]                 every manifest; the gate');
    out('');
    out('HORKOS proves the write happened. ZOILUS proves the work is good.');
    out('This proves the work contains what its source demanded.');
}

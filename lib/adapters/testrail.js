'use strict';
// TestRail adapter. Rate-limit aware: 180 req/min (Professional): audits use single GETs,
// never enumeration; bulk checks should use get_cases (one call), not per-case loops.

function auth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.user}:${cfg.apiKey}`).toString('base64');
}

async function api(cfg, method) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/index.php?/api/v2/${method}`;
  const res = await fetch(url, { headers: { Authorization: auth(cfg), 'Content-Type': 'application/json' } });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 5);
    await new Promise(r => setTimeout(r, wait * 1000));
    return api(cfg, method);
  }
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  return res.json();
}

async function verify(entry, tier, config) {
  const cfg = (config.systems || {}).testrail;
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    if (entry.receipt && entry.receipt.ok && entry.receipt.id && tier === 1) {
      return { status: 'pass', detail: 'receipt-only: write response carried an id (no creds configured for probe)' };
    }
    return { status: 'receipt-only', detail: 'no TestRail creds in ~/.horkos/config.json. Receipt: ' + JSON.stringify(entry.receipt) };
  }
  const id = entry.target || entry.receipt.id;
  if (!id) return { status: 'unverifiable', detail: 'no entity id recorded' };
  try {
    if (tier === 1 && entry.receipt.ok && entry.receipt.id) {
      return { status: 'pass', detail: `receipt: write response carried id ${entry.receipt.id}` };
    }
    // Entity kind from the tool that wrote it.
    const kind = /section/.test(entry.tool) ? 'section' : /run/.test(entry.tool) ? 'run' : /suite/.test(entry.tool) ? 'suite' : 'case';
    const data = await api(cfg, `get_${kind}/${id}`);
    if (entry.op === 'delete') return { status: 'fail', detail: `${kind} ${id} still exists: claimed delete did not happen` };
    const updated = data.updated_on ? data.updated_on * 1000 : null;
    const ageMin = updated ? (Date.now() - updated) / 60000 : null;
    if (tier >= 2 && entry.op === 'edit' && ageMin != null && ageMin > 120) {
      return { status: 'fail', detail: `${kind} ${id} updated_on is ${Math.round(ageMin)} min old: claimed edit not reflected` };
    }
    if (tier >= 3 && entry.title && data.title && !data.title.includes(entry.title) && !entry.title.includes(data.title)) {
      return { status: 'fail', detail: `${kind} ${id} live title "${data.title}" does not match sent title "${entry.title}"` };
    }
    return { status: 'pass', detail: `${kind} ${id} exists${ageMin != null ? `, updated ${Math.round(ageMin)} min ago` : ''}${tier >= 3 ? ', title matches' : ''}` };
  } catch (e) {
    if (entry.op === 'delete' && /404/.test(e.message)) return { status: 'pass', detail: `entity ${id} gone (404): delete confirmed` };
    return { status: 'unverifiable', detail: 'API error during audit: ' + e.message };
  }
}

module.exports = { verify };

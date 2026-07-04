'use strict';
// Confluence Cloud adapter. Receipt = version.number (optimistic locking makes it a real receipt).
// Known caveat handled: v2 API version-number lag -> one retry after 3s before failing.

function auth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
}

async function getPage(cfg, pageId, withBody) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/wiki/api/v2/pages/${pageId}${withBody ? '?body-format=storage' : ''}`;
  const res = await fetch(url, { headers: { Authorization: auth(cfg), Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET page ${pageId} -> HTTP ${res.status}`);
  return res.json();
}

// Normalize storage-format XHTML for comparison: Confluence re-serializes macros,
// so a naive string compare false-positives. Compare text content only.
function normalize(storageBody) {
  return String(storageBody || '')
    .replace(/<[^>]+>/g, ' ')       // strip tags
    .replace(/&[a-z]+;/gi, ' ')     // entities
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sample(text, n) {
  // Probe lines spread across the sent body: start, middle, end.
  const t = normalize(text);
  if (t.length <= 120) return t ? [t] : [];
  const picks = [];
  for (const at of [0, 0.5, Math.max(0, 1 - 160 / t.length)]) {
    picks.push(t.slice(Math.floor(t.length * at), Math.floor(t.length * at) + 120).trim());
  }
  return picks.filter(Boolean).slice(0, n || 3);
}

async function verify(entry, tier, config) {
  const cfg = (config.systems || {}).confluence;
  // Honest no-creds state: never fake a pass.
  if (!cfg || !cfg.baseUrl || !cfg.apiToken) {
    if (entry.receipt && entry.receipt.ok && entry.receipt.version != null && tier === 1) {
      return { status: 'pass', detail: `receipt-only: write response carried version ${entry.receipt.version} (no creds configured for probe)` };
    }
    return { status: 'receipt-only', detail: 'no Confluence creds in ~/.horkos/config.json: cannot probe or re-fetch. Receipt from write response: ' + JSON.stringify(entry.receipt) };
  }
  const pageId = entry.target || entry.receipt.id;
  if (!pageId) return { status: 'unverifiable', detail: 'no page id recorded in ledger or receipt' };

  const attempt = async () => {
    if (tier === 1) {
      if (entry.receipt.ok && entry.receipt.version != null) return { status: 'pass', detail: `version ${entry.receipt.version} in write response, status ok` };
      // Receipt weak -> promote to a cheap probe rather than passing on nothing.
      tier = 2;
    }
    if (tier === 2) {
      const page = await getPage(cfg, pageId, false);
      const v = page.version && page.version.number;
      if (entry.receipt.version != null && v >= entry.receipt.version) return { status: 'pass', detail: `probe: live version ${v} >= receipt version ${entry.receipt.version}, status ${page.status}` };
      if (entry.receipt.version == null && page.status === 'current') return { status: 'pass', detail: `probe: page exists, version ${v}, status current` };
      return { status: 'fail', detail: `probe: live version ${v} < receipt version ${entry.receipt.version}: the write did not land` };
    }
    // Tier 3: full re-fetch + normalized containment of what the agent SENT.
    const page = await getPage(cfg, pageId, true);
    const v = page.version && page.version.number;
    const live = normalize(page.body && page.body.storage && page.body.storage.value);
    if (!live) return { status: 'fail', detail: `re-fetch: page ${pageId} has no body` };
    if (entry.receipt.version != null && v < entry.receipt.version) return { status: 'fail', detail: `re-fetch: live version ${v} < receipt ${entry.receipt.version}` };
    const probes = sample(entry.sent_head, 3);
    const missing = probes.filter(p => !live.includes(p));
    if (probes.length && missing.length === probes.length) {
      return { status: 'fail', detail: `re-fetch: NONE of ${probes.length} content probes from the sent body found in the live page (version ${v}). The content did not land as claimed.` };
    }
    if (missing.length) {
      return { status: 'fail', detail: `re-fetch: ${missing.length}/${probes.length} content probes missing from live page (version ${v}). Partial landing: redo required.` };
    }
    return { status: 'pass', detail: `re-fetch: version ${v}, ${probes.length}/${probes.length} content probes found, ${live.length} chars live` };
  };

  try {
    const first = await attempt();
    if (first.status !== 'fail') return first;
    // v2 version-lag tolerance: one retry after 3s before declaring failure.
    await new Promise(r => setTimeout(r, 3000));
    const second = await attempt();
    return second.status === 'pass' ? second : { ...second, detail: second.detail + ' (confirmed after 3s version-lag retry)' };
  } catch (e) {
    return { status: 'unverifiable', detail: 'API error during audit: ' + e.message };
  }
}

module.exports = { verify, normalize, sample };

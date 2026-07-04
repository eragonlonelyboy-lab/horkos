'use strict';
// Jira Cloud adapter. Receipt = issue key from write response; probe = updated timestamp;
// deep audit = changelog (append-only, not user-editable -> strong evidence).

function auth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
}

async function getIssue(cfg, key, expandChangelog) {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${key}?fields=updated,summary,status${expandChangelog ? '&expand=changelog' : ''}`;
  const res = await fetch(url, { headers: { Authorization: auth(cfg), Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET issue ${key} -> HTTP ${res.status}`);
  return res.json();
}

async function verify(entry, tier, config) {
  const cfg = (config.systems || {}).jira;
  if (!cfg || !cfg.baseUrl || !cfg.apiToken) {
    if (entry.receipt && entry.receipt.ok && (entry.receipt.id || entry.receipt.status) && tier === 1) {
      return { status: 'pass', detail: `receipt-only: write response carried id/status (no creds configured for probe)` };
    }
    return { status: 'receipt-only', detail: 'no Jira creds in ~/.horkos/config.json. Receipt: ' + JSON.stringify(entry.receipt) };
  }
  const key = entry.target || entry.receipt.id;
  if (!key) return { status: 'unverifiable', detail: 'no issue key recorded' };
  try {
    if (tier === 1 && entry.receipt.ok && entry.receipt.id) {
      return { status: 'pass', detail: `receipt: write response carried issue ${entry.receipt.id}` };
    }
    const issue = await getIssue(cfg, key, tier >= 3);
    const updated = issue.fields && issue.fields.updated;
    const ageMin = updated ? (Date.now() - new Date(updated).getTime()) / 60000 : Infinity;
    if (ageMin > 120) return { status: 'fail', detail: `issue ${key} last updated ${Math.round(ageMin)} min ago — the claimed write is not reflected` };
    if (tier >= 3 && issue.changelog) {
      const entries = issue.changelog.histories || [];
      const recent = entries.filter(h => (Date.now() - new Date(h.created).getTime()) < 2 * 3600 * 1000);
      if (!recent.length && entry.op === 'edit') return { status: 'fail', detail: `issue ${key}: no changelog entries in the last 2h — claimed edit left no trace` };
      return { status: 'pass', detail: `issue ${key} updated ${Math.round(ageMin)} min ago, ${recent.length} recent changelog entries` };
    }
    return { status: 'pass', detail: `issue ${key} updated ${Math.round(ageMin)} min ago, status ${issue.fields.status && issue.fields.status.name}` };
  } catch (e) {
    return { status: 'unverifiable', detail: 'API error during audit: ' + e.message };
  }
}

module.exports = { verify };

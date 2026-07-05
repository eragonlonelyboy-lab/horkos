'use strict';
// Tier-0 baseline adapter: local filesystem + git. Free, content-addressed, tamper-evident.
const fs = require('fs');
const { execFileSync } = require('child_process');

async function verify(entry /*, tier, config */) {
  if (entry.system === 'fs') {
    const p = entry.target;
    if (!p) return { status: 'unverifiable', detail: 'no file path recorded' };
    if (!fs.existsSync(p)) return { status: 'fail', detail: `claimed write but file does not exist: ${p}` };
    const stat = fs.statSync(p);
    if (stat.size === 0 && entry.sent_chars > 0) return { status: 'fail', detail: `file exists but is empty: ${p}` };
    // Containment probe: the head of what the agent sent should be in the file (Write ops).
    if (entry.sent_head && entry.op === 'create-or-overwrite') {
      const content = fs.readFileSync(p, 'utf8');
      const probe = entry.sent_head.slice(0, 120).trim();
      if (probe && !content.includes(probe)) {
        return { status: 'fail', detail: `file content does not contain the head of what was sent: ${p}` };
      }
    }
    return { status: 'pass', detail: `file exists, ${stat.size} bytes${entry.sent_head ? ', head content confirmed' : ''}` };
  }
  if (entry.system === 'git') {
    // Resolve the repo the claim is about. The ledger records a cd-prefix path or the
    // hook cwd; legacy entries carry the placeholder "repo". Normalize git-bash /c/ form.
    let repoDir = null;
    if (entry.target && entry.target !== 'repo') {
      let t = String(entry.target).replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ':/');
      if (fs.existsSync(t) && fs.statSync(t).isDirectory()) repoDir = t;
    }
    const recorded = !!repoDir;
    repoDir = repoDir || process.cwd();
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', timeout: 5000 }).trim();
      if (entry.op === 'commit') {
        const msgTs = execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: repoDir, encoding: 'utf8', timeout: 5000 }).trim();
        // Compare against the CLAIM time, not the audit time: a commit landed iff
        // HEAD is not older than the ledger entry (30 min slack). Session length
        // must never fail a real commit (6h-age false positive, dogfood 2026-07-05).
        const commitTime = new Date(msgTs).getTime();
        const claimTime = entry.ts ? new Date(entry.ts).getTime() : Date.now();
        if (commitTime < claimTime - 30 * 60000) {
          if (recorded) return { status: 'fail', detail: `HEAD in ${repoDir} predates the ledgered commit claim by ${Math.round((claimTime - commitTime) / 60000)} min: claimed commit did not land` };
          // Repo path was never recorded: checking some other repo's HEAD proves nothing.
          return { status: 'unverifiable', detail: 'repo path not recorded in ledger and cwd repo HEAD predates the claim: cannot locate the claimed repo' };
        }
        return { status: 'pass', detail: `HEAD ${head.slice(0, 8)} in ${repoDir} committed at/after the claim` };
      }
      return { status: 'pass', detail: `repo reachable, HEAD ${head.slice(0, 8)}` };
    } catch (e) {
      return { status: 'unverifiable', detail: 'git not reachable from ' + repoDir + ': ' + e.message.split('\n')[0] };
    }
  }
  return { status: 'unverifiable', detail: 'not an fs/git entry' };
}

module.exports = { verify };

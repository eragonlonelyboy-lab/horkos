'use strict';
// HORKOS write ledger: records every external write + its receipt, live, at write time.
// Zero extra API calls: the receipt is whatever the write response already carried.
const { appendJSONL, readJSONL, ledgerPath } = require('./config');

// Map a tool call to {system, op} or null if it is not a write we track.
function classifyTool(toolName, toolInput) {
  const n = String(toolName || '');
  // Local filesystem writes
  if (n === 'Write') return { system: 'fs', op: 'create-or-overwrite', target: toolInput.file_path };
  if (n === 'Edit' || n === 'NotebookEdit') return { system: 'fs', op: 'edit', target: toolInput.file_path || toolInput.notebook_path };
  // git via shell (Bash or PowerShell). Match `git <subcommand>` even when global
  // flags sit between them: `git -C <path> commit`, `git -c k=v push`,
  // `git --git-dir=<path> tag`, `git --no-pager merge`. Pre-fix this required the
  // subcommand to immediately follow `git`, so `git -C $repo commit` produced NO
  // ledger entry and a real push read as a phantom (dogfood 2026-07-07, AURA/KINEMA push).
  if (n === 'Bash' || n === 'PowerShell') {
    const cmd = String(toolInput.command || '');
    const gm = cmd.match(/\bgit\b(?:\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?|-\w+))*\s+(commit|push|tag|merge)\b/);
    if (gm) {
      const op = gm[1];
      // Record WHICH repo. `git -C <path>` and `--git-dir=<path>` name it explicitly;
      // otherwise a leading `cd <path>` (wrong-repo false positive, dogfood 2026-07-05:
      // the audit checked HEAD age in the hook's cwd, not the committed repo).
      const pick = (m) => (m && (m[1] || m[2] || m[3])) || null;
      const cflag = cmd.match(/-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const gitdir = cmd.match(/--git-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/);
      const cd = cmd.match(/(?:^|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
      return { system: 'git', op, target: pick(cflag) || pick(gitdir) || pick(cd) || null };
    }
    return null;
  }
  // MCP writes: match by segment after the last "__"
  const short = n.includes('__') ? n.slice(n.lastIndexOf('__') + 2) : n;
  const mcp = [
    { re: /^createConfluence(Page|FooterComment|InlineComment)$/, system: 'confluence', op: 'create' },
    { re: /^updateConfluencePage$/, system: 'confluence', op: 'edit' },
    { re: /^(createJiraIssue|createIssueLink)$/, system: 'jira', op: 'create' },
    { re: /^(editJiraIssue|transitionJiraIssue|addCommentToJiraIssue|addWorklogToJiraIssue)$/, system: 'jira', op: 'edit' },
    { re: /^add_(case|section|suite|run|plan|milestone|result|result_for_case|results_for_cases)$/, system: 'testrail', op: 'create' },
    { re: /^update_(case|section|suite|run|plan|milestone)$/, system: 'testrail', op: 'edit' },
    { re: /^delete_(case|section|suite|run|plan|milestone)$/, system: 'testrail', op: 'delete' },
    { re: /^copy_cases_to_section$/, system: 'testrail', op: 'create' }
  ];
  for (const m of mcp) if (m.re.test(short)) return { system: m.system, op: m.op, target: null };
  return null;
}

// Pull the cheapest receipt out of a write response without any new call.
// For fs writes, skip the error-word sniffing: Write/Edit responses echo file
// content snippets, so a spec that merely CONTAINS "error" or "conflict" poisons
// the receipt (false silent-failures, dogfood session 0ae7e740, 2026-07-05).
// Disk is the ground truth for fs; the adapter verifies the artifact directly.
function extractReceipt(toolResponse, system) {
  let raw = toolResponse;
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
    raw = raw.content.map(c => c.text || '').join('\n');
  }
  let obj = null;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch {} } }
  } else if (raw && typeof raw === 'object') obj = raw;

  const r = { ok: null, id: null, version: null, status: null, updated: null, error: null };
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
  if (system !== 'fs') {
    if (/\b(409|conflict)\b/i.test(text)) r.error = 'conflict';
    else if (/\b(error|failed|denied|unauthorized|403|404|500)\b/i.test(text) && !/"status"\s*:\s*"current"/.test(text)) r.error = 'error-text';
  }
  if (obj) {
    r.id = obj.id || obj.key || (obj.page && obj.page.id) || null;
    r.version = (obj.version && (obj.version.number ?? obj.version)) ?? null;
    r.status = obj.status || null;
    r.updated = obj.updated_on || obj.updated || null;
    if (obj.is_error === true) r.error = r.error || 'is_error';
  }
  r.ok = !r.error;
  return r;
}

// Deterministic scope from the byte size of the body the agent sent.
function scopeOf(toolInput, thresholds) {
  const body = String(toolInput.body || toolInput.content || toolInput.description || toolInput.new_string || '');
  if (body.length <= thresholds.small_max_chars) return 'small';
  if (body.length <= thresholds.sections_max_chars) return 'sections';
  return 'full-body';
}

function recordFromHook(hookInput, thresholds) {
  const cls = classifyTool(hookInput.tool_name, hookInput.tool_input || {});
  if (!cls) return null; // not a tracked write: get out fast
  const receipt = extractReceipt(hookInput.tool_response, cls.system);
  const input = hookInput.tool_input || {};
  const entry = {
    ts: new Date().toISOString(),
    tool: hookInput.tool_name,
    system: cls.system,
    op: cls.op,
    target: cls.target || (cls.system === 'git' ? (hookInput.cwd || 'repo') : null) || input.pageId || input.page_id || input.issueIdOrKey || input.case_id || input.section_id || input.id || null,
    title: input.title || input.summary || null,
    novelty: cls.op === 'create' ? 'net-new' : 'existing',
    scope: scopeOf(input, thresholds),
    sent_chars: String(input.body || input.content || input.description || input.new_string || '').length,
    sent_head: String(input.body || input.content || input.description || input.new_string || '').slice(0, 400),
    receipt,
    conflict: receipt.error === 'conflict'
  };
  appendJSONL(ledgerPath(hookInput.session_id), entry);
  return entry;
}

function readLedger(sessionId) { return readJSONL(ledgerPath(sessionId)); }

module.exports = { classifyTool, extractReceipt, recordFromHook, readLedger, scopeOf };

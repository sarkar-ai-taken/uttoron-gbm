/**
 * Uttoron GBM Election — Google Apps Script backend
 * ---------------------------------------------------
 * Deploy as a Web App (Execute as: Me, Who has access: Anyone).
 * The bound Google Sheet is the paper trail. Tabs (created by setup()):
 *
 *   Config     key | value
 *   Voters     email | name | membership | code | voted_at | receipt
 *   Candidates id | name | note | active
 *   Votes      timestamp | email | name | choices | count | receipt | user_agent
 *   Log        timestamp | action | email | detail
 *
 * Run setup() once from the editor to create tabs + default config.
 */

const SHEET = {
  CONFIG: 'Config',
  VOTERS: 'Voters',
  CANDIDATES: 'Candidates',
  VOTES: 'Votes',
  LOG: 'Log',
};

const DEFAULT_CONFIG = {
  election_name: 'Uttoron Executive Committee Election',
  seats: 26,              // X — max picks per ballot (also # of winners shown)
  voting_open: 'false',   // Election Officer toggles from admin page
  admin_key: '',          // set a long random string here before election day
  code_length: 6,
};

// ------------------------------------------------------------------ setup

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET.CONFIG, ['key', 'value']);
  ensureSheet_(ss, SHEET.VOTERS, ['email', 'name', 'membership', 'code', 'voted_at', 'receipt']);
  ensureSheet_(ss, SHEET.CANDIDATES, ['id', 'name', 'note', 'active']);
  ensureSheet_(ss, SHEET.VOTES, ['timestamp', 'email', 'name', 'choices', 'count', 'receipt', 'user_agent']);
  ensureSheet_(ss, SHEET.LOG, ['timestamp', 'action', 'email', 'detail']);

  const cfg = readConfig_();
  const sh = ss.getSheetByName(SHEET.CONFIG);
  Object.keys(DEFAULT_CONFIG).forEach(k => {
    if (!(k in cfg)) sh.appendRow([k, DEFAULT_CONFIG[k]]);
  });
  if (!cfg.admin_key) {
    const key = Utilities.getUuid().replace(/-/g, '');
    setConfig_('admin_key', key);
    Logger.log('Generated admin_key: ' + key);
  }
  Logger.log('Setup complete. Fill Voters and Candidates tabs, then run generateCodes().');
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ------------------------------------------------------------------ HTTP

function doGet(e) {
  const action = (e.parameter.action || 'config').toString();
  return respond_(handle_(action, e.parameter, ''));
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { body = {}; }
  const action = (body.action || e.parameter.action || '').toString();
  const ua = (e.parameter.ua || body.ua || '').toString().slice(0, 200);
  return respond_(handle_(action, body, ua));
}

function respond_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle_(action, p, ua) {
  try {
    switch (action) {
      case 'config':        return actionConfig_();
      case 'verify':        return actionVerify_(p);
      case 'vote':          return actionVote_(p, ua);
      // admin
      case 'results':       return admin_(p, actionResults_);
      case 'setOpen':       return admin_(p, actionSetOpen_);
      case 'generateCodes': return admin_(p, actionGenerateCodes_);
      case 'codesCsv':      return admin_(p, actionCodesCsv_);
      case 'sendCodes':     return admin_(p, actionSendCodes_);
      default:              return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    log_('error', p && p.email, String(err && err.stack || err));
    return { ok: false, error: 'Server error: ' + (err.message || err) };
  }
}

function admin_(p, fn) {
  const cfg = readConfig_();
  if (!cfg.admin_key || String(p.adminKey || '') !== String(cfg.admin_key)) {
    return { ok: false, error: 'Invalid admin key' };
  }
  return fn(p, cfg);
}

// ------------------------------------------------------------------ public actions

function actionConfig_() {
  const cfg = readConfig_();
  return {
    ok: true,
    electionName: cfg.election_name,
    seats: Number(cfg.seats) || 26,
    open: String(cfg.voting_open) === 'true',
    candidates: readCandidates_(),
    serverTime: new Date().toISOString(),
  };
}

function actionVerify_(p) {
  const v = findVoter_(p.email, p.code);
  if (!v.ok) return v;
  return { ok: true, name: v.voter.name, alreadyVoted: !!v.voter.voted_at, receipt: v.voter.receipt || null };
}

function actionVote_(p, ua) {
  const cfg = readConfig_();
  if (String(cfg.voting_open) !== 'true') return { ok: false, error: 'Voting is closed.' };

  const seats = Number(cfg.seats) || 26;
  const choices = Array.isArray(p.choices) ? p.choices.map(String) : [];
  const uniq = [...new Set(choices)];
  if (uniq.length === 0) return { ok: false, error: 'Select at least one candidate.' };
  if (uniq.length > seats) return { ok: false, error: `You may select at most ${seats} candidates.` };

  const valid = new Set(readCandidates_().map(c => c.id));
  const bad = uniq.filter(id => !valid.has(id));
  if (bad.length) return { ok: false, error: 'Invalid candidate id(s): ' + bad.join(', ') };

  // Serialize the check-and-record so a double-submit can't vote twice.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'Server busy, please try again.' };
  try {
    const v = findVoter_(p.email, p.code);
    if (!v.ok) return v;
    if (v.voter.voted_at) return { ok: false, error: 'This email has already voted.', alreadyVoted: true, receipt: v.voter.receipt };

    const ts = new Date();
    const names = nameMap_();
    const choiceNames = uniq.map(id => names[id] || id);
    const receipt = receipt_(v.voter.email, ts, uniq);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.getSheetByName(SHEET.VOTES).appendRow([
      ts, v.voter.email, v.voter.name, choiceNames.join('; '), uniq.length, receipt, ua,
    ]);
    const vs = ss.getSheetByName(SHEET.VOTERS);
    vs.getRange(v.row, 5, 1, 2).setValues([[ts, receipt]]);
    SpreadsheetApp.flush();

    return { ok: true, receipt, timestamp: ts.toISOString(), count: uniq.length };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------ admin actions

function actionResults_(p, cfg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const seats = Number(cfg.seats) || 26;
  const candidates = readCandidates_(true);
  const tally = {};
  candidates.forEach(c => { tally[c.name] = 0; });

  const vs = ss.getSheetByName(SHEET.VOTES);
  const rows = vs.getLastRow() > 1 ? vs.getRange(2, 1, vs.getLastRow() - 1, 7).getValues() : [];
  rows.forEach(r => {
    String(r[3] || '').split('; ').filter(Boolean).forEach(n => {
      tally[n] = (tally[n] || 0) + 1;
    });
  });

  const ranked = Object.keys(tally)
    .map(name => ({ name, votes: tally[name] }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));

  // Tie at the cutoff: last winner's vote count equals first loser's.
  let tieAtCutoff = false;
  if (ranked.length > seats && ranked[seats - 1].votes === ranked[seats].votes) tieAtCutoff = true;

  const voters = ss.getSheetByName(SHEET.VOTERS);
  const eligible = Math.max(voters.getLastRow() - 1, 0);

  return {
    ok: true,
    electionName: cfg.election_name,
    seats,
    open: String(cfg.voting_open) === 'true',
    eligible,
    ballots: rows.length,
    tieAtCutoff,
    ranked,
    generatedAt: new Date().toISOString(),
  };
}

function actionSetOpen_(p) {
  const open = String(p.open) === 'true';
  setConfig_('voting_open', open ? 'true' : 'false');
  log_('setOpen', '', open ? 'OPEN' : 'CLOSED');
  return { ok: true, open };
}

function actionGenerateCodes_(p, cfg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET.VOTERS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return { ok: true, generated: 0 };
  const len = Number(cfg.code_length) || 6;
  const range = sh.getRange(2, 1, n, 4);
  const vals = range.getValues();
  const seen = new Set(vals.map(r => String(r[3])).filter(Boolean));
  let generated = 0;
  vals.forEach(r => {
    r[0] = normEmail_(r[0]);
    if (!r[3] && r[0]) {
      let c;
      do { c = randomCode_(len); } while (seen.has(c));
      seen.add(c); r[3] = c; generated++;
    }
  });
  range.setValues(vals);
  log_('generateCodes', '', generated + ' codes');
  return { ok: true, generated };
}

function actionCodesCsv_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET.VOTERS);
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 4).getValues() : [];
  const csv = ['email,name,membership,code']
    .concat(rows.map(r => r.slice(0, 4).map(csvCell_).join(',')))
    .join('\n');
  return { ok: true, csv };
}

/** Emails each voter their code via MailApp. Gmail quota: ~100/day (consumer), ~1500/day (Workspace). */
function actionSendCodes_(p, cfg) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET.VOTERS);
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 4).getValues() : [];
  const quota = MailApp.getRemainingDailyQuota();
  const siteUrl = String(p.siteUrl || '');
  let sent = 0, skipped = 0;
  const onlyEmails = Array.isArray(p.emails) ? new Set(p.emails.map(normEmail_)) : null;
  for (const r of rows) {
    const email = normEmail_(r[0]);
    if (!email || !r[3]) { skipped++; continue; }
    if (onlyEmails && !onlyEmails.has(email)) continue;
    if (sent >= quota) { skipped++; continue; }
    MailApp.sendEmail({
      to: email,
      subject: `${cfg.election_name} — your voting code`,
      htmlBody:
        `<p>Dear ${r[1] || 'member'},</p>` +
        `<p>Your one-time voting code for the <b>${cfg.election_name}</b> is:</p>` +
        `<p style="font-size:28px;letter-spacing:4px;font-family:monospace"><b>${r[3]}</b></p>` +
        (siteUrl ? `<p>When voting opens, go to <a href="${siteUrl}">${siteUrl}</a>, enter this email address and the code above.</p>` : '') +
        `<p>You may vote once. Please do not share this code.</p><p>— Uttoron Election Officer</p>`,
    });
    sent++;
  }
  log_('sendCodes', '', `sent ${sent}, skipped ${skipped}`);
  return { ok: true, sent, skipped, remainingQuota: MailApp.getRemainingDailyQuota() };
}

// ------------------------------------------------------------------ helpers

function readConfig_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.CONFIG);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0]) out[String(r[0])] = r[1]; });
  return out;
}

function setConfig_(key, value) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.CONFIG);
  const vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

/** Candidates (active only unless includeInactive). Cached 30s to survive 1000 voters loading at once. */
function readCandidates_(includeInactive) {
  const cache = CacheService.getScriptCache();
  const key = 'cands_' + (includeInactive ? 'all' : 'active');
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.CANDIDATES);
  const n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 4).getValues() : [];
  const list = rows
    .filter(r => r[1])
    .map(r => ({ id: String(r[0] || r[1]).trim(), name: String(r[1]).trim(), note: String(r[2] || ''), active: String(r[3]).toLowerCase() !== 'false' && String(r[3]).toLowerCase() !== 'no' }))
    .filter(c => includeInactive || c.active);
  cache.put(key, JSON.stringify(list), 30);
  return list;
}

function nameMap_() {
  const m = {};
  readCandidates_(true).forEach(c => { m[c.id] = c.name; });
  return m;
}

function findVoter_(email, code) {
  email = normEmail_(email);
  code = String(code || '').trim().toUpperCase();
  if (!email) return { ok: false, error: 'Enter your email address.' };
  if (!code) return { ok: false, error: 'Enter your voting code.' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.VOTERS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return { ok: false, error: 'No eligible voters loaded.' };
  const rows = sh.getRange(2, 1, n, 6).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (normEmail_(rows[i][0]) === email) {
      if (String(rows[i][3]).trim().toUpperCase() !== code) {
        log_('badCode', email, '');
        return { ok: false, error: 'Code does not match this email.' };
      }
      return { ok: true, row: i + 2, voter: { email, name: String(rows[i][1] || ''), membership: String(rows[i][2] || ''), voted_at: rows[i][4], receipt: rows[i][5] } };
    }
  }
  log_('unknownEmail', email, '');
  return { ok: false, error: 'This email is not on the eligible voter list. Contact the Election Officer.' };
}

function normEmail_(e) { return String(e || '').trim().toLowerCase(); }

function randomCode_(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function receipt_(email, ts, choices) {
  const raw = email + '|' + ts.getTime() + '|' + choices.slice().sort().join(',');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.slice(0, 5).map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('').toUpperCase();
}

function csvCell_(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function log_(action, email, detail) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.LOG).appendRow([new Date(), action, email || '', detail || '']);
  } catch (e) { /* never fail a request because logging failed */ }
}

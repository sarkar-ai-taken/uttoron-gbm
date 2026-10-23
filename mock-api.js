// In-browser mock of the Apps Script backend. Active only when ELECTION_CONFIG.MOCK is non-empty.
// Lets you try the voter and admin pages locally with no Google Sheet.
(function () {
  if (!(window.ELECTION_CONFIG || {}).MOCK) return;
  const names = Array.from({ length: 30 }, (_, i) => 'Person ' + (i + 1));
  const db = {
    seats: 26, open: true, closeAt: null, electionName: 'Uttoron Executive Committee Election 2027 (MOCK)',
    candidates: names.map((n, i) => ({ id: 'c' + (i + 1), name: n, note: '', active: true })),
    voters: { 'test@example.com': { name: 'Test Member', code: 'ABC123' }, 'spouse@example.com': { name: 'Spouse Member', code: 'XYZ789' } },
    votes: [], adminKey: 'admin',
  };
  // pre-seed some ballots so admin has data
  for (let i = 0; i < 40; i++) {
    const picks = db.candidates.map(c => c.id).sort(() => Math.random() - .5).slice(0, 20 + Math.floor(Math.random() * 7));
    db.votes.push({ email: 'seed' + i + '@example.com', choices: picks });
  }
  // persist across reloads (per browser) so already-voted and open/close can be tested across tabs
  try { const saved = JSON.parse(localStorage.getItem('mockdb') || 'null'); if (saved) Object.assign(db, saved); } catch (e) {}
  const persist = () => { try { localStorage.setItem('mockdb', JSON.stringify({ open: db.open, closeAt: db.closeAt, voters: db.voters, votes: db.votes })); } catch (e) {} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rc = () => Math.random().toString(16).slice(2, 12).toUpperCase();

  const reload = () => { try { const saved = JSON.parse(localStorage.getItem('mockdb') || 'null'); if (saved) Object.assign(db, saved); } catch (e) {} };
  window.MOCK_API = async function (action, p) {
    await sleep(250);
    reload(); // pick up changes made from other tabs (e.g. admin closing voting)
    try { return await mock(action, p); } finally { persist(); }
  };
  async function mock(action, p) {
    const auth = () => { if (p.token !== 'tok') throw Object.assign(new Error('Not signed in or session expired. Please sign in again.'), { data: { authRequired: true } }); };
    const isOpen = () => { if (db.open && db.closeAt && Date.now() >= db.closeAt) { db.open = false; db.closeAt = null; } return db.open; };
    const voter = () => {
      const v = db.voters[(p.email || '').toLowerCase()];
      if (!v) throw Object.assign(new Error('This email is not on the eligible voter list. Contact the Election Officer.'), { data: {} });
      if (v.code !== (p.code || '').toUpperCase()) throw Object.assign(new Error('Code does not match this email.'), { data: {} });
      return v;
    };
    switch (action) {
      case 'config': return { ok: true, electionName: db.electionName, seats: db.seats, open: isOpen(), closeAt: db.closeAt, candidates: db.candidates };
      case 'status': return { ok: true, open: isOpen(), closeAt: db.closeAt, serverTime: Date.now() };
      case 'adminLogin': if (p.email === 'admin@example.com' && p.password === 'admin') return { ok: true, token: 'tok', name: 'Mock Officer', email: p.email }; throw Object.assign(new Error('Email or password is incorrect.'), { data: {} });
      case 'adminLogout': return { ok: true };
      case 'verify': { const v = voter(); return { ok: true, name: v.name, alreadyVoted: !!v.voted, receipt: v.receipt || null }; }
      case 'vote': {
        if (!isOpen()) throw Object.assign(new Error('Voting is closed.'), { data: {} });
        const v = voter();
        if (v.voted) throw Object.assign(new Error('This email has already voted.'), { data: { alreadyVoted: true, receipt: v.receipt } });
        if (p.choices.length > db.seats) throw Object.assign(new Error('Too many'), { data: {} });
        v.voted = true; v.receipt = rc();
        db.votes.push({ email: p.email, choices: p.choices });
        return { ok: true, receipt: v.receipt, timestamp: new Date().toISOString(), count: p.choices.length };
      }
      case 'results': {
        auth();
        const t = {}; db.candidates.forEach(c => t[c.name] = 0);
        const byId = Object.fromEntries(db.candidates.map(c => [c.id, c.name]));
        db.votes.forEach(v => v.choices.forEach(id => t[byId[id]]++));
        const ranked = Object.keys(t).map(name => ({ name, votes: t[name] })).sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
        return { ok: true, electionName: db.electionName, seats: db.seats, open: isOpen(), closeAt: db.closeAt, eligible: Object.keys(db.voters).length + 40,
          ballots: db.votes.length, tieAtCutoff: ranked.length > db.seats && ranked[db.seats - 1].votes === ranked[db.seats].votes, ranked, generatedAt: new Date().toISOString() };
      }
      case 'setOpen': auth(); if (String(p.open) === 'true') { db.open = true; db.closeAt = null; } else { db.closeAt = Date.now() + 15000; } return { ok: true, open: db.open, closeAt: db.closeAt };
      case 'generateCodes': auth(); return { ok: true, generated: 0 };
      case 'codesCsv': auth(); return { ok: true, csv: 'email,name,membership,code\n' + Object.entries(db.voters).map(([e, v]) => `${e},${v.name},,${v.code}`).join('\n') };
      case 'sendCodes': auth(); return { ok: true, sent: 2, skipped: 0, remainingQuota: 98 };
      default: throw new Error('Unknown action ' + action);
    }
  }
})();

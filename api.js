// Shared API client for the voter and admin pages.
// Apps Script Web Apps accept cross-origin POSTs when the body is text/plain
// (no CORS preflight), and reply with JSON after a redirect — fetch follows it.
(function () {
  const cfg = window.ELECTION_CONFIG || {};

  async function call(action, payload) {
    if (cfg.MOCK && window.MOCK_API) return window.MOCK_API(action, payload || {});
    if (!cfg.API_URL || cfg.API_URL.includes('REPLACE_ME')) {
      throw new Error('API_URL is not set in config.js');
    }
    const body = Object.assign({ action, ua: navigator.userAgent }, payload || {});
    const res = await fetch(cfg.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('Network error (' + res.status + ')');
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Unexpected response from server'); }
    if (!data.ok) { const err = new Error(data.error || 'Request failed'); err.data = data; throw err; }
    return data;
  }

  window.API = { call };
})();

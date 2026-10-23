# Uttoron GBM Election

Online + in-person voting for the Uttoron Executive Committee election.
Members enter their registered email and a one-time code, pick up to **X** candidates
(X = 26 by default, configurable), and get a receipt. The Election Officer opens/closes
voting and sees live results. Every ballot is a row in a Google Sheet — that sheet is the
paper trail.

```
┌───────────────┐  POST JSON  ┌──────────────────────┐  reads/writes  ┌────────────────┐
│ GitHub Pages  │ ──────────▶ │ Google Apps Script   │ ─────────────▶ │ Google Sheet   │
│ index.html    │             │ Web App (Code.gs)    │                │ Voters, Votes, │
│ admin.html    │ ◀────────── │ verify / vote / tally│ ◀───────────── │ Candidates…    │
└───────────────┘             └──────────────────────┘                └────────────────┘
```

## Files

| File | Purpose |
|---|---|
| `index.html` | Voter page (email + code → ballot → review → receipt) |
| `admin.html` | Election Officer panel: open/close voting, live tally, winners, CSV export, voter codes |
| `styles.css`, `api.js`, `config.js` | Shared styling, API client, site config (paste your Apps Script URL here) |
| `mock-api.js` | In-browser fake backend for local testing (`MOCK: '1'` in `config.js`) |
| `apps-script/Code.gs` | The backend — paste into a Google Apps Script bound to the election Sheet |
| `data/user_list_10_23_2026_members.csv` | Member export (type = member) from the membership system |
| `data/voters-2026-10-23.csv` | Same members in the `Voters` tab format — paste into the Sheet |
| `data/candidates-template.csv` | Column layout for the `Candidates` tab |

## One-time setup (≈20 minutes)

### 1. Create the Google Sheet + backend
1. Create a new Google Sheet (e.g. "Uttoron Election 2027"). The account that owns it
   should be the Secretary's / Election Officer's.
2. **Extensions → Apps Script.** Delete the sample code, paste in `apps-script/Code.gs`, save.
3. In the editor, pick the function **`setup`** and click **Run**. Approve the permissions.
   This creates the tabs `Config`, `Admins`, `Voters`, `Candidates`, `Votes`, `Log`
   and adds you as the first admin (password printed in the execution log and
   visible in the `Admins` tab).
4. **Admins tab** — one row per person who may open/close voting:
   `email | name | password`. Each admin signs in separately on `admin.html`;
   every open/close/code action is logged with their email in the `Log` tab.
   Admin sessions last 6 hours.
5. **Deploy → New deployment → type: Web app.**
   *Execute as:* **Me**. *Who has access:* **Anyone**. Click Deploy and copy the **Web app URL**
   (ends in `/exec`).

### 2. Point the site at the backend
Edit `config.js`:
```js
API_URL: 'https://script.google.com/macros/s/AKfycb.../exec',
MOCK: '',
```

### 3. Publish on GitHub Pages
1. Push this repo to GitHub.
2. **Settings → Pages → Source: Deploy from a branch → `main` / root.**
3. The site is live at `https://<user>.github.io/uttoron-gbm/` (voters) and
   `https://<user>.github.io/uttoron-gbm/admin.html` (Election Officer).

> GitHub Pages on a **private** repo needs GitHub Pro/Team. If the repo is public, do **not**
> commit member data — see "Privacy" below.

## Before the GBM

1. **Voters tab** — paste `data/voters-2026-10-23.csv` (or export a fresh one). Columns:
   `email | name | membership | code | voted_at | receipt`. One row per voting email.
   Per the by-laws only members in good standing ≥30 days before the election vote, so
   pull the list no earlier than that cutoff.
2. **Candidates tab** — one row per nominee: `id | name | note | active`.
   `id` can be anything unique (`c1`, `c2`…); `note` is optional (e.g. "Incumbent");
   set `active` to `FALSE` to hide a withdrawn nominee without deleting the row.
3. **Config tab** — set `seats` (X), `election_name`, and leave `voting_open` = `false`.
4. Open `admin.html`, sign in with your admin email + password, click **Generate missing codes**.
5. **Send codes.** Click **Download codes CSV** and send via a Gmail/Sheets mail merge
   (recommended for 300+ members), or click **Email codes via script**
   (uses the Sheet owner's Gmail quota: ~100/day personal, ~1,500/day Workspace).

## On election day (the 15-minute window)

1. Election Officer opens `admin.html`, signs in with their own email + password.
2. Put the voter URL on the screen / in Zoom chat. Members can open it early — they'll
   see "Voting has not opened yet" and the page refreshes itself.
3. Click **Open voting**. Announce the window.
4. Watch *ballots cast* climb. Click **Close voting** at the end of the window.
   Every voter who is on the ballot sees a full-screen **10 → 1 countdown** with a
   "Submit my ballot now" button; ballots submitted before zero count. After zero the
   backend rejects submissions and voters see "Voting has closed".
   (The server grace is 15 s — `close_countdown_sec` in `Config` — so a voter whose
   page polls late still gets the full 10-second count.)
5. Top X rows are highlighted as elected. A yellow **tie at the cutoff** banner appears if
   the last seat is tied — the Election Officer resolves it (by-laws).
6. Click **Download results CSV** / **Print** for the minutes. The `Votes` tab holds every
   ballot (timestamp, email, choices, receipt) and `Log` holds failed attempts.

## Rules enforced by the backend
- Email must be in `Voters` and the code must match (case-insensitive).
- One ballot per email — a second submission is rejected and shows the original receipt.
- At most `seats` choices, all must be active candidate ids; at least one choice.
- Votes are accepted only while voting is open (and, after **Close**, only until the
  scheduled close time).
- Admin actions require a per-admin login (`Admins` tab) and are logged by email.
- Writes are serialized with a script lock so double-taps can't double-vote.

## Capacity
Apps Script comfortably handles ~1 vote/second sustained (1000 ballots in 15 min ≈ 1.1/s);
the candidate list is cached for 30 s so 1000 people loading the page at once doesn't
hammer the Sheet. Voters on the ballot screen poll a cache-only `status` endpoint every
5 s (that's how the closing countdown reaches them); it never touches the Sheet. If you expect a surge at "Open voting", tell members to load the page
and enter their code *before* the window opens — the ballot screen appears the moment
voting opens.

## Local testing
Set `MOCK: '1'` in `config.js` and open `index.html` in a browser. Test voter:
`test@example.com` / `ABC123` (and `spouse@example.com` / `XYZ789`).
Admin: `admin@example.com` / `admin`. Mock state is kept in the browser's localStorage so
you can open the admin and voter pages in two tabs and try the close countdown.
Set `MOCK: ''` before publishing.

## Privacy
`data/` contains member names and emails. Keep this repo **private**, or move `data/` out of
the repo (add `data/` to `.gitignore`) before making it public. The Sheet should be shared
only with the Election Officer and Secretary.

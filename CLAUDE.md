# Betsson 7x7 Fantasy — project notes for Claude

Single-file fantasy-football app (`sfl-fantasy-v2.html`) for a real
Lithuanian 7x7 amateur league, backed by Firebase (Auth/Firestore/Hosting/
Functions), deployed at `sfl-fantasy.web.app`. UI text is Lithuanian with
an EN toggle. The owner (eima.lotuzys@gmail.com) is the sole admin.

`functions/index.js` runs a scheduled scraper (Sat/Sun 06:00 Europe/Vilnius)
that re-syncs all 60 team rosters across divisions A-E from
vilniausfutbolas.lt into the `players` Firestore collection, which
`sfl-fantasy-v2.html` boots its player list from. **This resync will run
again once the new season starts and rosters change (transfers, new
players, retirements).** The rules below must keep holding after that —
none of them are static/hardcoded against today's specific names, so a
resync should not require re-implementing anything, only verifying the
result still looks right.

## Invariants that a player-roster resync must not break

These are already designed to be resync-safe — do not "fix" them into
something that special-cases specific player names or a specific season:

- **Ids are permanent.** Assigned once per division's reserved id block
  (A:1-999, B:1000-1499, C:1500-1999, D:2000-2499, E:2500-2999) at
  first-seen, never reassigned or reused, even if a player goes inactive.
  See `functions/index.js` header comment for the full reasoning
  (`meta/players` array-index mirror that `firestore.rules` depends on).
- **Price is computed once, at first-seen, and then frozen.** `calcPrice`
  is duplicated in both `functions/index.js` (server, source of truth for
  new players) and `sfl-fantasy-v2.html` (client, used for the static
  fallback list) — keep the two formulas byte-identical:
  `Math.round((2.5 + goals*posFactor + teamBonus) * 2) / 2`, where
  `posFactor = {G:.5, D:.3, M:.25, F:.2}` and `teamBonus` derives from the
  team's last-season win count (`HIST`). A resync never touches
  `goals`/`price` on an existing player doc — only `name`/`pos`/`team`/
  `division`/`active` get updated live. Price DOES change later through a
  completely separate, deliberate mechanism — see "Automatic price
  updates" below — a roster resync must still never touch it.
- **Division is always concrete**, never missing/null, on every player
  doc and on the `meta/players` mirror — `firestore.rules`' `squadLegal()`
  relies on that with no fallback.
- **Players are never deleted**, only marked `active:false` when they drop
  off a roster page. Deleting would break the array-index id lookup for
  everyone who already has that player in a saved squad.
- **Same-surname disambiguation on the pitch is dynamic, not a lookup
  table.** `pitchSurname(p, div)` in `sfl-fantasy-v2.html` recomputes, from
  the live `PLAYERS` array, which players in the same division share a
  surname and prefixes with just enough of the first name (1 letter,
  escalating to 2+ if initials collide too) to tell them apart — e.g.
  division B's Tomaš/Daniel/Pavel Gulbicki. Because it reads `PLAYERS` at
  render time, it automatically re-derives correctly after a resync brings
  in new names/collisions — never replace it with a precomputed/cached
  name map that would go stale.

## Client-side conventions established via bug reports — keep following them

- **Everything division-scoped must resolve the ACTUAL division of the
  data being shown, not the globally-active one.** `STATE.division` is
  only the viewer's own division. Several pages have their own read-only
  division filters (`STATS_DIVISION`, `TS_DIVISION`, `LB_DIVISION`) that
  can differ from it. `getDivisionDB(div)`, and the optional third `div`
  param on `kitSvg()`/`teamLogoImg()`, exist specifically so cross-division
  browsing (Statistika, Sezono rinktinė, Lyderiai, viewing another user's
  squad) shows the right kit colors/logos/fixtures/results instead of
  whatever division happens to be globally active.
- **Ownership %** denominator is the count of users who actually submitted
  a squad for that specific round — never `allUsers.length` (total
  registered).
- **Player list default sort**: round 1 sorts by price; round 2 onward
  sorts by season points-so-far, when the picker panel opens.
- **Lithuanian grammatical number agreement** — use the `ltForm(n, one,
  few, many)` helper for any new UI text that pairs a count with a
  Lithuanian noun (komanda/komandos/komandų, taškas/taškai/taškų, turas/
  turai/turų, etc). Rule: ends in 1 (not 11) → singular; ends in 2-9 (not
  12-19) → nominative plural; else → genitive plural. Do **not** apply it
  to: ordinal/label uses of a number (e.g. "5 turas" meaning "Round 5" —
  always singular regardless of n), numerals governed by a preposition
  like "po" (after) — different, genitive-only rule — or a table column
  header not tied to one specific number.
- **`#page-squad`'s mobile-only pitch CSS block is pixel-tuned and
  explicitly marked `DO NOT MODIFY`** in the source — restored verbatim
  from an approved commit after being accidentally altered once. Leave it
  alone; if the same mobile treatment needs to appear elsewhere, duplicate
  it under the other selector instead of touching this block.
- **30h post-deadline pick freeze.** Once a round's deadline passes,
  squad-picking for the next round stays closed league-wide for 30h
  (`PICK_FREEZE_MS` / `isPickingFrozen()` / `pickFreezeUntil()` in
  `sfl-fantasy-v2.html`, mirrored server-side by `pickWindowOpen()` in
  `firestore.rules` — keep both durations in sync) — this is the window
  the admin uses to update player prices/goals before the next round
  opens. It only ever gates picking/editing a squad (`isLocked()`,
  `isCurRoundFrozen()`); every other page (dashboard, stats, fixtures,
  other users' squads, history) stays fully viewable throughout. Round 0
  has no previous round to wait on and is never frozen.

## Automatic price updates — rules fixed by the league owner, do not alter

`recalcPricesForRound(div, round)` in `sfl-fantasy-v2.html` (button in the
Admin round panel, next to that round's match-entry forms) recomputes
every player's price in one division from that round's ownership % and
round points. These are business rules the owner set explicitly — treat
them as fixed unless the owner asks to change them, not as something to
"improve":

- **Rise** — both can apply, summed onto the price: ownership 30-49.99% →
  +0.5M, 50%+ → +1M; round points 15-24 → +0.5M, 25-34 → +1M, 35+ →
  +1.5M.
- **Fall** — one tier per ownership bracket; the stricter points cutoff
  always wins over the milder one (never both, never stacked): ownership
  20%+ and points <5 → -1M, else points <10 → -0.5M; ownership 5-19.99%
  and points <1 → -1M, else points <5 → -0.5M. Below 5% ownership: no
  fall regardless of points.
- **Rise and fall are independent and both apply the same round if
  triggered** (e.g. a widely-owned player having a bad round nets a rise
  from ownership against a fall from underperforming) — summed, not one
  overriding the other.
- **Floor**: price never drops below `PRICE_FLOOR` (3.0M) regardless of
  the computed total.
- **Ownership/points are per-round, division-scoped values** —
  `computeOwnershipMapForRound(div,round)` (submitted-squad-based, same
  denominator convention as everywhere else) and
  `computeAllPlayerRoundPts(round,STATE.DB,div)` (the player's own base
  score — goals/clean-sheets/MOTM/etc — never captain-doubled, since
  captaincy is a per-user choice, not a player property).
- **Idempotent by design via `priceBase`**: each player doc's
  `priceBase.{round}` map field freezes the price they had immediately
  BEFORE that round's adjustment, captured on the first run and never
  overwritten afterward. Every recompute (including a deliberate re-run
  after the admin fixes a wrongly-entered scorer) always applies the
  round's delta on top of that same frozen base, never on top of an
  already-adjusted price — re-running for the same round is always safe.
  Never "simplify" this into reading `price` directly as the base.
  `functions/index.js`'s roster-resync price-freeze invariant (above) and
  this mechanism are deliberately separate — a resync must never touch
  `priceBase` either.
- **Blocked until the round is fully entered**: `roundResultsComplete()`
  requires every match in the round to have a saved result before the
  button is even enabled — a partially-entered round would silently treat
  every not-yet-entered match's players as having scored 0, wrongly
  triggering the fall rules for players who simply haven't had their
  result typed in yet.
- Admin-triggered per division (not a scheduled background job) —
  matches this app's existing pattern of explicit, reviewable admin
  actions (`saveM()` for match results) rather than a silent write.

## Technical results (walkover matches) — rule fixed by the league owner, do not alter

SFL allows a match to not actually be played because one team is at fault
(no-show/forfeit). The site records this the same way it records a real
3-0 win: a saved match result with **hg/ag of 3:0 or 0:3 and zero listed
goal scorers**. That exact pattern — nothing else — is SFL's own signal
for a technical win/loss, not a genuinely-played 3-0 blowout. This is a
business rule the owner set explicitly; treat it as fixed unless the
owner asks to change it, not as something to "improve":

- **Detection is fully derived, never a stored flag.** `isTechResult(saved)`
  in `sfl-fantasy-v2.html` — `(hg===3&&ag===0 || hg===0&&ag===3) &&
  scorers.length===0` — computed fresh from the same `hg`/`ag`/`scorers`
  every match result already has. No migration was needed for the 3
  already-recorded round-1 matches that fit this pattern (see "Round 1
  test data" below) — they were picked up automatically once this rule
  shipped.
- **Scoring is flat and REPLACES the normal formula for that one match**,
  not additive on top of it: every player on the winning-by-forfeit team
  gets a flat `CONFIG.TECH_WIN_PTS` (+5), every player on the forfeiting
  team gets a flat `CONFIG.TECH_LOSS_PTS` (-2), for that specific match —
  no goals/clean-sheet/1-conceded/win-bonus/red-card/MOTM line items on
  top, since none of those genuinely happened. Only that one matchday is
  replaced — if a team's OTHER matchday in the same round was a normal
  result, that other match still scores normally and both contributions
  sum into the round total as usual.
- **Team standings (W/D/L/goals/points/clean-sheets) are NOT touched by
  this rule** — `saveM()` still records the 3:0/0:3 as a normal result in
  the standings table; only the FANTASY POINTS layer treats it specially.
  The owner has not asked for the standings table itself to distinguish
  a technical result from a genuine one.
- **Must be visibly labeled everywhere the match/points appear** — not
  just computed silently, using two distinct icon vocabularies (owner's
  explicit choice — do not swap them):
  - **Per-player win/loss line** (`matchStatRowsHtml()`, shared by every
    per-match points display): a single line item — green "+" circle +
    "Tech. pergalė +5" for the winning side, red "×" circle + "Tech.
    pralaimėjimas -2" for the forfeiting side (CSS `.tech-ico.win`/
    `.tech-ico.loss`, i18n keys `mstat_tech_win`/`mstat_tech_loss`) —
    instead of the normal goal/CS/win/loss rows. Deliberately NOT the
    same icon for both sides — the color/glyph itself has to say who won
    without reading the text.
  - **Match-level marker** (doesn't belong to one side — shown once per
    match, not per player): a small black "!" badge (`techMarkHtml()`,
    CSS `.tech-mark`) — used on that match's header row in the points-
    history breakdown, next to the Fixtures score chip, and in the Admin
    round panel's match header, so the admin can immediately tell a 3:0
    entry will be scored as a walkover. Neutral on purpose since a single
    match-level flag can't itself say who won.
- **Implemented identically in all three scoring engines** so they can
  never disagree: `computeScoring()` (per-user squad, round + season
  totals), `computePlayerMatchBreakdown()` (single player's per-match
  expand), `computeAllPlayerRoundPts()` (Statistika/Leaders/price-recalc's
  all-players-in-division pass). All three call the same `isTechResult()`
  helper — never duplicate the 3:0/0:3-and-no-scorers check inline.

## Real match-results scraping — confirmed site facts, not yet built

The owner's plan (not yet implemented): stop hand-entering match results
in the Admin panel and instead scrape them from vilniausfutbolas.lt, the
same way rosters already are — the admin panel stays as the fallback/
correction UI, but the scraped data becomes the source of truth the
moment every match in a round has been scraped. Investigated this
directly (via a temporary `onSchedule` probe function, fired on-demand
through the Cloud Scheduler API's `jobs.run` since this dev sandbox's own
egress policy blocks `*.cloudfunctions.net`/`*.run.app`/vilniausfutbolas.lt
directly but allows `*.googleapis.com` control-plane APIs including
Firestore and Cloud Scheduler — reuse that same probing technique if
investigating this site again from a similarly-restricted session).
Confirmed facts, so this doesn't need re-discovering:

- **Results-list page shows EVERY division's matches together on one
  page, regardless of `comp_id`**: `http://www.vilniausfutbolas.lt/
  rezultatai/3?comp_id={id}` — confirmed by re-fetching with comp_id
  5/6/7/35/40 and getting byte-identical output every time. `comp_id`
  does NOT filter by division the way it was first assumed to (ignore
  the earlier "A=5, B=6, C=7, D=35, E=40" mapping as a filter — those
  numbers don't do anything here); one fetch (any comp_id) returns all
  660 rows, and division comes from each row's own `Turnyras` cell text
  (`"7x7 Lyga A grupė"` etc.) — group by that instead. Table columns
  `Nr. | Data | Laikas | Turas | Turnyras | Rungtynės | Stadionas` — the
  `Rungtynės` cell does NOT contain the score as plain text (an earlier
  note here was wrong): it's a single `<a>` to the HOME team's own
  `/komanda/` page, home-team text only. The match's own detail-page link
  (`/varzybos/...`) is a DIFFERENT anchor elsewhere in the same `<tr>` —
  select it explicitly (`tr a[href*="/varzybos/"]`), don't assume the
  first `<a>` in the row. `Turas` gives the site's own round number per
  match — confirmed NOT 1:1 with this app's "Fantasy Turas": a division's
  132 archived rows split into exactly 11 `Turas` values × 12 matches
  each (i.e. one site `Turas` already IS one fantasy round's worth, 2
  real match-days bundled together) — but a fresh season's round-1
  fixtures are NOT guaranteed to land under `Turas=1`; match by team-pair
  instead of trusting `Turas`, at least until proven otherwise on a real
  new-season scrape.
- **As of 2026-08-25 ~14:30 EEST (shortly after round 1's own 13:30
  deadline), zero round-1 matches were posted yet** — the results list's
  newest rows were still last season's finale (2026-03-01). The owner
  then deliberately re-tested round 1 with fixture pairings that reuse
  real historical (winter 2025) results, purely to exercise the deadline/
  freeze mechanics without waiting for real matches — see "Round 1 test
  data" below. Re-check the live site before assuming there's nothing to
  scrape for a genuinely new round; the "nothing posted yet" state above
  was a point-in-time check, not a site limitation.
- **Each match has its own detail page**:
  `http://www.vilniausfutbolas.lt/varzybos/{TeamA}-{TeamB}/{matchId}` —
  team names in this URL slug can differ from both the roster-scraper's
  `/komanda/` slug AND the canon name used elsewhere in this app (e.g.
  canon `Ketera`/`Grija`/`Navigatoriai` appear here as `FK-Ketera-`/
  `FK-Grija`/`FK-Navigatoriai`; canon `Del. Euforija` as
  `Delamode-Euforija-`; canon `Gladiatoriai` as `Gladiatoriu-Imperija`;
  canon `FM Vytis` as `FM-Vilniaus-Vytis`) — don't reconstruct this slug
  from canon names, resolve matches by team-pair search instead (see
  "Round 1 test data" below for the working normalize+substring approach
  that handled every one of these).
  - **Score**: reliably in `#match-info h1` as `"HG - AG"` — this is the
    ONLY safe place to read it; a whole-page regex for `" N - N "` risks
    matching the standings table or head-to-head history sections
    instead. `#match-info` also has the two team names/crests either
    side, in home-away order matching the URL slug.
  - **Goal scorers**: each goal is one `.statistic-event` row INSIDE
    `.goals` specifically — `.statistic-event` is also reused, confusingly,
    by an unrelated lineup/roster section further down the same page
    (player headshot thumbnails, not a `goal.png` icon), so scope the
    selector to `.goals .statistic-event` or that section's players get
    miscounted as scorers. Each row has two possible `.goalscorer` divs
    (only one is ever populated) containing the scorer's
    `/zaidejas/{Name}/{extId}/3/35` link plus a sibling `<p>` with a team
    label. That team label is occasionally wrong/typo'd on the site's own
    data for a given match (seen once: "FK Tera" instead of the real team
    name) — don't rely on it for correctness. What DOES always check out:
    summing every scorer's goal count across the whole match equals
    `hg + ag` exactly (verified on 57/60 real matches). A handful of
    matches (3/60 in the same verification) have a score but NO `.goals`
    section at all — **this is NOT a scraper gap or a missing-data bug.**
    All 3 were a 3:0/0:3 scoreline with zero scorers, which is the real
    SFL walkover/technical-result convention — see "Technical results
    (walkover matches)" below. Detect it the same way live: 3:0 or 0:3 +
    empty scorers list = technical result, not "no breakdown available".
  - **Red cards**: still not confirmed — 0 occurred across the 60 real
    matches checked. The scraper's event loop already inspects every
    `.goals .statistic-event`'s icon filename generically (not hardcoded
    to `goal.png`), so a card icon will surface distinctly once a real
    example exists — check what filename it uses then, don't guess now.
- **MOTM is not marked on the site yet** (checked one real finished match,
  found nothing) — the owner confirmed it isn't in use yet either; expect
  it to start appearing once real matches are actually played and design
  the scraper to read it once an example exists, not before.

Decisions the owner has already made for when this gets built:
- Once every match in a round is scraped, `recalcPricesForRound` must
  fire **automatically** — no longer an admin-clicked-only button. The
  button can stay as a manual override/re-run, but the primary trigger
  becomes scrape-completion, ported server-side (Cloud Function, Admin
  SDK — a client-only trigger can't fire itself unattended).
- If the admin corrects a scraped result after prices were already
  recalculated for that round, the correction must **immediately
  re-trigger** the price recalculation again (safe already, since
  `priceBase` makes it idempotent) — not wait for a manual re-click.

### Round 1 test data — deliberately real historical results, not live scraping

Round 1's actual deadline (2026-08-25 13:30 EEST) passed with nothing new
posted on the results site yet, so the owner deliberately built round 1's
fixture pairings (`FR`/`FR_B..E` round index 0 in `sfl-fantasy-v2.html`)
to reuse real historical (winter 2025 season) team match-ups purely to
exercise the deadline/freeze mechanics end-to-end without waiting for
real matches. All 60 of those matches (12 per division × 5) were then
found in the results archive by team-pair (ignoring date/`Turas`, per the
owner's instruction), their real historical score/scorers scraped from
each match's detail page as described above, and written directly into
`league/state{,_B,_C,_D,_E}` — both `DB.0` (scores + scorers, matching
`saveM()`'s exact schema `{hg,ag,scorers:[{pid,cnt}],reds:[],motm:null}`)
and `teams` (the standings table, updated with the exact same win/draw/
loss/goals-for/against/clean-sheet accounting `saveM()` itself applies)
were kept in sync, plus `savedMatches` populated with all 12 `"0-{day}-
{match}"` keys per division — this is a REAL admin-panel-equivalent
write, not a placeholder. Two goals (one each in division A and E) came
from scorers no longer in the current roster (transferred out since
winter 2025) and were left off the scorer list — the goal still counts
in `hg`/`ag`, it just doesn't credit fantasy points to anyone. No red
cards occurred in any of the 60 matches. **3 of the 60 matches — B
division day 1 Mostiškės-Tonitra 3:0 Riešė, B division day 2 Riešė 0:3
Insola, D division day 2 Olandai 3:0 Vėtra — have a 3:0/0:3 score with
zero scorers on the source site.** These are real SFL technical results
(walkover matches, see "Technical results" above), not a scraping gap —
`isTechResult()` picks them up automatically (+5 flat to every
Mostiškės-Tonitra/Insola/Olandai player, -2 flat to every Riešė/Riešė/
Vėtra player, in place of normal per-goal scoring for that matchday), no
data migration was needed. This is a one-time, deliberate substitution
for round 1 only — round 2 onward should get real scraped (or
admin-entered) results once actual new-season matches are played; don't
repeat the "reuse old results" approach for later rounds without being
asked.

## Operating conventions for this repo

- Single source file: `sfl-fantasy-v2.html`. Verify JS syntax (extract
  `<script>` blocks, `new Function()`) before every commit.
- Deploy to LIVE production immediately after each verified change — no
  preview-first step — via `firebase-tools@13 deploy --only hosting[,
  firestore:rules]`.
- Never push to a branch other than the one the task specifies.
- Never commit secrets (Firebase tokens, OAuth refresh tokens) into this
  repo.

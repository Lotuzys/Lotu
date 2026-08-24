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
- **36h post-deadline pick freeze.** Once a round's deadline passes,
  squad-picking for the next round stays closed league-wide for 36h
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
  +0.5M, 50%+ → +1M; round points 15-24 → +0.5M, 25+ → +1M.
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

## Operating conventions for this repo

- Single source file: `sfl-fantasy-v2.html`. Verify JS syntax (extract
  `<script>` blocks, `new Function()`) before every commit.
- Deploy to LIVE production immediately after each verified change — no
  preview-first step — via `firebase-tools@13 deploy --only hosting[,
  firestore:rules]`.
- Never push to a branch other than the one the task specifies.
- Never commit secrets (Firebase tokens, OAuth refresh tokens) into this
  repo.

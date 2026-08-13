/**
 * Betsson 7x7 Fantasy — automated player roster sync.
 *
 * Every 12h (and on-demand via an admin-only HTTPS endpoint), this fetches
 * all 60 team pages across all 5 divisions (A-E) from vilniausfutbolas.lt,
 * parses each team's roster table, and upserts the results into the
 * `players` Firestore collection that the app boots its PLAYERS list from.
 *
 * Design constraints (do not change without re-reading firestore.rules):
 *  - Every player doc gets a stable `id` the moment it is first seen, drawn
 *    from its DIVISION's reserved id block (see BLOCK_START below) and
 *    NEVER reassigned or reused — firestore.rules resolves players by array
 *    index (idx[id-1]) against the `meta/players` mirror doc this file
 *    rebuilds. A shifted or reused id would silently invalidate saved
 *    squads / rules validation for everyone in that division. The block
 *    scheme (A:1-999, B:1000-1499, C:1500-1999, D:2000-2499, E:2500-2999)
 *    matches what sfl-fantasy-v2.html already hardcodes for its static
 *    B-E placeholder data — keep them in sync if either side ever changes.
 *  - Every player doc/index entry always carries a concrete `division`
 *    field — never omit it. firestore.rules' squadLegal() compares it
 *    directly with no missing-field fallback: an earlier version of that
 *    fallback (tried as a ternary, then a boolean-OR null check, then a
 *    retry) blew Firestore's 1000-expression rule budget once combined
 *    with the 7x-per-squad-write call pattern in slotValid(). Don't
 *    reintroduce a missing/null division anywhere in this pipeline.
 *  - `goals` / `price` are last-season figures used only for the initial
 *    price calculation (calcPrice mirrors the client's formula exactly).
 *    They are written ONCE, at first-seen, and never touched again by a
 *    resync — live in-season scoring is tracked separately by the app via
 *    admin-entered match results (currentSeasonGoals()), not by this figure.
 *  - Players are never deleted from Firestore, only marked `active:false`
 *    when they drop off a team's roster page (retired/transferred out).
 *    Deleting would leave a gap in the id sequence and break the
 *    array-index lookup for anyone who already has them in a saved squad.
 */

const {onSchedule} = require('firebase-functions/v2/scheduler');
const {onRequest, onCall, HttpsError} = require('firebase-functions/v2/https');
const {setGlobalOptions} = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const cheerio = require('cheerio');

admin.initializeApp();
// 60 team-page fetches + ~1500 player upserts takes meaningfully longer
// than the 60s default — see runWithConcurrency() below for how the writes
// themselves are kept fast despite the volume.
setGlobalOptions({maxInstances: 2, region: 'europe-west1', timeoutSeconds: 540});

const db = admin.firestore();

// ─── All 60 teams across all 5 divisions (7x7-CUP, "7x7 Lyga A/B/C/D/E
// grupė") ──────────────────────────────────────────────────────────────
// url: the real site's team page (its "sudetis" roster tab lives on the
// same URL). canon: the app's canonical team name — must match
// TEAMS_KEYS/TEAMS_B/TEAMS_C/TEAMS_D/TEAMS_E in sfl-fantasy-v2.html
// exactly (division A's names are historically abbreviated — Š-VGTU-Vilkai,
// Del. Euforija, Gladiatoriai — the rest use the real site names verbatim).
const TEAMS = [
  // A
  {canon: 'Praliotas', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Praliotas/486/3/35'},
  {canon: 'El Dorado', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/El-Dorado/347/3/35'},
  {canon: 'Š-VGTU-Vilkai', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Sirvintos-VGTU-Vilkai/335/3/35'},
  {canon: 'Navigatoriai', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Navigatoriai/14/3/35'},
  {canon: 'Tornado', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Tornado/540/3/35'},
  {canon: 'Grija', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Grija/166/3/35'},
  {canon: 'VSG United', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/VSG-United/345/3/35'},
  {canon: 'Esperanza', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Esperanza/536/3/35'},
  {canon: 'FC Areonas', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/FC-Areonas/210/3/35'},
  {canon: 'Ketera', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Ketera/488/3/35'},
  {canon: 'Del. Euforija', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Delamode-Euforija/37/3/35'},
  {canon: 'Gladiatoriai', division: 'A', url: 'http://www.vilniausfutbolas.lt/komanda/Gladiatoriu-Imperija/524/3/35'},
  // B
  {canon: 'Insola', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Insola/535/3/35'},
  {canon: 'Mostiškės-Tonitra', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Mostiskes-Tonitra/273/3/35'},
  {canon: 'Joga Bonito', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Joga-Bonito/518/3/35'},
  {canon: 'AFK', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/AFK/30/3/35'},
  {canon: 'Citus Futboliukas', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Citus-Futboliukas/89/3/35'},
  {canon: 'Reaktyvas', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Reaktyvas/23/3/35'},
  {canon: 'Pinta', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Pinta/489/3/35'},
  {canon: 'Problema', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Problema/512/3/35'},
  {canon: 'Alytis', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Alytis/549/3/35'},
  {canon: 'Modulis', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Modulis/208/3/35'},
  {canon: 'Riešė', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Riese/506/3/35'},
  {canon: 'Pabradė', division: 'B', url: 'http://www.vilniausfutbolas.lt/komanda/Pabrade/42/3/35'},
  // C
  {canon: 'Maraksis', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Maraksis/485/3/35'},
  {canon: 'Skaidiškės', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Skaidiskes/209/3/35'},
  {canon: 'TEC', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/TEC/62/3/35'},
  {canon: 'Ozo tapyrai', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Ozo-tapyrai/18/3/35'},
  {canon: 'Ave.Ko.', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/AveKo/141/3/35'},
  {canon: 'Viesulas', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Viesulas/9/3/35'},
  {canon: 'Sviedinys', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Sviedinys/476/3/35'},
  {canon: 'Top Kickers', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Top-Kickers/390/3/35'},
  {canon: 'Navigatoriai Old Boys', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Navigatoriai-Old-Boys/432/3/35'},
  {canon: 'Geležinis Vilkas', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Gelezinis-Vilkas/200/3/35'},
  {canon: 'Utenos Utena', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Utenos-Utena/529/3/35'},
  {canon: 'Trivartis', division: 'C', url: 'http://www.vilniausfutbolas.lt/komanda/Trivartis/61/3/35'},
  // D
  {canon: 'MSC', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/MSC/541/3/35'},
  {canon: 'FM Vytis', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/FM-Vytis/409/3/35'},
  {canon: 'Inter Nemenčinė', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Inter-Nemencine/468/3/35'},
  {canon: 'Los Faveleros', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Los-Faveleros/528/3/35'},
  {canon: 'Šumskas', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Sumskas/544/3/35'},
  {canon: 'WorldOne United', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/WorldOne-United/407/3/35'},
  {canon: 'Vilnoja', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Vilnoja/521/3/35'},
  {canon: 'FK Balaganas', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/FK-Balaganas/538/3/35'},
  {canon: 'Malanka B', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Malanka-B/523/3/35'},
  {canon: 'Olandai', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Olandai/138/3/35'},
  {canon: 'Katastrofa', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Katastrofa/31/3/35'},
  {canon: 'Vėtra', division: 'D', url: 'http://www.vilniausfutbolas.lt/komanda/Vetra/283/3/35'},
  // E
  {canon: 'Maureen', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Maureen/551/3/35'},
  {canon: 'VRSK', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/VRSK/545/3/35'},
  {canon: 'Povetron', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Povetron/550/3/35'},
  {canon: 'Ave.Ko. Senjorai', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/AveKo-Senjorai/387/3/35'},
  {canon: 'Grakai', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Grakai/552/3/35'},
  {canon: 'Pažanga', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Pazanga/507/3/35'},
  {canon: 'Pietų IV', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Pietu-IV/7/3/35'},
  {canon: 'Citus Paupys', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Citus-Paupys/509/3/35'},
  {canon: 'Inter Vilnius', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Inter-Vilnius/522/3/35'},
  {canon: 'Western Union', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Western-Union/175/3/35'},
  {canon: 'Partizanas-GV', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Partizanas-GV/466/3/35'},
  {canon: 'Internacionalas', division: 'E', url: 'http://www.vilniausfutbolas.lt/komanda/Internacionalas/56/3/35'},
];

// Reserved id block per division — must match sfl-fantasy-v2.html's
// DIVISIONS-REGISTRY id-block comment exactly.
const BLOCK_START = {A: 1, B: 1000, C: 1500, D: 2000, E: 2500};

// Lithuanian roster-table position text -> app position code.
const POS_MAP = {
  'Vartininkas': 'G',
  'Gynėjas': 'D',
  'Saugas': 'M',
  'Puolėjas': 'F',
};

// Last-season win/loss/clean-sheet record per team, mirrors HIST_A..E in
// sfl-fantasy-v2.html. Static (finished season), used only by calcPrice —
// not re-scraped. Team names are unique across all 5 divisions, so these
// merge into one lookup with no collision risk.
const HIST = {
  // A
  'Praliotas': {w: 19, l: 3, cs: 8}, 'El Dorado': {w: 18, l: 3, cs: 7},
  'Š-VGTU-Vilkai': {w: 15, l: 5, cs: 5}, 'Navigatoriai': {w: 12, l: 8, cs: 4},
  'Tornado': {w: 11, l: 9, cs: 3}, 'Grija': {w: 11, l: 9, cs: 4},
  'VSG United': {w: 10, l: 11, cs: 2}, 'Esperanza': {w: 9, l: 13, cs: 2},
  'FC Areonas': {w: 7, l: 13, cs: 1}, 'Ketera': {w: 6, l: 12, cs: 1},
  'Del. Euforija': {w: 2, l: 18, cs: 0}, 'Gladiatoriai': {w: 2, l: 18, cs: 0},
  // B
  'Insola': {w: 18, l: 4, cs: 7}, 'Mostiškės-Tonitra': {w: 16, l: 6, cs: 6},
  'Joga Bonito': {w: 16, l: 6, cs: 6}, 'AFK': {w: 13, l: 9, cs: 5},
  'Citus Futboliukas': {w: 13, l: 9, cs: 5}, 'Reaktyvas': {w: 11, l: 11, cs: 4},
  'Pinta': {w: 10, l: 12, cs: 4}, 'Problema': {w: 9, l: 13, cs: 4},
  'Alytis': {w: 8, l: 14, cs: 3}, 'Modulis': {w: 6, l: 16, cs: 2},
  'Riešė': {w: 5, l: 17, cs: 2}, 'Pabradė': {w: 3, l: 19, cs: 1},
  // C
  'Maraksis': {w: 16, l: 6, cs: 6}, 'Skaidiškės': {w: 15, l: 7, cs: 6},
  'TEC': {w: 14, l: 8, cs: 6}, 'Ozo tapyrai': {w: 13, l: 9, cs: 5},
  'Ave.Ko.': {w: 13, l: 9, cs: 5}, 'Viesulas': {w: 11, l: 11, cs: 4},
  'Sviedinys': {w: 10, l: 12, cs: 4}, 'Top Kickers': {w: 10, l: 12, cs: 4},
  'Navigatoriai Old Boys': {w: 9, l: 13, cs: 4}, 'Geležinis Vilkas': {w: 8, l: 14, cs: 3},
  'Utenos Utena': {w: 7, l: 15, cs: 3}, 'Trivartis': {w: 1, l: 21, cs: 0},
  // D
  'MSC': {w: 20, l: 2, cs: 8}, 'FM Vytis': {w: 16, l: 6, cs: 6},
  'Inter Nemenčinė': {w: 15, l: 7, cs: 6}, 'Los Faveleros': {w: 15, l: 7, cs: 6},
  'Šumskas': {w: 12, l: 10, cs: 5}, 'WorldOne United': {w: 11, l: 11, cs: 4},
  'Vilnoja': {w: 9, l: 13, cs: 4}, 'FK Balaganas': {w: 8, l: 14, cs: 3},
  'Malanka B': {w: 8, l: 14, cs: 3}, 'Olandai': {w: 7, l: 15, cs: 3},
  'Katastrofa': {w: 6, l: 16, cs: 2}, 'Vėtra': {w: 0, l: 22, cs: 0},
  // E
  'Maureen': {w: 20, l: 2, cs: 8}, 'VRSK': {w: 17, l: 5, cs: 7},
  'Povetron': {w: 16, l: 6, cs: 6}, 'Ave.Ko. Senjorai': {w: 16, l: 6, cs: 6},
  'Grakai': {w: 12, l: 10, cs: 5}, 'Pažanga': {w: 11, l: 11, cs: 4},
  'Pietų IV': {w: 10, l: 12, cs: 4}, 'Citus Paupys': {w: 8, l: 14, cs: 3},
  'Inter Vilnius': {w: 5, l: 17, cs: 2}, 'Western Union': {w: 5, l: 17, cs: 2},
  'Partizanas-GV': {w: 4, l: 18, cs: 2}, 'Internacionalas': {w: 3, l: 19, cs: 1},
};

function calcPrice(g, pos, team) {
  const pf = {G: .5, D: .3, M: .25, F: .2};
  const hist = HIST[team] || {w: 0};
  const tb = Math.round(hist.w / 19 * 3 * 10) / 10;
  return Math.round((2.5 + g * pf[pos] + tb) * 2) / 2;
}

function normName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Run async tasks with bounded concurrency instead of one at a time or
 * all at once — keeps ~1500 sequential Firestore transactions from taking
 * minutes, without opening 1500 connections simultaneously either. */
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return results;
}

/** Parse one team's roster page HTML into a flat player list. */
function parseRoster(html, team) {
  const $ = cheerio.load(html);
  let $table = null;
  // Find the roster table robustly by its header text rather than by
  // class name alone (class names on this site have moved before).
  $('table').each((_, tbl) => {
    const headText = $(tbl).find('tr').first().text();
    if (headText.includes('Pozicija')) {
      $table = $(tbl);
      return false;
    }
  });
  if (!$table) {
    logger.warn(`No roster table found for ${team.canon} (${team.division})`);
    return [];
  }

  const out = [];
  $table.find('tr').slice(1).each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 8) return;
    const link = $(tds[1]).find('a').first();
    const href = link.attr('href') || '';
    const idMatch = href.match(/\/zaidejas\/[^/]+\/(\d+)\//);
    if (!idMatch) return;
    const extId = idMatch[1];
    const name = normName(link.text());
    const posText = normName($(tds[3]).text());
    const pos = POS_MAP[posText];
    if (!pos || !name) return;
    const goals = parseInt(normName($(tds[4]).text()), 10) || 0;
    out.push({extId, name, pos, team: team.canon, division: team.division, goals});
  });
  return out;
}

async function fetchTeamRoster(team) {
  const res = await fetch(team.url, {
    headers: {'User-Agent': 'Mozilla/5.0 (compatible; Betsson7x7FantasyBot/1.0)'},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${team.url}`);
  const html = await res.text();
  return parseRoster(html, team);
}

/** Assign the next stable id inside a division's reserved block, inside a
 * transaction. meta/playerIdCounter holds one field per division so each
 * division's counter is independent — a busy sync for one division never
 * contends with another's counter. */
async function nextPlayerId(tx, division) {
  const ref = db.doc('meta/playerIdCounter');
  const snap = await tx.get(ref);
  const counters = snap.exists ? snap.data() : {};
  const next = counters[division] || BLOCK_START[division];
  tx.set(ref, {[division]: next + 1}, {merge: true});
  return next;
}

/**
 * Rebuild the meta/players array mirror (used by firestore.rules) from the
 * players collection, spanning every division's reserved id block. Index i
 * (0-based) always holds the player whose id === i+1; gaps between one
 * division's real players and the next division's block start are left as
 * explicit nulls — firestore.rules' playerAt() treats a null slot as "not
 * a real player", failing that check closed, same as any other id that was
 * never assigned.
 */
async function rebuildPlayerIndex() {
  const snap = await db.collection('players').orderBy('id').get();
  const list = [];
  snap.forEach((doc) => {
    const p = doc.data();
    list[p.id - 1] = {pos: p.pos, team: p.team, price: p.price, division: p.division};
  });
  // Firestore arrays can't have trailing/leading holes serialize implicitly
  // as null the way a plain JS sparse array might be assumed to — fill any
  // gap explicitly so every index up to the highest assigned id is defined.
  for (let i = 0; i < list.length; i++) {
    if (list[i] === undefined) list[i] = null;
  }
  await db.doc('meta/players').set({list, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
}

async function syncPlayers() {
  const results = await Promise.allSettled(TEAMS.map(fetchTeamRoster));
  const scraped = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      scraped.push(...r.value);
    } else {
      logger.error(`Failed to fetch ${TEAMS[i].canon} (${TEAMS[i].division}): ${r.reason}`);
    }
  });

  if (scraped.length === 0) {
    logger.error('Sync aborted: zero players parsed from any team page (site down/changed?)');
    return {ok: false, reason: 'no-data-parsed'};
  }

  const seenExtIds = new Set();
  let created = 0, updated = 0, reactivated = 0;

  await runWithConcurrency(scraped, 15, async (p) => {
    seenExtIds.add(p.extId);
    const ref = db.doc(`players/${p.extId}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const id = await nextPlayerId(tx, p.division);
        const price = calcPrice(p.goals, p.pos, p.team);
        tx.set(ref, {
          id, extId: p.extId, name: p.name, pos: p.pos, team: p.team, division: p.division,
          goals: p.goals, price, active: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        created++;
      } else {
        const cur = snap.data();
        const patch = {updatedAt: admin.firestore.FieldValue.serverTimestamp()};
        if (cur.name !== p.name) patch.name = p.name;
        if (cur.pos !== p.pos) patch.pos = p.pos;
        if (cur.team !== p.team) patch.team = p.team;
        if (cur.division !== p.division) patch.division = p.division;
        if (!cur.active) { patch.active = true; reactivated++; }
        // goals/price intentionally left untouched — see file header.
        tx.set(ref, patch, {merge: true});
        updated++;
      }
    });
  });

  // Anyone previously active but not seen this run has left their roster page.
  const activeSnap = await db.collection('players').where('active', '==', true).get();
  const toDeactivate = activeSnap.docs.filter((doc) => !seenExtIds.has(doc.data().extId));
  await runWithConcurrency(toDeactivate, 15, async (doc) => {
    await doc.ref.set({active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
  });
  const deactivated = toDeactivate.length;

  await rebuildPlayerIndex();

  const byDivision = {};
  scraped.forEach((p) => { byDivision[p.division] = (byDivision[p.division] || 0) + 1; });

  const summary = {ok: true, scraped: scraped.length, byDivision, created, updated, reactivated, deactivated};
  logger.info('Player sync complete', summary);
  return summary;
}

// Scheduled: every 12 hours.
exports.syncPlayersScheduled = onSchedule('every 12 hours', async () => {
  await syncPlayers();
});

// Manual trigger for testing / forcing an immediate resync. Requires the
// same admin identity the app itself trusts (checked via Firebase Auth ID
// token, matching isAdmin() in firestore.rules).
exports.syncPlayersNow = onRequest(async (req, res) => {
  try {
    const authHeader = req.get('Authorization') || '';
    const m = authHeader.match(/^Bearer (.+)$/);
    if (!m) { res.status(401).json({error: 'missing bearer token'}); return; }
    const decoded = await admin.auth().verifyIdToken(m[1]);
    if (decoded.email !== 'eima.lotuzys@gmail.com') {
      res.status(403).json({error: 'not admin'});
      return;
    }
    const result = await syncPlayers();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    logger.error('syncPlayersNow failed', e);
    res.status(500).json({error: String(e)});
  }
});

// Auto-links a Facebook sign-in to an existing email/password account with
// the same email, instead of forcing the user to dig up a password for an
// account they're trying to reach via Facebook precisely because they
// don't want to. Firebase itself blocks signInWithPopup() from creating a
// second account on the same email (auth/account-exists-with-different-
// credential) — the client calls this with the Facebook access token from
// that failed attempt, and gets back a custom token for the EXISTING
// account's uid to sign in with instead.
//
// The Facebook access token is verified independently against Facebook's
// own Graph API here — never trust a client-supplied email/uid claim
// directly. A token that Facebook's own API confirms belongs to a real,
// current session tied to a verified email proves the caller controls
// that inbox, the same trust level a password-reset link relies on, which
// is what justifies skipping the existing account's password entirely.
exports.linkFacebookAccount = onCall(async (request) => {
  const accessToken = request.data && request.data.accessToken;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing Facebook access token');
  }
  let fbData;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/me?fields=email&access_token=${encodeURIComponent(accessToken)}`
    );
    fbData = await resp.json();
  } catch (e) {
    logger.error('linkFacebookAccount: Facebook Graph API unreachable', e);
    throw new HttpsError('unavailable', 'Could not reach Facebook');
  }
  if (!fbData || fbData.error || !fbData.email) {
    logger.warn('linkFacebookAccount: token did not resolve to a verified email', fbData && fbData.error);
    throw new HttpsError('unauthenticated', 'Could not verify Facebook account');
  }
  const email = String(fbData.email).toLowerCase();
  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch (e) {
    // Shouldn't normally happen — the client only calls this after Firebase
    // itself reported an existing account on this email — but a stale
    // client-side error object is possible if the account was deleted
    // between the two calls.
    throw new HttpsError('not-found', 'No existing account for this email');
  }
  const token = await admin.auth().createCustomToken(userRecord.uid);
  return {token};
});

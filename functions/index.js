/**
 * Betsson 7x7 Fantasy — automated player roster sync.
 *
 * Every 12h (and on-demand via an admin-only HTTPS endpoint), this fetches
 * the 12 division team pages from vilniausfutbolas.lt, parses each team's
 * roster table, and upserts the results into the `players` Firestore
 * collection that the app now boots its PLAYERS list from.
 *
 * Design constraints (do not change without re-reading firestore.rules):
 *  - Every player doc gets a stable, sequential, 1-based `id` the moment it
 *    is first seen. That id is NEVER reassigned or reused, because
 *    firestore.rules resolves players by array index (idx[id-1]) against
 *    the `meta/players` mirror doc that syncPlayerIndex() builds client-side.
 *    A shifted or reused id would silently invalidate saved squads / rules
 *    validation for everyone.
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
const {onRequest} = require('firebase-functions/v2/https');
const {setGlobalOptions} = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const cheerio = require('cheerio');

admin.initializeApp();
setGlobalOptions({maxInstances: 2, region: 'europe-west1'});

const db = admin.firestore();

// ─── Division 12 teams (7x7-CUP, A Divizionas / comp_id=3) ───────────────
// url: the real site's team page (its "sudetis" roster tab lives on the
// same URL). canon: the app's existing canonical short team name — kept
// unchanged so HIST/TEAM_LOGOS/TEAM_COLORS/fixture-schedule keys in the app
// don't need to move.
const TEAMS = [
  {canon: 'Praliotas', url: 'http://www.vilniausfutbolas.lt/komanda/Praliotas/486/3/35'},
  {canon: 'El Dorado', url: 'http://www.vilniausfutbolas.lt/komanda/El-Dorado/347/3/35'},
  {canon: 'Š-VGTU-Vilkai', url: 'http://www.vilniausfutbolas.lt/komanda/Sirvintos-VGTU-Vilkai/335/3/35'},
  {canon: 'Navigatoriai', url: 'http://www.vilniausfutbolas.lt/komanda/Navigatoriai/14/3/35'},
  {canon: 'Tornado', url: 'http://www.vilniausfutbolas.lt/komanda/Tornado/540/3/35'},
  {canon: 'Grija', url: 'http://www.vilniausfutbolas.lt/komanda/Grija/166/3/35'},
  {canon: 'VSG United', url: 'http://www.vilniausfutbolas.lt/komanda/VSG-United/345/3/35'},
  {canon: 'Esperanza', url: 'http://www.vilniausfutbolas.lt/komanda/Esperanza/536/3/35'},
  {canon: 'FC Areonas', url: 'http://www.vilniausfutbolas.lt/komanda/FC-Areonas/210/3/35'},
  {canon: 'Ketera', url: 'http://www.vilniausfutbolas.lt/komanda/Ketera/488/3/35'},
  {canon: 'Del. Euforija', url: 'http://www.vilniausfutbolas.lt/komanda/Delamode-Euforija/37/3/35'},
  {canon: 'Gladiatoriai', url: 'http://www.vilniausfutbolas.lt/komanda/Gladiatoriu-Imperija/524/3/35'},
];

// Lithuanian roster-table position text -> app position code.
const POS_MAP = {
  'Vartininkas': 'G',
  'Gynėjas': 'D',
  'Saugas': 'M',
  'Puolėjas': 'F',
};

// Last-season win/loss/clean-sheet record, mirrors HIST in sfl-fantasy-v2.html.
// Static (finished season), used only by calcPrice — not re-scraped.
const HIST = {
  'Praliotas': {w: 19, l: 3, cs: 8}, 'El Dorado': {w: 18, l: 3, cs: 7},
  'Š-VGTU-Vilkai': {w: 15, l: 5, cs: 5}, 'Navigatoriai': {w: 12, l: 8, cs: 4},
  'Tornado': {w: 11, l: 9, cs: 3}, 'Grija': {w: 11, l: 9, cs: 4},
  'VSG United': {w: 10, l: 11, cs: 2}, 'Esperanza': {w: 9, l: 13, cs: 2},
  'FC Areonas': {w: 7, l: 13, cs: 1}, 'Ketera': {w: 6, l: 12, cs: 1},
  'Del. Euforija': {w: 2, l: 18, cs: 0}, 'Gladiatoriai': {w: 2, l: 18, cs: 0},
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

/** Parse one team's roster page HTML into a flat player list. */
function parseRoster(html, canonTeam) {
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
    logger.warn(`No roster table found for ${canonTeam}`);
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
    out.push({extId, name, pos, team: canonTeam, goals});
  });
  return out;
}

async function fetchTeamRoster(team) {
  const res = await fetch(team.url, {
    headers: {'User-Agent': 'Mozilla/5.0 (compatible; Betsson7x7FantasyBot/1.0)'},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${team.url}`);
  const html = await res.text();
  return parseRoster(html, team.canon);
}

/** Assign the next stable sequential id inside a transaction. */
async function nextPlayerId(tx) {
  const ref = db.doc('meta/playerIdCounter');
  const snap = await tx.get(ref);
  const next = snap.exists ? (snap.data().next || 1) : 1;
  tx.set(ref, {next: next + 1}, {merge: true});
  return next;
}

/**
 * Rebuild the meta/players array mirror (used by firestore.rules) from the
 * players collection. Index i (0-based) must always hold the player whose
 * id === i+1, so gaps are impossible as long as ids are only ever assigned
 * sequentially and never reused — see nextPlayerId().
 */
async function rebuildPlayerIndex() {
  const snap = await db.collection('players').orderBy('id').get();
  const list = [];
  snap.forEach((doc) => {
    const p = doc.data();
    list[p.id - 1] = {pos: p.pos, team: p.team, price: p.price};
  });
  await db.doc('meta/players').set({list, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
}

async function syncPlayers() {
  const results = await Promise.allSettled(TEAMS.map(fetchTeamRoster));
  const scraped = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      scraped.push(...r.value);
    } else {
      logger.error(`Failed to fetch ${TEAMS[i].canon}: ${r.reason}`);
    }
  });

  if (scraped.length === 0) {
    logger.error('Sync aborted: zero players parsed from any team page (site down/changed?)');
    return {ok: false, reason: 'no-data-parsed'};
  }

  const seenExtIds = new Set();
  let created = 0, updated = 0, reactivated = 0;

  for (const p of scraped) {
    seenExtIds.add(p.extId);
    const ref = db.doc(`players/${p.extId}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const id = await nextPlayerId(tx);
        const price = calcPrice(p.goals, p.pos, p.team);
        tx.set(ref, {
          id, extId: p.extId, name: p.name, pos: p.pos, team: p.team,
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
        if (!cur.active) { patch.active = true; reactivated++; }
        // goals/price intentionally left untouched — see file header.
        tx.set(ref, patch, {merge: true});
        updated++;
      }
    });
  }

  // Anyone previously active but not seen this run has left their roster page.
  const activeSnap = await db.collection('players').where('active', '==', true).get();
  let deactivated = 0;
  for (const doc of activeSnap.docs) {
    const extId = doc.data().extId;
    if (!seenExtIds.has(extId)) {
      await doc.ref.set({active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      deactivated++;
    }
  }

  await rebuildPlayerIndex();

  const summary = {ok: true, scraped: scraped.length, created, updated, reactivated, deactivated};
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

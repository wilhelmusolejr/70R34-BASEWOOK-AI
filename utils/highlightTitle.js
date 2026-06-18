/**
 * highlightTitle — random pool of short titles for a profile "Highlights"
 * (featured collection). Mirrors the avatar-description pool pattern
 * (utils/generateAvatarDescription.js): a country-aware set of curated strings,
 * picked uniformly at random.
 *
 * Output shapes (see pickHighlightTitle):
 *   - 20% → emoji-only (two distinct emojis, e.g. "✨🎉")
 *   - 80% → text, with ~50% chance of a single trailing emoji
 *           (e.g. "Memories" / "Memories ✨")
 *
 * All entries are <= 18 characters — FB's title input is maxlength="18".
 */

const TITLES_EN = [
  'Memories',
  'Travel',
  'Life',
  'Friends',
  'Family',
  'Moments',
  'Adventures',
  'Good Times',
  'Vibes',
  'Favorites',
  'Throwback',
  'Weekend',
  'Summer',
  'Days Out',
  'Happy',
  'My World',
  'Everyday',
  'Smiles',
  'Highlights',
  'Best Days',
  // more text
  'Good Vibes',
  'My People',
  'Loved Ones',
  'Sunsets',
  'Road Trips',
  'Beach Days',
  'Night Out',
  'Coffee Time',
  'Little Things',
  'Out & About',
  'City Life',
  'Lazy Days',
  'Golden Days',
  'Celebrations',
  'Cozy Days',
  'Wanderlust',
  'Snapshots',
  'Good Days',
  'Foodie',
  'Festivities',
];

const TITLES_IT = [
  'Ricordi',
  'Viaggi',
  'Vita',
  'Amici',
  'Famiglia',
  'Momenti',
  'Avventure',
  'Bei momenti',
  'Vibes',
  'Preferiti',
  'Ricordi belli',
  'Weekend',
  'Estate',
  'Giornate',
  'Felicità',
  'Il mio mondo',
  'Sorrisi',
  'Ogni giorno',
  'Relax',
  'Bei giorni',
  // more text
  'Buone vibes',
  'La mia gente',
  'Cari amici',
  'Tramonti',
  'Mare',
  'Serate',
  'In giro',
  'Caffè',
  'Le piccole cose',
  'Vita di città',
  'Giorni pigri',
  'Giorni belli',
  'Feste',
  'Celebrazioni',
  'Istantanee',
  'Buon cibo',
  'Dolce vita',
  'Spensierati',
  'Giorni d’oro',
  'Voglia di mare',
];

// Emoji pool. FB's title input is maxlength="18" and counts UTF-16 code units,
// so an emoji costs 1-2 of those — the fit checks below account for that.
const EMOJIS = ['✨', '🎉', '🌸', '😊', '🔥', '💫', '🌟', '📸', '💛', '🌿'];

const MAX_LEN = 18; // FB title input maxlength (UTF-16 code units)

// Loose country normalization (same loose forms the rest of the codebase accepts).
function normCountry(c) {
  const s = String(c || '')
    .trim()
    .toLowerCase();
  if (['it', 'ita', 'italy', 'italia'].includes(s)) return 'IT';
  return 'US';
}

/**
 * Clamp a string to <= MAX_LEN UTF-16 code units (FB's maxlength semantics)
 * without leaving a dangling high surrogate (which would render as a tofu box).
 * @param {string} s
 * @returns {string}
 */
function clampTitle(s, max = MAX_LEN) {
  let out = String(s || '');
  if (out.length <= max) return out;
  out = out.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // drop lone high surrogate
  return out;
}

// Two DISTINCT random emojis, concatenated (e.g. "✨🎉"). Well within MAX_LEN.
function twoEmojis() {
  const a = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  let b = a;
  for (let i = 0; i < 10 && b === a; i++) {
    b = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  }
  return `${a}${b}`;
}

/**
 * Pick a random highlight title for the given country.
 *
 * Distribution:
 *   - `emojiOnlyChance` (default 0.20) → emoji-only: two distinct emojis ("✨🎉")
 *   - otherwise (default 0.80)         → text, with `emojiChance` (default 0.50)
 *                                        of a single trailing emoji ("Vibes ✨")
 *
 * Always <= 18 UTF-16 code units (a trailing emoji is dropped if it wouldn't fit).
 *
 * @param {string} country
 * @param {{ emojiChance?: number, emojiOnlyChance?: number }} [opts]
 * @returns {string}
 */
function pickHighlightTitle(country = '', { emojiChance = 0.5, emojiOnlyChance = 0.2 } = {}) {
  // 20%: emoji-only.
  if (Math.random() < emojiOnlyChance) return twoEmojis();

  // 80%: text (+ ~50% trailing emoji).
  const pool = normCountry(country) === 'IT' ? TITLES_IT : TITLES_EN;
  const base = pool[Math.floor(Math.random() * pool.length)];

  if (Math.random() < emojiChance) {
    const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    const candidate = `${base} ${emoji}`;
    if (candidate.length <= MAX_LEN) return candidate;
  }
  return clampTitle(base);
}

module.exports = { pickHighlightTitle, clampTitle, twoEmojis, EMOJIS, TITLES_EN, TITLES_IT };

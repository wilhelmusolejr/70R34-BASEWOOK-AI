/**
 * generateAvatarDescription — short caption for a profile-picture update post.
 * Primary path: GitHub Models API in the persona's POV (user.identityPrompt).
 * Fallback: random pick — first a category, then a random entry within that
 * category. Pool and language are chosen by country (IT → Italian, default English).
 * Light emoji sprinkle (~40% chance, one symbol) on both paths.
 *
 * Always returns a non-empty string — caller can type directly.
 *
 * Env vars (shared with generateMessage.js):
 *   GITHUB_MODELS_TOKEN, GITHUB_MODELS_MODEL, GITHUB_MODELS_BASE_URL, GITHUB_MODELS_API_VERSION
 */

require('dotenv').config();

const DESCRIPTION_POOLS_EN = {
  bible_verses: [
    'For I know the plans I have for you, declares the Lord. (Jeremiah 29:11)',
    'The Lord is my shepherd, I lack nothing. (Psalm 23:1)',
    'I can do all things through Christ who strengthens me. (Philippians 4:13)',
    'Trust in the Lord with all your heart. (Proverbs 3:5)',
    'Be strong and courageous. Do not be afraid. (Joshua 1:9)',
    'This is the day the Lord has made; let us rejoice. (Psalm 118:24)',
    'Cast all your anxiety on him because he cares for you. (1 Peter 5:7)',
    'The Lord is my light and my salvation, whom shall I fear. (Psalm 27:1)',
    'Love is patient, love is kind. (1 Corinthians 13:4)',
    'Let everything that has breath praise the Lord. (Psalm 150:6)',
    'Be still, and know that I am God. (Psalm 46:10)',
    'Weeping may stay for the night, but rejoicing comes in the morning. (Psalm 30:5)',
    'The joy of the Lord is your strength. (Nehemiah 8:10)',
    'Walk by faith, not by sight. (2 Corinthians 5:7)',
    'Do everything in love. (1 Corinthians 16:14)',
    'His mercies are new every morning. (Lamentations 3:22-23)',
    'Rejoice in the Lord always. (Philippians 4:4)',
    'The Lord will fight for you; you need only to be still. (Exodus 14:14)',
    'Give thanks to the Lord, for he is good. (Psalm 107:1)',
    'My grace is sufficient for you. (2 Corinthians 12:9)',
  ],

  inspirational_quotes: [
    'Be yourself; everyone else is already taken.',
    'The only way to do great work is to love what you do.',
    'Life is what happens when you are busy making other plans.',
    'In the middle of every difficulty lies opportunity.',
    'Act as if what you do makes a difference. It does.',
    'The best time to plant a tree was 20 years ago. The second best is now.',
    'Do what you can, with what you have, where you are.',
    'Whatever you are, be a good one.',
    'Happiness depends upon ourselves.',
    'Turn your wounds into wisdom.',
    'Keep your face always toward the sunshine.',
    'The journey of a thousand miles begins with one step.',
    'You are never too old to set another goal or dream a new dream.',
    'Do not count the days, make the days count.',
    'Simplicity is the ultimate sophistication.',
    'Nothing will work unless you do.',
    'Well done is better than well said.',
    'The future depends on what you do today.',
    'Go confidently in the direction of your dreams.',
    'Stay hungry, stay foolish.',
  ],

  gratitude: [
    'Grateful for another beautiful day.',
    'Counting blessings, not burdens.',
    'Thankful for the little things today.',
    'So much to be grateful for this season.',
    'Finding joy in the ordinary.',
    'A heart full of gratitude is a heart full of peace.',
    'Grateful beyond words for this life.',
    'Small joys, big gratitude.',
    'Thankful heart, happy life.',
    'Blessed and grateful, always.',
    'Today, I choose gratitude.',
    'So many reasons to smile today.',
    'My heart is full this morning.',
    'Every day is a gift worth unwrapping.',
    'Grateful for the people in my life.',
    'Thankful for this moment right here.',
    'Little moments, big blessings.',
    'Counting my blessings one by one.',
    'Gratitude turns what we have into enough.',
    'A thankful heart is a happy heart.',
  ],

  life_mottos: [
    'Good vibes only.',
    'Just me, being me.',
    'Living, laughing, loving.',
    'Keep going, keep growing.',
    'Be the good you want to see.',
    'One day at a time.',
    'Making memories, not excuses.',
    'Stay humble, hustle kind.',
    'Progress, not perfection.',
    'Be kind to yourself today.',
    'Chasing sunsets and simple dreams.',
    'Soft heart, strong spine.',
    'Choose joy every day.',
    'Keep it simple, keep it real.',
    'Live more, worry less.',
    'Wake up, show up, shine on.',
    'Life is better when you laugh.',
    'Be where your feet are.',
    'Breathe in, breathe out, carry on.',
    'Small steps, big dreams.',
  ],

  blessings: [
    'Blessed beyond measure.',
    'Faith over fear, always.',
    'Favor follows those who trust.',
    'Every sunrise is a gift from above.',
    'His plans are better than mine.',
    'Standing on promises, walking in faith.',
    'Grace carries me through every day.',
    'Highly favored and deeply loved.',
    'Prayers whispered, faith rising.',
    'His love never fails.',
    'Trusting every step of this journey.',
    'Blessed with peace that passes understanding.',
    'Thanking God for another day.',
    'Worship in the waiting.',
    'Still standing, still believing.',
    'Small seeds of faith, big harvests of hope.',
    'He is faithful, even when I am weak.',
    'Blessings on blessings, big and small.',
    'Living loved, living whole.',
    'Faith makes all things possible.',
  ],
};

const DESCRIPTION_POOLS_IT = {
  citazioni_bibliche: [
    'Io conosco i progetti che ho per voi, dice il Signore. (Geremia 29:11)',
    'Il Signore è il mio pastore, non manco di nulla. (Salmo 23:1)',
    'Tutto posso in colui che mi dà la forza. (Filippesi 4:13)',
    'Confida nel Signore con tutto il cuore. (Proverbi 3:5)',
    'Sii forte e coraggioso. Non avere paura. (Giosuè 1:9)',
    'Questo è il giorno che il Signore ha fatto; rallegriamoci. (Salmo 118:24)',
    'Gettate su di lui ogni vostra preoccupazione, perché egli ha cura di voi. (1 Pietro 5:7)',
    'Il Signore è la mia luce e la mia salvezza, di chi avrò timore. (Salmo 27:1)',
    'L\'amore è paziente, l\'amore è gentile. (1 Corinzi 13:4)',
    'Ogni cosa che respira lodi il Signore. (Salmo 150:6)',
    'Fermatevi e sappiate che io sono Dio. (Salmo 46:10)',
    'Il pianto può durare una notte, ma la gioia viene al mattino. (Salmo 30:5)',
    'La gioia del Signore è la vostra forza. (Neemia 8:10)',
    'Camminiamo per fede, non per visione. (2 Corinzi 5:7)',
    'Fate ogni cosa con amore. (1 Corinzi 16:14)',
    'Le sue misericordie si rinnovano ogni mattina. (Lamentazioni 3:22-23)',
    'Rallegratevi sempre nel Signore. (Filippesi 4:4)',
    'Il Signore combatterà per voi; voi dovete solo stare fermi. (Esodo 14:14)',
    'Rendete grazie al Signore, perché è buono. (Salmo 107:1)',
    'La mia grazia ti basta. (2 Corinzi 12:9)',
  ],

  citazioni_ispirazionali: [
    'Sii te stesso; tutti gli altri sono già occupati.',
    'L\'unico modo di fare un grande lavoro è amare quello che fai.',
    'La vita è quello che ti succede mentre sei impegnato a fare altri progetti.',
    'Nel mezzo di ogni difficoltà si nasconde un\'opportunità.',
    'Agisci come se quello che fai facesse la differenza. La fa.',
    'Il momento migliore per piantare un albero era vent\'anni fa. Il secondo è adesso.',
    'Fai quello che puoi, con quello che hai, dove sei.',
    'Qualunque cosa tu sia, sii una versione migliore.',
    'La felicità dipende da noi stessi.',
    'Trasforma le tue ferite in saggezza.',
    'Tieni sempre il viso rivolto verso il sole.',
    'Un viaggio di mille miglia inizia con un singolo passo.',
    'Non sei mai troppo vecchio per un nuovo sogno.',
    'Non contare i giorni, fai che i giorni contino.',
    'La semplicità è la sofisticatezza suprema.',
    'Niente funziona se non ti impegni.',
    'Ben fatto è meglio che ben detto.',
    'Il futuro dipende da quello che fai oggi.',
    'Vai con fiducia nella direzione dei tuoi sogni.',
    'Resta affamato, resta folle.',
  ],

  gratitudine: [
    'Grata per un altro giorno bellissimo.',
    'Conto le benedizioni, non i problemi.',
    'Grata per le piccole cose di oggi.',
    'Tanto da essere grati in questa stagione.',
    'Trovo gioia nelle cose semplici.',
    'Un cuore pieno di gratitudine è un cuore pieno di pace.',
    'Grata oltre le parole per questa vita.',
    'Piccole gioie, grande gratitudine.',
    'Cuore grato, vita felice.',
    'Benedetta e grata, sempre.',
    'Oggi scelgo la gratitudine.',
    'Tanti motivi per sorridere oggi.',
    'Il mio cuore è pieno stamattina.',
    'Ogni giorno è un regalo da scartare.',
    'Grata per le persone nella mia vita.',
    'Grata per questo momento, qui e ora.',
    'Piccoli momenti, grandi benedizioni.',
    'Conto le mie benedizioni una ad una.',
    'La gratitudine trasforma ciò che abbiamo in abbastanza.',
    'Un cuore grato è un cuore felice.',
  ],

  motti_di_vita: [
    'Solo buone vibrazioni.',
    'Solo io, come sono.',
    'Vivere, ridere, amare.',
    'Vai avanti, continua a crescere.',
    'Sii il bene che vuoi vedere.',
    'Un giorno alla volta.',
    'Creo ricordi, non scuse.',
    'Resta umile, lavora con gentilezza.',
    'Progresso, non perfezione.',
    'Sii gentile con te stesso oggi.',
    'Inseguo tramonti e sogni semplici.',
    'Cuore tenero, spina dorsale forte.',
    'Scegli la gioia ogni giorno.',
    'Semplice e autentico.',
    'Vivi di più, preoccupati di meno.',
    'Svegliati, presentati, brilla.',
    'La vita è meglio quando ridi.',
    'Sii dove sono i tuoi piedi.',
    'Inspira, espira, vai avanti.',
    'Piccoli passi, grandi sogni.',
  ],

  benedizioni: [
    'Benedetta oltre misura.',
    'Fede sopra la paura, sempre.',
    'Il favore segue chi ha fiducia.',
    'Ogni alba è un dono dall\'alto.',
    'I suoi piani sono migliori dei miei.',
    'In piedi sulle promesse, cammino nella fede.',
    'La grazia mi accompagna ogni giorno.',
    'Molto favorita e profondamente amata.',
    'Preghiere sussurrate, fede che cresce.',
    'Il suo amore non viene mai meno.',
    'Mi fido di ogni passo di questo cammino.',
    'Benedetta con una pace che supera ogni comprensione.',
    'Ringrazio Dio per un altro giorno.',
    'Adorazione nell\'attesa.',
    'Ancora in piedi, ancora a credere.',
    'Piccoli semi di fede, grandi raccolti di speranza.',
    'Lui è fedele, anche quando io sono debole.',
    'Benedizioni su benedizioni, grandi e piccole.',
    'Vivere amata, vivere intera.',
    'La fede rende tutto possibile.',
  ],
};

const COUNTRY_POOLS = {
  IT: DESCRIPTION_POOLS_IT,
};

const COUNTRY_LANGUAGES = {
  IT: 'Italian',
};

const EMOJIS = ['🙏', '✝️', '💫', '🌿', '☀️', '🕊️', '💛', '✨', '🌻', '❤️'];

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sprinkleEmoji(text) {
  if (!text) return text;
  if (Math.random() >= 0.4) return text;
  return `${text} ${randomPick(EMOJIS)}`;
}

function getPoolsForCountry(country) {
  const code = (country || '').toUpperCase().trim();
  return COUNTRY_POOLS[code] || DESCRIPTION_POOLS_EN;
}

function getLanguageForCountry(country) {
  const code = (country || '').toUpperCase().trim();
  return COUNTRY_LANGUAGES[code] || 'English';
}

async function requestGitHubModels(messages, options = {}) {
  const token = String(process.env.GITHUB_MODELS_TOKEN || '').trim();
  const model = String(process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4.1').trim();
  const endpoint = String(
    process.env.GITHUB_MODELS_BASE_URL || 'https://models.github.ai/inference/chat/completions'
  ).trim();
  const apiVersion = String(process.env.GITHUB_MODELS_API_VERSION || '2026-03-10').trim();

  if (!token) throw new Error('Missing GITHUB_MODELS_TOKEN in environment.');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': apiVersion,
    },
    body: JSON.stringify({
      model,
      temperature: options.temperature ?? 0.9,
      max_tokens: options.maxTokens ?? 80,
      messages,
    }),
  });

  if (!response.ok) {
    let errorMessage = `GitHub Models request failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      const detail = body?.message || body?.error?.message || JSON.stringify(body);
      errorMessage = `HTTP ${response.status}: ${detail}`;
    } catch {}
    throw new Error(errorMessage);
  }

  return await response.json();
}

function fallbackQuote(country) {
  const pools = getPoolsForCountry(country);
  const poolKeys = Object.keys(pools);
  const poolKey = randomPick(poolKeys);
  const quote = randomPick(pools[poolKey]);
  const decorated = sprinkleEmoji(quote);
  console.log(`  [generateAvatarDescription] fallback [${poolKey}]: "${decorated}"`);
  return decorated;
}

async function generateAvatarDescription(userIdentity, country) {
  const persona = String(userIdentity || '').trim();
  const language = getLanguageForCountry(country);

  if (!persona) {
    console.log('  [generateAvatarDescription] no userIdentity — using fallback quote');
    return fallbackQuote(country);
  }

  try {
    const systemPrompt = `
      USER PERSONA: ${persona}

      TASK:
      Write a short Facebook caption to post with a new profile picture, written in the FIRST PERSON from the persona above.

      CONSTRAINTS:
      - POV: Always first person ("I", "me", "my") — the persona is posting their own new pic.
      - LANGUAGE: Always ${language}.
      - TONE: Casual, warm, natural — like a real person captioning a new photo. Match the persona's vibe.
      - LENGTH: 4 to 15 words.
      - EMOJI: At most ONE emoji, and only if it fits naturally. Usually none is better.
      - VARIETY: Do not start with "Check out", "Just", "New pic", "Look at", or "Guess". Do not use hashtags or quotation marks.
      - NO HYPHENS: Do not use em dashes (—), en dashes (–), or standalone hyphens (-). Use commas or rewrite.
      - OUTPUT: Plain text only. No labels, no quotes around the whole thing.
      - SKIP: Return only the word SKIP (nothing else) if the persona is empty or unreadable.
    `.trim();

    const payload = await requestGitHubModels([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Generate the profile-picture caption:' },
    ]);

    const raw = payload.choices[0]?.message?.content?.trim().replace(/^["']|["']$/g, '') ?? '';
    if (!raw || raw === 'SKIP') {
      console.log('  [generateAvatarDescription] model returned SKIP — using fallback quote');
      return fallbackQuote(country);
    }

    const cleaned = raw
      .replace(/[—–]|(?<= )-(?= )/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!cleaned) {
      return fallbackQuote(country);
    }

    const finalText = sprinkleEmoji(cleaned);
    console.log(`  [generateAvatarDescription] generated (${language}): "${finalText}"`);
    return finalText;
  } catch (err) {
    console.warn(`  [generateAvatarDescription] API error: ${err.message} — using fallback quote`);
    return fallbackQuote(country);
  }
}

module.exports = { generateAvatarDescription, DESCRIPTION_POOLS: DESCRIPTION_POOLS_EN };

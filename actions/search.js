/**
 * search - Navigator action.
 * Performs a Facebook search. Three modes:
 *   - "name" : random "{first} {last}" from 100×100 name pools
 *   - "news" : random "{US state} {news keyword}"
 *   - "page" : "{category} in {city}" — category random from pool (or `category` param),
 *              city auto-injected from user.city (or `city` param)
 * Explicit `query` overrides mode-based generation.
 * Ends on the search-results page so child steps (scroll, like_posts, follow,
 * add_friend, open_search_result, ...) can act on it.
 */

const { humanClick, humanWait, humanType } = require('../utils/humanBehavior');
const { stepWait } = require('../utils/pageSetupHelpers');

const FIRST_NAMES = [
  'James',
  'Mary',
  'John',
  'Patricia',
  'Robert',
  'Jennifer',
  'Michael',
  'Linda',
  'William',
  'Elizabeth',
  'David',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Charles',
  'Karen',
  'Christopher',
  'Nancy',
  'Daniel',
  'Lisa',
  'Matthew',
  'Margaret',
  'Anthony',
  'Betty',
  'Mark',
  'Sandra',
  'Donald',
  'Ashley',
  'Steven',
  'Kimberly',
  'Paul',
  'Emily',
  'Andrew',
  'Donna',
  'Joshua',
  'Michelle',
  'Kenneth',
  'Carol',
  'Kevin',
  'Amanda',
  'Brian',
  'Melissa',
  'George',
  'Deborah',
  'Timothy',
  'Stephanie',
  'Ronald',
  'Rebecca',
  'Jason',
  'Laura',
  'Edward',
  'Sharon',
  'Jeffrey',
  'Cynthia',
  'Ryan',
  'Kathleen',
  'Jacob',
  'Amy',
  'Gary',
  'Shirley',
  'Nicholas',
  'Angela',
  'Eric',
  'Helen',
  'Jonathan',
  'Anna',
  'Stephen',
  'Brenda',
  'Larry',
  'Pamela',
  'Justin',
  'Nicole',
  'Scott',
  'Samantha',
  'Brandon',
  'Katherine',
  'Benjamin',
  'Emma',
  'Samuel',
  'Ruth',
  'Gregory',
  'Christine',
  'Alexander',
  'Catherine',
  'Patrick',
  'Debra',
  'Frank',
  'Rachel',
  'Raymond',
  'Carolyn',
  'Jack',
  'Janet',
  'Dennis',
  'Virginia',
  'Jerry',
  'Maria',
];

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker',
  'Young',
  'Allen',
  'King',
  'Wright',
  'Scott',
  'Torres',
  'Nguyen',
  'Hill',
  'Flores',
  'Green',
  'Adams',
  'Nelson',
  'Baker',
  'Hall',
  'Rivera',
  'Campbell',
  'Mitchell',
  'Carter',
  'Roberts',
  'Gomez',
  'Phillips',
  'Evans',
  'Turner',
  'Diaz',
  'Parker',
  'Cruz',
  'Edwards',
  'Collins',
  'Reyes',
  'Stewart',
  'Morris',
  'Morales',
  'Murphy',
  'Cook',
  'Rogers',
  'Gutierrez',
  'Ortiz',
  'Morgan',
  'Cooper',
  'Peterson',
  'Bailey',
  'Reed',
  'Kelly',
  'Howard',
  'Ramos',
  'Kim',
  'Cox',
  'Ward',
  'Richardson',
  'Watson',
  'Brooks',
  'Chavez',
  'Wood',
  'James',
  'Bennett',
  'Gray',
  'Mendoza',
  'Ruiz',
  'Hughes',
  'Price',
  'Alvarez',
  'Castillo',
  'Sanders',
  'Patel',
  'Myers',
  'Long',
  'Ross',
  'Foster',
  'Jimenez',
];

const IT_FIRST_NAMES = [
  'Marco',
  'Giuseppe',
  'Luca',
  'Alessandro',
  'Andrea',
  'Francesco',
  'Matteo',
  'Lorenzo',
  'Davide',
  'Simone',
  'Federico',
  'Stefano',
  'Roberto',
  'Antonio',
  'Giovanni',
  'Paolo',
  'Riccardo',
  'Nicola',
  'Fabio',
  'Alberto',
  'Daniele',
  'Massimo',
  'Vincenzo',
  'Salvatore',
  'Emanuele',
  'Giulia',
  'Francesca',
  'Sara',
  'Valentina',
  'Chiara',
  'Alessia',
  'Martina',
  'Anna',
  'Elena',
  'Silvia',
  'Federica',
  'Laura',
  'Elisa',
  'Roberta',
  'Paola',
  'Claudia',
  'Maria',
  'Ilaria',
  'Giorgia',
  'Monica',
  'Cristina',
  'Serena',
  'Simona',
  'Marta',
  'Arianna',
];

const IT_LAST_NAMES = [
  'Rossi',
  'Russo',
  'Ferrari',
  'Esposito',
  'Bianchi',
  'Romano',
  'Colombo',
  'Ricci',
  'Marino',
  'Greco',
  'Bruno',
  'Gallo',
  'Conti',
  'De Luca',
  'Mancini',
  'Costa',
  'Giordano',
  'Rizzo',
  'Lombardi',
  'Moretti',
  'Barbieri',
  'Fontana',
  'Santoro',
  'Mariani',
  'Rinaldi',
  'Caruso',
  'Ferrara',
  'Galli',
  'Martini',
  'Leone',
  'Longo',
  'Gentile',
  'Martinelli',
  'Vitale',
  'Lombardo',
  'Serra',
  'Coppola',
  'De Santis',
  "D'Angelo",
  'Marchetti',
  'Parisi',
  'Villa',
  'Conte',
  'Ferraro',
  'Ferri',
  'Fabbri',
  'Bianco',
  'Marini',
  'Grasso',
  'Valentini',
];

const US_STATES = [
  'Alabama',
  'Alaska',
  'Arizona',
  'Arkansas',
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'Florida',
  'Georgia',
  'Hawaii',
  'Idaho',
  'Illinois',
  'Indiana',
  'Iowa',
  'Kansas',
  'Kentucky',
  'Louisiana',
  'Maine',
  'Maryland',
  'Massachusetts',
  'Michigan',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Montana',
  'Nebraska',
  'Nevada',
  'New Hampshire',
  'New Jersey',
  'New Mexico',
  'New York',
  'North Carolina',
  'North Dakota',
  'Ohio',
  'Oklahoma',
  'Oregon',
  'Pennsylvania',
  'Rhode Island',
  'South Carolina',
  'South Dakota',
  'Tennessee',
  'Texas',
  'Utah',
  'Vermont',
  'Virginia',
  'Washington',
  'West Virginia',
  'Wisconsin',
  'Wyoming',
];

const IT_REGIONS = [
  'Lazio',
  'Lombardia',
  'Sicilia',
  'Toscana',
  'Emilia-Romagna',
  'Campania',
  'Veneto',
  'Piemonte',
  'Puglia',
  'Calabria',
  'Sardegna',
  'Liguria',
  'Marche',
  'Abruzzo',
  'Friuli Venezia Giulia',
  'Umbria',
  'Basilicata',
  'Molise',
  'Trentino-Alto Adige',
  "Valle d'Aosta",
];

const NEWS_KEYWORDS = [
  'news',
  'breaking news',
  'latest news',
  'local news',
  'weather',
  'traffic',
  'sports',
  'politics',
  'events',
  'today',
  'headlines',
  'update',
];

const IT_NEWS_KEYWORDS = [
  'notizie',
  'ultime notizie',
  'cronaca',
  'meteo',
  'sport',
  'eventi',
  'aggiornamenti',
  'politica',
  'calcio',
  'cultura',
  'economia',
  'traffico',
];

const GENERAL_TOPICS = [
  'best pizza',
  'restaurants',
  'coffee shops',
  'things to do',
  'events this weekend',
  'farmers market',
  'brunch',
  'happy hour',
  'tacos',
  'ice cream',
  'thrift stores',
  'hiking trails',
  'dog parks',
  'yoga classes',
  'gyms',
  'barber shops',
  'nail salons',
  'car wash',
  'auto repair',
  'dentist',
  'used cars for sale',
  'apartments for rent',
  'garage sales',
  'live music',
  'open mic night',
  'food trucks',
  'burgers',
  'sushi',
  'chinese food',
  'mexican food',
  'italian food',
  'bakery',
  'florist',
  'pet grooming',
  'daycare',
  'tutoring',
  'volunteer',
  'church',
  'book clubs',
  'running clubs',
  'basketball courts',
  'swimming pools',
  'fishing spots',
  'camping',
  'beaches',
  'parks',
  'flea market',
  'karaoke',
  'sports bars',
  'wings',
];

const IT_GENERAL_TOPICS = [
  'pizza',
  'ristoranti',
  'bar',
  'cosa fare',
  'eventi',
  'mercato',
  'brunch',
  'aperitivo',
  'trattoria',
  'gelateria',
  'mercatini usato',
  'sentieri trekking',
  'parchi per cani',
  'corsi yoga',
  'palestra',
  'barbiere',
  'parrucchiere',
  'autolavaggio',
  'officina',
  'dentista',
  'auto usate',
  'appartamenti in affitto',
  'mercatini',
  'musica dal vivo',
  'open mic',
  'street food',
  'hamburger',
  'sushi',
  'ristorante cinese',
  'ristorante messicano',
  'ristorante tipico',
  'pasticceria',
  'fiorista',
  'toelettatura',
  'asilo nido',
  'ripetizioni',
  'volontariato',
  'chiesa',
  'club del libro',
  'gruppo corsa',
  'campi da basket',
  'piscina',
  'pesca',
  'campeggio',
  'spiagge',
  'parchi',
  'mercato delle pulci',
  'karaoke',
  'pub sportivo',
  'alette di pollo',
];

const COUNTRY_ALIASES = {
  us: 'US',
  usa: 'US',
  united_states: 'US',
  'united states': 'US',
  it: 'IT',
  ita: 'IT',
  italy: 'IT',
  italia: 'IT',
};

function normalizeCountry(raw) {
  if (!raw) return 'US';
  const key = String(raw).trim().toLowerCase();
  return COUNTRY_ALIASES[key] || key.toUpperCase();
}

const PAGE_CATEGORIES = [
  'Photography',
  'Restaurant',
  'Local news',
  'Sports',
  'Music',
  'Fitness',
  'Real estate',
  'Cooking',
  'Fashion',
  'Art',
  'Gaming',
  'Travel',
  'Health',
  'Education',
  'Technology',
  'Automotive',
  'Pets',
  'Books',
  'Movies',
  'Coffee shop',
  'Barbershop',
  'Salon',
  'Yoga',
  'Gym',
  'Bakery',
];

const IT_PAGE_CATEGORIES = [
  'Fotografia',
  'Ristorante',
  'Notizie locali',
  'Sport',
  'Musica',
  'Palestra',
  'Immobiliare',
  'Cucina',
  'Moda',
  'Arte',
  'Videogiochi',
  'Viaggi',
  'Salute',
  'Istruzione',
  'Tecnologia',
  'Auto e moto',
  'Animali',
  'Libri',
  'Cinema',
  'Bar e caffetteria',
  'Barbiere',
  'Parrucchiere',
  'Yoga',
  'Palestra e fitness',
  'Pasticceria',
];

const SEARCH_INPUT_SELECTOR =
  'input[aria-label="Search Facebook"][type="search"], ' +
  'input[placeholder="Search Facebook"][role="combobox"], ' +
  'input[type="search"][role="combobox"]';

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateQuery({ mode, category, city, country }) {
  const cc = normalizeCountry(country);
  if (mode === 'name') {
    const firsts = cc === 'IT' ? IT_FIRST_NAMES : FIRST_NAMES;
    const lasts = cc === 'IT' ? IT_LAST_NAMES : LAST_NAMES;
    return `${randomPick(firsts)} ${randomPick(lasts)}`;
  }
  if (mode === 'news') {
    const regions = cc === 'IT' ? IT_REGIONS : US_STATES;
    const keywords = cc === 'IT' ? IT_NEWS_KEYWORDS : NEWS_KEYWORDS;
    return `${randomPick(regions)} ${randomPick(keywords)}`;
  }
  if (mode === 'page') {
    const categories = cc === 'IT' ? IT_PAGE_CATEGORIES : PAGE_CATEGORIES;
    const cat = String(category || '').trim() || randomPick(categories);
    const loc = String(city || '').trim();
    return loc ? `${cat} in ${loc}` : cat;
  }
  if (mode === 'general') {
    const topics = cc === 'IT' ? IT_GENERAL_TOPICS : GENERAL_TOPICS;
    const topic = randomPick(topics);
    const loc = String(city || '').trim();
    const nearMe = cc === 'IT' ? 'vicino a me' : 'near me';
    if (!loc) return `${topic} ${nearMe}`;
    return Math.random() < 0.5 ? `${topic} ${nearMe}` : `${topic} in ${loc}`;
  }
  throw new Error(`search: unknown mode "${mode}" (expected "name", "news", "page", or "general")`);
}

module.exports = async function search(page, params) {
  const { query = '', mode = 'name', filter = '', category = '', city = '', country = '' } = params;

  const searchQuery =
    String(query || '').trim() || generateQuery({ mode, category, city, country });

  console.log(`  [search] Query: "${searchQuery}" (${query ? 'explicit' : `mode=${mode}`})`);

  if (!page.url().includes('facebook.com')) {
    console.log('  [search] Not on Facebook — navigating home first...');
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });
    await humanWait(page, 1500, 3000);
  }

  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  await searchInput.waitFor({ state: 'visible', timeout: 15000 });

  console.log('  [search] Clicking search input...');
  await humanClick(page, await searchInput.boundingBox());
  await humanWait(page, 500, 1200);

  await page.keyboard.press('Control+a');
  await humanWait(page, 150, 400);
  await page.keyboard.press('Backspace');
  await humanWait(page, 300, 800);

  console.log('  [search] Typing query...');
  await humanType(page, searchQuery);
  await humanWait(page, 700, 1500);

  console.log('  [search] Submitting search...');
  await page.keyboard.press('Enter');

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  } catch (err) {
    console.warn(`  [search] domcontentloaded wait timed out: ${err.message}`);
  }
  await humanWait(page, 2500, 4500);

  if (filter) {
    const filterLink = page
      .locator(`xpath=//a[@role="link"][.//span[normalize-space(text())="${filter}"]]`)
      .first();
    const filterVisible = await filterLink.isVisible().catch(() => false);

    if (filterVisible) {
      console.log(`  [search] Applying filter: ${filter}`);
      await humanClick(page, await filterLink.boundingBox());
      await humanWait(page, 2000, 4000);
    } else {
      console.warn(`  [search] Filter "${filter}" not visible — continuing without it.`);
    }
  }

  await stepWait(page);
  console.log('  [search] Results loaded.');
};

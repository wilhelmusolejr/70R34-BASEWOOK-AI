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
  'James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda','William','Elizabeth',
  'David','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen',
  'Christopher','Nancy','Daniel','Lisa','Matthew','Margaret','Anthony','Betty','Mark','Sandra',
  'Donald','Ashley','Steven','Kimberly','Paul','Emily','Andrew','Donna','Joshua','Michelle',
  'Kenneth','Carol','Kevin','Amanda','Brian','Melissa','George','Deborah','Timothy','Stephanie',
  'Ronald','Rebecca','Jason','Laura','Edward','Sharon','Jeffrey','Cynthia','Ryan','Kathleen',
  'Jacob','Amy','Gary','Shirley','Nicholas','Angela','Eric','Helen','Jonathan','Anna',
  'Stephen','Brenda','Larry','Pamela','Justin','Nicole','Scott','Samantha','Brandon','Katherine',
  'Benjamin','Emma','Samuel','Ruth','Gregory','Christine','Alexander','Catherine','Patrick','Debra',
  'Frank','Rachel','Raymond','Carolyn','Jack','Janet','Dennis','Virginia','Jerry','Maria',
];

const LAST_NAMES = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
  'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
  'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
  'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores',
  'Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts',
  'Gomez','Phillips','Evans','Turner','Diaz','Parker','Cruz','Edwards','Collins','Reyes',
  'Stewart','Morris','Morales','Murphy','Cook','Rogers','Gutierrez','Ortiz','Morgan','Cooper',
  'Peterson','Bailey','Reed','Kelly','Howard','Ramos','Kim','Cox','Ward','Richardson',
  'Watson','Brooks','Chavez','Wood','James','Bennett','Gray','Mendoza','Ruiz','Hughes',
  'Price','Alvarez','Castillo','Sanders','Patel','Myers','Long','Ross','Foster','Jimenez',
];

const US_STATES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia',
  'Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland',
  'Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey',
  'New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina',
  'South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming',
];

const NEWS_KEYWORDS = [
  'news','breaking news','latest news','local news','weather','traffic','sports',
  'politics','events','today','headlines','update',
];

const PAGE_CATEGORIES = [
  'Photography','Restaurant','Local news','Sports','Music','Fitness','Real estate',
  'Cooking','Fashion','Art','Gaming','Travel','Health','Education','Technology',
  'Automotive','Pets','Books','Movies','Coffee shop','Barbershop','Salon','Yoga',
  'Gym','Bakery',
];

const SEARCH_INPUT_SELECTOR =
  'input[aria-label="Search Facebook"][type="search"], ' +
  'input[placeholder="Search Facebook"][role="combobox"], ' +
  'input[type="search"][role="combobox"]';

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateQuery({ mode, category, city }) {
  if (mode === 'name') {
    return `${randomPick(FIRST_NAMES)} ${randomPick(LAST_NAMES)}`;
  }
  if (mode === 'news') {
    return `${randomPick(US_STATES)} ${randomPick(NEWS_KEYWORDS)}`;
  }
  if (mode === 'page') {
    const cat = String(category || '').trim() || randomPick(PAGE_CATEGORIES);
    const loc = String(city || '').trim();
    return loc ? `${cat} in ${loc}` : cat;
  }
  throw new Error(`search: unknown mode "${mode}" (expected "name", "news", or "page")`);
}

module.exports = async function search(page, params) {
  const {
    query = '',
    mode = 'name',
    filter = '',
    category = '',
    city = '',
  } = params;

  const searchQuery = String(query || '').trim() || generateQuery({ mode, category, city });

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
    const filterLink = page.locator(
      `xpath=//a[@role="link"][.//span[normalize-space(text())="${filter}"]]`
    ).first();
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

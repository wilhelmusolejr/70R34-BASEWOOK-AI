/**
 * postTopics.js — random topic seeds for text-only Facebook status posts
 * (used by publish_text_post). 50 topics across 5 categories of 10.
 *
 * A topic is just a SEED/theme. The AI (generateTopicPost) writes the actual
 * status in the user's voice, grounding it in their identity (location, work,
 * hobbies). Some topics carry {city} / {work} tokens that pickPostTopic() fills
 * from the user record; when the data is missing the token's clause is dropped
 * so the topic still reads cleanly.
 */

// 1) Questioning / asking the network — recommendations, local & work-related.
const ASKING = [
  'Asking friends for a good place to grab coffee{cityClause}',
  'Wondering if anyone knows a reliable handyman{cityClause}',
  'Looking for weekend trip ideas that are not too far{cityClause}',
  'Asking for honest recommendations on where to eat out{cityClause}',
  'Curious what people use to stay organized{workClause}',
  'Asking the network for advice about {work}',
  'Wondering where everyone buys fresh produce these days{cityClause}',
  'Looking for a good book or show recommendation for the weekend',
  'Asking if anyone has tips for getting back into a workout routine',
  'Wondering what the best value phone plan is right now',
];

// 2) Facebook / online "drama" & commentary — light, relatable, not hostile.
const DRAMA = [
  'Half-joking about how everyone suddenly became an expert on the internet',
  'Light commentary on people who post every single meal they eat',
  'Mild rant about endless group chat notifications',
  'Funny take on how Facebook keeps reminding me of cringe memories',
  'Joking about the comment-section arguments under local news posts',
  'Observation about people who reply "DM sent" on every post',
  'Light vent about constant fake giveaway posts going around',
  'Amused that my feed is 90% ads and 10% actual friends now',
  'Poking fun at the "share if you agree" chain posts',
  'Joking about how nobody actually reads past the headline anymore',
];

// 3) Everyday life / personal musings — the mundane, made warm.
const EVERYDAY = [
  'A small win that made my day better',
  'Thinking out loud about how fast this week went',
  'A simple morning routine that is actually working for me',
  'Quietly grateful for a slow, easy evening at home',
  'Random thought about how good a home-cooked meal hits',
  'Mood update after way too little sleep',
  'Appreciating the weather today and wanting to be outside',
  'A tiny thing that annoyed me but is honestly kind of funny',
  'Feeling motivated and wanting to get things done today',
  'Reflecting on a quiet weekend and feeling recharged',
];

// 4) Opinions / hot takes on everyday trends — playful, low-stakes.
const OPINIONS = [
  'A mild hot take about a food everyone loves but I do not',
  'My honest opinion on early mornings vs late nights',
  'Defending a guilty-pleasure habit I refuse to give up',
  'A small opinion about coffee vs tea',
  'My take on whether the weekend is too short',
  'An unpopular opinion about a popular show or movie',
  'Why I think simple plans beat big complicated ones',
  'A take on how phones have changed the way we hang out',
  'My stance on texting back fast vs taking your time',
  'A light opinion about pineapple, ketchup, or some other food debate',
];

// 5) Nostalgia / memories / gratitude — warm, reflective.
const NOSTALGIA = [
  'A throwback memory that randomly popped into my head today',
  'Missing how simple things felt a few years ago',
  'Grateful for an old friend I reconnected with',
  'A childhood food or place I have been thinking about',
  'Remembering a small trip that meant more than I expected',
  'Thankful for the people who show up without being asked',
  'A song that instantly takes me back',
  'Looking at old photos and feeling all the feelings',
  'Appreciating how far things have come this past year',
  'A simple thing from growing up that I wish was still around',
];

const CATEGORIES = [ASKING, DRAMA, EVERYDAY, OPINIONS, NOSTALGIA];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Fill {city}/{work} tokens (and their wrapper clauses) from the user record.
// Missing data → drop the clause so the seed still reads naturally.
function fillTokens(topic, user = {}) {
  const city = String(user.city || user.hometown || '').trim();
  // Pick a single work-ish detail to ground "work" topics.
  const work = String(
    (user.work && (user.work.title || user.work.company || user.work)) ||
      user.profession ||
      ''
  ).trim();

  return topic
    .replace(/\{cityClause\}/g, city ? ` around ${city}` : '')
    .replace(/\{workClause\}/g, work ? ` at work` : '')
    .replace(/\{city\}/g, city || 'my area')
    .replace(/\{work\}/g, work || 'my line of work')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Pick a random topic seed, grounded in the user record. Returns a plain string.
 * @param {object} user — the user record (city/hometown/work used for grounding)
 */
function pickPostTopic(user = {}) {
  const category = pick(CATEGORIES);
  return fillTokens(pick(category), user);
}

module.exports = { pickPostTopic, CATEGORIES };

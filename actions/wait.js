/**
 * wait - Idle on the current page for a duration. Two modes:
 *   - Fixed:  { duration: 30 }            → exactly 30s
 *   - Random: { min: 10, max: 30 }        → uniform random 10–30s
 *
 * All durations are in seconds. If both `duration` and min/max are given,
 * `duration` wins. Defaults to 5s when no params are provided.
 */

module.exports = async function wait(page, params = {}) {
  let seconds;

  if (typeof params.duration === 'number' && params.duration >= 0) {
    seconds = params.duration;
  } else if (
    typeof params.min === 'number' &&
    typeof params.max === 'number' &&
    params.max >= params.min
  ) {
    seconds = params.min + Math.random() * (params.max - params.min);
  } else {
    seconds = 5;
  }

  const ms = Math.round(seconds * 1000);
  console.log(`  Waiting ${seconds.toFixed(1)}s...`);
  await page.waitForTimeout(ms);
  console.log(`  Wait complete`);
};

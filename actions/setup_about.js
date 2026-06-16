const axios = require('axios');
const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');
const { setOnboarding } = require('../utils/userApi');

const USER_API_BASE_URL = process.env.USER_API_BASE_URL || '';

async function markProfileSetup(userId) {
  if (!userId) {
    console.warn('  [setup_about] No userId provided — skipping status/profileSetup PATCH.');
    return;
  }
  if (!USER_API_BASE_URL) {
    console.warn('  [setup_about] USER_API_BASE_URL not set — skipping status/profileSetup PATCH.');
    return;
  }

  const target = `${USER_API_BASE_URL}/api/profiles/${userId}`;
  try {
    await axios.patch(target, { status: 'Active', profileSetup: true }, { timeout: 15000 });
    console.log(`  [setup_about] PATCHed status=Active, profileSetup=true → ${target}`);
  } catch (err) {
    console.warn(`  [setup_about] Failed to PATCH profile setup flags: ${err.message}`);
  }
}

/**
 * Normalize a captured profile URL — strip trailing /about (and similar tab
 * suffixes) and any sk= query param so we record the profile root only.
 */
function normalizeProfileUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    const u = new URL(raw);
    u.pathname = u.pathname.replace(/\/(about|friends|photos|videos|reels)(?:\/.*)?\/?$/i, '');
    u.searchParams.delete('sk');
    let out = u.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch (_) {
    return raw;
  }
}

/**
 * If user.profileUrl is empty, PATCH it back to the user record so future
 * runs can navigate to it directly. Mirrors the create_page → pageUrl flow.
 */
async function persistProfileUrl(userId, profileUrl) {
  if (!userId || !profileUrl) return;
  if (!USER_API_BASE_URL) return;
  const target = `${USER_API_BASE_URL}/api/profiles/${userId}`;
  try {
    await axios.patch(target, { profileUrl }, { timeout: 15000 });
    console.log(`  [setup_about] PATCHed profileUrl=${profileUrl} → ${target}`);
  } catch (err) {
    console.warn(`  [setup_about] Failed to PATCH profileUrl: ${err.message}`);
  }
}

// ========================= NAVIGATION HELPERS =========================

async function goToOwnProfile(page) {
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3000);
}

async function clickAboutTab(page) {
  // FB serves slightly different About-tab markup across account states /
  // locales / browser fingerprints. Match on ANY of three signals:
  //   (1) href contains sk=about
  //   (2) aria-label is "About"
  //   (3) visible text is "About"
  // Polled in-page so React render delays (Multilogin's slower stack) are tolerated.
  let elHandle;
  try {
    const jsHandle = await page.waitForFunction(
      () => {
        const anchors = Array.from(document.querySelectorAll('a[role="tab"], a[href]'));
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const aria = a.getAttribute('aria-label') || '';
          // textContent — not innerText — so this works before layout is computed
          const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
          const role = a.getAttribute('role') || '';

          const hrefMatch =
            href.includes('sk=about') || // ?sk=about query style
            /\/about(?:\/|\?|$)/.test(href); // /<username>/about path style

          const ariaMatch = aria === 'About';

          // Only accept the text fallback when the element is clearly a tab,
          // so we don't pick up a footer "About" link on the same page.
          const textMatch = role === 'tab' && text === 'About';

          if (hrefMatch || ariaMatch || textMatch) return a;
        }
        return null;
      },
      { timeout: 30000 }
    );
    elHandle = jsHandle.asElement();
  } catch (_) {
    throw new Error('[setup_about] About tab not found on profile page');
  }
  if (!elHandle) throw new Error('[setup_about] About tab handle was null');

  await elHandle.scrollIntoViewIfNeeded();
  await humanWait(page, 300, 500);
  const box = await elHandle.boundingBox();
  if (!box) throw new Error('[setup_about] About tab has no bounding box');
  await humanClick(page, box);
  await humanWait(page, 2000, 3000);
  console.log('  [setup_about] Clicked About tab');
}

/**
 * If FB shows a "You have unsaved changes — Leave Page?" modal after
 * clicking a sidebar tab, click Leave Page to discard the leftover input
 * and let navigation proceed. Probes with a short timeout so the common
 * (no-modal) case isn't slowed down.
 */
async function dismissLeavePageDialog(page, { timeout = 2500 } = {}) {
  const btn = page.locator('[aria-label="Leave Page"]').first();
  try {
    await btn.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }

  try {
    await btn.click();
    // The modal appearing AT ALL means the section we just left did not save —
    // FB only shows it when the form still holds unsaved changes. We discard so
    // navigation can proceed, but this is a save-failure signal, not routine.
    console.warn(
      '  [setup_about] "Leave Page?" modal appeared — previous section had UNSAVED changes (discarding to continue)'
    );
    await humanWait(page, 800, 1500);
    return true;
  } catch (err) {
    console.warn(`  [setup_about] Leave Page click failed: ${err.message}`);
    return false;
  }
}

async function clickSubsection(page, skFragment, fallbackText) {
  try {
    const el = await page.$(`a[href*="${skFragment}"]`);
    if (el) {
      await el.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      const box = await el.boundingBox();
      if (box) {
        await humanClick(page, box);
        await humanWait(page, 1800, 2800);
        await dismissLeavePageDialog(page);
        console.log(`  [setup_about] Navigated to subsection: ${skFragment}`);
        return true;
      }
    }
  } catch {
    /* fall through */
  }

  if (fallbackText) {
    try {
      const el = page.getByRole('tab', { name: fallbackText }).first();
      await el.waitFor({ state: 'visible', timeout: 4000 });
      await el.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      const box = await el.boundingBox();
      if (box) {
        await humanClick(page, box);
        await humanWait(page, 1800, 2800);
        await dismissLeavePageDialog(page);
        console.log(`  [setup_about] Navigated to subsection via text: ${fallbackText}`);
        return true;
      }
    } catch {
      /* not found */
    }
  }

  // Direct URL navigation — fresh accounts may not render sidebar links yet.
  try {
    const currentUrl = page.url();
    const u = new URL(currentUrl);
    u.searchParams.set('sk', skFragment);
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
    await humanWait(page, 2000, 3000);
    console.log(`  [setup_about] Navigated to subsection via URL: ${skFragment}`);
    return true;
  } catch {
    /* fall through */
  }

  console.log(`  [setup_about] Could not navigate to subsection: ${skFragment}`);
  return false;
}

// ========================= UI INTERACTION HELPERS =========================

async function waitForDialog(page, timeout = 6000) {
  try {
    await page.waitForSelector('[role="dialog"]', { timeout });
    await humanWait(page, 600, 1000);
    return true;
  } catch {
    return false;
  }
}

async function clickByText(page, text, timeout = 5000) {
  try {
    const el = page.getByText(text, { exact: false }).first();
    await el.waitFor({ state: 'visible', timeout });
    await el.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    const box = await el.boundingBox();
    if (!box) return false;
    await humanClick(page, box);
    return true;
  } catch {
    return false;
  }
}

async function clickButton(page, namePattern, timeout = 5000) {
  try {
    const btn = page.getByRole('button', { name: namePattern }).first();
    await btn.waitFor({ state: 'visible', timeout });
    await btn.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    const box = await btn.boundingBox();
    if (!box) return false;
    await humanClick(page, box);
    return true;
  } catch {
    return false;
  }
}

async function fillInput(page, selectors, value) {
  if (!value) return false;
  const list = Array.isArray(selectors) ? selectors : selectors.split(',').map((s) => s.trim());
  for (const sel of list) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) {
        await el.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await el.click();
        await humanWait(page, 200, 400);
        await page.keyboard.press('Control+a');
        await humanType(page, String(value));
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

async function fillCombobox(page, selectors, value) {
  if (!value) return false;
  const list = Array.isArray(selectors) ? selectors : selectors.split(',').map((s) => s.trim());
  for (const sel of list) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) {
        await el.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await humanClick(page, await el.boundingBox());
        await humanWait(page, 300, 600);
        await humanType(page, value);
        await humanWait(page, 1800, 2800);

        const option = await page.$('[role="option"]');
        if (option) {
          await option.scrollIntoViewIfNeeded();
          await humanWait(page, 200, 400);
          const box = await option.boundingBox();
          if (box) {
            await humanClick(page, box);
            return true;
          }
        }
        await page.keyboard.press('Enter');
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

async function setYear(page, labelPatterns, value) {
  if (!value) return false;
  const str = String(value);
  const patterns = Array.isArray(labelPatterns) ? labelPatterns : [labelPatterns];

  for (const pattern of patterns) {
    try {
      const selects = await page.$$('select');
      for (const sel of selects) {
        const label = (await sel.getAttribute('aria-label').catch(() => '')) || '';
        const matches =
          pattern instanceof RegExp
            ? pattern.test(label)
            : label.toLowerCase().includes(pattern.toLowerCase());
        if (matches) {
          await sel.scrollIntoViewIfNeeded();
          await humanWait(page, 200, 400);
          await sel.selectOption(str);
          await humanWait(page, 300, 600);
          return true;
        }
      }
    } catch {
      /* continue */
    }

    try {
      const pat = pattern instanceof RegExp ? pattern.source : pattern;
      const el = await page.$(`[aria-label="${pat}"]`);
      if (el && (await el.isVisible())) {
        await el.scrollIntoViewIfNeeded();
        await humanWait(page, 200, 400);
        await el.click();
        await page.keyboard.press('Control+a');
        await humanType(page, str);
        return true;
      }
    } catch {
      /* continue */
    }
  }
  return false;
}

async function checkBox(page, selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const sel of list) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.scrollIntoViewIfNeeded();
      await humanWait(page, 200, 400);
      const checked = await el.isChecked().catch(() => null);
      if (checked === false) {
        const box = await el.boundingBox();
        if (box) {
          await humanClick(page, box);
          await humanWait(page, 300, 600);
        }
      }
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

// Click a panel form button by XPath (no aria-label on these divs)
async function clickPanelButton(page, spanText, timeout = 6000) {
  const xpath = `xpath=//div[@role="button"][.//span[text()="${spanText}"]]`;
  try {
    const el = await page.waitForSelector(xpath, { timeout });
    await el.scrollIntoViewIfNeeded();
    await humanWait(page, 400, 700);
    await humanClick(page, await el.boundingBox());
    await humanWait(page, 1000, 1800);
    return true;
  } catch {
    console.log(`  [setup_about] Panel button not found: "${spanText}"`);
    return false;
  }
}

// Type into an input then ArrowDown + Enter to pick the first suggestion
async function typeAndSelect(page, selector, value, timeout = 5000) {
  const el = await page.waitForSelector(selector, { timeout });
  await el.scrollIntoViewIfNeeded();
  await humanWait(page, 400, 700);
  await humanClick(page, await el.boundingBox());
  await humanWait(page, 300, 600);
  await humanType(page, value);
  await humanWait(page, 1500, 2200);
  await page.keyboard.press('ArrowDown');
  await humanWait(page, 300, 500);
  await page.keyboard.press('Enter');
  await humanWait(page, 500, 900);
}

// Open a year dropdown and click the matching year option
async function selectYearFromDropdown(page, dropdownSelector, year, timeout = 5000) {
  const dropdown = await page.waitForSelector(dropdownSelector, { timeout });
  await dropdown.scrollIntoViewIfNeeded();
  await humanWait(page, 400, 700);
  await humanClick(page, await dropdown.boundingBox());
  await humanWait(page, 800, 1400);

  const yearXpath = `xpath=//div[@role="option"][.//span[text()="${year}"]]`;
  const option = await page.waitForSelector(yearXpath, { timeout: 5000 });
  await option.scrollIntoViewIfNeeded();
  await humanWait(page, 300, 500);
  await humanClick(page, await option.boundingBox());
  await humanWait(page, 500, 900);
}

// ========================= SAVE + VERIFY =========================

// A FB inline Save button is "disabled" (aria-disabled="true") until the form
// holds VALID, ACCEPTED input — e.g. a city/company typeahead suggestion was
// actually selected, not merely typed. Clicking it while disabled is a SILENT
// no-op: the form keeps its unsaved changes, the section looks done, and the
// next sidebar navigation pops the "Leave Page?" modal ("You have unsaved
// changes to your profile."). This is the root cause of the "reported saved but
// wasn't" bug. A robust save MUST (a) wait for the button to leave the disabled
// state and (b) treat "never enabled" as a fill failure, NOT a save.
async function saveButtonEnabled(handle) {
  if (!handle) return false;
  const disabled = await handle.getAttribute('aria-disabled').catch(() => null);
  return disabled !== 'true';
}

async function querySave(page, saveSelector) {
  try {
    return await page.$(saveSelector);
  } catch {
    return null;
  }
}

// Generic inline-panel Save button (no aria-label) — target the role=button
// ANCESTOR (it carries aria-disabled), never the inner <span> (which doesn't).
const GENERIC_SAVE = 'xpath=//div[@role="button"][.//span[text()="Save"]]';

// Wait for the save button to become enabled, then humanClick it. Returns false
// if it's missing or never leaves aria-disabled="true" (input not accepted).
async function clickSaveWhenEnabled(page, saveSelector, { enableTimeout = 10000 } = {}) {
  let el = await querySave(page, saveSelector);
  if (!el) {
    try {
      el = await page.waitForSelector(saveSelector, { timeout: 4000 });
    } catch {
      console.warn(`  [setup_about] Save button not found: ${saveSelector}`);
      return false;
    }
  }

  const deadline = Date.now() + enableTimeout;
  while (Date.now() < deadline) {
    if (await saveButtonEnabled(el)) break;
    await humanWait(page, 400, 700);
    el = (await querySave(page, saveSelector)) || el; // re-resolve — FB re-renders the node
  }

  if (!(await saveButtonEnabled(el))) {
    console.warn(
      `  [setup_about] Save stayed DISABLED — input not accepted, NOT saved (${saveSelector})`
    );
    return false;
  }

  await el.scrollIntoViewIfNeeded();
  await humanWait(page, 300, 500);
  const box = await el.boundingBox();
  if (!box) return false;
  await humanClick(page, box);
  await humanWait(page, 800, 1400);
  return true;
}

// Confirm the form actually committed: the save button (and its inline form)
// disappears once FB accepts the change. Returns true once it's gone.
async function waitForSaveComplete(page, saveBtnSelector, panelButtonText, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await humanWait(page, 4000, 7000);

    let saveVisible = false;
    try {
      const el = await querySave(page, saveBtnSelector);
      saveVisible = el ? await el.isVisible().catch(() => false) : false;
    } catch {
      saveVisible = false;
    }

    if (!saveVisible) {
      console.log(`  [setup_about] Save confirmed (form closed): "${panelButtonText}"`);
      return true;
    }

    console.log(
      `  [setup_about] Save button still visible (attempt ${attempt}/${maxRetries}) — waiting...`
    );
  }

  console.warn(
    `  [setup_about] Save button still present after retries — "${panelButtonText}" likely NOT saved`
  );
  return false;
}

// One-shot save: wait-for-enabled → click → confirm the form closed. The single
// save entry point for every inline panel. Returns true ONLY on a verified save
// (button was enabled, clicked, and the form committed/closed).
async function commitSave(page, saveSelector, panelButtonText, opts = {}) {
  const clicked = await clickSaveWhenEnabled(page, saveSelector, opts);
  if (!clicked) return false;
  return waitForSaveComplete(page, saveSelector, panelButtonText);
}

// For work/education panels (generic span Save). Returns verified-save boolean.
async function saveDialog(page) {
  const ok = await commitSave(page, GENERIC_SAVE, 'Save');
  if (!ok) console.warn('  [setup_about] Dialog/panel save not confirmed');
  return ok;
}

// For bio save — try the aria-label button first, then the generic span button.
// Returns verified-save boolean.
async function savePanelForm(page) {
  let ok = await commitSave(page, 'div[role="button"][aria-label="Save"]', 'About you');
  if (!ok) ok = await commitSave(page, GENERIC_SAVE, 'About you');
  if (!ok) console.warn('  [setup_about] Bio panel save not confirmed');
  return ok;
}

// ========================= SECTION HANDLERS =========================

async function setBio(page, bio) {
  if (!bio) return true;
  console.log('  [setup_about] Setting bio...');

  const navigated = await clickSubsection(page, 'directory_intro', 'Intro');
  if (!navigated) {
    console.log('  [setup_about] Intro section not found — skipping bio');
    return true;
  }

  const opened = await clickPanelButton(page, 'About you');
  if (!opened) return true; // already set or panel absent — not a save failure

  const filled = await fillInput(
    page,
    ['textarea[aria-describedby]', 'xpath=//textarea[@maxlength="101"]'],
    bio
  );

  if (!filled) {
    console.log('  [setup_about] Bio textarea not found');
    return true;
  }

  await humanWait(page, 500, 1000);
  const saved = await savePanelForm(page);
  if (!saved) console.warn('  [setup_about] Bio NOT saved');
  return saved;
}

async function setWork(page, workEntries) {
  if (!workEntries || workEntries.length === 0) return true;
  console.log(`  [setup_about] Adding ${workEntries.length} work entry(ies)...`);

  // Sidebar link text is "Work experience"
  const navigated = await clickSubsection(page, 'directory_work', 'Work experience');
  if (!navigated) {
    console.log('  [setup_about] Work section not found — skipping');
    return true;
  }

  // Wait for the "Work experience" panel button to appear — confirms section is fully rendered
  try {
    await page.waitForSelector('xpath=//div[@role="button"][.//span[text()="Work experience"]]', {
      timeout: 8000,
    });
  } catch {
    console.log('  [setup_about] "Work experience" button not found — skipping work section');
    return true;
  }

  // Now check if Edit Workplace exists — if so, entries already added, skip
  const alreadyHasWork = await page
    .$('[aria-label="Edit Workplace"]')
    .then((el) => !!el)
    .catch(() => false);
  if (alreadyHasWork) {
    console.log('  [setup_about] Work data already exists — skipping');
    return true;
  }

  let ok = true;
  for (const work of workEntries) {
    console.log(`  [setup_about] Adding work: ${work.company}`);

    // Open the work form — same inline panel pattern as Intro / Personal Details
    const clicked = await clickPanelButton(page, 'Work experience');
    if (!clicked) {
      console.log('  [setup_about] "Work experience" panel button not found — skipping entry');
      continue;
    }

    try {
      // Company — type + ArrowDown + Enter to pick from suggestions
      await typeAndSelect(page, '[aria-label="Company"]', work.company);

      // Position — same pattern
      if (work.position) {
        await typeAndSelect(page, '[aria-label="Position"]', work.position);
      }

      // Start year dropdown
      if (work.from) {
        await selectYearFromDropdown(
          page,
          '[aria-label="Edit starting date workplace year. Current selection is none"]',
          work.from
        );
      }

      // "I currently work here" checkbox — selector: input[name="is_current"]
      // Checked by default on new entries, so we only need to act if state needs to change
      try {
        const checkbox = await page.$('input[name="is_current"]');
        if (checkbox) {
          const isChecked = await checkbox.isChecked();
          if (work.current && !isChecked) {
            // Should be current but isn't checked — click to check
            await checkbox.scrollIntoViewIfNeeded();
            await humanWait(page, 300, 500);
            await humanClick(page, await checkbox.boundingBox());
            await humanWait(page, 500, 800);
          } else if (!work.current && isChecked) {
            // Not current but is checked — uncheck it so the "To" year field appears
            await checkbox.scrollIntoViewIfNeeded();
            await humanWait(page, 300, 500);
            await humanClick(page, await checkbox.boundingBox());
            await humanWait(page, 800, 1200); // wait for "To" year field to appear
          }
        }
      } catch (e) {
        console.log(`  [setup_about] Checkbox error: ${e.message}`);
      }

      // End year — only shown after unchecking "I currently work here"
      if (!work.current && work.to) {
        await selectYearFromDropdown(
          page,
          '[aria-label="Edit ending date workplace year. Current selection is none"]',
          work.to
        ).catch(() => console.log('  [setup_about] End year dropdown not found — skipping'));
      }

      // Save and verify (wait for enabled → click → confirm form closed)
      const saved = await commitSave(page, GENERIC_SAVE, 'Company');
      if (!saved) {
        console.warn(`  [setup_about] Work entry NOT saved (${work.company})`);
        ok = false;
      }
    } catch (e) {
      console.log(`  [setup_about] Work entry error (${work.company}): ${e.message}`);
      ok = false;
    }
  }
  return ok;
}

async function setEducation(page, education) {
  if (!education) return true;
  console.log('  [setup_about] Adding education...');

  const navigated = await clickSubsection(page, 'directory_education', 'Education');
  if (!navigated) {
    console.log('  [setup_about] Education section not found — skipping');
    return true;
  }

  let ok = true;

  // ---- College ----
  if (education.college && education.college.name) {
    const col = education.college;

    await humanWait(page, 1000, 2000);
    const alreadyHasCollege = await page
      .waitForSelector('[aria-label="Edit college"]', { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (alreadyHasCollege) {
      console.log('  [setup_about] College data already exists — skipping');
    } else {
      const opened = await clickPanelButton(page, 'College');
      if (opened) {
        try {
          // College name — typeAndSelect (type + ArrowDown + Enter)
          await typeAndSelect(page, '[aria-label="College name"]', col.name);

          if (col.from) {
            await selectYearFromDropdown(
              page,
              '[aria-label="Edit starting date college year. Current selection is none"]',
              col.from
            );
          }

          if (col.to) {
            await selectYearFromDropdown(
              page,
              '[aria-label="Edit ending date college year. Current selection is none"]',
              col.to
            );
          }

          // Graduated — default unchecked (aria-checked="false"), only click if graduated: true
          if (col.graduated) {
            const checkbox = await page.$('input[aria-label="Graduated"]');
            if (checkbox) {
              const isChecked = await checkbox.isChecked();
              if (!isChecked) {
                await checkbox.scrollIntoViewIfNeeded();
                await humanWait(page, 300, 500);
                await humanClick(page, await checkbox.boundingBox());
                await humanWait(page, 500, 800);
              }
            }
          }

          const saved = await commitSave(page, GENERIC_SAVE, 'College');
          if (!saved) {
            console.warn('  [setup_about] College NOT saved');
            ok = false;
          }
        } catch (e) {
          console.log(`  [setup_about] College error: ${e.message}`);
          ok = false;
        }
      }
    }
  }

  // ---- High school ----
  if (education.highSchool && education.highSchool.name) {
    const hs = education.highSchool;

    await humanWait(page, 1000, 2000);
    const alreadyHasHs = await page
      .waitForSelector('[aria-label="Edit school"]', { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (alreadyHasHs) {
      console.log('  [setup_about] High school data already exists — skipping');
    } else {
      const opened = await clickPanelButton(page, 'High school');
      if (opened) {
        try {
          // School name — typeAndSelect
          await typeAndSelect(page, '[aria-label="School"]', hs.name);

          if (hs.from) {
            await selectYearFromDropdown(
              page,
              '[aria-label="Edit starting date secondary school year. Current selection is none"]',
              hs.from
            );
          }

          if (hs.to) {
            await selectYearFromDropdown(
              page,
              '[aria-label="Edit ending date secondary school year. Current selection is none"]',
              hs.to
            );
          }

          // Graduated — same checkbox pattern as college
          if (hs.graduated) {
            const checkbox = await page.$('input[aria-label="Graduated"]');
            if (checkbox) {
              const isChecked = await checkbox.isChecked();
              if (!isChecked) {
                await checkbox.scrollIntoViewIfNeeded();
                await humanWait(page, 300, 500);
                await humanClick(page, await checkbox.boundingBox());
                await humanWait(page, 500, 800);
              }
            }
          }

          const saved = await commitSave(page, GENERIC_SAVE, 'High school');
          if (!saved) {
            console.warn('  [setup_about] High school NOT saved');
            ok = false;
          }
        } catch (e) {
          console.log(`  [setup_about] High school error: ${e.message}`);
          ok = false;
        }
      }
    }
  }
  return ok;
}

// City, hometown, relationship — all live in Personal Details
async function setPersonalDetails(page, city, hometown, personal) {
  const needsCity = !!city;
  const needsHometown = !!hometown;
  const needsRelStatus = !!(personal && personal.relationshipStatus);

  if (!needsCity && !needsHometown && !needsRelStatus) return true;

  console.log('  [setup_about] Setting personal details...');

  const navigated = await clickSubsection(page, 'directory_personal_details', 'Personal details');
  if (!navigated) {
    console.log('  [setup_about] Personal Details section not found — skipping');
    return true;
  }

  let ok = true;

  // ---- Current city ----
  if (needsCity) {
    const opened = await clickPanelButton(page, 'Current city or town');
    if (opened) {
      try {
        await typeAndSelect(page, '[aria-label="Current city"]', city);

        const saved = await commitSave(
          page,
          '[aria-label="Current city save"]',
          'Current city or town'
        );
        if (!saved) {
          console.warn('  [setup_about] Current city NOT saved');
          ok = false;
        }
      } catch (e) {
        console.log(`  [setup_about] City input error: ${e.message}`);
        ok = false;
      }
    }
  }

  // ---- Hometown ----
  if (needsHometown) {
    const opened = await clickPanelButton(page, 'Hometown');
    if (opened) {
      try {
        await typeAndSelect(page, '[aria-label="Hometown"]', hometown, 6000);

        const saved = await commitSave(page, '[aria-label="Hometown save"]', 'Hometown');
        if (!saved) {
          console.warn('  [setup_about] Hometown NOT saved');
          ok = false;
        }
      } catch (e) {
        console.log(`  [setup_about] Hometown input error: ${e.message}`);
        ok = false;
      }
    }
  }

  // ---- Relationship status ----
  if (needsRelStatus) {
    const opened = await clickPanelButton(page, 'Relationship status');
    if (opened) {
      try {
        const STATUS_DISPLAY = {
          single: 'Single',
          'in a relationship': 'In a relationship',
          engaged: 'Engaged',
          married: 'Married',
          'in a civil union': 'In a civil union',
          'domestic partnership': 'In a domestic partnership',
          'in a domestic partnership': 'In a domestic partnership',
          'open relationship': 'In an open relationship',
          'in an open relationship': 'In an open relationship',
          "it's complicated": "It's complicated",
          separated: 'Separated',
          divorced: 'Divorced',
          widowed: 'Widowed',
        };
        const displayText =
          STATUS_DISPLAY[personal.relationshipStatus.toLowerCase()] || personal.relationshipStatus;

        const dropdown = await page.waitForSelector(
          '[aria-label="Select your relationship status"]',
          { timeout: 5000 }
        );
        await dropdown.scrollIntoViewIfNeeded();
        await humanWait(page, 400, 700);
        await humanClick(page, await dropdown.boundingBox());
        await humanWait(page, 800, 1400);

        const optionXpath = `xpath=//div[@role="option"][.//span[text()="${displayText}"]]`;
        const option = await page.waitForSelector(optionXpath, { timeout: 5000 });
        await option.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await humanClick(page, await option.boundingBox());
        await humanWait(page, 800, 1400);

        if (personal.relationshipStatusSince) {
          try {
            const yearDropdown = await page.waitForSelector(
              '[aria-label="Edit ending date  year. Current selection is none"]',
              { timeout: 4000 }
            );
            await yearDropdown.scrollIntoViewIfNeeded();
            await humanWait(page, 400, 700);
            await humanClick(page, await yearDropdown.boundingBox());
            await humanWait(page, 800, 1400);

            const yearXpath = `xpath=//div[@role="option"][.//span[text()="${personal.relationshipStatusSince}"]]`;
            const yearOption = await page.waitForSelector(yearXpath, { timeout: 5000 });
            await yearOption.scrollIntoViewIfNeeded();
            await humanWait(page, 300, 500);
            await humanClick(page, await yearOption.boundingBox());
            await humanWait(page, 500, 900);
          } catch (e) {
            console.log(`  [setup_about] Relationship year not found: ${e.message}`);
          }
        }

        const saved = await commitSave(page, GENERIC_SAVE, 'Relationship status');
        if (!saved) {
          console.warn('  [setup_about] Relationship status NOT saved');
          ok = false;
        }
      } catch (e) {
        console.log(`  [setup_about] Relationship status error: ${e.message}`);
        ok = false;
      }
    }
  }

  return ok;
}

// Shared: set privacy to Public inside an open panel form.
// Match the privacy button by aria-label PREFIX ("Edit privacy. Sharing with
// ...") so it works regardless of the CURRENT audience — friends of friends,
// Friends, Only me, or already Public. An exact "friends of friends" match
// silently skipped any panel whose default differed, leaving it non-public.
async function setPanelPrivacyPublic(page) {
  try {
    const privacyBtn = await page.waitForSelector('[aria-label^="Edit privacy"]', {
      timeout: 5000,
    });
    await privacyBtn.scrollIntoViewIfNeeded();
    await humanWait(page, 400, 700);
    await humanClick(page, await privacyBtn.boundingBox());
    await humanWait(page, 1000, 1800);

    const publicRadio = await page.waitForSelector(
      'xpath=//label[.//span[text()="Public"]]//input[@type="radio"]',
      { timeout: 5000 }
    );
    await publicRadio.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await publicRadio.boundingBox());
    await humanWait(page, 500, 900);

    const doneBtn = await page.waitForSelector(
      '[aria-label="Done with privacy audience selection and close dialog"]',
      { timeout: 5000 }
    );
    await doneBtn.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await doneBtn.boundingBox());
    await humanWait(page, 10000, 15000);
  } catch (e) {
    console.log(`  [setup_about] Privacy setup error: ${e.message}`);
  }
}

const ITEM_SEARCH_INPUT = 'input[aria-label="Search"][role="combobox"]';

// Clear leftover typed text from the panel's Search combobox. Reads the input
// value and stops the moment it's empty — NEVER blindly mashes Backspace, which
// would delete a just-committed interest chip once the text field runs empty
// (FB's token input removes the last chip on Backspace-when-empty).
async function clearSearchInput(page) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const val = await page.$eval(ITEM_SEARCH_INPUT, (el) => el.value).catch(() => '');
    if (!val) break; // empty — stop so a committed chip is never deleted
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(70 + Math.floor(Math.random() * 60));
  }
}

// Shared: add items via search combobox (hobbies + every interest category).
// Returns true if at least one item was actually selected from the suggestion
// dropdown. Items with no matching suggestion are skipped (NOT typed-and-left),
// because raw un-selected text keeps the Save button disabled.
async function addSearchItems(page, items, label) {
  let addedAny = false;
  for (const item of items) {
    try {
      console.log(`  [setup_about] Adding ${label}: ${item}`);
      const input = await page.waitForSelector(ITEM_SEARCH_INPUT, { timeout: 5000 });
      await input.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      await humanClick(page, await input.boundingBox());
      await humanWait(page, 200, 400);
      await humanType(page, item);
      await humanWait(page, 1500, 2500);

      // Wait for a REAL suggestion option to render, then click the first one.
      // FB serves results as <li role="option"> inside <ul role="listbox">.
      // Blind ArrowDown+Enter used to commit nothing when no option appeared,
      // leaving raw text behind → no chip → Save stayed aria-disabled.
      let option = null;
      try {
        option = await page.waitForSelector('li[role="option"]', {
          state: 'visible',
          timeout: 4000,
        });
      } catch {
        option = null;
      }

      if (!option) {
        console.warn(`  [setup_about] No suggestion for ${label} "${item}" — skipping`);
        await clearSearchInput(page);
        await humanWait(page, 300, 600);
        continue;
      }

      await option.scrollIntoViewIfNeeded().catch(() => {});
      await humanWait(page, 200, 400);
      const box = await option.boundingBox();
      if (box) {
        await humanClick(page, box);
      } else {
        // Fallback if the option has no bbox (rare) — keyboard select.
        await page.keyboard.press('ArrowDown');
        await humanWait(page, 200, 400);
        await page.keyboard.press('Enter');
      }
      await humanWait(page, 1000, 1800);
      addedAny = true;

      // Clear any residual text before the next item (safe — value-checked).
      await clearSearchInput(page);
      await humanWait(page, 300, 600);
    } catch (e) {
      console.log(`  [setup_about] ${label} error (${item}): ${e.message}`);
    }
  }
  return addedAny;
}

// Shared: open panel button → set privacy → add items → save.
// Returns verified-save boolean (true when the panel wasn't opened, or there
// was nothing addable, or the save committed; false only when items were
// actually selected but the save didn't stick).
async function fillPanelWithItems(page, panelButtonText, items) {
  if (!items || items.length === 0) return true;

  const opened = await clickPanelButton(page, panelButtonText);
  if (!opened) return true; // panel absent / already set — not a save failure

  // Confirm the panel ACTUALLY opened — its Search combobox must be present.
  // clickPanelButton can report success while a transient re-render (e.g. the
  // previous category's save still settling) means the form never mounted. If
  // the search field is missing, this is a real failure (so the profile
  // re-runs), NOT a silent "nothing to save" skip.
  const panelReady = await page
    .waitForSelector(ITEM_SEARCH_INPUT, { state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!panelReady) {
    console.warn(
      `  [setup_about] "${panelButtonText}" panel did not open (no search field) — failing for retry`
    );
    return false;
  }

  await setPanelPrivacyPublic(page);
  const addedAny = await addSearchItems(page, items, panelButtonText);

  // Panel was open but NO item matched a suggestion — nothing was selected, so
  // there's nothing to save. Returning true (instead of letting commitSave fail
  // on a disabled button) avoids re-running forever over items FB can't match.
  if (!addedAny) {
    console.warn(
      `  [setup_about] No "${panelButtonText}" items had a matching suggestion — nothing to save`
    );
    return true;
  }

  const saved = await commitSave(page, GENERIC_SAVE, panelButtonText);
  if (!saved) console.warn(`  [setup_about] "${panelButtonText}" items NOT saved`);
  return saved;
}

async function setHobbies(page, hobbies) {
  if (!hobbies || hobbies.length === 0) return true;
  console.log(`  [setup_about] Setting ${hobbies.length} hobbie(s)...`);

  const navigated = await clickSubsection(page, 'directory_activites', 'Hobbies');
  if (!navigated) {
    console.log('  [setup_about] Hobbies section not found — skipping');
    return true;
  }

  return fillPanelWithItems(page, 'Hobbies', hobbies);
}

async function setInterests(page, interests) {
  if (!interests) return true;

  const categories = [
    { key: 'music', panelText: 'Music' },
    { key: 'tvShows', panelText: 'TV shows' },
    { key: 'movies', panelText: 'Movies' },
    { key: 'games', panelText: 'Games' },
    { key: 'sportsTeams', panelText: 'Sports teams and athletes' },
  ];

  const hasAny = categories.some((c) => interests[c.key]?.length > 0);
  if (!hasAny) return true;

  console.log('  [setup_about] Setting interests...');

  const navigated = await clickSubsection(page, 'directory_interests', 'Interests');
  if (!navigated) {
    console.log('  [setup_about] Interests section not found — skipping');
    return true;
  }

  let ok = true;
  let first = true;
  for (const { key, panelText } of categories) {
    const items = interests[key];
    if (!items || items.length === 0) continue;
    // Let the previous category's save fully settle before opening the next
    // panel — opening too soon (mid re-render) was leaving the new panel's
    // search field unmounted.
    if (!first) await humanWait(page, 2500, 4000);
    first = false;
    console.log(`  [setup_about] Adding ${panelText} interests: ${items.join(', ')}`);
    const saved = await fillPanelWithItems(page, panelText, items);
    if (!saved) ok = false;
  }
  return ok;
}

async function setTravel(page, travel) {
  if (!travel || travel.length === 0) return true;

  // Normalize: accept both string "Place" and object { place: "Place", date: "..." }
  const places = travel.map((t) => (typeof t === 'string' ? t : t.place)).filter(Boolean);
  if (places.length === 0) return true;

  console.log(`  [setup_about] Setting ${places.length} travel place(s)...`);

  const navigated = await clickSubsection(page, 'directory_travel', 'Places');
  if (!navigated) {
    console.log('  [setup_about] Travel section not found — skipping');
    return true;
  }

  const opened = await clickPanelButton(page, 'Places');
  if (!opened) return true;

  await setPanelPrivacyPublic(page);

  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    try {
      // From the second place onward, click "Add places you've visited" to open a new row
      if (i > 0) {
        const addBtn = await page.waitForSelector(
          'xpath=//div[@role="button"][.//span[contains(text(),"Add places")]]',
          { timeout: 5000 }
        );
        await addBtn.scrollIntoViewIfNeeded();
        await humanWait(page, 400, 700);
        await humanClick(page, await addBtn.boundingBox());
        await humanWait(page, 800, 1400);
      }

      // Always target the LAST "Place visited" combobox — it's the newest empty one
      const inputs = await page.$$('[aria-label="Place visited"][role="combobox"]');
      const input = inputs[inputs.length - 1];
      if (!input) throw new Error('"Place visited" input not found');

      await input.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      await humanClick(page, await input.boundingBox());
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await humanWait(page, 200, 400);
      await humanType(page, place);
      await humanWait(page, 1500, 2200);
      await page.keyboard.press('ArrowDown');
      await humanWait(page, 300, 500);
      await page.keyboard.press('Enter');
      await humanWait(page, 1000, 2000);
    } catch (e) {
      console.log(`  [setup_about] Travel error (${place}): ${e.message}`);
    }
  }

  const saved = await commitSave(page, GENERIC_SAVE, 'Places');
  if (!saved) console.warn('  [setup_about] Travel places NOT saved');
  return saved;
}

// Pick the FIRST valid pronunciation radio for a name field. FB renders the
// phonetic options as radios (value="KRIS-chen", ...) plus a disabled,
// empty-value "Empty pronunciation" default and a separate type="text" custom
// input (excluded by [type=radio]). We click the first radio that is enabled
// and has a non-empty value. Returns true if one was clicked, false otherwise.
async function pickFirstPronunciationOption(page, name) {
  const radios = await page.$$(`input[name="${name}"][type="radio"]`);
  for (const radio of radios) {
    const disabled = await radio.getAttribute('disabled').catch(() => null);
    if (disabled !== null) continue; // skip the disabled "Empty pronunciation" default
    const value = (await radio.getAttribute('value').catch(() => '')) || '';
    if (!value.trim()) continue; // skip empty/none options
    await radio.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    const box = await radio.boundingBox();
    if (!box) continue;
    await humanClick(page, box);
    await humanWait(page, 500, 900);
    return true;
  }
  return false;
}

async function setNamePronunciation(page) {
  console.log('  [setup_about] Setting name pronunciation...');

  const navigated = await clickSubsection(page, 'directory_names', 'Names');
  if (!navigated) {
    console.log('  [setup_about] Names section not found — skipping');
    return true;
  }

  const opened = await clickPanelButton(page, 'Name pronunciation');
  if (!opened) return true;

  try {
    // Choose the FIRST real pronunciation option for both first and last name.
    // The radio group also contains a disabled, empty-value "Empty pronunciation"
    // default — skip it and any blank-value entry so we land on the first actual
    // phonetic option (e.g. "KRIS-chen"). Some names offer none at all; if no
    // valid option exists, there's nothing to set — clean skip, not a failure.
    const firstPicked = await pickFirstPronunciationOption(page, 'firstname-pronunciation');
    if (!firstPicked) {
      console.log('  [setup_about] No name pronunciation options offered — skipping');
      return true;
    }
    console.log('  [setup_about] Selected first pronunciation option for first name');

    // Last name — same rule as first name: pick the first valid option, and if
    // none is found, just skip it (no failure).
    const lastPicked = await pickFirstPronunciationOption(page, 'lastname-pronunciation');
    if (lastPicked) {
      console.log('  [setup_about] Selected first pronunciation option for last name');
    } else {
      console.log('  [setup_about] No last name pronunciation option — skipping');
    }

    const saved = await commitSave(page, GENERIC_SAVE, 'Name pronunciation');
    if (!saved) console.warn('  [setup_about] Name pronunciation NOT saved');
    return saved;
  } catch (e) {
    console.log(`  [setup_about] Name pronunciation error: ${e.message}`);
    return false;
  }
}

// ========================= MAIN HANDLER =========================

module.exports = async function setupAbout(page, params) {
  const {
    bio,
    city,
    hometown,
    personal,
    work,
    education,
    hobbies,
    interests,
    travel,
    userId = '',
    profileUrl = '',
  } = params;

  console.log('  [setup_about] Navigating to own profile...');
  await goToOwnProfile(page);

  // Capture canonical profile URL right after the /me redirect lands, while
  // we're still on the profile root (before clickAboutTab navigates to /about).
  // Save only when the user record's profileUrl is currently empty.
  let captured = '';
  if (!profileUrl) {
    try {
      await page.waitForURL(
        (url) => {
          const s = url.toString();
          return s.includes('facebook.com') && !/\/me(?:\/|\?|$)/.test(s);
        },
        { timeout: 10000 }
      );
    } catch (_) {
      // Redirect didn't settle in 10s — fall through and capture whatever we have.
    }
    captured = normalizeProfileUrl(page.url());
  }

  await clickAboutTab(page);

  const sections = [
    ['bio', () => setBio(page, bio)],
    ['personal details', () => setPersonalDetails(page, city, hometown, personal)],
    ['work', () => setWork(page, work)],
    ['education', () => setEducation(page, education)],
    ['hobbies', () => setHobbies(page, hobbies)],
    ['interests', () => setInterests(page, interests)],
    ['travel', () => setTravel(page, travel)],
    ['name pronunciation', () => setNamePronunciation(page)],
  ];

  // Shuffle order so each account fills sections in a different sequence
  for (let i = sections.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sections[i], sections[j]] = [sections[j], sections[i]];
  }

  // Each section returns a verified-save boolean. A section that had nothing to
  // do (no data, already set, panel absent) returns true. Only a section that
  // actually filled a form whose Save never committed returns false.
  const failed = [];
  for (const [name, run] of sections) {
    let ok = false;
    try {
      ok = await run();
    } catch (e) {
      console.warn(`  [setup_about] Section "${name}" threw: ${e.message}`);
      ok = false;
    }
    if (ok === false) failed.push(name);
  }

  // Capture the profile URL regardless — it's harmless and unrelated to saves.
  if (!profileUrl && captured && captured.includes('facebook.com')) {
    await persistProfileUrl(userId, captured);
  }

  // If ANY section's input wasn't verifiably saved, do NOT mark the profile
  // Active and do NOT stamp aboutSetAt — leaving it unstamped means the next
  // scheduled run (guarded by ifOnboardingMissing: "aboutSetAt") retries it.
  // Throw noRetry so the runner records it as a soft failure (PARTIAL) without
  // re-running the entire 7-section flow 3×.
  if (failed.length > 0) {
    console.warn(
      `  [setup_about] ${failed.length} section(s) NOT saved: ${failed.join(', ')} — leaving aboutSetAt unstamped for retry`
    );
    const err = new Error(
      `setup_about: ${failed.length} section(s) not verified-saved: ${failed.join(', ')}`
    );
    err.noRetry = true;
    throw err;
  }

  console.log('  [setup_about] Profile about setup complete — all sections verified saved');

  await markProfileSetup(userId);

  if (userId) await setOnboarding(userId, 'aboutSetAt');
};

const { humanWait, humanClick, humanType } = require('../utils/humanBehavior');

// ========================= NAVIGATION HELPERS =========================

async function goToOwnProfile(page) {
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
  await humanWait(page, 2000, 3000);
}

async function clickAboutTab(page) {
  const el = await page.$('a[href*="sk=about"][role="tab"]');
  if (!el) throw new Error('[setup_about] About tab not found on profile page');
  await el.scrollIntoViewIfNeeded();
  await humanWait(page, 300, 500);
  await humanClick(page, await el.boundingBox());
  await humanWait(page, 2000, 3000);
  console.log('  [setup_about] Clicked About tab');
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
        console.log(`  [setup_about] Navigated to subsection: ${skFragment}`);
        return true;
      }
    }
  } catch { /* fall through */ }

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
        console.log(`  [setup_about] Navigated to subsection via text: ${fallbackText}`);
        return true;
      }
    } catch { /* not found */ }
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
  const list = Array.isArray(selectors) ? selectors : selectors.split(',').map(s => s.trim());
  for (const sel of list) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await el.click();
        await humanWait(page, 200, 400);
        await page.keyboard.press('Control+a');
        await humanType(page, String(value));
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function fillCombobox(page, selectors, value) {
  if (!value) return false;
  const list = Array.isArray(selectors) ? selectors : selectors.split(',').map(s => s.trim());
  for (const sel of list) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
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
          if (box) { await humanClick(page, box); return true; }
        }
        await page.keyboard.press('Enter');
        return true;
      }
    } catch { /* try next */ }
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
        const matches = pattern instanceof RegExp ? pattern.test(label) : label.toLowerCase().includes(pattern.toLowerCase());
        if (matches) {
          await sel.scrollIntoViewIfNeeded();
          await humanWait(page, 200, 400);
          await sel.selectOption(str);
          await humanWait(page, 300, 600);
          return true;
        }
      }
    } catch { /* continue */ }

    try {
      const pat = pattern instanceof RegExp ? pattern.source : pattern;
      const el = await page.$(`[aria-label="${pat}"]`);
      if (el && await el.isVisible()) {
        await el.scrollIntoViewIfNeeded();
        await humanWait(page, 200, 400);
        await el.click();
        await page.keyboard.press('Control+a');
        await humanType(page, str);
        return true;
      }
    } catch { /* continue */ }
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
        if (box) { await humanClick(page, box); await humanWait(page, 300, 600); }
      }
      return true;
    } catch { /* try next */ }
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

// After clicking save:
// 1. Wait 10-15s
// 2. Check if the save button is still visible — if yes, wait 5-10s and retry (up to maxRetries)
// 3. Once save button is gone, check if the panel button (that opened the form) is also gone
//    — if gone: form saved and closed successfully → return true
//    — if still there: form may have reset without saving → return false (caller can retry)
async function waitForSaveComplete(page, saveBtnSelector, panelButtonText, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await humanWait(page, 10000, 15000);

    // Check if save button is still visible
    let saveVisible = false;
    try {
      const el = await page.$(saveBtnSelector);
      saveVisible = el ? await el.isVisible().catch(() => false) : false;
    } catch { saveVisible = false; }

    if (saveVisible) {
      console.log(`  [setup_about] Save button still visible (attempt ${attempt}/${maxRetries}), waiting more...`);
      await humanWait(page, 5000, 10000);
      continue;
    }

    // Save button gone — verify the panel button (form open trigger) also closed
    let panelGone = true;
    try {
      const panelXpath = `xpath=//div[@role="button"][.//span[text()="${panelButtonText}"]]`;
      const el = await page.$(panelXpath);
      // If the panel button is back in the DOM it means the form closed (success for most cases)
      // BUT if the panel button XPath still matches the un-filled state label, save may not have stuck
      panelGone = !el;
    } catch { panelGone = true; }

    if (panelGone) {
      console.log(`  [setup_about] Save confirmed: "${panelButtonText}"`);
      return true;
    }

    // Panel button still showing with original text — save likely didn't stick
    console.log(`  [setup_about] Panel button "${panelButtonText}" still showing after save — may not have saved`);
    return false;
  }

  console.log(`  [setup_about] Max retries reached for "${panelButtonText}" — moving on`);
  return false;
}

// For work/education dialogs (real <button> save, whole dialog closes)
async function saveDialog(page) {
  const saved =
    await clickButton(page, /^save$/i, 4000) ||
    await clickButton(page, /save changes/i, 3000) ||
    await clickByText(page, 'Save', 3000);

  if (!saved) { console.log('  [setup_about] Save button not found — dialog may have auto-closed'); return; }

  // Wait and verify dialog closed
  for (let attempt = 1; attempt <= 3; attempt++) {
    await humanWait(page, 10000, 15000);
    const dialogStillOpen = await page.$('[role="dialog"]').then(el => el?.isVisible().catch(() => false)).catch(() => false);
    if (!dialogStillOpen) { console.log('  [setup_about] Dialog closed — save confirmed'); return; }
    console.log(`  [setup_about] Dialog still open (attempt ${attempt}/3), waiting more...`);
    await humanWait(page, 5000, 10000);
  }
  console.log('  [setup_about] Dialog may still be open — moving on');
}

// For bio save (div[role="button"][aria-label="Save"])
async function savePanelForm(page) {
  try {
    const el = await page.waitForSelector('div[role="button"][aria-label="Save"]', { timeout: 4000 });
    await el.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await el.boundingBox());
    await waitForSaveComplete(page, 'div[role="button"][aria-label="Save"]', 'About you');
    return;
  } catch { /* fall through */ }

  try {
    const el = await page.waitForSelector('xpath=//div[@role="button"]//span[text()="Save"]', { timeout: 3000 });
    await el.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await el.boundingBox());
    await waitForSaveComplete(page, 'xpath=//div[@role="button"]//span[text()="Save"]', 'About you');
    return;
  } catch { /* fall through */ }

  console.log('  [setup_about] Panel save button not found');
}

// ========================= SECTION HANDLERS =========================

async function setBio(page, bio) {
  if (!bio) return;
  console.log('  [setup_about] Setting bio...');

  const navigated = await clickSubsection(page, 'directory_intro', 'Intro');
  if (!navigated) { console.log('  [setup_about] Intro section not found — skipping bio'); return; }

  const opened = await clickPanelButton(page, 'About you');
  if (!opened) return;

  const filled = await fillInput(page, [
    'textarea[aria-describedby]',
    'xpath=//textarea[@maxlength="101"]'
  ], bio);

  if (!filled) { console.log('  [setup_about] Bio textarea not found'); return; }

  await humanWait(page, 500, 1000);
  await savePanelForm(page);
}

async function setWork(page, workEntries) {
  if (!workEntries || workEntries.length === 0) return;
  console.log(`  [setup_about] Adding ${workEntries.length} work entry(ies)...`);

  // Sidebar link text is "Work experience"
  const navigated = await clickSubsection(page, 'directory_work', 'Work experience');
  if (!navigated) { console.log('  [setup_about] Work section not found — skipping'); return; }

  // Wait for the work section to render, then check for existing entries
  await humanWait(page, 1500, 2500);
  const alreadyHasWork = await page.waitForSelector('[aria-label="Edit Workplace"]', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (alreadyHasWork) {
    console.log('  [setup_about] Work data already exists — skipping');
    return;
  }

  for (const work of workEntries) {
    console.log(`  [setup_about] Adding work: ${work.company}`);

    // Open the work form — same inline panel pattern as Intro / Personal Details
    const clicked = await clickPanelButton(page, 'Work experience');
    if (!clicked) { console.log('  [setup_about] "Work experience" panel button not found — skipping entry'); continue; }

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

      // Save and verify — check that Company input disappears (form closed)
      const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 5000 });
      await saveBtn.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      await humanClick(page, await saveBtn.boundingBox());
      await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', 'Company');
    } catch (e) {
      console.log(`  [setup_about] Work entry error (${work.company}): ${e.message}`);
    }
  }
}

async function setEducation(page, education) {
  if (!education) return;
  console.log('  [setup_about] Adding education...');

  const navigated = await clickSubsection(page, 'directory_education', 'Education');
  if (!navigated) { console.log('  [setup_about] Education section not found — skipping'); return; }

  // ---- College ----
  if (education.college && education.college.name) {
    const col = education.college;

    await humanWait(page, 1000, 2000);
    const alreadyHasCollege = await page.waitForSelector('[aria-label="Edit college"]', { timeout: 4000 })
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

          const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 5000 });
          await saveBtn.scrollIntoViewIfNeeded();
          await humanWait(page, 300, 500);
          await humanClick(page, await saveBtn.boundingBox());
          await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', 'College');
        } catch (e) {
          console.log(`  [setup_about] College error: ${e.message}`);
        }
      }
    }
  }

  // ---- High school ----
  if (education.highSchool && education.highSchool.name) {
    const hs = education.highSchool;

    await humanWait(page, 1000, 2000);
    const alreadyHasHs = await page.waitForSelector('[aria-label="Edit school"]', { timeout: 4000 })
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

          const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 5000 });
          await saveBtn.scrollIntoViewIfNeeded();
          await humanWait(page, 300, 500);
          await humanClick(page, await saveBtn.boundingBox());
          await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', 'High school');
        } catch (e) {
          console.log(`  [setup_about] High school error: ${e.message}`);
        }
      }
    }
  }
}

// City, hometown, relationship — all live in Personal Details
async function setPersonalDetails(page, city, hometown, personal) {
  const needsCity      = !!city;
  const needsHometown  = !!hometown;
  const needsRelStatus = !!(personal && personal.relationshipStatus);

  if (!needsCity && !needsHometown && !needsRelStatus) return;

  console.log('  [setup_about] Setting personal details...');

  const navigated = await clickSubsection(page, 'directory_personal_details', 'Personal details');
  if (!navigated) { console.log('  [setup_about] Personal Details section not found — skipping'); return; }

  // ---- Current city ----
  if (needsCity) {
    const opened = await clickPanelButton(page, 'Current city or town');
    if (opened) {
      try {
        await typeAndSelect(page, '[aria-label="Current city"]', city);

        const saveBtn = await page.waitForSelector('[aria-label="Current city save"]', { timeout: 4000 });
        await saveBtn.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await humanClick(page, await saveBtn.boundingBox());
        await waitForSaveComplete(page, '[aria-label="Current city save"]', 'Current city or town');
      } catch (e) {
        console.log(`  [setup_about] City input error: ${e.message}`);
      }
    }
  }

  // ---- Hometown ----
  if (needsHometown) {
    const opened = await clickPanelButton(page, 'Hometown');
    if (opened) {
      try {
        await typeAndSelect(page, '[aria-label="Hometown"]', hometown, 6000);

        const saveBtn = await page.waitForSelector('[aria-label="Hometown save"]', { timeout: 4000 });
        await saveBtn.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await humanClick(page, await saveBtn.boundingBox());
        await waitForSaveComplete(page, '[aria-label="Hometown save"]', 'Hometown');
      } catch (e) {
        console.log(`  [setup_about] Hometown input error: ${e.message}`);
      }
    }
  }

  // ---- Relationship status ----
  if (needsRelStatus) {
    const opened = await clickPanelButton(page, 'Relationship status');
    if (opened) {
      try {
        const STATUS_DISPLAY = {
          'single':                    'Single',
          'in a relationship':         'In a relationship',
          'engaged':                   'Engaged',
          'married':                   'Married',
          'in a civil union':          'In a civil union',
          'domestic partnership':      'In a domestic partnership',
          'in a domestic partnership': 'In a domestic partnership',
          'open relationship':         'In an open relationship',
          'in an open relationship':   'In an open relationship',
          "it's complicated":          "It's complicated",
          'separated':                 'Separated',
          'divorced':                  'Divorced',
          'widowed':                   'Widowed',
        };
        const displayText = STATUS_DISPLAY[personal.relationshipStatus.toLowerCase()] || personal.relationshipStatus;

        const dropdown = await page.waitForSelector('[aria-label="Select your relationship status"]', { timeout: 5000 });
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
            const yearDropdown = await page.waitForSelector('[aria-label="Edit ending date  year. Current selection is none"]', { timeout: 4000 });
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

        const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 4000 });
        await saveBtn.scrollIntoViewIfNeeded();
        await humanWait(page, 300, 500);
        await humanClick(page, await saveBtn.boundingBox());
        await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', 'Relationship status');
      } catch (e) {
        console.log(`  [setup_about] Relationship status error: ${e.message}`);
      }
    }
  }
}

// Shared: set privacy to Public inside an open panel form
async function setPanelPrivacyPublic(page) {
  try {
    const privacyBtn = await page.waitForSelector(
      '[aria-label="Edit privacy. Sharing with Your friends of friends. "]',
      { timeout: 5000 }
    );
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

// Shared: add items via search combobox (hobbies + every interest category)
async function addSearchItems(page, items, label) {
  for (const item of items) {
    try {
      console.log(`  [setup_about] Adding ${label}: ${item}`);
      const input = await page.waitForSelector('input[aria-label="Search"][role="combobox"]', { timeout: 5000 });
      await input.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      await humanClick(page, await input.boundingBox());
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await humanWait(page, 200, 400);
      await humanType(page, item);
      await humanWait(page, 1500, 2200);
      await page.keyboard.press('ArrowDown');
      await humanWait(page, 300, 500);
      await page.keyboard.press('Enter');
      await humanWait(page, 1000, 2000);
    } catch (e) {
      console.log(`  [setup_about] ${label} error (${item}): ${e.message}`);
    }
  }
}

// Shared: open panel button → set privacy → add items → save
async function fillPanelWithItems(page, panelButtonText, items) {
  if (!items || items.length === 0) return;

  const opened = await clickPanelButton(page, panelButtonText);
  if (!opened) return;

  await setPanelPrivacyPublic(page);
  await addSearchItems(page, items, panelButtonText);

  try {
    const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 5000 });
    await saveBtn.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await saveBtn.boundingBox());
    await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', panelButtonText);
  } catch (e) {
    console.log(`  [setup_about] Save error for "${panelButtonText}": ${e.message}`);
  }
}

async function setHobbies(page, hobbies) {
  if (!hobbies || hobbies.length === 0) return;
  console.log(`  [setup_about] Setting ${hobbies.length} hobbie(s)...`);

  const navigated = await clickSubsection(page, 'directory_activites', 'Hobbies');
  if (!navigated) { console.log('  [setup_about] Hobbies section not found — skipping'); return; }

  await fillPanelWithItems(page, 'Hobbies', hobbies);
}

async function setInterests(page, interests) {
  if (!interests) return;

  const categories = [
    { key: 'music',       panelText: 'Music'                        },
    { key: 'tvShows',     panelText: 'TV shows'                     },
    { key: 'movies',      panelText: 'Movies'                       },
    { key: 'games',       panelText: 'Games'                        },
    { key: 'sportsTeams', panelText: 'Sports teams and athletes'    },
  ];

  const hasAny = categories.some(c => interests[c.key]?.length > 0);
  if (!hasAny) return;

  console.log('  [setup_about] Setting interests...');

  const navigated = await clickSubsection(page, 'directory_interests', 'Interests');
  if (!navigated) { console.log('  [setup_about] Interests section not found — skipping'); return; }

  for (const { key, panelText } of categories) {
    const items = interests[key];
    if (!items || items.length === 0) continue;
    console.log(`  [setup_about] Adding ${panelText} interests: ${items.join(', ')}`);
    await fillPanelWithItems(page, panelText, items);
  }
}

async function setTravel(page, travel) {
  if (!travel || travel.length === 0) return;
  console.log(`  [setup_about] Setting ${travel.length} travel place(s)...`);

  const navigated = await clickSubsection(page, 'directory_travel', 'Places');
  if (!navigated) { console.log('  [setup_about] Travel section not found — skipping'); return; }

  const opened = await clickPanelButton(page, 'Places');
  if (!opened) return;

  await setPanelPrivacyPublic(page);

  for (let i = 0; i < travel.length; i++) {
    const { place } = travel[i];
    try {
      // From the second place onward, click "Add places you've visited" to open a new row
      if (i > 0) {
        const addBtn = await page.waitForSelector(
          'xpath=//div[@role="button"][.//span[text()="Add places you\'ve visited"]]',
          { timeout: 5000 }
        );
        await addBtn.scrollIntoViewIfNeeded();
        await humanWait(page, 400, 700);
        await humanClick(page, await addBtn.boundingBox());
        await humanWait(page, 800, 1400);
      }

      // Always target the LAST "Place visited" input — it's the newest empty one
      const inputs = await page.$$('[aria-label="Place visited"]');
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

  try {
    const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 5000 });
    await saveBtn.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await saveBtn.boundingBox());
    await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', 'Places');
  } catch (e) {
    console.log(`  [setup_about] Travel save error: ${e.message}`);
  }
}

async function setNamePronunciation(page) {
  console.log('  [setup_about] Setting name pronunciation...');

  const navigated = await clickSubsection(page, 'directory_names', 'Names');
  if (!navigated) { console.log('  [setup_about] Names section not found — skipping'); return; }

  const opened = await clickPanelButton(page, 'Name pronunciation');
  if (!opened) return;

  try {
    // First name — pick a random option (1, 2, or 3) via XPath positional index
    const firstIdx = Math.floor(Math.random() * 3) + 1;
    const firstRadio = await page.waitForSelector(
      `xpath=(//input[@name="firstname-pronunciation"])[${firstIdx}]`,
      { timeout: 5000 }
    );
    await firstRadio.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await firstRadio.boundingBox());
    await humanWait(page, 500, 900);

    // Last name — get all 3 radios and pick a random one
    const lastRadios = await page.$$('input[name="lastname-pronunciation"][type="radio"]');
    if (lastRadios.length > 0) {
      const lastIdx = Math.floor(Math.random() * lastRadios.length);
      const lastRadio = lastRadios[lastIdx];
      await lastRadio.scrollIntoViewIfNeeded();
      await humanWait(page, 300, 500);
      await humanClick(page, await lastRadio.boundingBox());
      await humanWait(page, 500, 900);
    }

    const saveBtn = await page.waitForSelector('xpath=//span[text()="Save"]', { timeout: 5000 });
    await saveBtn.scrollIntoViewIfNeeded();
    await humanWait(page, 300, 500);
    await humanClick(page, await saveBtn.boundingBox());
    await waitForSaveComplete(page, 'xpath=//span[text()="Save"]', 'Name pronunciation');
  } catch (e) {
    console.log(`  [setup_about] Name pronunciation error: ${e.message}`);
  }
}

// ========================= MAIN HANDLER =========================

module.exports = async function setupAbout(page, params) {
  const { bio, city, hometown, personal, work, education, hobbies, interests, travel } = params;

  console.log('  [setup_about] Navigating to own profile...');
  await goToOwnProfile(page);
  await clickAboutTab(page);

  await setBio(page, bio);
  await setPersonalDetails(page, city, hometown, personal);
  await setWork(page, work);
  await setEducation(page, education);
  await setHobbies(page, hobbies);
  await setInterests(page, interests);
  await setTravel(page, travel);
  await setNamePronunciation(page);

  console.log('  [setup_about] Profile about setup complete');
};

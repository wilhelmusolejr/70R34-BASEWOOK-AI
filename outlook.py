"""
=============================================================
  Multilogin X + Outlook.com Automation Script
  
  FLOW:
    1. Create profiles manually in Multilogin X UI
    2. Put profile_id in your Excel file
    3. Run this script — it will:
         - Start each profile via launcher API
         - Connect Playwright to the running browser
         - Log into Outlook.com
         - Handle all Microsoft prompts
         - Save session & stop profile

=============================================================
SETUP:
  1. pip install requests pandas openpyxl playwright python-dotenv
     playwright install chromium
  2. .env file:
       MULTILOGIN_EMAIL=your@email.com
       MULTILOGIN_PASSWORD=yourpassword
       EXCEL_FILE=credentials_template.xlsx
       OWNER_WORKSPACE_ID=dffbde94-5ea4-40c8-87fc-cf3cc1ca0d7e
       FOLDER_ID=3d5f7ab6-e082-43b3-b5cd-467f68a76d06
  3. Excel columns:
       profile_id | profile_name | username | password | proxy_host | proxy_port | proxy_user | proxy_pass
  4. Multilogin X app open & agent connected
  5. Run: python multilogin_outlook_automation.py
=============================================================
"""

import os, sys, time, hashlib, requests, pandas as pd
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

MULTILOGIN_EMAIL    = os.getenv("MULTILOGIN_EMAIL")
MULTILOGIN_PASSWORD = os.getenv("MULTILOGIN_PASSWORD")
EXCEL_FILE          = os.getenv("EXCEL_FILE", "credentials_template.xlsx")
OWNER_WORKSPACE_ID  = os.getenv("OWNER_WORKSPACE_ID")
FOLDER_ID           = os.getenv("FOLDER_ID", "")

MLX_BASE        = "https://api.multilogin.com"
MLX_LAUNCHER_V2 = "https://launcher.mlx.yt:45001/api/v2"
MLX_LAUNCHER    = "https://launcher.mlx.yt:45001/api/v1"
LOCALHOST       = "http://127.0.0.1"

HEADERS = {"Accept": "application/json", "Content-Type": "application/json"}


# ─────────────────────────────────────────
#  STEP 1 — Sign in + switch to owner workspace
# ─────────────────────────────────────────
def get_mlx_token():
    print("🔐 Signing in to Multilogin X...")
    md5_pass = hashlib.md5(MULTILOGIN_PASSWORD.encode()).hexdigest()

    r = requests.post(f"{MLX_BASE}/user/signin",
                      json={"email": MULTILOGIN_EMAIL, "password": md5_pass},
                      headers=HEADERS)
    if r.status_code != 200:
        print(f"❌ Sign-in failed: {r.text}"); sys.exit(1)

    data = r.json()["data"]
    token, refresh_token = data["token"], data["refresh_token"]
    print("  ✅ Signed in.")

    print(f"🔄 Switching to workspace: {OWNER_WORKSPACE_ID}...")
    r2 = requests.post(f"{MLX_BASE}/user/refresh_token",
                       json={"email": MULTILOGIN_EMAIL,
                             "refresh_token": refresh_token,
                             "workspace_id": OWNER_WORKSPACE_ID},
                       headers={**HEADERS, "Authorization": f"Bearer {token}"})
    if r2.status_code != 200:
        print(f"❌ Workspace switch failed: {r2.text}"); sys.exit(1)

    token = r2.json()["data"]["token"]
    print("  ✅ Workspace ready!")
    return token


# ─────────────────────────────────────────
#  STEP 2 — Start existing profile, get port
#  Official endpoint:
#  GET /api/v2/profile/f/{folder_id}/p/{profile_id}/start?automation_type=playwright
# ─────────────────────────────────────────
def start_profile(token, profile_id):
    print(f"  🚀 Starting profile {profile_id}...")
    auth = {**HEADERS, "Authorization": f"Bearer {token}"}

    url = f"{MLX_LAUNCHER_V2}/profile/f/{FOLDER_ID}/p/{profile_id}/start?automation_type=playwright"
    print(f"     GET {url}")
    r = requests.get(url, headers=auth)
    print(f"     Response: {r.status_code} — {r.text[:200]}")

    if r.status_code != 200:
        print(f"  ❌ Failed to start profile.")
        return None

    port = r.json().get("data", {}).get("port")
    if not port:
        print(f"  ❌ No port in response.")
        return None

    print(f"  ✅ Profile started on port: {port}")
    return str(port)


# ─────────────────────────────────────────
#  STEP 2b — Update proxy on existing profile
#  Called before starting if proxy columns exist in Excel
# ─────────────────────────────────────────
def update_profile_proxy(token, profile_id, proxy_host, proxy_port, proxy_user, proxy_pass):
    print(f"  🔧 Updating proxy for profile {profile_id}...")
    auth = {**HEADERS, "Authorization": f"Bearer {token}"}

    payload = {
        "parameters": {
            "proxy": {
                "type":     "HTTP",
                "host":     str(proxy_host),
                "port":     int(proxy_port),
                "username": str(proxy_user) if proxy_user else "",
                "password": str(proxy_pass) if proxy_pass else "",
            },
            "flags": {
                "proxy_masking": "custom",
            }
        }
    }

    # Try PATCH on launcher v2 first, then api base
    for url in [
        f"{MLX_LAUNCHER_V2}/profile/{profile_id}",
        f"{MLX_BASE}/profile/{profile_id}",
    ]:
        r = requests.patch(url, headers=auth, json=payload)
        if r.status_code in (200, 201):
            print(f"  ✅ Proxy updated successfully.")
            return True
        print(f"     {url} → {r.status_code}: {r.text[:100]}")

    print(f"  ⚠️  Could not update proxy — using existing profile proxy settings.")
    return False


# ─────────────────────────────────────────
#  STEP 3 — Stop profile
# ─────────────────────────────────────────
def stop_profile(token, profile_id):
    auth = {**HEADERS, "Authorization": f"Bearer {token}"}
    requests.get(f"{MLX_LAUNCHER}/profile/stop/p/{profile_id}", headers=auth)
    print(f"  🛑 Profile stopped.")


# ─────────────────────────────────────────
#  STEP 4 — Handle Microsoft prompts
#
#  Prompt order for new accounts:
#  [A] "Let's protect your account" → click "Skip for now"
#  [B] "Setting up your passkey..."  → click Cancel FAST before OS dialog
#  [C] Windows Security passkey OS dialog → can't click, handled by [B]
#  [D] "Stay signed in?"             → click Yes
#  [E] Inbox reached                 → done, take screenshot
# ─────────────────────────────────────────
def handle_microsoft_prompts(page, profile_name):
    for attempt in range(16):
        time.sleep(2)
        url = page.url
        print(f"    🔍 [{attempt+1}] {url[:70]}")

        # Always press Escape to dismiss any OS-level dialogs (passkey Windows popup)
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass

        # ── [E] microsoft.com = signed in, go to Outlook ──
        if "microsoft.com" in url and "login" not in url and "account" not in url:
            print("    ✅ Back on microsoft.com — signed in! Navigating to Outlook...")
            page.goto("https://outlook.live.com/mail/", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=15000)
            time.sleep(3)
            page.screenshot(path=f"inbox_{profile_name}.png")
            print(f"    📸 Inbox screenshot: inbox_{profile_name}.png")
            return True

        # ── [E] Directly reached Outlook inbox ──
        if "outlook.live.com/mail" in url or "outlook.office.com/mail" in url:
            print("    ✅ Inbox reached!")
            time.sleep(3)
            page.screenshot(path=f"inbox_{profile_name}.png")
            print(f"    📸 Inbox screenshot: inbox_{profile_name}.png")
            return True

        # ── [D] "Stay signed in?" — new UI uses Yes/No buttons ──
        # URL pattern: login.live.com/oauth20_authorize or kmsi
        try:
            # New style Yes button (what we see in screenshot)
            yes_btn = page.locator("button:has-text('Yes')").first
            if yes_btn.is_visible(timeout=1500):
                print("    👉 'Stay signed in?' → Yes")
                yes_btn.click(); continue
        except Exception:
            pass
        try:
            # Old style #idSIButton9
            yes_btn = page.locator("#idSIButton9")
            if yes_btn.is_visible(timeout=500):
                print("    👉 'Stay signed in?' → Yes (old UI)")
                yes_btn.click(); continue
        except Exception:
            pass

        # ── [B] Passkey pages → Cancel ──
        # Covers: /passkey, /fido, passkey enrollment, "We couldn't create a passkey"
        if "passkey" in url or "fido" in url:
            # Try all cancel selectors in order
            cancel_selectors = [
                "button[data-testid='secondaryButton']",  # "Cancel" on failure page
                "button:has-text('Cancel')",              # "Setting up your passkey" page
                "#idBtn_Back",                            # generic back/cancel
            ]
            for sel in cancel_selectors:
                try:
                    btn = page.locator(sel).first
                    if btn.is_visible(timeout=1000):
                        print(f"    👉 Passkey → Cancel ({sel})")
                        btn.click()
                        time.sleep(1)
                        break
                except Exception:
                    continue
            continue

        # ── [A] "Let's protect your account" → Skip for now ──
        try:
            skip = page.locator("a:has-text('Skip for now')").first
            if skip.is_visible(timeout=1000):
                print("    👉 Protect account → Skip for now")
                skip.click(); continue
        except Exception:
            pass

        # ── Fallback skip/cancel ──
        for sel in [
            "#idBtn_Back",
            "a[id='iCancel']", "button[id='iCancel']",
            "a:has-text('Not now')", "button:has-text('Not now')",
            "a:has-text('Skip setup')", "button:has-text('Skip setup')",
        ]:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=500):
                    print(f"    👉 Fallback ({sel})")
                    btn.click(); break
            except Exception:
                continue

    page.screenshot(path=f"debug_{profile_name}.png")
    print(f"    ⚠️  Debug screenshot: debug_{profile_name}.png")
    return False


# ─────────────────────────────────────────
#  STEP 5 — Login to Outlook.com
#
#  Flow:
#  1. Go to outlook.com
#  2. Check where it lands:
#     → already at /mail/ = already logged in, take screenshot & done
#     → redirected to microsoft.com = not logged in, proceed with login
#  3. Click Sign in → new tab → email → password → prompts
# ─────────────────────────────────────────
def login_outlook(port, username, password, profile_name):
    print(f"  🌐 Logging in: {username}")
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"{LOCALHOST}:{port}")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else context.new_page()

        try:
            # Step 1 — Go to outlook.com and see where it lands
            # Only retry on ERR_INVALID_AUTH_CREDENTIALS (bad proxy)
            # Navigation interruptions = redirect = treat as success
            print("    🔗 Navigating to outlook.com...")
            current_url = ""
            for nav_attempt in range(1, 6):
                try:
                    page.goto("https://www.microsoft.com", timeout=30000)
                    page.wait_for_load_state("networkidle", timeout=15000)
                    time.sleep(2)
                    current_url = page.url
                    print(f"    📍 Landed on: {current_url[:80]}")
                    break  # success
                except Exception as nav_err:
                    err_str = str(nav_err)
                    # Redirect/interruption = page loaded somewhere, just grab URL
                    if "interrupted by another navigation" in err_str or "ERR_ABORTED" in err_str:
                        time.sleep(2)
                        current_url = page.url
                        print(f"    📍 Redirected to: {current_url[:80]}")
                        break
                    # Proxy auth error = retry after 20s
                    elif "ERR_INVALID_AUTH_CREDENTIALS" in err_str:
                        print(f"    ⚠️  Proxy auth failed (attempt {nav_attempt}/5)")
                        if nav_attempt < 5:
                            print(f"    ⏳ Waiting 20s before retry...")
                            time.sleep(20)
                        else:
                            raise
                    # Any other error = raise immediately
                    else:
                        raise

            # Step 2 — Already logged in?
            if "outlook.live.com/mail" in current_url or "outlook.office.com/mail" in current_url:
                print(f"    ✅ Already logged in!")
                time.sleep(2)
                page.screenshot(path=f"inbox_{profile_name}.png")
                print(f"    📸 Screenshot: inbox_{profile_name}.png")
                browser.close()
                return "SUCCESS"

            # Step 3 — Not logged in, landed on microsoft.com marketing page
            print("    🔒 Not logged in — starting login flow...")

            # Click Sign in button (opens new tab)
            print("    👉 Clicking Sign in...")
            with context.expect_page() as new_page_info:
                page.locator("a#action-oc5b26").first.click()
            page = new_page_info.value
            page.wait_for_load_state("networkidle", timeout=20000)
            time.sleep(2)
            print(f"    📍 {page.url[:80]}")

            # Step 4 — Enter email
            print("    📧 Entering email...")
            page.wait_for_selector("#i0116", timeout=20000)
            page.fill("#i0116", username)
            time.sleep(1)
            page.click("#idSIButton9")
            page.wait_for_load_state("networkidle", timeout=15000)
            time.sleep(2)
            print(f"    📍 {page.url[:80]}")

            # Step 5 — Enter password
            print("    🔑 Entering password...")
            page.wait_for_selector("input[name='passwd']", timeout=15000)
            page.fill("input[name='passwd']", password)
            time.sleep(1)
            page.click("button[data-testid='primaryButton']")
            page.wait_for_load_state("networkidle", timeout=15000)
            time.sleep(2)
            print(f"    📍 {page.url[:80]}")

            # Step 6 — Handle all post-login prompts
            success = handle_microsoft_prompts(page, profile_name)

            if success:
                print(f"  ✅ Logged in: {username}")
                result = "SUCCESS"
            else:
                result = "FAILED - prompt"

        except Exception as e:
            print(f"  ❌ Error: {e}")
            try: page.screenshot(path=f"error_{profile_name}.png")
            except Exception: pass
            result = "FAILED"
        finally:
            try: page.close()
            except Exception: pass
            browser.close()
    return result


# ─────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────
def main():
    print("=" * 55)
    print("  Multilogin X + Outlook Automation")
    print("=" * 55)

    for var in ["MULTILOGIN_EMAIL", "MULTILOGIN_PASSWORD", "OWNER_WORKSPACE_ID"]:
        if not os.getenv(var):
            print(f"❌ Missing .env variable: {var}"); sys.exit(1)

    if not FOLDER_ID:
        print("❌ FOLDER_ID missing from .env"); sys.exit(1)

    print(f"\n📊 Reading Excel: {EXCEL_FILE}")
    try:
        df = pd.read_excel(EXCEL_FILE)
    except FileNotFoundError:
        print(f"❌ File not found: {EXCEL_FILE}"); sys.exit(1)

    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]

    # profile_id column is now required
    for col in ["profile_id", "username", "password"]:
        if col not in df.columns:
            print(f"❌ Missing column in Excel: '{col}'")
            print(f"   Found: {list(df.columns)}")
            sys.exit(1)

    print(f"✅ Found {len(df)} account(s).")

    token = get_mlx_token()
    results = []

    for index, row in df.iterrows():
        profile_id   = str(row["profile_id"]).strip()
        profile_name = str(row.get("profile_name", f"Profile_{index+1}"))
        username     = str(row["username"])
        password     = str(row["password"])
        proxy_host   = str(row.get("proxy_host", "") or "").strip().replace("nan", "")
        proxy_port   = str(row.get("proxy_port", "") or "").strip().replace("nan", "")
        proxy_user   = str(row.get("proxy_user", "") or "").strip().replace("nan", "")
        proxy_pass   = str(row.get("proxy_pass", "") or "").strip().replace("nan", "")

        print(f"\n[{index+1}/{len(df)}] {profile_name} ({username})")
        print("-" * 45)
        print(f"  Profile ID: {profile_id}")

        # Update proxy if provided in Excel
        if proxy_host and proxy_port:
            update_profile_proxy(token, profile_id, proxy_host, proxy_port, proxy_user, proxy_pass)

        port = start_profile(token, profile_id)
        if not port:
            results.append({"profile": profile_name, "username": username,
                            "status": "FAILED - start"}); continue

        time.sleep(3)
        status = login_outlook(port, username, password, profile_name)
        stop_profile(token, profile_id)

        results.append({"profile": profile_name, "username": username,
                        "profile_id": profile_id, "status": status})

        if index < len(df) - 1:
            print("  ⏳ Waiting 5s..."); time.sleep(5)

    print("\n" + "=" * 55)
    print("  RESULTS SUMMARY")
    print("=" * 55)
    for r in results:
        icon = "✅" if r["status"] == "SUCCESS" else "❌"
        print(f"  {icon} {r['profile']} ({r['username']}) — {r['status']}")

    pd.DataFrame(results).to_excel("automation_results.xlsx", index=False)
    print(f"\n📄 Results saved to: automation_results.xlsx")
    print("=" * 55)


if __name__ == "__main__":
    main()
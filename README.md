# TofuPalWoffu

Chrome Extension (Manifest V3) for preparing time entries in Woffu in *dry-run* mode. Features:

- Configure credentials and time blocks directly from the popup.
- Query monthly diary summary and detect days without valid time entries.
- Preview the payload (`PUT /api/diaries/{diaryId}/workday/slots/self`) for one or multiple days before sending.
- Keep data locally (`chrome.storage`) without making real submissions (dry-run mode always active by default).
- **Automatic mode**: registers every due working day unattended, using the schedule Woffu assigns to each day.

## Automatic mode

A background service worker (`scripts/background.js`) registers the workday without any interaction:

- **When**: on Chrome startup, every 30 minutes, and right after the cutoff time (default `17:31`). Today becomes due after the cutoff; past days are always due.
- **Catch-up**: each run looks back 45 days and fills every working day that is still empty, so days missed while the computer was off are registered on the next start.
- **Which days**: only editable working days with no worked time. Weekends, holidays, absences, pending requests and days that already have time are never touched (the `PUT` replaces existing slots, so it is deliberately conservative). Right before each `PUT` the day's slots are checked again.
- **Which blocks**: taken from Woffu's theoretical schedule for that date (`in`, `out`, `breaks`). No break → one block (Fridays, summer intensive schedule); with a break → `in–lunch` and `lunch+break–out`. The configured blocks are only a fallback.
- **Time zone**: UTC times are computed with the system time zone for each date, so DST changes are handled.
- **Session**: the token is read from the `woffu.token` cookie in the background, so you do not need to open Woffu. The JWT inside the cookie lasts about 360 days from login (independently of the cookie expiry) and Woffu does not reissue it while it is still valid: only a new login does. When fewer than 14 days are left you get a daily notification and a `!` badge; **Renew session** clears the cookie and opens Woffu so it logs in again (the current token is kept until it expires, so nothing is lost if the login is not completed). The new cookie is picked up automatically. If the token does expire, the extension opens Woffu in a background tab once every 12 h in case the Microsoft SSO can complete silently.
- **Feedback**: desktop notifications for registered/failed days, a red `!` badge on problems, and status + log in the popup.
- **Health check**: the popup shows a green/amber/red banner and a checklist (automatic mode enabled, scheduler alarms, session validity, Woffu API reachable with today's blocks, last run). **Test notification** checks that desktop notifications reach you.
- **Woffu schedule**: the popup summarizes the year's calendar from Woffu by periods (Mon–Thu and Friday blocks), so you can see exactly when the summer intensive schedule starts and ends (marked ☀).

Use **Simulate** in the popup to see what would be registered before enabling the toggle. Chrome must be running (it does not need a Woffu tab open).

Tests for the scheduling logic: `TZ=Europe/Madrid node --test tests/schedule.test.mjs`.

## Structure

```
woffu-extension/
  manifest.json
  popup.html
  options.html
  styles/popup.css
  scripts/
    config.js
    schedule.js
    api.js
    background.js
    popup.js
    content.js
  schemas/
    diary-summary.schema.json
    workday-slots-put.schema.json
  README.md
```

The real request examples extracted from `~/Documents/woffu/requests.txt` have been translated to JSON schemas included in `schemas/`, which serve as a guide to validate the data used by the extension.

## Chrome Installation (Developer Mode)

1. Package or copy the complete `woffu-extension/` folder to your machine.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Use **Load unpacked** and select the extension folder.
4. Pin the icon in the toolbar for quick access.

## Initial Configuration

1. Open the popup and fill in the basic fields:
   - **Base URL**: for example `https://xxxxx.woffu.com`.
   - **User ID**: your numeric identifier (e.g. `xxxxxx`).
   - **Bearer token**: paste your current Woffu JWT.
   - **Comment**: optional text that will be added to each time entry.
   - **Fallback blocks (Monday-Thursday / Friday)**: used only when Woffu does not return a schedule for the day.
2. **Data is saved automatically** when modifying any field (no need to press any button).
3. **Automatic detection**: if you open the popup while browsing `*.woffu.com`, the extension will try to automatically detect:
   - Base URL (from the domain)
   - User ID (from localStorage, sessionStorage, URL or DOM)
   - Bearer token (from localStorage, sessionStorage or requests)

## Usage Flow

1. Select the month with the picker (`YYYY-MM`).
2. Click **Load records**. The extension queries `GET /api/svc/core/diariesquery/users/{userId}/diaries/summary/presence` and filters editable pending days (no time entry, negative difference or pending requests).
3. Review the "Pending days" table:
   - Each row includes a checkbox to include/exclude the day.
   - **Smart automatic selection**:
     - ✓ **Checked by default**: days without time entry blocks
     - ✗ **NOT checked**: current day, days with "pending" status or days that already have blocks
   - Visual indicators:
     - 🟢 **"Today"**: marks the current day
     - 🟡 **"Pending"**: pending approval requests
     - 🔴 **"No blocks"**: no registered time entries (automatically checked)
     - ⚪ **"No entry"**: has blocks but negative difference
   - **Preview** button to generate the day's payload.
   - Blocks follow the schedule Woffu assigns to each day (Fridays, summer intensive schedule…).
4. Use the bottom buttons:
   - **Preview day**: takes the first selected day or the one marked with *Preview*.
   - **Preview selection**: generates an array with all checked payloads.
   - **Send selection**: sends selected days to Woffu (requires prior confirmation).
5. The result appears in the "Preview" section:
   - For previews: shows the endpoint and the payload that would be sent.
   - For submissions: shows the result of each request (success/failure) and automatically reloads records.

## Dry-run Mode and Real Submissions

- The `dryRun` flag remains visible in the configuration for reference, but no longer affects submission.
- The `buildDryRunResponse` function returns the preview structure for inspection.
- When clicking **Send selection**, the extension:
  1. Shows a confirmation dialog with the days to send
  2. Executes the `PUT` calls to the Woffu API
  3. Shows detailed result of each submission (success/failure)
  4. Automatically reloads records after 2 seconds

## Security Considerations

- The extension stores the JWT in the browser's local storage; remember to renew it manually when it expires.
- The extension tries to detect the token automatically from Woffu pages, but never sends it to third parties.
- Avoid sharing the extension folder with the embedded token.
- If you prefer to work only with test data, leave the token empty and paste responses manually in the console (`previewOutput`).

## Suggested Next Steps

- Allow importing a JSON configuration file directly.
- Add granular control per day to modify time blocks before previewing.
- Integrate notifications or badges when pending days exist.
- Implement real `PUT` conditioned by an additional security switch.

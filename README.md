# TofuPalWoffu

Chrome Extension (Manifest V3) for preparing time entries in Woffu in *dry-run* mode. Features:

- Configure credentials and time blocks directly from the popup.
- Query monthly diary summary and detect days without valid time entries.
- Preview the payload (`PUT /api/diaries/{diaryId}/workday/slots/self`) for one or multiple days before sending.
- Keep data locally (`chrome.storage`) without making real submissions (dry-run mode always active by default).

## Structure

```
woffu-extension/
  manifest.json
  popup.html
  options.html
  styles/popup.css
  scripts/
    config.js
    api.js
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
   - **UTC Offset**: automatically detected based on your timezone (considers daylight saving time).
   - **Time blocks (Monday-Thursday)**: default blocks for working days (e.g. `08:00-13:00` and `14:00-17:30`).
   - **Time blocks (Friday)**: specific blocks for Fridays (default: `08:00-15:00`).
2. **Data is saved automatically** when modifying any field (no need to press any button).
3. **Automatic detection**: if you open the popup while browsing `*.woffu.com`, the extension will try to automatically detect:
   - Base URL (from the domain)
   - User ID (from localStorage, sessionStorage, URL or DOM)
   - Bearer token (from localStorage, sessionStorage or requests)
   - UTC Offset (from browser timezone, automatically adjusting for daylight saving time)

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
   - **The extension automatically detects if it's Friday** and applies the corresponding time blocks.
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

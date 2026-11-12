# AFFS — Auto Form Fill

A Manifest V3 Chrome extension for the HyperDyn feedback portal at `http://192.168.10.72:8080/feedback/`. It imports a CSV of register numbers and submits mid-term and end-term feedback for each student in sequence.

The side panel uses [Material Web](https://material-web.dev/) components and follows the browser's light or dark theme through system colors.

## Features

- Bulk CSV and TXT import for student register numbers
- Sequential sign-in, feedback submission, sign-out, and next-student processing
- Mid-term and end-term modes, individually selectable
- Dry-run mode for checking the workflow without submitting
- Course-by-course submission with completion detection
- Per-student progress, run counters, and an activity log
- Material Web buttons, checkboxes, lists, and linear progress
- No external requests; all processing stays in the browser

## Requirements

- Google Chrome 114 or newer
- Access to `http://192.168.10.72:8080/feedback/`
- Student accounts where the username and password are the register number
- A CSV or TXT file with one register number per line (maximum 500 students, 2 MB)

## Installation

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`form-auto-fill-extension`).
5. Pin AFFS from the extensions menu, then click the toolbar icon to open the side panel.

Do not install a self-signed `.crx` directly. Current Chrome versions reject it with `CRX_REQUIRED_PROOF_MISSING`. Use **Load unpacked** for local use, or distribute the ZIP through the Chrome Web Store or enterprise policy.

## Usage

1. Open the AFFS side panel.
2. Choose **Mid-term**, **End-term**, or both.
3. Click **Import CSV** and select a CSV or TXT file. You can also drop the file on the Students card.
4. Review the student list. Pending and failed students will run.
5. Click **Start**. The automation tab opens and the extension processes each student.
6. Click **Stop** to stop after the current step. The interrupted student remains pending.

Enable **Dry run** to select a course and fill the form without submitting. Dry runs do not mark students complete.

### CSV format

```text
418IS24026
418IS24027
418IS24028
```

A header row is allowed:

```csv
Register Number
418IS24026
418IS24027
```

The first non-empty cell in each row is used. Headers such as `Register Number`, `USN`, or `Roll No` are skipped. Duplicate and invalid rows are skipped. Importing replaces the existing list.

## How it works

1. The background service worker builds a queue from pending and failed students.
2. It opens one automation tab and signs in with the register number as both username and password.
3. It opens the mid-term or end-term page and selects each available course.
4. It fills every visible rating field with a weighted random value from 1 to 5.
5. It submits the form and waits for the course to leave the dropdown. The portal's `Completed!` dialog is recorded in the activity log.
6. It signs out, then continues with the next student.

Student records and settings are stored in `chrome.storage.local`. Logs and transient run state use `chrome.storage.session`.

## Configuration

Portal URLs, DOM IDs, storage keys, and limits are defined in `constants.js`:

```javascript
const ORIGIN = 'http://192.168.10.72:8080';
const BASE = `${ORIGIN}/feedback`;
```

If the portal address changes, update `ORIGIN` in `constants.js` and the host permission and content-script match in `manifest.json`.

The content script uses these portal elements:

- Login: `input_email`, `input_password`, `j_idt11`
- Course dropdown: `k:sel`, `k:sel_input`, `k:sel_panel`, `k:sel_label`
- Mid-term ratings: `k:q*`
- End-term ratings: `k:aq*`, `k:bq*`, `k:cq*`
- Submit: `k:s2`

If the portal markup changes, update `IDS` and `PREFIXES` in `constants.js`.

## Build

The side panel bundles Material Web locally because Manifest V3 extension pages cannot load remote scripts. The build setup is in the repository's `build/` folder.

```bash
cd build
npm install
npm run build
```

The build writes `sidepanel.bundle.js` into this folder. The bundle includes Material Web, Lit, `constants.js`, and `sidepanel.js`. `sidepanel.html` loads only the bundle.

After changing `sidepanel.js` or the Material imports, rebuild the bundle and reload the extension on `chrome://extensions/`. Close and reopen the side panel to refresh its page.

## Files

```text
form-auto-fill-extension/
├── manifest.json
├── background.js
├── content.js
├── constants.js
├── sidepanel.html
├── sidepanel.css
├── sidepanel.js
├── sidepanel.bundle.js
├── icons/
├── README.md
└── THIRD_PARTY_NOTICES.md
```

## Troubleshooting

- **The side panel shows an older layout** — Reload the extension, close the side panel, and reopen it. If the extension was loaded from another folder, remove the old copy and load this folder.
- **The portal does not load** — Confirm the machine can reach `http://192.168.10.72:8080/feedback/`. Use a normal tab to test the URL first.
- **Start is disabled** — Import a CSV, select at least one feedback type, or click **Reset statuses** if all students are complete.
- **Import finds no students** — Use one register number per line, or a CSV whose first column contains the register numbers. Check the 500-student and 2 MB limits.
- **Sign-in is rejected** — The username and password must both be the student register number.
- **A student fails** — Open the activity log for the error. The student remains pending and can be retried.
- **Forms do not fill** — The portal markup may have changed. Inspect the fields and update `constants.js`.
- **`CRX_REQUIRED_PROOF_MISSING`** — Chrome blocks direct installation of self-signed CRX files. Use **Load unpacked** or deploy through enterprise policy.

For deeper diagnostics, open `chrome://extensions/`, locate AFFS, and click **Service worker** to inspect background logs.

## Privacy and security

- No data collection and no analytics
- No external requests
- Only `http://192.168.10.72:8080/*` is matched by the content script
- Student records and settings stay in local Chrome storage

## Support

- Website: [hyperdyn.in](https://hyperdyn.in)
- Email: [skandanv.is.dev@gmail.com](mailto:skandanv.is.dev@gmail.com)

## License

MIT License. See the repository `LICENSE` file for details.

Material Web and Lit are licensed under the Apache License 2.0. See `THIRD_PARTY_NOTICES.md`.

# AFFS — Auto Form Fill System

A Chrome side-panel extension for the HyperDyn feedback portal. It imports a CSV of student register numbers, logs in as each student, submits mid-term and end-term feedback, signs out, and moves to the next student.

Built with Manifest V3 and [Material Web](https://material-web.dev/) components. The interface follows the browser's light or dark theme through system colors.

[![Release](https://img.shields.io/github/v/release/ExynoxAI/AFFS?style=flat-square)](https://github.com/ExynoxAI/AFFS/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-informational?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/)

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [CSV format](#csv-format)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Privacy and security](#privacy-and-security)
- [Support](#support)
- [License](#license)
- [Version history](#version-history)

## Features

- **Bulk CSV import** — Load a list of register numbers instead of entering students one at a time.
- **Sequential automation** — For each student: sign in, submit available feedback, sign out, then continue to the next student.
- **Mid-term and end-term modes** — Run either feedback type or both.
- **Course-by-course submission** — Selects each available course, fills every rating field, submits, and waits for the portal to confirm that the course is complete.
- **Completion detection** — Confirms success when the course leaves the dropdown and the portal reports `Completed!`.
- **Dry run** — Selects a course and fills the form without submitting, so the workflow can be checked safely.
- **Material side panel** — Real Material Web controls and lists, with live run status, per-student progress, and an activity log.
- **Browser theme aware** — Uses Chrome's `Canvas`, `CanvasText`, and `AccentColor` system colors, so the panel follows the browser's light or dark theme.
- **Local only** — No analytics, telemetry, or external network requests.

## Requirements

| Requirement | Details |
| --- | --- |
| Browser | Google Chrome 114 or newer |
| Operating system | Windows, macOS, or Linux |
| Portal | `http://192.168.10.72:8080/feedback/` |
| Login | Username and password are both the student register number |
| Input file | CSV or TXT, up to 2 MB and 500 students |

The portal must be reachable from the machine running Chrome. If the portal is on a campus network, connect to that network or VPN first.

## Installation

### 1. Download the release

Download the packaged extension:

[AFFS-Release.v1.zip](https://raw.githubusercontent.com/ExynoxAI/AFFS/refs/heads/main/AFFS-Release.v1.zip)

Or clone the repository:

```bash
git clone https://github.com/ExynoxAI/AFFS.git
cd AFFS
```

### 2. Extract the archive

**Windows (PowerShell):**

```powershell
Expand-Archive -Path AFFS-Release.v1.zip -DestinationPath .
```

**macOS / Linux:**

```bash
unzip AFFS-Release.v1.zip
```

### 3. Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `form-auto-fill-extension` folder.
5. Pin AFFS from the extensions menu if it is hidden.

> **Do not install the `.crx` file directly.** Current Chrome versions reject self-signed CRX packages with `CRX_REQUIRED_PROOF_MISSING`. Load the extracted folder as an unpacked extension instead. See [Troubleshooting](#troubleshooting).

### 4. Open the side panel

Click the AFFS toolbar icon. The side panel opens on the right side of the browser.

If Chrome still shows an older layout after an update, reload the extension on `chrome://extensions/`, close the side panel, and open it again.

## Usage

1. Open the portal in a tab if you want to confirm it is reachable: `http://192.168.10.72:8080/feedback/`.
2. Open the AFFS side panel.
3. Select **Mid-term**, **End-term**, or both.
4. Click **Import CSV** and choose a CSV or TXT file. You can also drag the file onto the Students card.
5. Review the imported students. Pending and failed students will run; completed students are skipped.
6. Click **Start**.
7. Keep the automation tab open. The extension logs in, submits feedback, signs out, and continues automatically.
8. Click **Stop** to stop after the current step. The current student is left pending so it can be retried.

### Dry run

Enable **Dry run** to select the first available course and fill the rating fields without submitting. The dry run restores the student statuses after it finishes, so nothing is marked complete.

### Status meanings

| Status | Meaning |
| --- | --- |
| `Idle` | Ready. Import a CSV and start a run. |
| `Running` | A student is being processed. Keep the automation tab open. |
| `Stopping` | A stop was requested. The current step is finishing. |
| `Stopped` | The run was stopped. Pending students can be retried. |
| `Complete` | All queued students were processed. |
| `Error` | The run stopped because of a fatal error. Check the activity log. |

### Student statuses

| Status | Meaning |
| --- | --- |
| `Pending` | Waiting to run. |
| `Running` | The student is being processed now. |
| `Done` | Feedback completed, or no feedback was pending. |
| `Failed` | The student could not be processed. The message explains why. |
| `Stopped` | The student was interrupted by a stop request. |

## CSV format

The simplest format is one register number per line:

```text
418IS24026
418IS24027
418IS24028
```

A standard CSV with a header also works:

```csv
Register Number
418IS24026
418IS24027
418IS24028
```

Rules:

- The first non-empty cell in each row is used.
- A header row such as `Register Number`, `USN`, or `Roll No` is skipped.
- Duplicate register numbers are skipped.
- Invalid rows are skipped.
- The import replaces the current student list.
- Up to 500 students are imported. The file size limit is 2 MB.

## How it works

1. **Queue building** — The background service worker selects pending and failed students.
2. **Sign in** — Opens one automation tab and signs in with the register number as both username and password.
3. **Feedback pages** — Navigates to the mid-term or end-term page and reads the available courses.
4. **Course selection** — Selects the first available course and waits for the form to update.
5. **Form filling** — Fills every visible rating field with a weighted random value from 1 to 5, biased toward the lower end.
6. **Submission** — Clicks submit and waits for the course to leave the dropdown. The portal's `Completed!` dialog is recorded in the activity log.
7. **Sign out** — Opens the portal logout URL and waits for the login page.
8. **Next student** — Repeats until the queue is empty or the run is stopped.

Student records and settings are stored in `chrome.storage.local`. Activity logs and the transient run state use `chrome.storage.session`.

## Project structure

```text
form-auto-fill-extension/
├── manifest.json          # Manifest V3 configuration
├── background.js          # Run queue, tab lifecycle, persistence, logging
├── content.js             # Portal login, course selection, filling, and submission
├── constants.js           # Portal URLs, DOM IDs, storage keys, limits
├── sidepanel.html         # Side panel markup
├── sidepanel.css          # Browser-theme palette and Material token overrides
├── sidepanel.js           # Side panel controller (source)
├── sidepanel.bundle.js    # Built Material Web + side panel runtime
├── icons/                 # Extension icons (16, 32, 48, 128 px)
├── README.md              # Extension-specific documentation
└── THIRD_PARTY_NOTICES.md # Material Web and Lit license notices

build/
├── package.json           # esbuild build configuration
├── sidepanel-entry.js     # Bundle entry point
└── node_modules/          # Build dependencies, not part of the extension
```

## Configuration

Portal URLs, DOM IDs, storage keys, and limits are defined in `form-auto-fill-extension/constants.js`:

```javascript
const ORIGIN = 'http://192.168.10.72:8080';
const BASE = `${ORIGIN}/feedback`;

LOGIN_URL: `${BASE}/login.xhtml`,
MID_URL: `${BASE}/pages/student/mfeedback.xhtml`,
END_URL: `${BASE}/pages/student/efeedback.xhtml`,
LOGOUT_URL: `${BASE}/feedback/j_spring_security_logout`,
```

If the portal address changes, update `ORIGIN` in `constants.js` and the host permission and content-script match in `manifest.json`.

### Form selectors

The content script uses the portal's current element IDs:

- Login: `input_email`, `input_password`, `j_idt11`
- Course dropdown: `k:sel`, `k:sel_input`, `k:sel_panel`, `k:sel_label`
- Mid-term fields: `k:q*`
- End-term fields: `k:aq*`, `k:bq*`, `k:cq*`
- Submit: `k:s2`

If the portal markup changes, update `IDS` and `PREFIXES` in `constants.js`.

### Timing

The inter-student delay and other automation timings are controlled by the background and content scripts. The default inter-student delay is 1200 ms. Feedback waits and page-load timeouts are defined near the top of `background.js` and `content.js`.

## Development

### Build the side panel

The side panel uses real Material Web components. Because Manifest V3 extension pages cannot load remote scripts, Material Web is bundled locally with esbuild.

```bash
cd build
npm install
npm run build
```

The build writes `form-auto-fill-extension/sidepanel.bundle.js`. The bundle includes:

- `@material/web` button, checkbox, list, and linear-progress components
- Lit (the Material Web runtime)
- `constants.js`
- `sidepanel.js`

The source files remain readable; only the bundle is loaded by `sidepanel.html`.

### Reload after changes

1. Edit the source files.
2. Rebuild the bundle if `sidepanel.js` or the Material imports changed.
3. Open `chrome://extensions/` and click the reload icon on AFFS.
4. Close and reopen the side panel.

### Package a release

Zip the `form-auto-fill-extension` folder so it remains the top-level directory inside the archive:

```powershell
Compress-Archive -Path form-auto-fill-extension -DestinationPath AFFS-Release.v1.zip -Force
```

### CRX packaging

Chrome's **Pack extension** tool creates a signed `.crx` file and a `.pem` private key. Keep the `.pem` file private and out of version control. It is required to sign future updates and must never be shared.

A self-signed `.crx` cannot be installed directly in current Chrome builds; Chrome returns `CRX_REQUIRED_PROOF_MISSING`. Use the ZIP with **Load unpacked**, publish through the Chrome Web Store, or deploy through enterprise policy.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `CRX_REQUIRED_PROOF_MISSING` | Chrome blocks direct installation of self-signed CRX files. Use **Load unpacked** on the `form-auto-fill-extension` folder. |
| The portal does not load | Confirm the machine is on the network that can reach `http://192.168.10.72:8080/feedback/`. Try the URL in a normal tab first. |
| The side panel shows an older UI | Reload AFFS on `chrome://extensions/`, close the side panel, and reopen it. If the extension was loaded from a different folder, remove the old copy and load the updated `form-auto-fill-extension` folder. |
| Start is disabled | Import a CSV, select at least one feedback type, or click **Reset statuses** if every student is already complete. |
| Import finds no students | Use one register number per line, or a CSV whose first column contains the register numbers. Check the 2 MB and 500-student limits. |
| Sign-in is rejected | The username and password must both be the student register number. Confirm the account exists on the portal. |
| A student fails | Check the activity log for the specific error. The student remains eligible for the next run. |
| The feedback page is not available | The portal may have no pending feedback for that student, or the session may have expired. The log distinguishes skipped pages from failures. |
| Sign-out fails | The portal may have changed its logout URL. Check `LOGOUT_URL` in `constants.js`. |
| The side panel cannot reach the service worker | Reload the extension from `chrome://extensions/`, then reopen the side panel. |

For deeper diagnostics:

1. Open `chrome://extensions/`, locate AFFS, and click **Service worker** to inspect background logs.
2. Open DevTools on the automation tab to inspect the portal page.
3. Check the activity log in the side panel for the failing step.

## Privacy and security

- **No data collection** — The extension does not collect personal data.
- **Local processing** — All automation runs in the browser.
- **No external requests** — Student lists, credentials, and page contents stay on the machine and the configured portal.
- **Limited host access** — The content script only matches `http://192.168.10.72:8080/*`.
- **Local storage** — Student records and settings are stored in `chrome.storage.local`; logs use `chrome.storage.session`.
- **Open source** — The full source is available in this repository.

## Support

- **Issues:** [github.com/ExynoxAI/AFFS/issues](https://github.com/ExynoxAI/AFFS/issues)
- **Discussions:** [github.com/ExynoxAI/AFFS/discussions](https://github.com/ExynoxAI/AFFS/discussions)
- **Website:** [hyperdyn.in](https://hyperdyn.in)
- **Email:** [skandanv.is.dev@gmail.com](mailto:skandanv.is.dev@gmail.com)

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.

The side panel bundles [Material Web](https://github.com/material-components/material-web) and [Lit](https://github.com/lit/lit), both licensed under the Apache License 2.0. See [THIRD_PARTY_NOTICES.md](form-auto-fill-extension/THIRD_PARTY_NOTICES.md) for details.

## Version history

### v2.0.1

- Keep processing remaining courses when the dropdown is briefly empty during the portal's AJAX refresh
- End a feedback mode only when the portal reports `Completed!`
- Continue from mid-term completion into end-term feedback

### v2.0.0

- Chrome side panel replaces the popup
- Bulk CSV and TXT register-number import
- Sequential login, feedback submission, and logout for every student
- Mid-term and end-term modes, plus dry run
- Per-student progress and an activity log
- Material Web controls, lists, and progress
- Browser light/dark theme support through system colors
- Updated portal URLs for `192.168.10.72:8080`

### v1.0.0

- Initial release
- Mid-term and end-semester form detection
- Automatic subject selection and form submission
- Manual Start and Stop controls
- Minimal popup interface
- Detailed console logging

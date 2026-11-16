# Personal Bests

A personal progress web app for tracking personal-best goals. It is a static site with no backend. Data is saved as one JSON file in a private GitHub repository.

## Files
- `index.html`, `styles.css`: the page and styling (dark mode)
- `core.js`: the logic for bests, exercises and sessions, trends, the heat map, flags, and ideas (no DOM)
- `github.js`: reads and writes the data file through the GitHub Contents API
- `app.js`: the screens, menu, sync, and offline handling
- `versions.js`: the Version History content (the newest entry also powers the “app updated” pop-up). Add a new entry at the top for each change.
- `logo-flame.png`: the flame logo shown in the header
- `lock.js`: the 4-digit code screen (remembers a device for 7 days). It is a casual lock, not strong security.
- `sw.js`, `manifest.webmanifest`, `icon-v4-*.png`: installable PWA and offline support

## Setup
1. **Create a private data repository** on GitHub, for example `personal-bests-data`. It can be empty.
2. **Create a fine-grained access token** at GitHub → Settings → Developer settings → Personal access tokens. Limit it to that one repository and grant **Contents: Read and write**.
3. **Host the app.** Put these files in a repository (the code can be public, since the token is not stored in it) and turn on GitHub Pages for the `main` branch.
4. **Open the Pages URL** on your phone and desktop. Go to ☰ → Sync settings and enter your username, the data repository name, and the token. The data file (`data/personal-bests.json` by default) is created on the first save.
5. **Install it** from the browser menu (on iPhone: Share → Add to Home Screen).

## Notes
- When the app updates, a pop-up shows the new version and what changed. It appears once per version on each device.
- To ship a new version: add an entry at the top of `versions.js`, and bump `CACHE` in `sw.js`.
- Edits save about a second after you stop, and they are kept on the device while offline. They upload when the connection returns.
- If two devices save at the same moment, the most recent save wins. Each save is a commit in the data repository, so older versions are in its history.
- Changes made on one device appear on others when you open the app or return to it.

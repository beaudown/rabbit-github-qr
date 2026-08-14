# Rabbit GitHub QR

An installable local-first PWA for macOS, iPadOS, and iOS that uploads files to one GitHub repository, maintains a searchable file index, and creates direct-download QR codes for the Rabbit r1.

## What it does

- Starts by asking whether to upload files or open the existing library.
- Accepts multiple files and safely queues their bytes in IndexedDB before upload.
- Computes SHA-256 locally and writes each file to `rabbit-files/files/YYYY/MM/`.
- Mirrors the index in IndexedDB and `rabbit-files/index.json`.
- Generates a QR code, copyable URL, and direct download action for every indexed file.
- Reconciles local entries, the committed index, and the live GitHub tree.
- Automatically repairs local-only queued uploads when enabled and the original bytes are still cached.
- Gives explicit choices for GitHub-only files: Add to index, Leave + flag permanently, Archive, or Delete.
- Never automatically deletes GitHub files.
- Runs a twice-weekly GitHub Action audit and stores the result in `rabbit-files/audit-report.json`.
- Works offline for the installed app shell and local index. GitHub actions require a network connection.

## GitHub setup

1. Create a dedicated **public** repository for this app and file library. A private repository can be managed by the PWA, but an unauthenticated Rabbit cannot use its raw-file QR links.
2. Push this project to its `main` branch.
3. In **Settings → Pages**, select **GitHub Actions** as the source.
4. Create a fine-grained GitHub token limited to this repository with **Contents: read and write**.
5. Open the deployed PWA, tap **GitHub**, enter the repository and token, and connect.
6. On iPhone/iPad Safari, use **Share → Add to Home Screen**. On macOS Safari, use **File → Add to Dock**.

The token is held in `sessionStorage` only. It is not persisted in IndexedDB, committed to GitHub, logged, or cached by the service worker. Closing the browser/PWA session may require entering it again.

## File limits

The GitHub Contents API does not support files larger than 100 MB. This app uses a 95 MiB safety limit so failures occur before hashing/uploading. Larger files should use GitHub Releases or Git LFS and can then be adopted into the index by URL in a future extension.

## Local development

```bash
npm install
npm run verify
npm run dev
```

Open `http://127.0.0.1:5180/`.

## Safety and recovery

- A selected file is cached locally before GitHub upload.
- GitHub writes occur one at a time.
- A failed upload remains marked local-only when its cached bytes are available.
- Archive copies a remote file into `rabbit-files/archive/YYYY-MM-DD/` before removing the original path.
- Delete requires a confirmation dialog and Git history may permit recovery.
- Scheduled audits only write an audit report; they do not archive or delete files.

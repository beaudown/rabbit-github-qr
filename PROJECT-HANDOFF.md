# Rabbit GitHub QR — project handoff

Updated: 2026-08-14

## Status

The standalone PWA is implemented, locally verified, and published at `beaudown/rabbit-github-qr`. GitHub Pages enablement and the first live deployment are in progress.

## Purpose

Provide one installable macOS/iPadOS/iOS tool that:

1. Asks whether the user wants to upload files or open the library.
2. Uploads one or many files to a configured GitHub repository.
3. Writes a portable GitHub index and a local IndexedDB mirror.
4. Generates a direct-download QR code for every indexed file so the Rabbit r1 can scan it.
5. Reconciles local-only, indexed-but-missing, and GitHub-only files.
6. Offers Add to index, Leave + permanent flag, Archive, or confirmed Delete for GitHub-only files.
7. Audits the repository twice weekly through GitHub Actions without automatic deletion.

## Security and privacy

- Use a fine-grained token limited to the one target repository with Contents read/write.
- The token is stored only in browser `sessionStorage`; it is not written to IndexedDB, GitHub, logs, or the service-worker cache.
- A public repository is required for unauthenticated direct downloads from Rabbit QR scans. Private-repository upload works, but the generated raw URLs will require authentication and therefore are not suitable for stock Rabbit delivery.
- GitHub deletes require a confirmation dialog. The scheduled audit never deletes or archives.
- Repository settings default to `beaudown/rabbit-github-qr`, branch `main`, and root `rabbit-files`; editable changes persist in local IndexedDB. The token remains session-only.

## Canonical paths

- Project: `/Users/z3k3z/Documents/Omi Dev Space/rabbit-github-qr`
- Local index seed: `rabbit-files/index.json`
- Audit report: `rabbit-files/audit-report.json`
- Audit workflow: `.github/workflows/audit-index.yml`
- Pages workflow: `.github/workflows/deploy-pages.yml`

## Verification

- `npm test`: 4/4 passed.
- `npm run audit:index`: status `ok`, zero issues.
- `npm run build`: passed with Vite 7.3.6.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Real local browser test: first-run choice, offline upload panel, multi-file picker, queue/clear, Back navigation, local library, and console all passed.
- Responsive checks: 390×844 iPhone layout and 1024×1366 iPad layout showed no horizontal overflow.
- No GitHub token or account was used during testing; no external file upload, delete, archive, repository creation, or publication occurred.

## Publication steps

1. Create a dedicated public GitHub repository, preferably `rabbit-github-qr`.
2. Push the local `main` branch.
3. In repository Settings → Pages, choose GitHub Actions.
4. Confirm the deploy workflow succeeds and install the resulting Pages URL from Safari.
5. Create a fine-grained repository token with Contents read/write and connect the PWA.
6. Upload a harmless canary file, scan its QR, and verify the direct URL before using APKs or recovery artifacts.

## Constraints

- GitHub Contents uploads are limited to 95 MiB by the app, below the API's 100 MB maximum.
- The PWA cannot run a true iOS background job while closed. Local reconciliation runs at launch; the twice-weekly GitHub Action audits the committed repository independently.
- This project does not issue Rabbit ADB, fastboot, recovery, root, flash, install, or boot-state commands.

# gigatype.app landing

Static export currently served at **https://gigatype.app/** by Caddy on `i167`.
The production web root is `/srv/type-site`.

There is no build step in this repository: `site/` is the deployable artifact
and the source of truth for the currently published landing. Preview it locally:

```bash
python3 -m http.server 8100 --directory site
```

## Deploy

Run from the repository root:

```bash
scripts/deploy-site.sh
```

The script creates a timestamped backup next to `/srv/type-site`, uploads the
complete artifact, and then atomically synchronizes the production web root.

## Yandex.Metrica

Counter `110570567` is initialized by `metrica.js`, which is loaded from
`index.html`. The delegated download handler covers the links rendered inside
the download dialog:

- `click_button_download` — every app download;
- `click_button_download_macos` — macOS downloads;
- `click_button_download_windows` — Windows downloads;
- `click_button_download_uniq` — the visitor's first app download.

The unique-download flag is stored in `localStorage` under
`gigatype_app_downloaded`. Download navigation waits for the Metrica callback,
with an 800 ms fallback, so leaving the page does not drop the goal.

When replacing this directory with a fresh Next.js export, preserve
`metrica.js`, the script reference in `index.html`, and the `<noscript>` counter
pixel.

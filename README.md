# RSS Reader

A reading-focused RSS reader designed to run entirely on GitHub Pages. It uses static HTML, CSS, and vanilla JavaScript with no build step.

## Features

- RSS 2.0, RSS 1.0/RDF, Atom, and JSON Feed parsing
- Add feed URLs or discover feed links from publisher pages
- Feed refresh, unread and saved article views, and per-feed navigation
- Search, date filters, and newest/oldest sorting
- OPML subscription import and export
- JSON settings import and export
- Subscriptions and preferences stored in browser localStorage
- Article cache and read/saved state stored in IndexedDB
- Responsive desktop and mobile layout
- Dark mode by default, with light and system options
- Adjustable reading width and text size
- Keyboard shortcuts: / to search, j/k to navigate, s to save, r to refresh, Escape to close
- Gentium Book Plus typography

## Hosting

The GitHub Actions workflow in `.github/workflows/pages.yml` deploys the repository root to GitHub Pages. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.

## Feed access limitation

Browsers enforce cross-origin resource sharing (CORS). This reader requests feeds directly from publishers. A publisher must permit browser requests from the site's origin for its feed to load. Some feeds will fail because their publishers do not grant that permission. The project deliberately has no proxy, backend, serverless function, or external feed service.

## Local data

Subscriptions and preferences belong to the current browser profile and site origin. Export OPML and JSON backups before clearing site data or moving to another browser or device. Cached articles and reading state use IndexedDB.

## Fonts

Gentium Book Plus is loaded from the WOFF2 files in the `fonts/` directory of the `stevenfarless/misc-notes` repository. The font files are served as static assets from GitHub.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

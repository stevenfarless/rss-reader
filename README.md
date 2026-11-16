# RSS Reader

A private, reading-first RSS reader for GitHub Pages. The application is intended to run entirely in the browser using static HTML, CSS, and JavaScript.

## Project requirements

- GitHub Pages is the only hosting platform.
- No backend, serverless functions, database service, proxy, analytics, accounts, or login.
- Feed subscriptions and preferences are stored locally in the browser.
- Subscriptions are portable through OPML import/export.
- Preferences and configuration are portable through JSON import/export.
- Gentium Book Plus is the required typeface.
- Dark mode is the default, with an optional light theme.
- No build process or framework.

## Feed access

Browsers enforce cross-origin resource sharing (CORS). A publisher must permit browser requests from this site's origin for its feed to load. Some feeds will therefore be unavailable in a fully static, proxy-free reader.

## Deployment

The repository includes a GitHub Actions workflow that publishes the repository root to GitHub Pages. In the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions** if GitHub has not selected it automatically.

## Local data

Subscriptions and preferences remain in the current browser profile and site origin. Export OPML and JSON backups before clearing site data or moving to another browser or device.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

# RSS Reader

A reading-focused RSS reader designed to run entirely on GitHub Pages. It uses static HTML, CSS, and vanilla JavaScript with no build step.

## Features

- RSS 2.0, RSS 1.0/RDF, Atom, and JSON Feed parsing
- Add feed URLs or discover feed links from publisher pages
- Feed refresh, unread and saved article views, and per-feed navigation
- Feed folders: create, rename, delete, and move feeds between folders (OPML folders are kept on import)
- Unsubscribe from a feed with the × beside it in the sidebar, or from the Folders &amp; tags dialog; the feed's articles are removed, except ones you saved
- Article tags: create, rename, and delete tags; apply them from the reader (t); filter by tag from the sidebar; search covers tags
- Full-article view: "Load full article" extracts the article text from the original page
- Search, date filters, and newest/oldest sorting
- OPML subscription import and export
- JSON settings import and export
- Subscriptions and preferences stored in browser localStorage
- Article cache and read/saved state stored in IndexedDB
- Responsive desktop and mobile layout
- Dark mode by default, with light and system options
- Adjustable reading width and text size
- Keyboard shortcuts: / search, j/k navigate, n/p next/previous unread, o open, v open original, m toggle read, s save, t add a tag, a mark visible read, u back to list, g then a/u/s go to All/Unread/Saved, r refresh, Space scroll, ? help, Esc close
- Gentium Book Plus typography

## Hosting

The GitHub Actions workflow in `.github/workflows/pages.yml` deploys the repository root to GitHub Pages. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.

## Feed access

Browsers enforce cross-origin resource sharing (CORS). This reader loads feeds entirely in the page, with no backend of its own, in this order:

1. Direct fetch of the feed (works when the publisher sends permissive CORS headers).
2. The site's own WordPress REST API (`/wp-json/wp/v2/posts`), which sends permissive CORS headers even when the site's `/feed` does not.
3. A public feed-to-JSON service (rss2json), only when the user opts in under Settings ("Proxy fallback for blocked feeds"). The feed address passes through that third party, so it is off by default.

Feeds that block cross-origin requests and offer none of the above still cannot load from a browser page; that is a browser security rule, not a bug in this reader.

"Load full article" fetches the article the same way: directly, then the site's own WordPress API looked up by the article's slug (no third party involved), then — with the proxy fallback on — public reader services (a Markdown reader, then a generic proxy). Those services are free and rate-limited, and some publishers block them, so full text is not guaranteed for every site.

## Local data

Subscriptions and preferences belong to the current browser profile and site origin. Export OPML and JSON backups before clearing site data or moving to another browser or device. Cached articles and reading state use IndexedDB.

## Fonts

Gentium Book Plus is bundled locally in `fonts/`. All four WOFF2 styles are served by this repository, with no font CDN or cross-repository dependency.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

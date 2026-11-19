# RSS Reader

A reading-focused RSS reader designed to run entirely on GitHub Pages. It uses static HTML, CSS, and vanilla JavaScript with no build step.

## Features

- RSS 2.0, RSS 1.0/RDF, Atom, and JSON Feed parsing
- Search Apple Podcasts and public RSS directories (RSS.mobi and RSSAmp, plus Feedsearch for website addresses) in one deduplicated result list; add feeds directly or enter a URL manually
- Discover feed links from publisher pages
- Feed refresh, unread and saved article views, and per-feed navigation
- Feed folders: create, rename, delete, and move feeds between folders (OPML folders are kept on import)
- Unsubscribe from a feed with the × beside it in the sidebar, or from the Folders &amp; tags dialog; the feed's articles are removed, except ones you saved
- Article tags: create, rename, and delete tags; apply them from the reader (t); filter by tag from the sidebar; search covers tags
- Markdown article rendering for plain-text RSS, Atom, and JSON Feed content, including headings, links, lists, tables, and code blocks
- Full-article view: "Load full article" extracts the article text from the original page
- Listen to an article in the reader (text-to-speech, with pause/resume, stop, and speed)
- Estimated reading time on cards and in the reader
- Reader font (serif/sans-serif) and line height (compact/comfortable/roomy) in Settings
- Share an article: the system share sheet, or a copy-link fallback where the sheet is unavailable
- Mark articles above or below the selected one read (buttons in the list heading, Ctrl+M / Shift+M)
- Snooze an article (later today, tomorrow, next week) with a Snoozed view and unsnooze
- Duplicate articles (the same address in more than one feed) shown once, with a toggle in the list filters and Settings
- Mute a feed: hide its articles from All and Unread without unsubscribing
- Search, date filters, and newest/oldest sorting
- OPML subscription import and export
- JSON settings import and export
- Subscriptions and preferences stored in browser localStorage
- Article cache and read/saved state stored in IndexedDB
- Responsive desktop and mobile layout
- Collapsible sidebar: the ‹/› toggle in the top left folds the sidebar to a narrow rail, remembered across visits
- Refresh on launch when the newest article is stale, with a last-updated time under the heading
- Undo for bulk actions (mark visible read, unsubscribe)
- Article thumbnails, per-feed favicons, and relative dates ("5m ago")
- Dark mode by default, with light and system options
- Adjustable reading width and text size
- Keyboard shortcuts: / search, j/k navigate, n/p next/previous unread, o or Enter open, v open original, m toggle read, s save, t add a tag, a mark visible read, Ctrl+M / Shift+M mark above/below read, u back to list, g then a/u/s go to All/Unread/Saved, r refresh, Space scroll, ? help, Esc close
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

## Feed discovery

The Add Feed search queries Apple Podcasts, RSSAmp, and RSS.mobi. Website-address searches also query Feedsearch. Search terms are sent to those services; subscriptions and preferences remain in this browser. Results from the providers are combined and deduplicated by feed URL. Each provider is independent, so a temporary outage does not block the others.

## Local data

Subscriptions and preferences belong to the current browser profile and site origin. Export OPML and JSON backups before clearing site data or moving to another browser or device. Cached articles and reading state use IndexedDB.

## Bundled libraries

- [DOMPurify](https://github.com/cure53/DOMPurify) 3.4.18 sanitizes converted feed content before it enters the page. Its license is included in `licenses/DOMPurify-LICENSE.txt`.
- `markdown.js` is a small local Markdown renderer maintained in this repository.

## Fonts

Gentium Book Plus is bundled locally in `fonts/`. All four WOFF2 styles are served by this repository, with no font CDN or cross-repository dependency.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

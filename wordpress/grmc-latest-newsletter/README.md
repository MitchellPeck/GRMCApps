# GRMC Latest Newsletter (WordPress plugin)

Short links on the website that open the most recent **sent** Mailchimp issue
whose subject contains some text. For example, `https://<site>/grace-notes`
opens the newest issue with "grace notes" in its subject (any case).
Resends are skipped.

## Install

1. Zip this folder, then upload it under Plugins → Add New → Upload Plugin and activate it.
2. Go to Settings → Latest Newsletter (the plugin's "Settings" link goes there too).
3. Paste a Mailchimp API key (Profile → Extras → API keys → Create A Key).
   Use a key just for the website, separate from social-posts, so either can be revoked alone.
4. Check the links. Grace Notes is set up already. The "Opens now" column shows the
   issue each link currently opens, or what is wrong.

To keep the key out of the database, define it in `wp-config.php` instead:
```php
define( 'GRMC_MAILCHIMP_API_KEY', 'abc123...-us21' );
```
That key takes priority, and the settings page then shows only its last characters.

## Settings page

- **API key**: leave it blank to keep the saved key. The saved key is never sent back
  to the page; only its last 8 characters are shown.
- **Links**: a path on this site plus the text the subject must contain. Use "Add another
  link" to add one. To remove one, clear both boxes and save. Paths that belong
  to WordPress (`wp-admin`, `wp-json`, anything starting `wp-`) and duplicate paths are refused.
- Saving clears the cache, so changes take effect straight away.

## Behaviour

- Mailchimp is asked at most once every 10 minutes per link, so a new issue
  appears on the link within 10 minutes of sending.
- If Mailchimp can't be reached or the key is wrong, the link opens the last
  issue it found. With nothing found yet, it opens the home page. Errors appear on the
  settings page and in the PHP error log, prefixed "GRMC Latest Newsletter".
- The redirect is a no-cache 302, so Cloudflare and caching plugins don't keep an old target.
  If a caching plugin still serves a stale redirect, exclude the link paths in its settings.
- A link's path wins over a WordPress page with the same slug.
- Needs pretty permalinks (any setting except "Plain").

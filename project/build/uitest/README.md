# Browser check for the Crux page

Every earlier check on this project went through `pg_net` — SQL calling the
edge function. That proves the API answers. It proves nothing about whether
the page's JavaScript parses, and for a while it did not: the page returned
200 and then did nothing, because the copy in `app_page` had drifted from the
source file through repeated SQL `replace()` surgery.

These three scripts close that gap. They run the real `app.html` in Chromium.

    node stub.mjs &            # stands in for the API on :8787
    node uitest.mjs            # signs in, opens every tab, desktop and mobile
    node google-branch.mjs     # the Google sign-in path, which the stub can't serve

`uitest.mjs` fails loudly on any page error, reports the heading each tab
renders, and measures horizontal overflow at 390px. Screenshots land in the
working directory.

The stub is deliberately thin. It is not a second implementation of the API —
it returns the shapes the views actually read, so that a rename on either side
shows up as an empty column in a screenshot rather than a surprise in Pune.

## Installing the page

Do not edit `app_page.html` with SQL string operations. Install it whole:

1. Commit `app.html` and push.
2. `select net.http_get(url := '<raw.githubusercontent URL at the commit sha>');`
3. Check `md5(content)` against `md5sum app.html` before writing anything.
4. `update app_page set html = r.content from net._http_response r where r.id = <id>;`

Step 3 is the point of the exercise. The bytes that were syntax-checked are
the bytes that get served.

If Playwright cannot find a browser, point it at one:

    chromium.launch({ executablePath: '/path/to/chrome', args: ['--no-sandbox'] })

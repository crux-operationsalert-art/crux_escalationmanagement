# Sharing exposures on the Google files — both now CLOSED

Two exposures were found on 2026-08-22 by reading the Drive permissions on the two
files the tool is built from. Neither was a code bug, so no deployment addressed
them — they were sharing settings.

**Both were fixed on 2026-08-23.** Re-checked the same way they were found:

```
GET permissions 1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB
  { "role": "owner", "type": "user", "emailAddress": "operations.alert@cruxindia.co.in" }

GET permissions 18NXfmfPZh-2p-qTMUNLQ2u5FQ7aeo79hi-YN0eUJb2s
  { "role": "owner", "type": "user", "emailAddress": "shantanu.suravase@cruxindia.co.in" }
```

No `{"type":"anyone"}` entry remains on either file. This file is kept as the record
of what was exposed and what still needs checking as a result.

---

## 1. The Apps Script project was world-editable — FIXED

Was `{"role":"writer","type":"anyone"}`: anyone with the project link could edit the
source of the live web app.

Why it was the more severe of the two: the web app is published `executeAs:
USER_DEPLOYING`, and its manifest grants `https://mail.google.com/`,
`.../auth/drive` and `.../auth/spreadsheets`. Code added by a stranger would have
run **with the deploying account's authority** — able to read and rewrite the whole
datastore, send mail as Crux, and read the Gemini API key out of script properties.
It would also have let them deploy that code to the URL your users open.

### Still worth doing, because it *was* open

Removing the sharing does not tell you whether anything was changed while it was
open. Two checks, neither urgent now that the door is shut:

- In the editor, **File → See version history** (or Deploy → Manage deployments →
  version list) and look for versions nobody on the team recognises.
- Deploying this branch makes the live code equal `src/` in git, so the question
  becomes moot going forward. But anything an outsider had written to the SETTINGS
  sheet or to PropertiesService would survive a deploy — worth a look at
  Admin → Settings for values nobody set.

## 2. The datastore spreadsheet was world-readable — FIXED

Was `{"role":"reader","type":"anyone"}`: anyone with the link could read every
sheet. That is 30 employee records with names, emails, mobile numbers, employee IDs,
joining dates and reporting lines; 28 clients and 812 branches with client contact
names, mobiles and emails; the escalation and warning registers, which name
individuals; 192 email log rows including recipients and subjects; and 1,987 audit
rows — personal data about staff and about named contacts at client organisations.

Restricting it did not break the tool, as expected: the web app runs as the
deploying account and reaches the sheet with that account's own credentials, so it
never relied on the public-read setting. The read-only client portal is likewise
served by the web app, not by sharing the sheet. The only things that would break
are direct sheet links or published CSV/HTML exports used outside the app.

---

## One thing to watch, introduced by the deploy preparation

The live manifest currently carries two extra scopes that are not in
`src/appsscript.json`:

```
https://www.googleapis.com/auth/script.projects
https://www.googleapis.com/auth/script.deployments
```

They were added so the in-project `bootstrap.gs` can rewrite the project (see
DEPLOY.md). They let code in this project rewrite *any* Apps Script project the
signed-in user can edit, so they should not be permanent.

**They remove themselves:** `step2_deploy` writes `src/appsscript.json` over the
manifest and drops `bootstrap.gs`, so a completed deploy returns the project to the
clean scope set. If the deploy is abandoned instead, delete `bootstrap.gs` and
remove those two scope lines by hand.

---

## Why this was not caught earlier

The code audit read the *contents* of both files. Sharing settings are metadata, and
they were only checked when verifying whether an ownership transfer had landed. That
was a gap in the review, not a subtlety of the system: "who can open this file"
should have been among the first questions asked, and section 39 of the brief asks
for exactly that.

Neither could be fixed from the session that found them. The Drive tools available
there can *add* or *raise* access for a named address (`share_file`) and can change
a file's title or folder (`update_file`), but neither can remove an `anyone`
permission.

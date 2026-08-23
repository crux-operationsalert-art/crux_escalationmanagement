# Two live exposures found on the Google files — fix these first

Found 2026-08-22 by reading the Drive permissions on the two files the tool is
built from. Neither is a code bug, so **no deployment fixes them**. Both are
sharing settings, and both are fixed with a few clicks.

These are separate from, and more severe than, the `?t=` token bypass that the
code changes on this branch address.

---

## 1. The Apps Script project is world-editable

```
GET permissions 1pueB41g1P2lzQDcGz3aIQrXlfRME6voGWddfL2bRTDz2ZN54aSONbnFB
  { "role": "writer", "type": "anyone" }        <-- anyone with the link can EDIT
  { "role": "owner",  "type": "user", "emailAddress": "operations.alert@cruxindia.co.in" }
```

Anyone who has the project link can change the source of the live web app.

Why that is the worst of the two: the web app is published `executeAs:
USER_DEPLOYING`, and its manifest grants `https://mail.google.com/`,
`.../auth/drive` and `.../auth/spreadsheets`. So code added by a stranger would
run **with the deploying account's authority** — able to read and rewrite the
whole datastore, send mail as Crux, and read the Gemini API key out of script
properties. It would also let them deploy that code to the URL your users open.

**Fix:** open the project → **Share** → under *General access*, change
**Anyone with the link** to **Restricted**. Then check the named list and remove
anyone who should not have edit access.

**Then audit what is there now.** Because this was open, the current live code
cannot be assumed to be what anyone intended. Two checks:

- In the editor, **File → See version history** (or Deploy → Manage deployments →
  version list) and look for versions nobody on the team recognises.
- After deploying this branch, the live code equals `src/` in git, so the question
  becomes moot going forward — but anything already written to the SETTINGS sheet
  or PropertiesService by an outsider would survive a deploy. Worth a look at
  Admin → Settings for values nobody set.

---

## 2. The datastore spreadsheet is world-readable

```
GET permissions 18NXfmfPZh-2p-qTMUNLQ2u5FQ7aeo79hi-YN0eUJb2s
  { "role": "reader", "type": "anyone" }        <-- anyone with the link can READ
  { "role": "owner",  "type": "user", "emailAddress": "shantanu.suravase@cruxindia.co.in" }
```

Anyone with the link can read every sheet. That is 30 employee records with names,
emails, mobile numbers, employee IDs, joining dates and reporting lines; 28 clients
and 812 branches with client contact names, mobiles and emails; the escalation and
warning registers, which name individuals; 192 email log rows including recipients
and subjects; and 1,987 audit rows.

This is personal data about staff and named contacts at client organisations.

**Fix:** open the spreadsheet → **Share** → *General access* → **Restricted**.

**This does not break the tool.** The web app runs as the deploying account and
reaches the sheet with that account's own credentials, so it never relies on the
public-read setting. The read-only client portal is likewise served by the web app,
not by sharing the sheet. The only things that would break are any direct
sheet links or published CSV/HTML exports someone is using outside the app — worth
asking the team before you flip it, but not a reason to leave it open.

---

## Why this was not caught earlier, and why I could not fix it

The code audit read the *contents* of both files. Sharing settings are metadata,
and I only looked at them when checking whether an ownership transfer had landed.
That was a gap in my own review, not a subtlety of the system: "who can open this
file" should have been among the first questions asked, and section 39 of the brief
asks for exactly that.

I could not fix either one from here. The Drive tools available to this session can
*add* or *raise* access for a named address (`share_file`) and can change a file's
title or folder (`update_file`), but neither can remove an `anyone` permission, and
`script.google.com` and `drive.google.com` are blocked by this environment's egress
policy so the Share dialog is unreachable.

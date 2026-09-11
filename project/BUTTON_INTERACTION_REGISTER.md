# BUTTON & INTERACTION REGISTER — Crux App v2

Covers `Crux App v2.dc.html` and its child `OrgChairCard.dc.html`.
This file records **how** every interactive element is verified, and the current
census. It replaces per-button prose, which cannot be kept true at this scale.

---

## 1. Why this is a detector and not a table

248 buttons × 16 chairs × 13 routes is ~51,000 role/route/control combinations.
A hand-written table of that goes stale the moment anyone edits a screen, and
the previous audit failed precisely because it *asserted* completeness instead of
testing it. So the register is a **program that re-derives the answer**, plus the
census it produced.

Clicking every control in the browser was tried first and abandoned: each route
render costs ~700 ms, so a full sweep exceeds every timeout available. Static
analysis of the source covers all roles at once, in about a second.

## 2. The detector (re-runnable, ~1s)

```js
const f = await readFile('Crux App v2.dc.html');
const tEnd = f.indexOf('</x-dc>');
const tpl = f.slice(0, tEnd), js = f.slice(tEnd);

// every identifier the logic could possibly expose
const idents = new Set([...js.matchAll(/[a-zA-Z_$][\w$]*/g)].map(m => m[0]));
// every loop variable the template declares
const asVars = new Set([...tpl.matchAll(/<sc-for[^>]*\sas="([\w$]+)"/g)].map(m => m[1]));
const grab = re => [...new Set([...tpl.matchAll(re)].map(m => m[1]))];

const handlers = grab(/on(?:Click|Change|Submit|Input|Blur|KeyDown)="\{\{\s*([\w.$]+)\s*\}\}"/g);
const lists    = grab(/<sc-for[^>]*\slist="\{\{\s*([\w.$]+)\s*\}\}"/g);
const conds    = grab(/<sc-if[^>]*\svalue="\{\{\s*([\w.$]+)\s*\}\}"/g);
const holes    = grab(/\{\{\s*([\w.$]+)\s*\}\}/g);

const dead = a => a.filter(b => {
  const root = b.split('.')[0];
  return !idents.has(root) && !asVars.has(root) && !idents.has(b.split('.').pop());
});
```

### What each check catches

| Check | Defect it catches | Why it matters |
|---|---|---|
| `<button>` with no `on*` attribute | a control that cannot respond | the literal orphan button |
| handler binding with no producer | a control wired to nothing | **clicks do nothing at all** |
| `sc-for list` with no producer | a list that renders as a blank box | empty section, no explanation |
| `sc-if value` with no producer | a branch that never opens, or always does | invisible or duplicated UI |
| any `{{ hole }}` with no producer | blank text, or invalid CSS inside `style=` | silent wrong rendering |
| `unused*` identifiers | dead code kept "just in case" | future readers cannot tell live from dead |
| `<select>` with one `<option>` | a dropdown with nothing to choose | looks interactive, is not |
| cross-screen namespace leak | screen A bound to screen B's state | one screen's emptiness blanks another |
| `type="button"` missing | implicit form submit | page reload, work lost |

### Cross-screen leak check

Each screen block is `<sc-if value="{{ isXxx }}">`. Bindings inside it are
matched against the namespace prefixes of *other* screens (`mis`, `ten`, `rate`,
`cov`, `acc`, `su`, `join`, `ogl`, `kpi`). Any hit is a leak — the class of bug
where the Rate master printed an empty state because the *MIS* had no rows.

## 3. Census — 8 Sep 2026, after remediation

| Measure | Count |
|---|---|
| `<button>` elements in the template | 248 |
| …with no handler attribute | **0** |
| Handler bindings | 247 |
| …dead (bound to nothing) | **0** |
| `sc-for` lists | 183 |
| …dead | **0** |
| `sc-if` conditions | 282 |
| …dead | **0** |
| Value holes total | 1,502 |
| …dead | **0** |
| Dead code (`unused*`) | **0** |
| Single-option selects | **0** |
| Buttons missing `type="button"` | **0** |
| Cross-screen binding leaks | **0** |

## 4. What every handler actually does

An orphan is not only a control bound to nothing; it is also a control that
*announces* instead of acting. Current split of 247 handlers:

| Behaviour | Count | Judgement |
|---|---|---|
| Opens a real form with fields and a submit | 60 | complete journey |
| Navigates to another screen | 19 | complete journey |
| Mutates state the UI then reflects | 59 | complete journey |
| Narrates the downstream effect only | 25 | **acceptable only where noted below** |
| Row/list handlers created per item | rest | inherit their parent's journey |

### The 25 narrate-only handlers

Legitimate where the action's effect is genuinely outside a design prototype —
an export producing a file, a payroll statement, a re-run of a scheduled job, a
notification to another person. Each states the concrete downstream effect
("6 people, ₹3,400, disputed lines excluded until decided") rather than
"exported successfully", so a reader can tell what the real system must do.

**Not legitimate** on a primary create/edit CTA. One was found and fixed this
round: *Add a rate* narrated a form that already existed in the registry but was
unreachable — a reverse-journey failure. It now opens that form.

## 5. Standing rules for new work

1. Every new control gets a handler that opens a form, navigates, or mutates
   state. Narration is reserved for effects outside the prototype's reach.
2. Never bind a screen to another screen's namespace. Compute per screen.
3. Never use a `{{ hole }}` inside `style=` unless the producer always returns a
   valid value — an unresolved hole yields invalid CSS, which fails *silently*.
4. Delete dead code. Do not rename it `unused*`.
5. Re-run the detector before declaring anything complete. Zero is the only
   acceptable number in the "dead" column.

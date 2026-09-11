/**
 * Gemini.gs — thin wrapper around the Gemini REST API for Apps Script.
 *
 * Configuration (Script Properties, NOT the Sheet — never expose to browser):
 *   GEMINI_API_KEY        Google AI Studio API key (or Emergent Universal LLM key).
 *   GEMINI_MODEL          Model id, default: gemini-2.5-flash (free tier)
 *   GEMINI_ENABLED        'true' / 'false'. Any admin can flip this from the UI.
 *
 * All Gemini-backed features degrade gracefully when the key is missing —
 * the app remains fully usable without AI.
 */

// NOTE: Google retires model ids on a rolling basis, so this default goes stale.
// As of Aug 2026 'gemini-2.5-flash' returns 404 "no longer available to new users".
// Do not trust this constant — run listGeminiModels() to see what your key allows,
// then set the real value in Admin > AI > Model (stored as the GEMINI_MODEL property).
var GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

function geminiConfigured_() {
  var props = PropertiesService.getScriptProperties();
  return !!props.getProperty('GEMINI_API_KEY') && props.getProperty('GEMINI_ENABLED') !== 'false';
}

/**
 * Diagnostic. Run this from the Apps Script editor (pick listGeminiModels in the
 * function dropdown, press Run, read the Execution log) to see exactly which
 * models YOUR api key is allowed to use right now.
 *
 * Google retires model ids on a rolling basis — a hard-coded default WILL go
 * stale and return "404 ... no longer available to new users". Rather than guess
 * a replacement, ask the API. Copy a name from the log into Admin > AI > Model.
 */
function listGeminiModels() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) {
    Logger.log('No GEMINI_API_KEY set. Go to Admin > AI and paste your key first.');
    return null;
  }
  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
    { muteHttpExceptions: true }
  );
  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log('Could not list models (HTTP ' + code + '):');
    Logger.log(String(res.getContentText() || '').slice(0, 600));
    return null;
  }
  var models = (JSON.parse(res.getContentText()).models || []).filter(function(m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
  });
  var names = models.map(function(m) { return String(m.name || '').replace(/^models\//, ''); });
  Logger.log('Currently configured GEMINI_MODEL: '
    + (props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL));
  Logger.log('Models this key may use with generateContent (' + names.length + '):');
  models.forEach(function(m) {
    Logger.log('  ' + String(m.name || '').replace(/^models\//, '')
      + '   (' + (m.displayName || '') + ')');
  });
  Logger.log('Pick one and set it in Admin > AI > Model. Prefer a "flash" variant'
    + ' for speed and cost; "pro" for quality.');
  return names;
}

function geminiStatus_() {
  var props = PropertiesService.getScriptProperties();
  var gk = props.getProperty('GEMINI_API_KEY');
  var qk = props.getProperty('GROQ_API_KEY');
  var mode = String(props.getProperty('AI_PROVIDER') || 'AUTO').toUpperCase();
  var primary = String(props.getProperty('AI_PRIMARY') || 'GEMINI').toUpperCase();
  var mask = function(k) { return k ? (String(k).slice(0, 4) + '\u2026' + String(k).slice(-4)) : ''; };
  return {
    configured: !!gk || !!qk,
    enabled: (props.getProperty('GEMINI_ENABLED') !== 'false') || (props.getProperty('GROQ_ENABLED') !== 'false'),
    model: (mode === 'GROQ' || (mode === 'AUTO' && primary === 'GROQ' && qk))
      ? (props.getProperty('GROQ_MODEL') || '(auto)')
      : (props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL),
    keyPreview: mask(gk || qk),
    mode: mode,
    primary: primary,
    providers: {
      gemini: { configured: !!gk, enabled: props.getProperty('GEMINI_ENABLED') !== 'false',
                model: props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL, keyPreview: mask(gk) },
      groq:   { configured: !!qk, enabled: props.getProperty('GROQ_ENABLED') !== 'false',
                model: props.getProperty('GROQ_MODEL') || '(auto)', keyPreview: mask(qk) }
    },
    failoverActive: !!gk && !!qk && mode === 'AUTO'
  };
}

/**
 * Save AI configuration. Handles BOTH providers so keys can be entered from
 * Admin > AI instead of Project Settings.
 * payload: { provider:'GEMINI'|'GROQ', apiKey, model, enabled, mode, primary }
 * An empty apiKey leaves the stored key untouched, so the masked preview in the
 * UI can be submitted without wiping a working key.
 */
function geminiSaveConfig_(payload, me) {
  var props = PropertiesService.getScriptProperties();
  var p = payload || {};
  var provider = String(p.provider || 'GEMINI').toUpperCase();
  var prefix = provider === 'GROQ' ? 'GROQ' : 'GEMINI';
  if (p.apiKey && String(p.apiKey).trim() && String(p.apiKey).indexOf('\u2026') === -1) {
    props.setProperty(prefix + '_API_KEY', String(p.apiKey).trim());
  }
  if (p.clearKey) props.deleteProperty(prefix + '_API_KEY');
  if (p.model !== undefined) {
    var mdl = String(p.model || '').trim();
    if (mdl && mdl !== '(auto)') props.setProperty(prefix + '_MODEL', mdl);
    else props.deleteProperty(prefix + '_MODEL');
  }
  if (p.enabled !== undefined) props.setProperty(prefix + '_ENABLED', p.enabled ? 'true' : 'false');
  if (p.mode) props.setProperty('AI_PROVIDER', String(p.mode).toUpperCase());
  if (p.primary) props.setProperty('AI_PRIMARY', String(p.primary).toUpperCase());
  logAudit_({ user: me.email, action: 'AI_CONFIG', entity: 'SCRIPT_PROPERTIES', entityId: prefix,
    oldValue: '', newValue: JSON.stringify({ provider: prefix, model: p.model, enabled: p.enabled, mode: p.mode, primary: p.primary }) });
  return geminiStatus_();
}

/**
 * Generic Gemini generateContent call.
 * @param {object} opts
 *   opts.system   Optional system instruction
 *   opts.prompt   User prompt (string)
 *   opts.json     If true, ask for JSON output and parse it
 *   opts.temp     0..1 sampling temperature (default 0.2)
 * @return {string|object}  Text response, or parsed JSON if opts.json
 */
/* ==================================================================
 * PROVIDER ROUTER
 *
 * Two providers, either can serve any request. AI_PROVIDER controls it:
 *   AUTO (default) - try the primary; on ANY failure fall through to the
 *                    other. A 503 from one no longer takes AI down.
 *   GEMINI / GROQ  - pin to a single provider.
 * AI_PRIMARY (GEMINI|GROQ) chooses which is tried first in AUTO mode.
 * ================================================================== */
var GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/';

function aiProviderConfigured_(which) {
  var props = PropertiesService.getScriptProperties();
  if (which === 'GROQ') {
    return !!props.getProperty('GROQ_API_KEY') && props.getProperty('GROQ_ENABLED') !== 'false';
  }
  return !!props.getProperty('GEMINI_API_KEY') && props.getProperty('GEMINI_ENABLED') !== 'false';
}

/** Single entry point for every AI feature. Name kept so the 6 call sites are untouched. */
function geminiCall_(opts) {
  var props = PropertiesService.getScriptProperties();
  // AI_PROVIDERS is an ordered fallback chain, e.g. "GROQ,GEMINI".
  // Each is tried in turn; the first that answers wins. Add a provider by
  // appending its name here and setting <NAME>_API_KEY. AI_PROVIDER/AI_PRIMARY
  // are still honoured so nothing already configured breaks.
  var chain = String(props.getProperty('AI_PROVIDERS') || '').toUpperCase();
  var order;
  if (chain.trim()) {
    order = chain.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
  } else {
    var mode = String(props.getProperty('AI_PROVIDER') || 'AUTO').toUpperCase();
    var primary = String(props.getProperty('AI_PRIMARY') || 'GEMINI').toUpperCase();
    if (mode === 'GEMINI') order = ['GEMINI'];
    else if (mode === 'GROQ') order = ['GROQ'];
    else order = primary === 'GROQ' ? ['GROQ', 'GEMINI'] : ['GEMINI', 'GROQ'];
  }
  order = order.filter(function(pv){ return aiProviderConfigured_(pv); });
  if (!order.length) {
    throw AuthError_('No AI provider is configured. Add a Gemini or Groq API key in Admin > AI.');
  }
  var errors = [];
  for (var i = 0; i < order.length; i++) {
    try {
      return order[i] === 'GROQ' ? groqCall_(opts) : geminiCallRaw_(opts);
    } catch (e) {
      errors.push(order[i] + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  throw new Error('All AI providers failed - ' + errors.join(' | '));
}

/** Groq (OpenAI-compatible chat completions). Model resolved live, never hard-coded. */
function groqCall_(opts) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GROQ_API_KEY');
  if (!apiKey) throw new Error('Groq API key not set.');
  var model = groqResolveModel_(apiKey);
  var messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.prompt });
  var body = {
    model: model, messages: messages,
    temperature: opts.temp == null ? 0.2 : opts.temp,
    max_tokens: opts.maxTokens || 1024
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  var res = UrlFetchApp.fetch(GROQ_ENDPOINT + 'chat/completions', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) {
    var em = '';
    try { em = JSON.parse(text).error && JSON.parse(text).error.message; } catch (e) {}
    throw new Error('Groq API ' + code + ': ' + (em || text.slice(0, 240)));
  }
  var data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Groq API: non-JSON response'); }
  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  if (!content) throw new Error('Groq returned no content.');
  if (opts.json) {
    try { return JSON.parse(content); }
    catch (e) {
      var stripped = content.replace(/^\s*```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
      return JSON.parse(stripped);
    }
  }
  return content;
}

/** Resolve a working Groq model id and cache it. Avoids the retired-model trap. */
function groqResolveModel_(apiKey) {
  var props = PropertiesService.getScriptProperties();
  var set = props.getProperty('GROQ_MODEL');
  if (set) return set;
  var ids = groqModelIds_(apiKey);
  if (!ids.length) throw new Error('Groq returned no usable models for this key.');
  var bad = /whisper|tts|guard|vision|embed/i;
  var pick = ids.filter(function(id){ return !bad.test(id); })[0] || ids[0];
  props.setProperty('GROQ_MODEL', pick);
  return pick;
}

function groqModelIds_(apiKey) {
  var res = UrlFetchApp.fetch(GROQ_ENDPOINT + 'models', {
    method: 'get', headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return [];
  try {
    var d = JSON.parse(res.getContentText());
    return (d.data || []).map(function(m){ return m.id; }).filter(Boolean);
  } catch (e) { return []; }
}

/** Diagnostic: run from the editor to see which Groq models your key allows. */
function listGroqModels() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GROQ_API_KEY');
  if (!key) { Logger.log('GROQ_API_KEY is not set.'); return []; }
  var ids = groqModelIds_(key);
  Logger.log('Currently configured GROQ_MODEL: ' + (props.getProperty('GROQ_MODEL') || '(auto)'));
  Logger.log('Models this key may use (' + ids.length + '):');
  ids.forEach(function(id){ Logger.log('    ' + id); });
  return ids;
}

function geminiCallRaw_(opts) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw AuthError_('Gemini is not configured. Please ask an admin to set the API key.');
  if (props.getProperty('GEMINI_ENABLED') === 'false') throw AuthError_('Gemini features are currently disabled.');
  // GEMINI_MODEL had been saved as 'groq', which made the Gemini fallback request
  // models/groq and die with a 404 - so when Groq failed there was no fallback at
  // all. Ignore any id that is not a Gemini model rather than trusting the setting.
  var model = props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
  if (String(model).toLowerCase().indexOf('gemini') !== 0) model = GEMINI_DEFAULT_MODEL;
  var url = GEMINI_ENDPOINT + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
  var body = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temp == null ? 0.2 : opts.temp,
      maxOutputTokens: opts.maxTokens || 1024,
      responseMimeType: opts.json ? 'application/json' : 'text/plain'
    }
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) {
    var errMsg = '';
    try { errMsg = JSON.parse(text).error && JSON.parse(text).error.message; } catch (e) {}
    throw new Error('Gemini API ' + code + ': ' + (errMsg || text.slice(0, 240)));
  }
  var data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Gemini API: non-JSON response'); }
  var content = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text || '';
  if (!content) throw new Error('Gemini returned no content. Reason: ' + (data.candidates && data.candidates[0] && data.candidates[0].finishReason || 'unknown'));
  if (opts.json) {
    try { return JSON.parse(content); }
    catch (e) {
      // Strip common code fences and retry
      var stripped = content.replace(/^\s*```(?:json)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
      return JSON.parse(stripped);
    }
  }
  return content;
}

/* ------------------------------------------------------------------
 * Feature: AI severity + category classifier (LOG escalation)
 * ------------------------------------------------------------------ */
function aiClassifyEscalation_(payload, me) {
  var desc = String(payload.description || '').trim();
  if (!desc) throw ValidationError_('Please add a short description first.');
  var out = geminiCall_({
    system: 'You are a triage assistant for a risk-management ops team. From a short banker/client complaint, output STRICT JSON: { "category": one of ["Service","Compliance","Ops","Billing","Other"], "severity": one of ["Low","Medium","High"], "reason": short single sentence explaining severity, "suggestedAction": one short imperative sentence }. No markdown, no extra fields.',
    prompt: 'Complaint description:\n"""\n' + desc.slice(0, 1500) + '\n"""',
    json: true, temp: 0.1, maxTokens: 300
  });
  logAudit_({ user: me.email, action: 'AI_CLASSIFY', entity: 'GEMINI', entityId: '', oldValue: '', newValue: JSON.stringify(out).slice(0, 500) });
  return out;
}

/* ------------------------------------------------------------------
 * Feature: AI-drafted formal escalation email body
 * ------------------------------------------------------------------ */
function aiDraftEscalation_(payload, me) {
  var seed = String(payload.brief || '').trim();
  if (!seed) throw ValidationError_('Please add a short brief describing the issue.');
  var client = payload.ClientID ? findRowById_('CLIENTS', 'ClientID', payload.ClientID) : null;
  var vars = {
    client: client ? client.ClientName : '(unspecified client)',
    brief: seed.slice(0, 2000),
    category: payload.category || 'General',
    severity: payload.severity || 'Medium'
  };
  var out = geminiCall_({
    system: 'You draft professional, concise formal escalation content for a risk-management firm ("Crux Risk Management Pvt Ltd"). Use neutral, respectful tone. NEVER threaten. Output STRICT JSON: { "description": 3-6 sentences describing the issue clearly, "requiredResolution": 1-3 sentences stating the expected fix and a reasonable timeline }. No markdown, no extra fields.',
    prompt: 'Client: ' + vars.client + '\nCategory: ' + vars.category + '\nSeverity: ' + vars.severity + '\nBrief:\n"""\n' + vars.brief + '\n"""',
    json: true, temp: 0.35, maxTokens: 1400
  });
  logAudit_({ user: me.email, action: 'AI_DRAFT_ESCALATION', entity: 'GEMINI', entityId: payload.ClientID || '', oldValue: '', newValue: JSON.stringify(out).slice(0, 500) });
  return out;
}

/* ------------------------------------------------------------------
 * Feature: Ask-my-data admin chat
 * The client sends short conversational messages. We attach a compressed
 * snapshot of the last 60 days of EMAIL_LOG + ESCALATIONS as context so
 * Gemini can answer common questions grounded in real data.
 * ------------------------------------------------------------------ */
function aiChat_(payload, me) {
  var messages = payload.messages || [];
  var lastUser = messages.filter(function(m){ return m.role === 'user'; }).slice(-1)[0];
  if (!lastUser) throw ValidationError_('No user message.');
  var snapshot = buildDataSnapshot_(me);
  var history = messages.slice(-10).map(function(m){ return (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.text; }).join('\n');
  var out = geminiCall_({
    system: 'You are an internal analytics assistant for the Crux Escalation Matrix tool. Answer succinctly, in plain English (max 6 sentences). ALWAYS ground answers in the provided data snapshot; if the answer is not in the snapshot, say so. Never invent client names or numbers. Prefer bullet points when listing 3+ items.',
    prompt: 'DATA SNAPSHOT (last 60 days):\n' + snapshot + '\n\nCONVERSATION SO FAR:\n' + history,
    temp: 0.2, maxTokens: 700
  });
  return { text: String(out) };
}

function buildDataSnapshot_(me) {
  var since = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  var sinceKey = Utilities.formatDate(since, getTz_(), 'yyyy-MM-dd');
  var emails = readTable_('EMAIL_LOG').filter(function(r){ return String(r.Timestamp) >= sinceKey; });
  var esc = readTable_('ESCALATIONS').filter(function(r){ return String(r.CreatedAt) >= sinceKey; });
  // SCOPE: the snapshot must never contain rows the caller cannot see, otherwise
  // the dashboard Ask box would leak another zone's escalations to a Location Head.
  // ADMIN and system callers (no `me`) keep the full picture.
  if (me && me.role && me.role !== 'ADMIN') {
    var _cidx = clientIndex_();
    esc = scopeEscalations_(esc, me, _cidx);
    var _allowed = {};
    scopeClientsForUser_(readTable_('CLIENTS'), me).forEach(function(c){ _allowed[c.ClientID] = true; });
    emails = emails.filter(function(r){ return !r.ClientID || _allowed[r.ClientID]; });
  }
  var clientMap = {};
  readTable_('CLIENTS').forEach(function(c){ clientMap[c.ClientID] = c.ClientName; });
  function byKey(arr, keyFn) {
    var m = {};
    arr.forEach(function(x){ var k = keyFn(x); m[k] = (m[k]||0) + 1; });
    return Object.keys(m).sort(function(a,b){ return m[b] - m[a]; }).slice(0, 12).map(function(k){ return k + ' (' + m[k] + ')'; }).join(', ');
  }
  var lines = [];
  lines.push('window_days=60 from ' + sinceKey);
  lines.push('total_emails=' + emails.length + ' sent=' + emails.filter(function(r){return r.Status==='SENT';}).length + ' failed=' + emails.filter(function(r){return r.Status==='FAILED';}).length);
  lines.push('emails_by_type: ' + byKey(emails, function(r){ return r.Type || 'UNKNOWN'; }));
  lines.push('failed_by_client: ' + byKey(emails.filter(function(r){return r.Status==='FAILED';}), function(r){ return clientMap[r.ClientID] || r.ClientID || '—'; }));
  lines.push('failed_reasons_sample: ' + emails.filter(function(r){return r.Status==='FAILED';}).slice(0,8).map(function(r){ return (r.Error||'').slice(0,80); }).join(' | '));
  lines.push('escalations=' + esc.length + ' open=' + esc.filter(function(r){ return ['OPEN','ASSIGNED','IN_PROGRESS'].indexOf(r.Status) !== -1; }).length);
  lines.push('escalations_by_client: ' + byKey(esc, function(r){ return clientMap[r.ClientID] || r.ClientID || '—'; }));
  lines.push('escalations_by_severity: ' + byKey(esc, function(r){ return r.Severity || 'Medium'; }));
  lines.push('escalations_by_category: ' + byKey(esc, function(r){ return r.Category || 'Other'; }));
  return lines.join('\n');
}

/* ------------------------------------------------------------------
 * Feature: Monthly digest insight paragraph — called by the scheduler.
 * Falls back silently to '' when Gemini is not configured.
 * ------------------------------------------------------------------ */
function aiSummaryInsight_(period, stats, incomplete, failedSamples) {
  if (!geminiConfigured_()) return '';
  try {
    var prompt = 'Period: ' + period + '\nStats: ' + JSON.stringify(stats) +
      '\nIncomplete clients: ' + incomplete.slice(0, 15).join(', ') +
      '\nFailed reasons sample: ' + failedSamples.slice(0, 8).map(function(e){ return e.slice(0,100); }).join(' | ');
    return geminiCall_({
      system: 'You write a short (3-5 sentence) plain-English paragraph titled "What changed / what to watch" for the Crux ops admin. Highlight anomalies, trends and recommendations. Be direct. No bullet points. No preamble.',
      prompt: prompt, temp: 0.3, maxTokens: 400
    });
  } catch (e) {
    return '';
  }
}


/* ------------------------------------------------------------------
 * Feature: Weekly Snapshot — top-3 anomalies pinned on the Dashboard.
 *
 * We build a compact 7-day snapshot and ask Gemini for exactly 3 items
 * as strict JSON. Result is cached in Script Properties for up to 6 hours
 * (or until explicitly refreshed) so the dashboard never blocks on the
 * Gemini API and quota is spent conservatively.
 * ------------------------------------------------------------------ */
var WEEKLY_CACHE_KEY = 'AI_WEEKLY_ANOMALIES';
var WEEKLY_CACHE_TTL_MS = 6 * 3600 * 1000;

function aiWeeklyAnomalies_(payload) {
  var props = PropertiesService.getScriptProperties();
  var refresh = !!(payload && payload.refresh);
  var cached = props.getProperty(WEEKLY_CACHE_KEY);
  if (!refresh && cached) {
    try {
      var obj = JSON.parse(cached);
      if (obj && obj.ts && (Date.now() - obj.ts) < WEEKLY_CACHE_TTL_MS) return obj;
    } catch (e) {}
  }
  if (!geminiConfigured_()) {
    return { ts: Date.now(), anomalies: [], skipped: true, reason: 'ai_not_configured' };
  }
  var snap = buildWeeklySnapshot_();
  var out;
  try {
    out = geminiCall_({
      system: 'You are an ops analyst for the Crux Escalation Matrix. Given a 7-day data snapshot, return EXACTLY 3 items as STRICT JSON: {"anomalies":[{"title":"3-6 words","severity":"low|medium|high","detail":"one plain-english sentence citing a specific number or client","suggestion":"one short imperative next step"}]}. Prefer real, cited anomalies over generic advice. If nothing notable happened, return items describing the calm state (severity="low"). No markdown fences, no extra fields.',
      prompt: 'DATA SNAPSHOT (7 days):\n' + snap,
      json: true, temp: 0.25, maxTokens: 700
    });
  } catch (e) {
    // Cache the error briefly to avoid hammering the API on a bad key.
    var errObj = { ts: Date.now(), anomalies: [], error: String(e && e.message || e) };
    props.setProperty(WEEKLY_CACHE_KEY, JSON.stringify(errObj));
    return errObj;
  }
  var items = (out && out.anomalies) || [];
  var normalized = items.slice(0, 3).map(function(a) {
    var sev = String(a.severity || 'medium').toLowerCase();
    if (['low','medium','high'].indexOf(sev) === -1) sev = 'medium';
    return {
      title: String(a.title || '').slice(0, 120),
      severity: sev,
      detail: String(a.detail || '').slice(0, 320),
      suggestion: String(a.suggestion || '').slice(0, 240)
    };
  });
  var result = { ts: Date.now(), anomalies: normalized, generatedAt: Utilities.formatDate(new Date(), getTz_(), 'dd MMM, HH:mm') };
  props.setProperty(WEEKLY_CACHE_KEY, JSON.stringify(result));
  return result;
}

function buildWeeklySnapshot_() {
  var since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  var sinceKey = Utilities.formatDate(since, getTz_(), 'yyyy-MM-dd');
  var emails = readTable_('EMAIL_LOG').filter(function(r){ return String(r.Timestamp) >= sinceKey; });
  var esc = readTable_('ESCALATIONS').filter(function(r){ return String(r.CreatedAt) >= sinceKey; });
  var clients = readTable_('CLIENTS').filter(function(c){ return c.Status !== 'INACTIVE'; });
  var matrix = readTable_('ESCALATION_MATRIX');
  var reminders = readTable_('REMINDER_LOG').filter(function(r){ return String(r.ExecutedAt) >= sinceKey; });
  var clientMap = {}; clients.forEach(function(c){ clientMap[c.ClientID] = c.ClientName; });
  var incomplete = clients.filter(function(c){
    var m = matrix.filter(function(x){ return x.ClientID === c.ClientID; });
    return !isMatrixComplete_(c, m);
  }).map(function(c){ return c.ClientName; });
  function byKey(arr, keyFn) {
    var m = {};
    arr.forEach(function(x){ var k = keyFn(x) || '—'; m[k] = (m[k]||0) + 1; });
    return Object.keys(m).sort(function(a,b){ return m[b] - m[a]; }).slice(0, 10).map(function(k){ return k + ' (' + m[k] + ')'; });
  }
  var lines = [];
  lines.push('window_days=7 from=' + sinceKey);
  lines.push('active_clients=' + clients.length + ' incomplete_matrices=' + incomplete.length);
  if (incomplete.length) lines.push('incomplete_client_names: ' + incomplete.slice(0, 10).join(', '));
  lines.push('emails=' + emails.length + ' sent=' + emails.filter(function(r){return r.Status==='SENT';}).length + ' failed=' + emails.filter(function(r){return r.Status==='FAILED';}).length);
  lines.push('emails_by_type: ' + byKey(emails, function(r){ return r.Type; }).join(', '));
  lines.push('failed_by_client: ' + byKey(emails.filter(function(r){return r.Status==='FAILED';}), function(r){ return clientMap[r.ClientID] || r.ClientID; }).join(', '));
  lines.push('failed_reasons_sample: ' + emails.filter(function(r){return r.Status==='FAILED';}).slice(0,6).map(function(r){ return (r.Error||'').slice(0,80); }).join(' | '));
  lines.push('escalations=' + esc.length + ' open=' + esc.filter(function(r){ return ['OPEN','ASSIGNED','IN_PROGRESS'].indexOf(r.Status) !== -1; }).length + ' high_severity=' + esc.filter(function(r){ return r.Severity === 'High'; }).length);
  lines.push('escalations_by_client: ' + byKey(esc, function(r){ return clientMap[r.ClientID] || r.ClientID; }).join(', '));
  lines.push('escalations_by_category: ' + byKey(esc, function(r){ return r.Category; }).join(', '));
  lines.push('reminder_jobs_this_week: ' + byKey(reminders, function(r){ return r.Type + '/' + r.Result; }).join(', '));
  return lines.join('\n');
}
/**
 * Test ONE provider directly, bypassing the failover router, so Admin > AI can
 * report which provider is actually healthy instead of a merged error.
 */
function aiTestProvider_(payload, me) {
  var which = String((payload && payload.provider) || 'GEMINI').toUpperCase();
  if (!aiProviderConfigured_(which)) {
    throw ValidationError_(which + ' has no API key saved, or is disabled.');
  }
  var props = PropertiesService.getScriptProperties();
  var t0 = new Date().getTime();
  var out = which === 'GROQ'
    ? groqCall_({ system: 'Reply with exactly one word.', prompt: 'Say OK', temp: 0, maxTokens: 16 })
    : geminiCallRaw_({ system: 'Reply with exactly one word.', prompt: 'Say OK', temp: 0, maxTokens: 16 });
  return {
    provider: which,
    ms: new Date().getTime() - t0,
    model: which === 'GROQ' ? (props.getProperty('GROQ_MODEL') || '(auto)')
                            : (props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL),
    text: String(out).slice(0, 200)
  };
}

/**
 * General note drafting for every free-text box in the app.
 * Deliberately plain and factual: these notes end up in warnings, plans and
 * escalations, so the model records what happened rather than characterising
 * the person, and is told to invent nothing.
 */
/**
 * Factual snapshot of one person, assembled SERVER-SIDE from the datastore.
 *
 * Section 26 requires a PIP draft to use the person's actual record: performance
 * gaps, missed targets, recurring escalations, warnings, the review period. The
 * draft previously had none of that - the browser passed a single line holding a
 * name, designation and department, so every "AI-assisted" plan was written from
 * three fields and whatever the manager had already typed.
 *
 * Building it here rather than trusting the browser matters twice over: the facts
 * are the real ones, and a client can no longer put arbitrary text in front of
 * the model as though it came from the record.
 *
 * Authorisation is the same gate as reading the score, so drafting can never
 * surface data about somebody the caller cannot already see.
 */
function personContextForAi_(email, me, monthsBack) {
  var em = String(email || '').toLowerCase();
  if (!em) return '';
  if (!canViewPerson_(me, em)) throw AuthError_('You cannot draft about that person.');

  var months = [];
  var now = new Date();
  for (var i = 0; i < (monthsBack || 3); i++) {
    months.push(monthKey_(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  var inWindow = function(mk) { return months.indexOf(String(mk || '')) !== -1; };

  var user = readTable_('USERS').filter(function(u) {
    return String(u.Email || '').toLowerCase() === em;
  })[0] || {};

  var lines = [];
  lines.push('PERSON: ' + (user.Name || em) + ' (' + em + ')');
  if (user.Designation) lines.push('ROLE: ' + user.Designation +
    (user.Department ? ', ' + user.Department : ''));
  if (user.Manager) lines.push('REPORTS TO: ' + user.Manager);
  if (user.DateOfJoining) lines.push('JOINED: ' + user.DateOfJoining);
  lines.push('REVIEW PERIOD: ' + months[months.length - 1] + ' to ' + months[0]);

  // Targets and achievement, per KPI, per month. The gap is the point.
  var targetRows = readTable_('TARGETS').filter(function(t) {
    return String(t.PersonEmail || '').toLowerCase() === em && inWindow(monthOfValue_(t.MonthKey));
  });
  if (targetRows.length) {
    months.slice().reverse().forEach(function(mk) {
      var d = targetAchievement_(em, mk);
      if (!d.categoriesSet) return;
      var per = (d.categories || []).filter(function(c) { return c.set; }).map(function(c) {
        return c.Category + ' ' + c.achieved + '/' + c.target + ' (' + c.pct + '%)';
      });
      if (per.length) lines.push('TARGETS ' + mk + ': ' + per.join('; '));
    });
  } else {
    lines.push('TARGETS: none recorded in this period.');
  }

  // Scores actually stored, with the manager's own words where present.
  var scores = readTable_('SCORES').filter(function(x) {
    return String(x.PersonEmail || '').toLowerCase() === em && inWindow(monthOfValue_(x.MonthKey));
  });
  scores.forEach(function(x) {
    var bits = ['SCORE ' + monthOfValue_(x.MonthKey) + ': final ' + (x.FinalScore || '-') +
      ' (target ' + (x.TargetScore || '-') + ', attributes ' + (x.AttributeScore || '-') + ')'];
    if (x.AreasOfImprovement) bits.push('areas to improve: ' + x.AreasOfImprovement);
    if (x.EmployeeDecision) bits.push('employee ' + String(x.EmployeeDecision).toLowerCase());
    lines.push(bits.join(' | '));
  });

  // Escalations raised against them, and whether they were answered.
  var escs = readTable_('ESCALATIONS').filter(function(e) {
    return String(e.AgainstEmail || '').toLowerCase() === em
      && inWindow(monthOfValue_(e.CreatedAt || e.Date));
  });
  if (escs.length) {
    lines.push('ESCALATIONS AGAINST THEM: ' + escs.length + ' in this period.');
    escs.slice(0, 8).forEach(function(e) {
      lines.push('  - ' + String(e.CreatedAt || e.Date).slice(0, 10) + ' ' +
        (e.Category || 'escalation') + ', severity ' + (e.Severity || '-') +
        ', status ' + (e.Status || '-') +
        (e.Description ? '. ' + String(e.Description).slice(0, 160) : ''));
    });
  } else {
    lines.push('ESCALATIONS AGAINST THEM: none in this period.');
  }

  var warns = readTable_('WARNINGS').filter(function(w) {
    return String(w.PersonEmail || '').toLowerCase() === em && inWindow(monthOfValue_(w.IssuedAt));
  });
  if (warns.length) {
    lines.push('WARNINGS: ' + warns.length + ' in this period.');
    warns.slice(0, 6).forEach(function(w) {
      lines.push('  - ' + String(w.IssuedAt).slice(0, 10) + ' ' + (w.Category || '') +
        ' (' + (w.Status || '') + ')' + (w.Summary ? ': ' + String(w.Summary).slice(0, 160) : ''));
    });
  } else {
    lines.push('WARNINGS: none in this period.');
  }

  var events = readTable_('PEOPLE_EVENTS').filter(function(e) {
    return String(e.PersonEmail || '').toLowerCase() === em && inWindow(monthOfValue_(e.Timestamp));
  });
  var appr = events.filter(function(e) { return e.Type === 'APPRECIATION'; });
  var pips = events.filter(function(e) { return e.Type === 'PIP'; });
  lines.push('APPRECIATIONS: ' + appr.length + ' in this period.');
  pips.forEach(function(e) {
    lines.push('PRIOR PIP: ' + e.StartDate + ' to ' + e.EndDate + ' (' + (e.Status || '') + ')' +
      (e.Outcome ? ', outcome ' + e.Outcome : ''));
  });

  return lines.join('\n');
}

function aiDraftNote_(payload, me) {
  var kind = String(payload.kind || 'note');
  var rough = String(payload.text || '').trim();
  // A hint the user typed. Kept, but clearly subordinate to the record below.
  var ctx = String(payload.context || '').trim();
  if (rough.length < 3) throw ValidationError_('Write a few words first, then let the AI tidy them up.');

  // The authoritative facts, read from the datastore for whoever this is about.
  var record = '';
  if (payload.Email) {
    try { record = personContextForAi_(payload.Email, me); }
    catch (e) {
      if (e && e.isFriendly) throw e;      // an authorisation refusal must surface
      record = '';                          // a data hiccup must not block drafting
    }
  }

  var guidance = {
    warning: 'a factual warning note. State what happened, when, and what must change. No adjectives about the person and no threats.',
    pip: 'a performance improvement plan. Cover, as short labelled paragraphs: ' +
         'the specific performance gap evidenced by the record; measurable objectives ' +
         'with figures taken only from the record; the review period; what support ' +
         'and coaching will be provided; and what happens if there is no improvement. ' +
         'Be direct but not punitive, and never characterise the person, only the work.',
    appreciation: 'a short appreciation. Say specifically what they did and why it mattered.',
    escalation: 'an escalation description. State the issue, the impact and what is needed.',
    note: 'a clear, professional note.'
  }[kind] || 'a clear, professional note.';

  var sys = 'You write internal notes for an Indian facilities-management company. ' +
    'Rewrite the user notes as ' + guidance + ' ' +
    'Use plain British English, short sentences, no jargon, no salutation and no sign-off. ' +
    'Keep every fact the user gave and INVENT NONE. If a figure, date or incident is ' +
    'not in the record or the notes, do not mention it and do not estimate it. ' +
    'Return only the rewritten text.';

  // The record is presented as the only source of facts, and the model is told
  // in the system prompt not to add any. It stays advisory: the output lands in
  // an editable box, is attributed to whoever pressed the button, and changes no
  // stored value.
  var prompt = '';
  if (record) {
    prompt += 'THE RECORD (these are the only facts you may use; do not add ' +
              'numbers, dates or incidents that are not here):\n' + record + '\n\n';
  }
  if (ctx) prompt += 'Additional context from the manager: ' + ctx + '\n\n';
  prompt += 'Rough notes:\n' + rough;

  var out = geminiCall_({
    system: sys,
    prompt: prompt,
    temp: 0.3, maxTokens: kind === 'pip' ? 900 : 600
  });
  return { text: String(out || '').trim(), usedRecord: !!record };
}

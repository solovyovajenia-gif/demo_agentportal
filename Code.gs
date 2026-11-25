// Company — Agent portal (personal link per agent)
// Agent opens  <web app URL>?a=<company id>&k=<key>  and sees their clients from Kommo
// grouped: In progress / Client paid / Commission paid / Client declined.
// A lead is shown to an agent only if: Company = agent's company AND Source = Agent (Sales pipeline).
// v3: new UI (status filters, client list, form with inline errors, discard dialog, success screen).
// v2: "+ Add lead" button — the agent submits a client; it lands in Kommo Incoming leads with
//     Source = Agent and Company = the agent's company, and shows up in the "New" block.
// Admin list of agents + ready links:  <web app URL>?admin=<SECRET>
//
// Script properties (Project settings → Script properties):
//   KOMMO_TOKEN  — long-lived token from Kommo (Settings → Integrations → your integration → Keys and scopes)
//   SECRET       — any long phrase you invent; changing it invalidates ALL agent links
//   PORTAL_URL   — optional, e.g. https://example.com/agent/  (pretty address that redirects here)

var KOMMO_DOMAIN = 'yourcompany.kommo.com';
var PIPELINE_ID  = 14364439;          // Sales

// Sales pipeline stage ids
var ST = {
  INCOMING: 110951611,  // Incoming leads
  RESP:     110951619,  // Responsible assigned
  CONTACT:  110951623,  // Contacted
  QUAL:     110951627,  // Qualified
  OFFER:    111164883,  // Offer sent
  FOLLOW:   111164887,  // Follow UP
  PAID:     111164895,  // Paid
  WON:      142,        // Won
  LOST:     143         // Lost
};
// "Передан в работу" = these stages. Add ST.INCOMING here if a lead should count from the very first stage.
var IN_WORK_STAGES = [ST.RESP, ST.CONTACT, ST.QUAL, ST.OFFER, ST.FOLLOW];
var PAID_STAGES    = [ST.PAID, ST.WON];

// Lead custom field ids
var CF = {
  COMMISSION_PAID: 467682,  // select: yes / no / N/A
  PRODUCT:         418116,  // select
  COUNTRY:         534326,  // multiselect "Country/Program (multi)" (old select 432068 was removed on 2026-09-30)
  SOURCE:          432700   // select; agent leads must have Source = Agent
};
var AGENT_SOURCE = 'Agent';
var CF_CONTACT_TELEGRAM = 529858;   // contact field "Telegram username"
var MAX_LEADS_PER_HOUR = 30;        // per agent link, protection from abuse
var INACTIVE_TAG = 'inactive';      // add this tag to the agent's company in Kommo to switch the link off

// Browser-tab icon (must be a public PNG url). Uploaded together with agent/index.html.
var FAVICON_URL = 'https://example.com/agent/favicon.png';
// Company logo as base64 PNG, embedded so the page has no external dependencies
var LOGO_B64 = ''; // put your logo PNG as base64 here

var TEXT = {
  title: 'My clients', sub: 'Live data from Company CRM as of page load',
  all: 'All', fresh: 'New', addLead: '+ Add lead',
  inwork: 'In progress', lost: 'Declined', paid: 'Client paid', comm: 'Commission paid',
  empty: 'Nobody here yet', none: 'Not specified', total: 'clients in total', updated: 'Updated', refresh: 'Refresh',
  bad: 'This link is not valid', badSub: 'Check the link or ask Company for a new one.',
  off: 'This link is no longer active', offSub: 'Please contact Company.',
  err: 'Could not load data', errSub: 'Please refresh the page in a minute.'
};

// ---------------------------------------------------------------- entry point
function doGet(e) {
  var p = (e && e.parameter) || {};
  var t = TEXT;

  if (p.admin) {
    if (p.admin !== prop_('SECRET')) return page_(errorHtml_('No access', 'Wrong secret.'), 'Company');
    return page_(adminHtml_(), 'Company — agents');
  }

  var companyId = String(p.a || '').replace(/\D/g, '');
  if (!companyId || !p.k || p.k !== keyFor_(companyId)) {
    return page_(errorHtml_(t.bad, t.badSub), 'Company');
  }

  try {
    if (isInactive_(getCompany_(companyId))) return page_(errorHtml_(t.off, t.offSub), 'Company');
    var data = getAgentData_(companyId);
    return page_(agentHtml_(data, t, companyId, p.k), data.agentName + ' — Company');
  } catch (err) {
    console.error(err);
    return page_(errorHtml_(t.err, t.errSub), 'Company');
  }
}

// ---------------------------------------------------------------- keys & links
function keyFor_(companyId) {
  var sig = Utilities.computeHmacSha256Signature(String(companyId), prop_('SECRET'));
  return sig.slice(0, 10).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function linkFor_(companyId) {
  var base = (prop_('PORTAL_URL') || ScriptApp.getService().getUrl()).replace(/\?.*$/, '');
  return base + '?a=' + companyId + '&k=' + keyFor_(companyId);
}

function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v ? v.trim() : '';
}

// ---------------------------------------------------------------- Kommo API
function kommo_(path) {
  var res = UrlFetchApp.fetch('https://' + KOMMO_DOMAIN + path, {
    headers: { Authorization: 'Bearer ' + prop_('KOMMO_TOKEN') },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 204) return null;
  if (code >= 300) throw new Error('Kommo ' + code + ' on ' + path + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

function getCompany_(id) {
  return kommo_('/api/v4/companies/' + id);
}

// true when the company carries the "inactive" tag: the agent's link stops working, leads stay in Kommo
function isInactive_(company) {
  var tags = company && company._embedded && company._embedded.tags || [];
  return tags.some(function (t) { return String(t.name || '').trim().toLowerCase() === INACTIVE_TAG; });
}

function getCompanyLeads_(companyId) {
  var ids = [];
  for (var pageNo = 1; pageNo < 20; pageNo++) {
    var r = kommo_('/api/v4/companies/' + companyId + '/links?filter[to_entity_type]=leads&limit=250&page=' + pageNo);
    var links = r && r._embedded && r._embedded.links || [];
    links.forEach(function (l) { ids.push(l.to_entity_id); });
    if (links.length < 250) break;
  }
  var leads = [];
  for (var i = 0; i < ids.length; i += 50) {
    var q = ids.slice(i, i + 50).map(function (id) { return 'filter[id][]=' + id; }).join('&');
    var r2 = kommo_('/api/v4/leads?' + q + '&limit=50');
    leads = leads.concat(r2 && r2._embedded && r2._embedded.leads || []);
  }
  // only Sales pipeline AND Source = Agent
  return leads.filter(function (l) {
    return l.pipeline_id === PIPELINE_ID && cfValue_(l, CF.SOURCE).toLowerCase() === AGENT_SOURCE.toLowerCase();
  });
}

function getStageNames_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('stages');
  if (hit) return JSON.parse(hit);
  var r = kommo_('/api/v4/leads/pipelines/' + PIPELINE_ID);
  var map = {};
  (r._embedded.statuses || []).forEach(function (s) { map[s.id] = s.name.trim(); });
  cache.put('stages', JSON.stringify(map), 21600);
  return map;
}

function cfValue_(lead, fieldId) {
  var list = lead.custom_fields_values || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].field_id === fieldId) {
      return (list[i].values || []).map(function (v) { return String(v.value || ''); }).filter(String).join(', ');
    }
  }
  return '';
}


// ---------------------------------------------------------------- dropdown lists from Kommo
function getEnums_(fieldId) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('enums:' + fieldId);
  if (hit) return JSON.parse(hit);
  var r = kommo_('/api/v4/leads/custom_fields/' + fieldId);
  var list = (r && r.enums || []).sort(function (a, b) { return a.sort - b.sort; }).map(function (e) { return e.value; });
  cache.put('enums:' + fieldId, JSON.stringify(list), 3600); // 1 hour
  return list;
}

function kommoPost_(path, body) {
  var res = UrlFetchApp.fetch('https://' + KOMMO_DOMAIN + path, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + prop_('KOMMO_TOKEN') }, muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Kommo ' + code + ' on POST ' + path + ': ' + res.getContentText().slice(0, 300));
  return res.getContentText() ? JSON.parse(res.getContentText()) : null;
}

function kommoPatch_(path, body) {
  var res = UrlFetchApp.fetch('https://' + KOMMO_DOMAIN + path, {
    method: 'patch', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + prop_('KOMMO_TOKEN') }, muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Kommo ' + code + ' on PATCH ' + path + ': ' + res.getContentText().slice(0, 300));
  return res.getContentText() ? JSON.parse(res.getContentText()) : null;
}

// Admin toggle: adds or removes the "inactive" tag on the agent's company in Kommo.
function setAgentActive(admin, companyId, active) {
  if (admin !== prop_('SECRET')) throw new Error('No access');
  companyId = String(companyId || '').replace(/\D/g, '');
  var company = getCompany_(companyId);
  if (!company) throw new Error('Company not found');
  var tags = (company._embedded && company._embedded.tags || [])
    .map(function (t) { return t.name; })
    .filter(function (n) { return String(n).trim().toLowerCase() !== INACTIVE_TAG; });
  if (!active) tags.push(INACTIVE_TAG);
  kommoPatch_('/api/v4/companies/' + companyId, { _embedded: { tags: tags.map(function (n) { return { name: n }; }) } });
  CacheService.getScriptCache().remove('agent:' + companyId);
  return { ok: true, active: !!active };
}

// ---------------------------------------------------------------- public API (called from the page via google.script.run)
// Returns fresh HTML of the lists (used by Refresh and after adding a lead).
function getView(a, k) {
  var companyId = String(a || '').replace(/\D/g, '');
  if (!companyId || k !== keyFor_(companyId)) throw new Error('Invalid link');
  if (isInactive_(getCompany_(companyId))) throw new Error('Inactive');
  CacheService.getScriptCache().remove('agent:' + companyId);
  return viewHtml_(getAgentData_(companyId), TEXT);
}

// Creates a lead in Kommo "Incoming leads": Source = Agent, Company = the agent's company.
function addLead(a, k, f) {
  var companyId = String(a || '').replace(/\D/g, '');
  if (!companyId || k !== keyFor_(companyId)) throw new Error('Invalid link');
  f = f || {};
  if (f.website) return { ok: true };                       // honeypot: bots fill it, people never see it

  var clean = function (v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); };
  var name = clean(f.name, 120), phone = clean(f.phone, 40), email = clean(f.email, 120);
  var tg = clean(f.telegram, 60), note = String(f.note || '').trim().slice(0, 1500);
  var product = clean(f.product, 120), country = clean(f.country, 120);

  if (!name) return { ok: false, error: 'Please enter the client name.' };
  if (!phone && !email && !tg) return { ok: false, error: 'Add at least one contact: phone, email or Telegram.' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Email looks incorrect.' };
  if (phone && phone.replace(/\D/g, '').length < 6) return { ok: false, error: 'Phone number looks too short.' };
  if (product && getEnums_(CF.PRODUCT).indexOf(product) < 0) product = '';
  if (country && getEnums_(CF.COUNTRY).indexOf(country) < 0) country = '';
  if (tg && tg.charAt(0) !== '@' && tg.indexOf('t.me') < 0) tg = '@' + tg;

  var cache = CacheService.getScriptCache();
  var token = clean(f.token, 60);
  if (token && cache.get('tok:' + token)) return { ok: true };   // same form sent twice (double tap)
  var used = Number(cache.get('rl:' + companyId) || 0);
  if (used >= MAX_LEADS_PER_HOUR) return { ok: false, error: 'Too many leads in an hour. Please try later or contact Company.' };

  var company = getCompany_(companyId);
  if (!company) return { ok: false, error: 'Agent not found. Contact Company.' };
  if (isInactive_(company)) return { ok: false, error: 'This link is no longer active. Contact Company.' };

  var leadFields = [{ field_id: CF.SOURCE, values: [{ value: AGENT_SOURCE }] }];
  if (product) leadFields.push({ field_id: CF.PRODUCT, values: [{ value: product }] });
  if (country) leadFields.push({ field_id: CF.COUNTRY, values: [{ value: country }] });
  var contactFields = [];
  if (phone) contactFields.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] });
  if (email) contactFields.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
  if (tg) contactFields.push({ field_id: CF_CONTACT_TELEGRAM, values: [{ value: tg }] });

  var now = Math.floor(Date.now() / 1000);
  var contact = { name: name };
  if (contactFields.length) contact.custom_fields_values = contactFields;
  var res = kommoPost_('/api/v4/leads/unsorted/forms', [{
    source_name: 'Agent', source_uid: 'agent', pipeline_id: PIPELINE_ID, created_at: now,
    // form_page is what Kommo shows as the card header in Incoming leads
    metadata: { form_id: 'agent-' + companyId, form_name: 'Lead from ' + company.name,
                form_page: 'Lead from ' + company.name, form_sent_at: now, ip: '127.0.0.1', referer: 'https://example.com/agent/' },
    _embedded: { leads: [{ name: name, custom_fields_values: leadFields }], contacts: [contact] }
  }]);
  var emb = res._embedded.unsorted[0]._embedded;
  var leadId = emb.leads[0].id;
  var contactId = emb.contacts && emb.contacts[0] && emb.contacts[0].id;

  // Kommo ignores a company at creation time, so the agent's company is linked by a second request
  kommoPost_('/api/v4/leads/' + leadId + '/link', [{ to_entity_id: Number(companyId), to_entity_type: 'companies' }]);
  // the client's contact card gets the same company, so it does not show "Company name not specified"
  if (contactId) {
    try { kommoPost_('/api/v4/contacts/' + contactId + '/link', [{ to_entity_id: Number(companyId), to_entity_type: 'companies' }]); }
    catch (err) { console.error(err); }
  }
  try {
    kommoPost_('/api/v4/leads/' + leadId + '/notes', [{ note_type: 'common', params: {
      text: 'Lead from agent: ' + company.name + (note ? '\nAgent note: ' + note : '') } }]);
  } catch (err) { console.error(err); }   // a failed note must not lose the lead

  if (token) cache.put('tok:' + token, '1', 600);
  cache.put('rl:' + companyId, String(used + 1), 3600);
  cache.remove('agent:' + companyId);
  return { ok: true, html: viewHtml_(getAgentData_(companyId), TEXT) };
}

// ---------------------------------------------------------------- data
function getAgentData_(companyId) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('agent:' + companyId);
  if (hit) return JSON.parse(hit);

  var company = getCompany_(companyId);
  if (!company) throw new Error('Company not found');
  var groups = { fresh: [], inwork: [], lost: [], paid: [], comm: [] };

  getCompanyLeads_(companyId).forEach(function (l) {
    var item = {
      name: l.name || ('#' + l.id),
      product: cfValue_(l, CF.PRODUCT),
      country: cfValue_(l, CF.COUNTRY)
    };
    var commPaid = cfValue_(l, CF.COMMISSION_PAID).toLowerCase() === 'yes';
    if (commPaid) groups.comm.push(item);
    else if (PAID_STAGES.indexOf(l.status_id) >= 0) groups.paid.push(item);
    else if (l.status_id === ST.LOST) groups.lost.push(item);
    else if (IN_WORK_STAGES.indexOf(l.status_id) >= 0) groups.inwork.push(item);
    else if (l.status_id === ST.INCOMING) groups.fresh.push(item);   // waiting for a manager to accept
  });

  var data = { agentName: company.name, groups: groups, at: fmtDate_(Date.now() / 1000, true) };
  cache.put('agent:' + companyId, JSON.stringify(data), 60); // 1 min
  return data;
}

function fmtDate_(ts, withTime) {
  if (!ts) return '';
  return Utilities.formatDate(new Date(ts * 1000), 'Asia/Dubai', withTime ? 'dd.MM.yyyy HH:mm' : 'dd.MM.yyyy');
}

// ---------------------------------------------------------------- HTML
function page_(body, title) {
  var html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc_(title) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<style>' + CSS_ + '</style></head><body>' + body + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Styles of the agent page (v3 UI) and the admin page.
var CSS_ = "[hidden]{display:none!important}\n:root{--navy:#1E3A5F;--navy-d:#142940;--sand:#C8B69A;--steel:#55708C;--mute:#6B7A8F;--paper:#F7F8FA;--line:#E6E2D8;--card:#fff;--ok:#2E7D5B;--bad:#A24A3B;\n--display:\"Playfair Display\",Georgia,serif;--body:Montserrat,\"Helvetica Neue\",Arial,sans-serif}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--paper);color:var(--navy);font-family:var(--body);font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}\nbutton{font-family:inherit;cursor:pointer}\nbutton:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--sand);outline-offset:2px}\n.gut{padding-left:max(20px,env(safe-area-inset-left,0px));padding-right:max(20px,env(safe-area-inset-right,0px))}\n.bar{background:#fff;padding-block:12px;display:flex;justify-content:center;border-bottom:1px solid var(--line)}\n.bar img{height:36px}\n.top{background:var(--navy);color:#fff;padding-block:22px 24px}\n.eyebrow{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--sand);margin-bottom:10px}\nh1{font-family:var(--display);font-weight:400;font-size:26px;line-height:1.2;margin:0 0 8px}\n.who{font-size:13px;color:rgba(255,255,255,.8);display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}\n.who .dot{width:3px;height:3px;border-radius:50%;background:var(--sand)}\n.topin{max-width:1120px;margin:0 auto;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}\n.rf{flex-shrink:0;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.28);color:#fff;display:flex;align-items:center;justify-content:center}\n.rf:active{background:rgba(255,255,255,.2)}\n.wrap{max-width:1120px;margin:0 auto;padding-block:16px 110px}\n.chips{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:2px 0 14px}\n.chip{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:3px;font-size:11px;font-weight:500;line-height:1.25;letter-spacing:.04em;white-space:nowrap;text-transform:uppercase;text-align:center;color:var(--navy);background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 6px}\n.chip b{order:-1;font-size:15px;font-weight:600;line-height:1.2;color:var(--navy);letter-spacing:0}\n.acts{display:flex;align-items:center;gap:10px;flex-shrink:0}\n.hadd{display:none}\n.chip[aria-selected=true]{background:var(--navy);border-color:var(--navy);color:#fff}\n.chips .chip[aria-selected=true] b{color:var(--sand)}\n.list{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}\n.rowi{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-top:1px solid var(--line)}\n.rowi:first-child{border-top:0}\n.rowi>div{min-width:0}\n.nm{font-size:15px;font-weight:600}\n.rs{font-size:13px;color:var(--mute);margin-top:2px}\n.pill{flex-shrink:0;font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;border-radius:999px;padding:5px 10px;background:#EEF1F5;color:var(--steel)}\n.pill.fresh{background:#F4EFE4;color:#8A734C}\n.pill.paid,.pill.comm{background:#E6F2EC;color:var(--ok)}\n.pill.lost{background:#F7E9E6;color:var(--bad)}\n.empty{padding:26px 18px;text-align:center;font-size:13px;color:var(--mute)}\n.cta{position:fixed;left:0;right:0;bottom:0;padding-block:12px calc(14px + env(safe-area-inset-bottom,0px));background:linear-gradient(to top,var(--paper) 70%,rgba(247,248,250,0));display:flex;justify-content:center}\n.btn{width:100%;max-width:1120px;font-size:13px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:#fff;background:var(--navy);border:0;border-radius:999px;padding:17px 22px;box-shadow:0 8px 24px rgba(30,58,95,.22)}\n.ov{position:fixed;inset:0;background:rgba(20,41,64,.55);display:flex;align-items:flex-end;justify-content:center;z-index:50}\n.modal{background:#fff;width:100%;max-width:560px;height:100%;max-height:100%;display:flex;flex-direction:column;overflow:hidden}\n.mh{flex-shrink:0;display:flex;justify-content:space-between;align-items:center;padding:18px 20px;background:var(--navy);color:#fff}\n.mh .eyebrow{margin-bottom:4px}\n.mh h2{font-family:var(--display);font-weight:400;font-size:26px;margin:0}\n.x{width:40px;height:40px;border-radius:50%;font-size:24px;line-height:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.28);color:#fff}\n.mb{flex:1 1 auto;min-height:0;padding:6px 20px 18px;background:var(--paper);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}\n.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 12px}\n.mb label{display:block;font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--navy);margin-top:14px}\n.mb label i{color:#B08A45;font-style:normal}\n.mb input,.mb select,.mb textarea{display:block;width:100%;margin-top:7px;font:inherit;font-size:16px;letter-spacing:0;text-transform:none;color:var(--navy);background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px 14px;-webkit-appearance:none;appearance:none}\n.mb input::placeholder,.mb textarea::placeholder{color:#B4BCC8}\n.mb input:focus,.mb select:focus,.mb textarea:focus{border-color:var(--navy);box-shadow:0 0 0 3px rgba(30,58,95,.12)}\n.ferr{display:block;margin-top:6px;font-size:13px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--bad)}\n.mb .bad{border-color:var(--bad);background:#FDF6F4}\n.grp{margin-top:18px;padding:14px 14px 16px;background:#fff;border:1px solid var(--line);border-radius:16px}\n.grp label:first-of-type{margin-top:12px}\n.grp input{background:#fff}\n.grph{font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--navy)}\n.grph i{color:#B08A45;font-style:normal}\n.grph span{display:block;margin-top:3px;font-size:13px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--mute)}\n.grp.badg{border-color:var(--bad)}\n.dlgov{position:fixed;inset:0;z-index:70;background:rgba(20,41,64,.6);display:flex;align-items:center;justify-content:center;padding:24px}\n.dlg{width:100%;max-width:360px;background:#fff;border-radius:20px;padding:24px 22px 20px;box-shadow:0 20px 60px rgba(0,0,0,.3);text-align:center}\n.dlg h3{font-family:var(--display);font-weight:400;font-size:26px;line-height:1.2;margin:0 0 8px}\n.dlg p{font-size:13px;color:var(--mute);margin:0 0 20px}\n.dlgf{display:flex;flex-direction:column;gap:10px}\n.dlgf .btn{box-shadow:none;padding:15px}\n.dlgf .danger{background:#fff;color:var(--bad);border:1px solid var(--bad)}\n.toast{position:fixed;left:50%;bottom:calc(92px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);background:var(--ok);color:#fff;font-size:13px;font-weight:500;padding:12px 18px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:60;text-align:center}\n.mb select{background-image:linear-gradient(45deg,transparent 50%,var(--steel) 50%),linear-gradient(135deg,var(--steel) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat}\n.hint{font-size:13px;color:var(--navy);margin:16px 0 -2px;padding:9px 12px;background:#F1EBDD;border-radius:10px}\n.mf{flex-shrink:0;display:flex;gap:10px;padding:12px 20px calc(16px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line);background:#fff}\n.mf .btn{box-shadow:none;padding:15px}\n.mf .ghost{flex:0 0 auto;width:auto;background:#fff;color:var(--navy);border:1px solid var(--navy)}\n@media(min-width:600px){.ov{align-items:center;padding:24px}.modal{height:auto;max-height:100%;border-radius:20px}}\n@media(min-width:760px){\n.gut{padding-left:max(32px,env(safe-area-inset-left,0px));padding-right:max(32px,env(safe-area-inset-right,0px))}\n.top{padding-block:30px 32px}\n.wrap{max-width:1184px;padding-block:24px 48px}\n.chips{grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;padding-bottom:18px}\n.chip{min-height:0;padding:14px 8px;letter-spacing:.1em}\n.cta{display:none}\n.hadd{display:block;width:auto;background:#fff;color:var(--navy);box-shadow:none;padding:12px 22px}\n.rowi{padding:16px 24px}\n.rowi>div{display:flex;align-items:baseline;gap:24px;flex:1}\n.nm{flex:0 0 300px}\n.rs{margin-top:0}\n}\n.rowi.f{border-top:0}\n.list:not([data-cur=all]) .pill{display:none}\n.btn:disabled{opacity:.6}\n.btn.ghost{background:#fff;color:var(--navy);border:1px solid var(--navy);box-shadow:none}\n.rf.spin svg{animation:spin .8s linear infinite}\n@keyframes spin{to{transform:rotate(360deg)}}\n.hp{position:absolute!important;left:-9999px;width:1px;height:1px;opacity:0}\n.gen{margin:14px 0 0;padding:9px 12px;background:#F7E9E6;border-radius:10px}\n.done{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:36px 24px;background:var(--paper)}\n.done .ok{width:56px;height:56px;border-radius:50%;background:#E6F2EC;color:var(--ok);display:flex;align-items:center;justify-content:center;margin-bottom:16px}\n.done h3{font-family:var(--display);font-weight:400;font-size:26px;line-height:1.2;margin:0 0 8px}\n.done p{font-size:13px;color:var(--mute);margin:0 0 24px;max-width:320px}\n.done .dlgf{width:100%;max-width:320px}\n.sub{font-size:13px;color:rgba(255,255,255,.72)}\n.err{max-width:480px;margin:60px auto;padding:0 20px;text-align:center}.err h1{color:var(--navy);font-size:22px}.err p{color:var(--mute)}\ntable{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top}th{background:#F4F1EA;font-weight:600}\ntd .lnk{font-family:monospace;font-size:11.5px;word-break:break-all;color:var(--steel)}\ntd button{font:inherit;font-size:12px;border:1px solid var(--navy);background:#fff;color:var(--navy);border-radius:16px;padding:4px 10px;cursor:pointer;white-space:nowrap}td button:active{background:var(--navy);color:#fff}\ntr .id{color:#999;font-size:11px}tr .offnote{display:none;font-size:12px;color:#A24A3B;font-weight:600}tr.off{color:#9AA3AE}tr.off .lnk,tr.off .on{display:none}tr.off .offnote{display:block}td a{font-size:12px;margin-left:6px}.tg{min-width:96px}tr.off .tg{border-color:#2E7D5B;color:#2E7D5B}";

// Browser-side script of the agent page (filters, refresh, Add lead form). Source: client-v3.js
var CLIENT_JS_ = "(function(){\nvar $=function(i){return document.getElementById(i)};\nvar view=$(\"view\"),ov=$(\"ov\"),form=$(\"form\"),el=form.elements,send=$(\"send\"),cur=\"all\",tok=\"\";\n\nfunction apply(){\n  var list=view.querySelector(\".list\"),ch=view.querySelector(\".chips\");if(!list||!ch)return;\n  list.setAttribute(\"data-cur\",cur);var n=0;\n  list.querySelectorAll(\".rowi\").forEach(function(r){\n    var on=cur===\"all\"||r.getAttribute(\"data-s\")===cur;r.hidden=!on;r.classList.toggle(\"f\",on&&n===0);if(on)n++;\n  });\n  list.querySelector(\".empty\").hidden=n>0;\n  ch.querySelectorAll(\".chip\").forEach(function(c){c.setAttribute(\"aria-selected\",String(c.getAttribute(\"data-s\")===cur))});\n  var t=ch.getAttribute(\"data-total\");$(\"tot\").textContent=t+(t===\"1\"?\" client\":\" clients\");$(\"upd\").textContent=ch.getAttribute(\"data-at\");\n}\nfunction setView(h){view.innerHTML=h;apply()}\nview.addEventListener(\"click\",function(e){var c=e.target.closest(\".chip\");if(c){cur=c.getAttribute(\"data-s\");apply()}});\n\n$(\"rf\").onclick=function(){var b=this;if(b.disabled)return;b.disabled=true;b.classList.add(\"spin\");\n  var done=function(){b.disabled=false;b.classList.remove(\"spin\")};\n  google.script.run.withSuccessHandler(function(h){setView(h);done()}).withFailureHandler(done).getView(A,K)};\n\nfunction dirty(){return [\"name\",\"phone\",\"email\",\"telegram\",\"note\"].some(function(n){return el[n].value.trim()})||el.product.value||el.country.value}\nfunction clr(){[\"e-name\",\"e-contact\",\"e-phone\",\"e-email\",\"e-gen\"].forEach(function(i){$(i).hidden=true});\n  form.querySelectorAll(\".bad\").forEach(function(x){x.classList.remove(\"bad\")});$(\"g-contact\").classList.remove(\"badg\")}\nfunction stage(sent){$(\"fbody\").hidden=sent;$(\"mf\").hidden=sent;$(\"done\").hidden=!sent}\nfunction busy(on){send.disabled=on;send.textContent=on?\"Sending…\":\"Send lead\"}\nfunction open(){form.reset();clr();stage(false);busy(false);tok=Date.now()+\"-\"+Math.random().toString(36).slice(2);\n  ov.hidden=false;document.body.style.overflow=\"hidden\";setTimeout(function(){el.name.focus()},60)}\nfunction shut(){ov.hidden=true;$(\"ask\").hidden=true;document.body.style.overflow=\"\"}\nfunction tryClose(){if(send.disabled)return;if(!$(\"done\").hidden||!dirty()){shut();return}\n  var n=el.name.value.trim();$(\"dlg-t\").textContent=n?\"Discard lead for \"+n+\"?\":\"Discard this lead?\";$(\"ask\").hidden=false;$(\"keep\").focus()}\nfunction bad(id,input){$(id).hidden=false;if(input)input.classList.add(\"bad\");return true}\n\ndocument.querySelectorAll(\".addbtn\").forEach(function(b){b.onclick=open});\n$(\"close\").onclick=$(\"cancel\").onclick=tryClose;\n$(\"keep\").onclick=function(){$(\"ask\").hidden=true};\n$(\"discard\").onclick=shut;$(\"fin\").onclick=shut;$(\"again\").onclick=open;\nov.addEventListener(\"click\",function(e){if(e.target===ov)tryClose()});\ndocument.addEventListener(\"keydown\",function(e){if(e.key!==\"Escape\")return;if(!$(\"ask\").hidden)$(\"ask\").hidden=true;else if(!ov.hidden)tryClose()});\nform.addEventListener(\"input\",clr);\n\nform.addEventListener(\"submit\",function(e){e.preventDefault();if(send.disabled)return;clr();\n  var f={};[\"name\",\"phone\",\"email\",\"telegram\",\"product\",\"country\",\"note\",\"website\"].forEach(function(n){f[n]=el[n].value});f.token=tok;\n  var name=f.name.trim(),ph=f.phone.trim(),em=f.email.trim(),tg=f.telegram.trim(),first=null;\n  if(!name){bad(\"e-name\",el.name);first=el.name}\n  if(!ph&&!em&&!tg){$(\"e-contact\").hidden=false;$(\"g-contact\").classList.add(\"badg\");first=first||el.phone}\n  if(ph&&ph.replace(/\\D/g,\"\").length<6){bad(\"e-phone\",el.phone);first=first||el.phone}\n  if(em&&!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(em)){bad(\"e-email\",el.email);first=first||el.email}\n  if(first){first.focus();return}\n  busy(true);\n  var fail=function(t){busy(false);$(\"e-gen\").textContent=t;$(\"e-gen\").hidden=false;$(\"fbody\").scrollTop=0};\n  google.script.run.withSuccessHandler(function(r){\n    if(r&&r.ok){busy(false);if(r.html){cur=\"all\";setView(r.html)}\n      $(\"done-t\").textContent=name+\" is now in New. A manager will contact the client.\";stage(true);$(\"again\").focus()}\n    else fail((r&&r.error)||\"Could not send. Try again.\");\n  }).withFailureHandler(function(){fail(\"Could not send. Check your connection and try again.\")}).addLead(A,K,f);\n});\n\napply();\n})();\n";

var STATUS_ORDER = ['fresh', 'inwork', 'paid', 'comm', 'lost'];

// Status filters + the client list. Returned on page load, on Refresh and after a lead is added.
function viewHtml_(d, t) {
  var g = d.groups, total = 0;
  STATUS_ORDER.forEach(function (k) { total += g[k].length; });
  var chip = function (key, label, n) {
    return '<button type="button" role="tab" class="chip" data-s="' + key + '" aria-selected="' + (key === 'all') + '"><span>' +
      esc_(label) + '</span><b>' + n + '</b></button>';
  };
  var chips = chip('all', t.all, total) + STATUS_ORDER.map(function (k) { return chip(k, t[k], g[k].length); }).join('');
  var rows = STATUS_ORDER.map(function (k) {
    return g[k].map(function (c) {
      var sub = [c.product, c.country].filter(String).join(' · ') || t.none;
      return '<div class="rowi" data-s="' + k + '"><div><div class="nm">' + esc_(c.name) + '</div><div class="rs">' + esc_(sub) +
        '</div></div><span class="pill ' + k + '">' + esc_(t[k]) + '</span></div>';
    }).join('');
  }).join('');
  return '<div class="chips" role="tablist" data-total="' + total + '" data-at="' + esc_(String(d.at).slice(-5)) + '">' + chips + '</div>' +
    '<div class="list" data-cur="all">' + rows + '<div class="empty"' + (total ? ' hidden' : '') + '>' + esc_(t.empty) + '</div></div>';
}

function options_(list) {
  return '<option value="">' + esc_(TEXT.none) + '</option>' + list.map(function (v) {
    return '<option value="' + esc_(v) + '">' + esc_(v) + '</option>';
  }).join('');
}

function agentHtml_(d, t, companyId, key) {
  var total = 0;
  STATUS_ORDER.forEach(function (k) { total += d.groups[k].length; });
  var products = [], countries = [];
  try { products = getEnums_(CF.PRODUCT); countries = getEnums_(CF.COUNTRY); } catch (err) { console.error(err); }
  var agent = esc_(d.agentName);

  var header =
    '<div class="top gut"><div class="topin"><div><div class="eyebrow">Agent portal</div><h1>' + agent + '</h1>' +
    '<div class="who"><span id="tot">' + total + (total === 1 ? ' client' : ' clients') + '</span><span class="dot"></span>' +
    '<span>Updated <span id="upd">' + esc_(String(d.at).slice(-5)) + '</span></span></div></div>' +
    '<div class="acts"><button type="button" class="btn hadd addbtn">' + esc_(t.addLead) + '</button>' +
    '<button type="button" class="rf" id="rf" aria-label="Refresh" title="Refresh"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button></div></div></div>';

  var form =
    '<div class="ov" id="ov" hidden><form class="modal" id="form" novalidate>' +
    '<div class="mh"><div><div class="eyebrow">' + agent + '</div><h2>New lead</h2></div>' +
    '<button type="button" class="x" id="close" aria-label="Close">&times;</button></div>' +
    '<div class="mb" id="fbody">' +
    '<span class="ferr gen" id="e-gen" hidden></span>' +
    '<label>Client name <i>*</i><input name="name" maxlength="120" autocomplete="off" placeholder="Full name or first name">' +
    '<span class="ferr" id="e-name" hidden>Enter the client name.</span></label>' +
    '<div class="grp" id="g-contact"><div class="grph">Contact <i>*</i><span>at least one: phone, email or Telegram</span></div>' +
    '<span class="ferr" id="e-contact" hidden>Add a phone, an email or a Telegram username.</span>' +
    '<label>Phone / WhatsApp<input name="phone" type="tel" maxlength="40" autocomplete="off" placeholder="+971 50 000 0000">' +
    '<span class="ferr" id="e-phone" hidden>This phone number looks too short.</span></label>' +
    '<div class="pair"><label>Email<input name="email" type="email" maxlength="120" autocomplete="off" placeholder="name@example.com">' +
    '<span class="ferr" id="e-email" hidden>Check the email address.</span></label>' +
    '<label>Telegram<input name="telegram" maxlength="60" autocomplete="off" placeholder="@username"></label></div></div>' +
    '<div class="pair"><label>Product<select name="product">' + options_(products) + '</select></label>' +
    '<label>Country/Program<select name="country">' + options_(countries) + '</select></label></div>' +
    '<label>Note<textarea name="note" rows="2" maxlength="1500" placeholder="Anything the manager should know"></textarea></label>' +
    '<input name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '</div>' +
    '<div class="mf" id="mf"><button type="button" class="btn ghost" id="cancel">Cancel</button>' +
    '<button type="submit" class="btn" id="send">Send lead</button></div>' +
    '<div class="done" id="done" hidden><div class="ok"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>' +
    '<h3>Lead sent</h3><p id="done-t"></p><div class="dlgf"><button type="button" class="btn" id="again">Add another lead</button>' +
    '<button type="button" class="btn ghost" id="fin">Done</button></div></div>' +
    '</form></div>' +
    '<div class="dlgov" id="ask" hidden><div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">' +
    '<h3 id="dlg-t">Discard this lead?</h3><p>The details you entered will be lost.</p><div class="dlgf">' +
    '<button type="button" class="btn" id="keep">Keep editing</button><button type="button" class="btn danger" id="discard">Discard</button></div></div></div>';

  var js = '<script>var A=' + JSON.stringify(String(companyId)) + ',K=' + JSON.stringify(String(key)) + ';</' + 'script>' +
    '<script>' + CLIENT_JS_ + '</' + 'script>';

  return logoBar_() + header + '<div class="wrap gut" id="view">' + viewHtml_(d, t) + '</div>' +
    '<div class="cta gut"><button type="button" class="btn addbtn">' + esc_(t.addLead) + '</button></div>' + form + js;
}

function logoBar_() {
  if (!LOGO_B64) return '<div class="bar gut"><div style="font-family:var(--display);font-size:13px;letter-spacing:.24em;text-transform:uppercase;color:var(--steel);padding:10px 0">Agent Portal</div></div>';
  return '<div class="bar gut"><img src="data:image/png;base64,' + LOGO_B64 + '" alt="Company"></div>';
}

function errorHtml_(h, p) {
  return logoBar_() + '<div class="err"><h1>' + esc_(h) + '</h1><p>' + esc_(p) + '</p></div>';
}

function adminHtml_() {
  var rows = [];
  for (var pageNo = 1; pageNo < 20; pageNo++) {
    var r = kommo_('/api/v4/companies?limit=250&page=' + pageNo);
    var list = r && r._embedded && r._embedded.companies || [];
    list.forEach(function (c) {
      var link = linkFor_(c.id), off = isInactive_(c);
      rows.push('<tr data-id="' + c.id + '" class="' + (off ? 'off' : '') + '">' +
        '<td>' + esc_(c.name) + '<br><span class="id">id ' + c.id + '</span></td>' +
        '<td class="lc"><div class="lnk">' + esc_(link) + '</div><div class="offnote">INACTIVE · the link is switched off</div></td>' +
        '<td class="ac"><span class="on"><button class="copy" data-l="' + esc_(link) + '">Copy</button> ' +
        '<a href="' + esc_(link) + '" target="_blank">open</a></span></td>' +
        '<td><button class="tg" data-id="' + c.id + '" data-active="' + (off ? '0' : '1') + '">' + (off ? 'Activate' : 'Deactivate') + '</button></td></tr>');
    });
    if (list.length < 250) break;
  }
  var js = '<script>(function(){var S=' + JSON.stringify(prop_('SECRET')) + ';' +
    'document.addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;' +
    'if(b.classList.contains("copy")){navigator.clipboard.writeText(b.dataset.l).then(function(){b.textContent="✓";setTimeout(function(){b.textContent="Copy"},1200)});return}' +
    'if(!b.classList.contains("tg"))return;var on=b.dataset.active==="1",id=b.dataset.id,tr=b.closest("tr");' +
    'if(on&&!confirm("Deactivate this agent? Their link will stop working. Deals stay in Kommo."))return;' +
    'b.disabled=true;b.textContent="…";' +
    'google.script.run.withSuccessHandler(function(r){b.disabled=false;b.dataset.active=r.active?"1":"0";b.textContent=r.active?"Deactivate":"Activate";tr.classList.toggle("off",!r.active)})' +
    '.withFailureHandler(function(err){b.disabled=false;b.textContent=on?"Deactivate":"Activate";alert("Could not update: "+(err&&err.message||err))})' +
    '.setAgentActive(S,id,!on)});})();</' + 'script>';
  return logoBar_() + '<div class="top gut"><div><h1>Agents · personal links</h1>' +
    '<div class="sub">One company in Kommo = one agent. Copy the link and send it to the agent. Deactivate switches the link off; the agent\'s deals stay in Kommo.</div></div></div>' +
    '<div class="wrap gut" style="max-width:1064px;padding-bottom:48px"><table><tr><th>Company</th><th>Link</th><th></th><th>Status</th></tr>' +
    (rows.join('') || '<tr><td colspan="4">No companies in Kommo yet.</td></tr>') + '</table></div>' + js;
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---------------------------------------------------------------- tests (run from the editor)
// Run ▶ testKommo once: grants the "external service" permission and checks the token.
function testKommo() {
  var r = kommo_('/api/v4/account');
  Logger.log('OK, account: ' + r.name + ' (' + r.subdomain + ')');
  var c = kommo_('/api/v4/companies?limit=5');
  Logger.log('Companies: ' + JSON.stringify((c && c._embedded && c._embedded.companies || []).map(function (x) { return x.id + ' ' + x.name; })));
}

// Run ▶ testLinks to see personal links for the first companies in the log.
function testLinks() {
  var c = kommo_('/api/v4/companies?limit=10');
  (c && c._embedded && c._embedded.companies || []).forEach(function (x) { Logger.log(x.name + ' → ' + linkFor_(x.id)); });
}

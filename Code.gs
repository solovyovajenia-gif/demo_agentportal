// Company — Agent portal (personal link per agent)
// Agent opens  <web app URL>?a=<company id>&k=<key>  and sees their clients from Kommo
// grouped: In progress / Client paid / Commission paid / Client declined.
// A lead is shown to an agent only if: Company = agent's company AND Source = Agent (Sales pipeline).
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
  fresh: 'New', addLead: '+ Add lead',
  inwork: 'In progress', lost: 'Client declined', paid: 'Client paid', comm: 'Commission paid',
  empty: 'Nobody yet', none: 'Not specified', total: 'clients in total', updated: 'Updated', refresh: 'Refresh',
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
    '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<style>' + CSS_ + '</style></head><body>' + body + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

var CSS_ = [
  ':root{--navy:#1E3A5F;--navy-d:#142940;--sand:#C8B69A;--steel:#55708C;--mute:#6B7A8F;--paper:#F7F8FA;--warm:#F4F1EA;--card:#fff;--ok:#2E7D5B;--bad:#A24A3B}',
  '[hidden]{display:none!important}*{box-sizing:border-box}html,body{margin:0;background:var(--paper);color:var(--navy);font-family:Montserrat,"Helvetica Neue",Arial,sans-serif;font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}',
  '.bar{background:#fff;border-bottom:1px solid #E6E9EE;padding:12px 20px;display:flex;justify-content:center}.bar img{height:40px;width:auto;display:block}',
  '.top{background:var(--navy);color:#fff;padding:22px 20px 26px}.brand{font-family:"Playfair Display",Georgia,serif;font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:var(--sand);margin-bottom:12px}',
  'h1{font-family:"Playfair Display",Georgia,serif;font-weight:500;font-size:26px;margin:0 0 4px;line-height:1.2}.sub{font-size:13px;color:rgba(255,255,255,.72)}.agent{font-size:13px;color:rgba(255,255,255,.85);margin-top:10px}',
  '.wrap{max-width:720px;margin:0 auto;padding:16px 16px 40px}',
  '.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin:-34px 0 18px}.stat{background:var(--card);border-radius:10px;padding:10px 6px;text-align:center;box-shadow:0 2px 12px rgba(30,58,95,.08)}.stat b{display:block;font-size:20px;font-weight:600}.stat span{display:block;font-size:10px;color:var(--mute);line-height:1.2;margin-top:2px}',
  '.group{margin-bottom:22px}.gh{display:flex;align-items:baseline;justify-content:space-between;margin:0 4px 8px}.gh h2{font-family:"Playfair Display",Georgia,serif;font-weight:500;font-size:18px;margin:0}.gh .n{font-size:12px;color:var(--mute)}',
  '.card{background:var(--card);border-radius:12px;padding:12px 14px;margin-bottom:8px;border-left:4px solid var(--steel);box-shadow:0 1px 4px rgba(30,58,95,.06)}.card.paid,.card.comm{border-left-color:var(--ok)}.card.fresh{border-left-color:var(--sand)}.card.lost{border-left-color:var(--bad)}',
  '.card .nm{font-weight:600;font-size:15px}.card .meta{font-size:12.5px;color:var(--mute);margin-top:5px;line-height:1.55}.card .meta .lb{color:var(--mute)}.card .meta .vl{color:var(--navy);font-weight:500}.card .meta .na{color:#A9B3C0;font-style:italic}',
  '.empty{background:var(--warm);border-radius:12px;padding:14px;color:var(--mute);font-size:13.5px;text-align:center}',
  '.foot{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--mute);margin-top:8px}.foot a{color:var(--navy);text-decoration:none;font-weight:500;border:1px solid var(--navy);border-radius:20px;padding:6px 14px}',
  'button{font-family:inherit}.ghost{font-size:12.5px;font-weight:500;color:var(--navy);background:#fff;border:1px solid var(--navy);border-radius:20px;padding:7px 16px;cursor:pointer}.ghost:disabled{opacity:.5}',
  '.tl{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.add{flex-shrink:0;font-size:13px;font-weight:600;color:var(--navy);background:#fff;border:0;border-radius:22px;padding:10px 16px;cursor:pointer;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.18)}.add:active{transform:translateY(1px)}',
  '.ov{position:fixed;inset:0;background:rgba(20,41,64,.55);display:flex;align-items:flex-end;justify-content:center;z-index:50}.modal{background:#fff;width:100%;max-width:520px;max-height:92vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;overflow:hidden}',
  '.mh{display:flex;justify-content:space-between;align-items:center;padding:16px 20px 10px}.mh h2{font-family:"Playfair Display",Georgia,serif;font-weight:500;font-size:21px;margin:0;color:var(--navy)}.x{font-size:26px;line-height:1;background:none;border:0;color:var(--mute);cursor:pointer;padding:0 4px}',
  '.mb{padding:4px 20px 12px;overflow-y:auto;-webkit-overflow-scrolling:touch}.mb label{display:block;font-size:12px;font-weight:500;color:var(--mute);margin-top:12px}.mb label i{color:var(--bad);font-style:normal}',
  '.mb input,.mb select,.mb textarea{display:block;width:100%;margin-top:5px;font:inherit;font-size:16px;color:var(--navy);background:var(--paper);border:1px solid #DDE2E9;border-radius:10px;padding:11px 12px;outline:none;-webkit-appearance:none;appearance:none}.mb textarea{resize:vertical;min-height:72px}.mb input:focus,.mb select:focus,.mb textarea:focus{border-color:var(--steel);background:#fff}',
  '.mb select{background-image:linear-gradient(45deg,transparent 50%,var(--steel) 50%),linear-gradient(135deg,var(--steel) 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;background-size:5px 5px;background-repeat:no-repeat;padding-right:34px}',
  '.hint{font-size:12px;color:var(--steel);background:var(--warm);border-radius:8px;padding:8px 10px;margin:14px 0 0}.hp{position:absolute!important;left:-9999px;width:1px;height:1px;opacity:0}.msg{margin-top:12px;font-size:13px;color:var(--bad);background:#FBEDEA;border-radius:8px;padding:9px 11px}',
  '.mf{display:flex;gap:10px;justify-content:flex-end;padding:12px 20px calc(14px + env(safe-area-inset-bottom));border-top:1px solid #EEF0F3}.primary{font-size:14px;font-weight:600;color:#fff;background:var(--navy);border:0;border-radius:22px;padding:11px 22px;cursor:pointer}.primary:disabled{opacity:.6}.mf .ghost{padding:10px 18px;font-size:14px}',
  '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ok);color:#fff;font-size:13.5px;font-weight:500;padding:11px 18px;border-radius:24px;box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:60;white-space:nowrap}',
  'tr .id{color:#999;font-size:11px}tr .offnote{display:none;font-size:12px;color:#A24A3B;font-weight:600}tr.off{color:#9AA3AE}tr.off .lnk,tr.off .on{display:none}tr.off .offnote{display:block}td a{font-size:12px;margin-left:6px}.tg{min-width:96px}tr.off .tg{border-color:#2E7D5B;color:#2E7D5B}',
  '@media(max-width:420px){.stat{padding:9px 2px}.stat b{font-size:18px}.stat span{font-size:9px}}',
  '@media(min-width:600px){.ov{align-items:center}.modal{border-radius:18px}}',
  '.err{max-width:480px;margin:60px auto;padding:0 20px;text-align:center}.err h1{color:var(--navy);font-size:22px}.err p{color:var(--mute)}',
  'table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top}th{background:var(--warm);font-weight:600}td .lnk{font-family:monospace;font-size:11.5px;word-break:break-all;color:var(--steel)}td button{font:inherit;font-size:12px;border:1px solid var(--navy);background:#fff;color:var(--navy);border-radius:16px;padding:4px 10px;cursor:pointer;white-space:nowrap}td button:active{background:var(--navy);color:#fff}',
  '@media(min-width:600px){h1{font-size:30px}.stats{margin-top:-30px}.stat b{font-size:24px}.stat span{font-size:12px}}'
].join('');

function viewHtml_(d, t) {
  var g = d.groups;
  var order = [['fresh', t.fresh], ['inwork', t.inwork], ['paid', t.paid], ['comm', t.comm], ['lost', t.lost]];
  var total = 0;
  order.forEach(function (o) { total += g[o[0]].length; });

  var stats = order.map(function (o) {
    return '<div class="stat ' + o[0] + '"><b>' + g[o[0]].length + '</b><span>' + esc_(o[1]) + '</span></div>';
  }).join('');

  var groups = order.map(function (o) {
    var list = g[o[0]];
    var cards = list.length ? list.map(function (c) {
      return '<div class="card ' + o[0] + '"><div class="nm">' + esc_(c.name) + '</div><div class="meta">' +
        metaRow_('Product', c.product, t.none) +
        metaRow_('Country/Program', c.country, t.none) + '</div></div>';
    }).join('') : '<div class="empty">' + esc_(t.empty) + '</div>';
    return '<section class="group"><div class="gh"><h2>' + esc_(o[1]) + '</h2><span class="n">' + list.length + '</span></div>' + cards + '</section>';
  }).join('');

  return '<div class="stats" data-total="' + total + '">' + stats + '</div>' + groups +
    '<div class="foot"><span>' + esc_(t.updated) + ' ' + esc_(d.at) + '</span><button type="button" class="ghost" id="refresh">' + esc_(t.refresh) + '</button></div>';
}

function options_(list) {
  return '<option value="">' + esc_(TEXT.none) + '</option>' + list.map(function (v) {
    return '<option value="' + esc_(v) + '">' + esc_(v) + '</option>';
  }).join('');
}

function agentHtml_(d, t, companyId, key) {
  var total = 0;
  Object.keys(d.groups).forEach(function (kk) { total += d.groups[kk].length; });
  var products = [], countries = [];
  try { products = getEnums_(CF.PRODUCT); countries = getEnums_(CF.COUNTRY); } catch (err) { console.error(err); }

  var modal =
    '<div class="ov" id="ov" hidden><form class="modal" id="form" novalidate>' +
    '<div class="mh"><h2>New lead</h2><button type="button" class="x" id="close" aria-label="Close">&times;</button></div>' +
    '<div class="mb">' +
    '<label>Client name <i>*</i><input name="name" maxlength="120" autocomplete="off" placeholder="Full name or first name"></label>' +
    '<p class="hint">At least one contact is required: phone, email or Telegram.</p>' +
    '<label>Phone / WhatsApp<input name="phone" type="tel" maxlength="40" autocomplete="off" placeholder="+971 50 000 0000"></label>' +
    '<label>Email<input name="email" type="email" maxlength="120" autocomplete="off" placeholder="name@example.com"></label>' +
    '<label>Telegram<input name="telegram" maxlength="60" autocomplete="off" placeholder="@username"></label>' +
    '<label>Product<select name="product">' + options_(products) + '</select></label>' +
    '<label>Country/Program<select name="country">' + options_(countries) + '</select></label>' +
    '<label>Note<textarea name="note" rows="3" maxlength="1500" placeholder="Anything the manager should know"></textarea></label>' +
    '<input name="website" class="hp" tabindex="-1" autocomplete="off">' +
    '<div class="msg" id="msg" hidden></div>' +
    '</div><div class="mf"><button type="button" class="ghost" id="cancel">Cancel</button><button type="submit" class="primary" id="send">Send lead</button></div>' +
    '</form></div>' +
    '<div class="toast" id="toast" hidden>Lead sent to Company</div>';

  var js = '<script>(function(){' +
    'var A=' + JSON.stringify(String(companyId)) + ',K=' + JSON.stringify(String(key)) + ';' +
    'var $=function(i){return document.getElementById(i)};var ov=$("ov"),form=$("form"),msg=$("msg"),send=$("send"),view=$("view"),tok="";' +
    'function total(){var s=view.querySelector(".stats");if(s)$("tot").textContent=s.getAttribute("data-total")}' +
    'function open(){form.reset();msg.hidden=true;tok=Date.now()+"-"+Math.random().toString(36).slice(2);ov.hidden=false;document.body.style.overflow="hidden";setTimeout(function(){form.elements.name.focus()},50)}' +
    'function close(){ov.hidden=true;document.body.style.overflow=""}' +
    'function err(t){msg.textContent=t;msg.hidden=false;send.disabled=false;send.textContent="Send lead"}' +
    'function toast(){var t=$("toast");t.hidden=false;setTimeout(function(){t.hidden=true},3500)}' +
    '$("add").onclick=open;$("close").onclick=close;$("cancel").onclick=close;' +
    'ov.addEventListener("click",function(e){if(e.target===ov)close()});' +
    'document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!ov.hidden)close()});' +
    'form.addEventListener("submit",function(e){e.preventDefault();var f={},el=form.elements;' +
    '["name","phone","email","telegram","product","country","note","website"].forEach(function(n){f[n]=el[n].value});f.token=tok;' +
    'if(!f.name.trim())return err("Please enter the client name.");' +
    'if(!f.phone.trim()&&!f.email.trim()&&!f.telegram.trim())return err("Add at least one contact: phone, email or Telegram.");' +
    'msg.hidden=true;send.disabled=true;send.textContent="Sending…";' +
    'google.script.run.withSuccessHandler(function(r){if(r&&r.ok){if(r.html){view.innerHTML=r.html;total()}close();send.disabled=false;send.textContent="Send lead";toast()}else err((r&&r.error)||"Could not send. Try again.")})' +
    '.withFailureHandler(function(){err("Could not send. Check your connection and try again.")}).addLead(A,K,f)});' +
    'view.addEventListener("click",function(e){var b=e.target.closest("#refresh");if(!b)return;b.disabled=true;b.textContent="…";' +
    'google.script.run.withSuccessHandler(function(h){view.innerHTML=h;total()}).withFailureHandler(function(){b.disabled=false;b.textContent="Refresh"}).getView(A,K)});' +
    '})();</' + 'script>';

  return logoBar_() + '<div class="top"><div class="tl"><div><h1>' + esc_(t.title) + '</h1>' +
    '<div class="sub">' + esc_(t.sub) + '</div></div>' +
    '<button type="button" class="add" id="add">' + esc_(t.addLead) + '</button></div>' +
    '<div class="agent">' + esc_(d.agentName) + ' · <span id="tot">' + total + '</span> ' + esc_(t.total) + '</div></div>' +
    '<div class="wrap" id="view">' + viewHtml_(d, t) + '</div>' + modal + js;
}

function metaRow_(label, value, none) {
  return '<div class="row"><span class="lb">' + esc_(label) + ':</span> ' +
    (value ? '<span class="vl">' + esc_(value) + '</span>' : '<span class="na">' + esc_(none) + '</span>') + '</div>';
}

function logoBar_() {
  return '<div class="bar"><img src="data:image/png;base64,' + LOGO_B64 + '" alt="Company"></div>';
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
  return logoBar_() + '<div class="top"><h1>Agents · personal links</h1>' +
    '<div class="sub">One company in Kommo = one agent. Copy the link and send it to the agent. Deactivate switches the link off; the agent\'s deals stay in Kommo.</div></div>' +
    '<div class="wrap" style="max-width:1000px"><table><tr><th>Company</th><th>Link</th><th></th><th>Status</th></tr>' +
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

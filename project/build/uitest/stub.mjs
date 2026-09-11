import http from 'node:http';
import fs from 'node:fs';
const page = fs.readFileSync(process.argv[2] || '../../../docs/app.html', 'utf8');

const P = (id,n)=>({id, full_name:n, app_role:'ADMIN', department:'Operations', chair_title:'Head — Operations'});
const OGL_A = (ref,st,sla)=>({id:'a-'+ref, ref, applicant_name:'R. Kulkarni',
  client:'State Bank of India', location:'Kothrud, Pune', current_state:st,
  sla_status:sla, cycle_no:1, escalation_level:sla==='BREACHED'?2:0,
  due_at:'2026-09-12T07:30:00Z', open_request_type:sla==='BREACHED'?'DELAY':null,
  next_action_owner:'A. Deshpande'});

const ROUTES = {
  '/api/config': {googleClientId:'', workspaceDomain:'cruxindia.co.in'},
  '/api/health': {ok:true},
  '/api/me': P('p1','Sample Administrator'),
  '/api/login': {token:'t', person:P('p1','Sample Administrator')},
  '/api/logout': {ok:true},
  '/api/kinds': {kinds:[{id:1,code:'BRANCH',title:'Branches'},{id:12,code:'SLA',title:'SLA rules'}]},
  '/api/refs': {clients:[{id:1,name:'State Bank of India'}], branches:[{id:1,name:'Kothrud'}],
    zones:[{id:1,name:'West'}], verification_types:['RESIDENCE','OFFICE'],
    people:[{id:'p1',full_name:'Sample Administrator'}], categories:[{id:1,name:'Service'}],
    desks:[{id:1,name:'Ops'}]},
  '/api/ogl': {assignments:[OGL_A('OGL-0001','IN_PROGRESS','ON_TRACK'), OGL_A('OGL-0002','ALLOCATED','BREACHED')]},
  '/api/ogl/tray': {segments:[{segment_id:'s1', ref:'OGL-0002', allocated_to:'A. Deshpande',
    minutes:95, reason_text:'Customer asked us to come back after 3 pm'}]},
  '/api/ogl/strikes': {strikes:[]},
  '/api/ogl/decisions': {decisions:[{id:'d1', force1_point_id:'P-77120', ref:'OGL-0003',
    prior_ref:'OGL-0002', applicant_name:'R. Kulkarni', prior_address:'14-B, M.G. Road',
    new_address:'14B MG Road', address_match:'NORMALISED', match_score:100, proposed:'REVISIT'}]},
  '/api/ogl/reasons': {reasons:[{id:1,label:'Address not traceable'}]},
  '/api/template': {columns:[]},
  '/api/mail': {settings:{provider:null}, outbox:[], status:{configured:false, provider:null}},
  '/api/reset/preview': {counts:{}},
  '/people/me': {primaryChair:{title:'Head — Operations'}, chairs:[], person:P('p1','Sample Administrator')},
  '/cases': {cases:[{id:'c1', ref:'ESC-0001', status:'OPEN', client_name:'SBI', branch_name:'Kothrud',
    category_name:'Service', last_activity_at:'2026-09-10T11:00:00Z'}]},
  '/matrix/incomplete': {branches:[{id:1,name:'Wakad',missing:['L3']}]},
  '/pms/cycle/current': {cycle:{id:1,label:'FY26 Q2'}, score:{final:82.4, kpis:[]}, kpis:[]},
  '/pms/me': {score:{final:82.4}, kpis:[]},
  '/people': {people:[P('p1','Sample Administrator')], branches:[]},
  '/penalties': {penalties:[]},
};

// the same CORS the real function sends
const CORS = {
  'access-control-allow-origin':'*',
  'access-control-allow-headers':'content-type, x-crux-token',
  'access-control-allow-methods':'GET,POST,OPTIONS',
};
const srv = http.createServer((req,res)=>{
  if (req.method === 'OPTIONS') { res.writeHead(200, CORS); return res.end('ok'); }
  const u = new URL(req.url,'http://x');
  let path = u.pathname;
  for (const pre of ['/functions/v1/crux','/functions/v1/api']) if (path.startsWith(pre)) path = path.slice(pre.length) || '/';
  if (path === '/' || path === '') { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(page); }
  const body = ROUTES[path];
  res.writeHead(body?200:404,{'content-type':'application/json', ...CORS});
  res.end(JSON.stringify(body || {error:'not_found', path}));
});
srv.listen(8787, ()=>console.log('stub on 8787'));

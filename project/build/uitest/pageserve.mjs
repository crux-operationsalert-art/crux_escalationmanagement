import http from 'node:http'; import fs from 'node:fs';
const page = fs.readFileSync('../../../docs/app.html','utf8');
http.createServer((q,r)=>{ r.writeHead(200,{'content-type':'text/html; charset=utf-8'}); r.end(page); })
  .listen(8899, ()=>console.log('page on 8899'));

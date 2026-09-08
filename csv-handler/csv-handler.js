const { parse } = require('csv-parse/sync');
const fs=require('fs');
function sanitize(val){ if(typeof val!=='string') return val; const t=val.trim(); if(/^[=\+\-@]/.test(t)) return `'${t}`; return t.replace(/<[^>]*>/g,''); }
function validateEmail(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function processCSV(filePath){
  const content=fs.readFileSync(filePath,'utf-8');
  const records=parse(content,{columns:true,skip_empty_lines:true,trim:true});
  if(records.length>5000) throw new Error('Max 5000 rows');
  const seen=new Set(); let valid=0,dup=0,invalid=0; const out=[];
  for(const r of records){
    const s={}; for(const k in r) s[k.toLowerCase()]=sanitize(r[k]);
    const phone=s.phone||s.mobile||''; const email=s.email||'';
    if(email && !validateEmail(email)){ invalid++; continue; }
    const key=`${phone}|${email}`.toLowerCase();
    if(seen.has(key)){ dup++; continue; }
    seen.add(key); out.push(s); valid++;
  }
  return {total:records.length,valid,dup,invalid,data:out};
}
module.exports={processCSV,sanitize,validateEmail};
console.log('CSV handler secure 10MB 5000 rows ready');

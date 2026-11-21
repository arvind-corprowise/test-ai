import express from 'express';
import {generate,download} from './generator.js';
import fileUpload from 'express-fileupload';
import crypto from 'node:crypto';
import {pdfPageImages, visionExtract} from './pdf-vision.js';
import {listModels, pickModel} from './models.js';
import XLSX from 'xlsx';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';

const app = express();
const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OLLAMA_MODEL || 'auto';
const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || '';
const OCR_PAGES = 8;
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const IMAGE = new Set(['.png','.jpg','.jpeg','.webp']);
const DOC = new Set(['.pdf','.csv','.xlsx','.txt','.md','.json']);
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const GENERATED_DIR = path.join(ROOT, 'generated');
await fs.mkdir(UPLOAD_DIR, {recursive:true,mode:0o700});
await fs.mkdir(GENERATED_DIR, {recursive:true,mode:0o700});
app.use(fileUpload({useTempFiles:true,tempFileDir:UPLOAD_DIR,createParentPath:true,
  limits:{fileSize:5*1024*1024,files:5},abortOnLimit:true,parseNested:false}));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
function validIds(value) {
  if (!Array.isArray(value) || value.length > MAX_FILES || value.some(id => typeof id !== 'string' || !UUID.test(id))) throw Error('Supply up to 5 valid uploaded fileIds');
  if (new Set(value).size !== value.length) throw Error('Duplicate uploaded fileIds');
  return value;
}
async function storedFiles(ids) {
  const result=[];
  for(const id of validIds(ids)) {
    let meta,stat,filepath;
    try{
      meta=JSON.parse(await fs.readFile(path.join(UPLOAD_DIR,id+'.json'),'utf8'));
      filepath=path.join(UPLOAD_DIR,id+meta.ext);
      stat=await fs.stat(filepath);
    }catch(e){if(e.code==='ENOENT'){console.warn('Skipping missing upload',id);continue}throw e}
    if(!stat.isFile() || stat.size===0){console.warn('Skipping empty upload',id);continue}
    result.push({id,originalname:meta.originalname,path:filepath,size:stat.size});
  }
  return result;
}
app.use(express.json({limit:'1mb'}));
app.post('/api/files/upload',async(req,res)=>{
  let dest=null;
  try {
    const file=req.files?.file;
    if(!file || Array.isArray(file)) return res.status(400).json({detail:'Select one file using the file field'});
    const originalname=String(file.name||'upload');
    const ext=path.extname(originalname).toLowerCase();
    if(!IMAGE.has(ext) && !DOC.has(ext)) throw Error('Unsupported file type');
    if(file.truncated || file.size > MAX_BYTES) throw Error('File exceeds 5 MB');
    const id=crypto.randomUUID();dest=path.join(UPLOAD_DIR,id+ext);
    await file.mv(dest);
    const stat=await fs.stat(dest);
    if(!stat.isFile() || stat.size===0 || stat.size>MAX_BYTES) throw Error('Saved file is empty or oversized');
    if(ext==='.pdf') {
      const handle=await fs.open(dest,'r');
      try {const header=Buffer.alloc(5);const {bytesRead}=await handle.read(header,0,5,0);if(bytesRead!==5||header.toString('ascii')!=='%PDF-')throw Error('Invalid PDF signature');}
      finally {await handle.close()}
    }
    const meta={id,ext,originalname,size:stat.size,uploadedAt:new Date().toISOString()};
    await fs.writeFile(path.join(UPLOAD_DIR,id+'.json'),JSON.stringify(meta),{mode:0o600});
    console.log('Saved upload',id,originalname,stat.size);
    res.json({success:true,fileId:id,filename:originalname,size:stat.size});
  }catch(e){if(dest)await fs.rm(dest,{force:true}).catch(()=>{});res.status(400).json({detail:e.message})}
});
app.get('/api/files/:id',async(req,res)=>{
  try {const [file]=await storedFiles([req.params.id]);if(!file)throw Error();res.json({fileId:file.id,filename:file.originalname,size:file.size})}
  catch{res.status(404).json({detail:'File not found'})}
});
app.disable('x-powered-by');
app.use('/static',express.static(path.join(ROOT,'static')));
app.get('/',(_req,res)=>res.sendFile(path.join(ROOT,'static','index.html')));
app.get('/api/health',(_req,res)=>res.json({ok:true,model:MODEL}));
app.get('/api/models',async(_req,res)=>{
  try {
    const models=await listModels();
    const [text,vision]=await Promise.all([pickModel('auto').catch(()=>null),pickModel('auto',{needVision:true}).catch(()=>null)]);
    res.json({models:models.map(m=>m.name),details:models,auto:{text,vision},default:MODEL,textModel:TEXT_MODEL});
  }catch(e){res.status(502).json({detail:e.message})}
});
function tableFromText(text){
  const raw=text.trim();
  try {
    const parsed=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
    const items=Array.isArray(parsed)?parsed:(Array.isArray(parsed.rows)?parsed.rows:null);
    if(items?.length && items.every(x=>x&&typeof x==='object'&&!Array.isArray(x))){
      const headers=[...new Set(items.flatMap(x=>Object.keys(x)))];
      return [headers,...items.map(x=>headers.map(h=>x[h]??''))];
    }
  }catch{}
  // Accept Markdown tables with or without leading/trailing pipes.
  const lines=raw.split(/\r?\n/).filter(x=>(x.match(/\|/g)||[]).length>=2);
  if(lines.length>=2){
    const clean=y=>y.trim().replace(/\*\*|__/g,'').replace(/^Column [A-Z]+:\s*/i,'');
    // Only strip an outer leading pipe if the header uses one; otherwise " | Transfer" means an empty first cell.
    const outer=lines[0].trim().startsWith('|');
    let rows=lines.map(x=>{let l=x.replace(/\s+$/,'');if(outer)l=l.trim().replace(/^\|/,'');return l.replace(/\|$/,'').split('|').map(clean)})
      .filter(x=>!x.every(y=>y===''||/^:?-{2,}:?$/.test(y)));
    const width=rows[0].length;
    rows=rows.map(r=>{r=r.slice(0,width);while(r.length<width)r.push('');return r});
    // Convert numeric-looking cells (e.g. "4,247.14", "$85.00") to numbers.
    rows=rows.map((r,i)=>i===0?r:r.map(c=>/^-?\$?[\d,]+(\.\d+)?$/.test(c)?Number(c.replace(/[$,]/g,'')):c));
    if(rows.length>=2)return rows;
  }
  return null;
}
app.post('/api/export-excel',express.json({limit:'1mb'}),async(req,res)=>{
  try{
    const rows=tableFromText(String(req.body?.content||''));
    if(!rows)return res.status(400).json({detail:'No JSON rows or Markdown table found. Ask AI to return a Markdown table or JSON array first.'});
    if(rows.length>5000||rows[0].length>80)return res.status(400).json({detail:'Table too large'});
    const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('AI Draft');
    for(const row of rows)ws.addRow(row.map(x=>typeof x==='object'?JSON.stringify(x):x));
    ws.getRow(1).font={bold:true};ws.views=[{state:'frozen',ySplit:1}];
    for(let i=1;i<=rows[0].length;i++)ws.getColumn(i).width=22;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="kad-ai-draft.xlsx"');
    const exportId=crypto.randomUUID();
    const buffer=Buffer.from(await wb.xlsx.writeBuffer());
    await fs.writeFile(path.join(GENERATED_DIR,exportId+'.xlsx'),buffer,{mode:0o600});
    res.send(buffer);
  }catch(e){if(!res.headersSent)res.status(500).json({detail:e.message});else res.end()}
});

async function extract(file,ext){
  if(ext==='.pdf')throw Error('PDFs require visual page analysis');
  if(ext==='.xlsx'){
    const wb=XLSX.readFile(file.path);
    return wb.SheetNames.slice(0,5).map(name=>{
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,defval:''}).slice(0,150);
      return `Sheet: ${name}\n`+rows.map(row=>row.join(' | ')).join('\n');
    }).join('\n').slice(0,12000);
  }
  if(ext==='.csv'){
    // Preserve CSV quoting; model can interpret original CSV rows.
    return (await fs.readFile(file.path)).toString('utf8').replace(/^\uFEFF/,'').split(/\r?\n/).slice(0,150).join('\n').slice(0,12000);
  }
  return (await fs.readFile(file.path)).toString('utf8').slice(0,12000);
}

app.post('/api/chat',async(req,res)=>{
  const abort=new AbortController();
  res.on('close',()=>{if(!res.writableEnded)abort.abort()});
  try{
    const staged=await storedFiles(req.body.fileIds || []);
    const message=typeof req.body.message==='string'?req.body.message:'';
    const requestedModel=String(req.body.model||'auto');
    if(message.length>10000)return res.status(400).json({detail:'Message too long'});
    let history;
    try{history=Array.isArray(req.body.history)?req.body.history:JSON.parse(req.body.history||'[]');if(!Array.isArray(history))throw Error()}catch{return res.status(400).json({detail:'Invalid chat history'})}
    const messages=[{role:'system',content:'You are KAD Local AI, a helpful assistant. Answer directly using your knowledge. Analyze documents and images accurately. Never invent financial figures or missing information. Clearly state when document input is truncated.'}];
    for(const item of history.slice(-12)){
      if(item&&['user','assistant'].includes(item.role)&&typeof item.content==='string')messages.push({role:item.role,content:item.content.slice(0,3000)});
    }
    const images=[],docs=[];
    for(const file of staged){
      const name=path.basename(file.originalname);
      const ext=path.extname(name).toLowerCase();
      if(!IMAGE.has(ext)&&!DOC.has(ext))return res.status(400).json({detail:`Unsupported file: ${name}`});
      if(IMAGE.has(ext))images.push((await fs.readFile(file.path)).toString('base64'));
      else if(ext==='.pdf'){
        const pages=await pdfPageImages(file.path,4);
        const selectedVision=await pickModel(requestedModel,{needVision:true}).catch(()=>pickModel('auto',{needVision:true}));
        for(let i=0;i<pages.length;i++){
          const content=await visionExtract(selectedVision,pages[i],`Read PDF page ${i+1}/${pages.length} visually. Transcribe its content and tables accurately. Preserve dates, numbers and original row order. Do not guess.`,{tokens:1800});
          docs.push(`--- ${name}, page ${i+1} of ${pages.length} ---\n${content}`);
        }
      } else docs.push(`--- ${name} ---\n${await extract(file,ext)}`);
    }
    let prompt=message.trim()||'Analyze the attached files.';
    if(docs.length){const combined=docs.join('\n\n');if(combined.length>18000)throw Error('Document text exceeds chat context; use Create Excel with smaller PDFs instead.');prompt+='\n\nAttached documents:\n'+combined;}
    messages.push({role:'user',content:prompt,...(images.length?{images}:{})});
    const visual=images.length>0;
    let selected;
    try{selected=await pickModel(requestedModel,{needVision:visual})}catch(e){return res.status(400).json({detail:e.message})}
    res.setHeader('X-Selected-Model',selected);
    const upstream=await fetch(`${OLLAMA}/api/chat`,{method:'POST',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({model:selected,messages,stream:true,think:false,options:{num_ctx:4096,num_predict:900}})});
    if(!upstream.ok)return res.status(502).json({detail:`Ollama returned ${upstream.status}: ${(await upstream.text()).slice(0,250)}`});
    res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('X-Accel-Buffering','no');
    const reader=upstream.body.getReader();let buffer='';const decoder=new TextDecoder();
    while(true){
      const {done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){if(!line.trim())continue;const part=JSON.parse(line);if(part.error)throw Error(part.error);if(part.message?.content)res.write(JSON.stringify({text:part.message.content})+'\n')}
    }
    res.end(JSON.stringify({done:true})+'\n');
  }catch(err){
    if(res.destroyed)return;
    if(res.headersSent){res.write(JSON.stringify({error:String(err.message||err).slice(0,500)})+'\n');res.end()}
    else res.status(400).json({detail:String(err.message||err).slice(0,500)});
  }
});
app.use((err,_req,res,_next)=>res.status(400).json({detail:err.message}));
app.post('/api/workbook',async(req,res)=>{
  try{
    const staged=await storedFiles(req.body.fileIds || []);
    const result=await generate({instructions:String(req.body?.instructions||''),files:staged,model:String(req.body?.model||'auto'),previousId:String(req.body?.previousId||'')});
    // Retain generated Excel under project/generated as requested, as well as existing revision storage.
    const saved=await download(result.id);
    await fs.writeFile(path.join(GENERATED_DIR,`${result.id}.xlsx`),saved.buffer,{mode:0o600});
    res.json(result);
  }catch(e){res.status(400).json({detail:String(e.message||e)})}
});
app.get('/api/workbook/:id/download',async(req,res)=>{
  try{const {buffer,filename}=await download(req.params.id);res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="${filename.replace(/["\r\n]/g,'')}"`);res.send(buffer)}
  catch(e){res.status(404).json({detail:'Workbook not found'})}
});
app.listen(PORT,'127.0.0.1' ,()=>console.log(`KAD Local AI at http://127.0.0.1:${PORT}`));


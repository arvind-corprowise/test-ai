import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pdfPageImages, visionExtract} from './pdf-vision.js';
import {pickModel} from './models.js';
import XLSX from 'xlsx';
import {normalizeSpec,makeWorkbook} from './workbook.js';
const run=promisify(execFile);
const OLLAMA=process.env.OLLAMA_URL||'http://127.0.0.1:11434';
const DATA=path.join(os.homedir(),'.kad-local-ai-workbooks');
const MAX_PAGES=20,MAX_CHARS=50000;
const MAX_CHUNK=6500;
function cleanJSON(text){const match=text.match(/```(?:json)?\s*([\s\S]*?)```/);const s=match?match[1]:text;const start=s.indexOf('{'),end=s.lastIndexOf('}');if(start<0||end<start)throw Error('AI did not return a JSON workbook');return JSON.parse(s.slice(start,end+1))}
async function ask(model,system,prompt,{tokens=2800,ctx=8192}={}){
 const r=await fetch(`${OLLAMA}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,think:false,format:'json',options:{num_ctx:ctx,num_predict:tokens,temperature:0.1},messages:[{role:'system',content:system},{role:'user',content:prompt}]})});
 if(!r.ok)throw Error(`Ollama ${r.status}: ${(await r.text()).slice(0,300)}`);
 const d=await r.json();return cleanJSON(d.message?.content||'');
}
async function readFiles(files){const out=[];for(const f of files){const ext=path.extname(f.originalname).toLowerCase();let content='';let truncated=false;
 if(ext==='.pdf'){
   const pages=await pdfPageImages(f.path,12);
   out.push({name:f.originalname,pages,truncated:false});continue;
 }
 else if(ext==='.xlsx'){const wb=XLSX.readFile(f.path);content=wb.SheetNames.map(name=>`Sheet ${name}\n`+XLSX.utils.sheet_to_csv(wb.Sheets[name])).join('\n');}
 else if(['.csv','.txt','.md','.json'].includes(ext))content=(await fs.readFile(f.path)).toString('utf8');
 else if(['.png','.jpg','.jpeg','.webp'].includes(ext)){
   out.push({name:f.originalname,image:(await fs.readFile(f.path)).toString('base64'),truncated:false});continue;
 }else throw Error(`Unsupported file ${f.originalname}`);
 if(content.length>MAX_CHARS){content=content.slice(0,MAX_CHARS);truncated=true}
 out.push({name:f.originalname,content,truncated});
 }return out}
async function imageToText(model,base64,name){
 return visionExtract(model,base64,`Read this image (${name}) carefully. Transcribe all rows, headings, dates, descriptions, amounts and balances. Preserve the source order. Mark unreadable text as uncertain; never guess.`,{tokens:2200});
}
const EXTRACT_SYSTEM='Extract structured records from supplied document text. Return JSON ONLY: {"rows":[{"field":"value"}],"notes":[]}. Preserve original values and currency; never invent transactions or amounts. Keep each record distinct. For narrative documents use meaningful records. No Markdown.';
const PLAN_SYSTEM='You design Excel workbooks from user instructions and source records. Return ONLY JSON with {"filename":"name.xlsx","sheets":[{"name":"Sheet","columns":["Column A"],"rows":[["value"]],"highlights":[{"row":1,"color":"red"}]}],"notes":"limitations"}. Sheet columns and count must follow user instructions; never use a fixed template. Use all provided source records relevant to instructions, no invented facts. Rows must be arrays, numbers must be JSON numbers. Include meaningful totals only when computable; no speculative calculations. For revisions, modify the existing workbook. Limit 15 sheets, 60 columns, 15000 rows/sheet. Mark uncertain data for review. No Markdown.';
async function getModel(preferred){return pickModel(preferred||'auto')}
async function getVisionModel(){return pickModel('auto',{needVision:true}).catch(()=>null)}
export async function generate({instructions,files,model,previousId}){
 if(!instructions||instructions.length>6000)throw Error('Provide instructions (max 6000 characters)');
 await fs.mkdir(DATA,{recursive:true,mode:0o700});
 const selected=await getModel(model);let previous=null;
 if(previousId){if(!/^[a-f0-9-]{36}$/.test(previousId))throw Error('Invalid workbook ID');try{previous=JSON.parse(await fs.readFile(path.join(DATA,previousId+'.json'),'utf8'))}catch{throw Error('Previous workbook not found')}}
 let sources=[];const warnings=[];
 if(files.length){
  const docs=await readFiles(files);
  const vision=docs.some(d=>d.image||d.pages)?await getVisionModel():null;
  if(docs.some(d=>d.image||d.pages)&&!vision)throw Error('No vision-capable model found in Ollama on the VM (needed for images/PDFs).');
  for(const d of docs){
   const units=d.pages?d.pages.map((image,i)=>({image,page:i+1})):d.image?[{image:d.image,page:1}]:[];
   if(units.length){
    for(const unit of units){
     // AI reads the rendered page directly. No pdf-parse, OCR or fixed bank layouts.
     const prompt=`Extract every visible transaction or table row on this document page as JSON ONLY: {"rows":[{"date":"...","description":"...","withdrawal":"...","deposit":"...","balance":"..."}],"notes":[]}. These are example field names, NOT mandatory columns; use the actual labels/fields on the page. Keep amounts as shown and every row separate. Do not invent data. Return no prose. Source: ${d.name}, page ${unit.page}.`;
     const raw=await visionExtract(vision,unit.image,prompt,{tokens:3600,ctx:4096});
     let extracted;try{extracted=cleanJSON(raw)}catch{throw Error(`AI returned invalid JSON for ${d.name} page ${unit.page}; no workbook created`)}
     if(!Array.isArray(extracted.rows))throw Error(`No structured rows returned for ${d.name} page ${unit.page}`);
     sources.push(...extracted.rows.map(row=>({source:d.name,sourcePage:unit.page,...row})));
     if(sources.length>450)throw Error('More than 450 records; split input into smaller batches. No workbook was saved.');
    }
   }else{
    if(d.truncated)throw Error(`${d.name} exceeds the safe text limit; split the file. No workbook was saved.`);
    const chunks=(d.content.match(new RegExp(`[\\s\\S]{1,${MAX_CHUNK}}`,'g'))||[]);
    for(let i=0;i<chunks.length;i++){
     const extracted=await ask(selected,EXTRACT_SYSTEM,`Source file: ${d.name}; chunk ${i+1}/${chunks.length}\n${chunks[i]}`,{tokens:2600});
     if(!Array.isArray(extracted.rows))throw Error(`No structured rows returned for ${d.name} chunk ${i+1}`);
     sources.push(...extracted.rows.map(row=>({source:d.name,...row})));
     if(sources.length>450)throw Error('More than 450 records; split input into smaller batches.');
    }
   }
  }
 }

 // The model is CPU-only and its context is finite. Refuse oversized specifications rather than silently dropping rows.
 const sourceJSON=JSON.stringify(sources);
 const priorJSON=previous?JSON.stringify(previous.spec):'';
 if(sourceJSON.length>27000||priorJSON.length>27000)throw Error('Too much source data for a reliable single-pass workbook. Split documents into smaller batches. No data was silently dropped.');
 if(!files.length&&!previous)throw Error('Attach documents or revise a previously generated workbook');
 const request=`User instructions:\n${instructions}\n\n${previous?'Existing workbook JSON:\n'+priorJSON:'Create a new workbook.'}\n\nSource records (${sources.length}):\n${sourceJSON}\n\nIMPORTANT: Preserve every relevant record, follow requested sheets/columns and do not invent data.`;
 const raw=await ask(selected,PLAN_SYSTEM,request,{tokens:7500,ctx:16384});
 const spec=normalizeSpec(raw);
 const outputRows=spec.sheets.reduce((n,s)=>n+s.rows.length,0);
 if(sources.length>0&&outputRows===0)throw Error('AI returned no rows; workbook was not saved');
 const id=crypto.randomUUID();const buffer=await makeWorkbook(spec);
 await fs.writeFile(path.join(DATA,id+'.xlsx'),buffer,{mode:0o600});
 await fs.writeFile(path.join(DATA,id+'.json'),JSON.stringify({spec,createdAt:new Date().toISOString(),model:selected,sourceCount:sources.length}),{mode:0o600});
 return {id,filename:spec.filename.endsWith('.xlsx')?spec.filename:spec.filename+'.xlsx',model:selected,sheets:spec.sheets.map(s=>({name:s.name,rows:s.rows.length,columns:s.columns})),sourceCount:sources.length,warnings:[...warnings,...(spec.notes?[spec.notes]:[]),'AI-generated results are drafts: verify every figure, completeness, formulas and classifications before use.']};
}
export async function download(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid ID');const info=JSON.parse(await fs.readFile(path.join(DATA,id+'.json'),'utf8'));return {buffer:await fs.readFile(path.join(DATA,id+'.xlsx')),filename:info.spec.filename.endsWith('.xlsx')?info.spec.filename:info.spec.filename+'.xlsx'}}

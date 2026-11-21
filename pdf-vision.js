import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const OLLAMA=process.env.OLLAMA_URL||'http://127.0.0.1:11434';

export async function pdfPageImages(pdfPath, maxPages=12){
 const handle=await fs.open(pdfPath,'r');
 try{
  const header=Buffer.alloc(5);
  const {bytesRead}=await handle.read(header,0,5,0);
  if(bytesRead!==5||header.toString('ascii')!=='%PDF-')throw Error('Invalid or empty PDF upload');
 }finally{await handle.close()}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kad-pdf-'));
 try{
  const input=pdfPath;
  const {stdout}=await run('pdfinfo',[input],{timeout:20000,maxBuffer:1024*1024});
  const pages=Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
  if(!Number.isInteger(pages)||pages<1)throw Error('Could not determine PDF page count');
  if(pages>maxPages)throw Error(`PDF has ${pages} pages; this operation allows at most ${maxPages}. Split the PDF into smaller files; no pages were skipped.`);
  await run('pdftoppm',['-f','1','-l',String(pages),'-r','115','-png',input,path.join(dir,'page')],{timeout:240000,maxBuffer:1024*1024});
  const names=(await fs.readdir(dir)).filter(n=>/^page-\d+\.png$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  if(names.length!==pages)throw Error(`Rendered ${names.length} of ${pages} pages; PDF conversion incomplete`);
  return await Promise.all(names.map(n=>fs.readFile(path.join(dir,n)).then(b=>b.toString('base64'))));
 }finally{await fs.rm(dir,{recursive:true,force:true})}
}

export async function visionExtract(model,image,prompt,{tokens=2400,ctx=4096}={}){
 const response=await fetch(`${OLLAMA}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,think:false,options:{num_ctx:ctx,num_predict:tokens,temperature:0},messages:[{role:'user',content:prompt,images:[image]}]})});
 if(!response.ok)throw Error(`Ollama vision request failed: ${response.status} ${(await response.text()).slice(0,150)}`);
 const json=await response.json();const text=json.message?.content?.trim();
 if(!text)throw Error('Vision model returned no content; retry or increase model output tokens');
 return text;
}

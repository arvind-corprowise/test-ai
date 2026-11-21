const $=id=>document.getElementById(id);
const KEY='kad-local-ai-chats-v1';
let chats=[],current=null,pending=[],controller=null;
try{chats=JSON.parse(localStorage.getItem(KEY))||[]}catch{chats=[]}
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(chats))}catch{alert('Browser storage is full. Old chat history may need clearing.')}};
function newChat(){const chat={id:crypto.randomUUID(),title:'New conversation',messages:[],fileIds:[]};chats.unshift(chat);current=chat.id;save();render();}
function getChat(){return chats.find(c=>c.id===current)}
function selectChat(id){current=id;pending=[];render();$('sidebar').classList.remove('open')}
function renderList(){$('conversations').replaceChildren();for(const c of chats){const b=document.createElement('button');b.className='conversation'+(c.id===current?' active':'');b.textContent=c.title;b.onclick=()=>selectChat(c.id);$('conversations').append(b)}}
function addBubble(role,text,files=[]){const div=document.createElement('div');div.className='bubble '+role;const label=document.createElement('div');label.className='role';label.textContent=role==='assistant'?'✦ KAD Local AI':'You';const body=document.createElement('div');body.textContent=text;div.append(label,body);if(files.length){const info=document.createElement('span');info.className='attached-label';info.textContent='📎 '+files.join(', ');div.append(info)}$('messages').append(div);$('messages').scrollTop=$('messages').scrollHeight;return body}
function render() {renderList();$('messages').replaceChildren();const c=getChat();if(!c||!c.messages.length){const w=document.createElement('div');w.className='welcome';w.innerHTML='<div class="sparkle">✦</div><h1>How can I help you?</h1><p>Chat, paste an image, or attach a document.</p>';$('messages').append(w)}else for(const m of c.messages)addBubble(m.role,m.content,m.files||[]);renderAttachments()}
function renderAttachments(){$('attachments').replaceChildren();pending.forEach((item,i)=>{const d=document.createElement('div');d.className='chip';d.textContent='📎 '+item.name+' ('+item.status+')';const b=document.createElement('button');b.textContent='×';b.onclick=()=>{pending.splice(i,1);renderAttachments()};d.append(b);$('attachments').append(d)})}
async function addFiles(files){
 for(const f of files){
  if(pending.length>=5){alert('Maximum 5 attachments at once');break}
  if(f.size>5*1024*1024){alert(f.name+' exceeds 5 MB');continue}
  if(!['.png','.jpg','.jpeg','.webp','.pdf','.csv','.xlsx','.txt','.md','.json'].some(ext=>f.name.toLowerCase().endsWith(ext))){alert('Unsupported file: '+f.name);continue}
  const item={name:f.name,status:'uploading',id:null,promise:null};pending.push(item);renderAttachments();
  item.promise=(async()=>{try{
    const fd=new FormData();fd.append('file',f,f.name);
    const r=await fetch('/api/files/upload',{method:'POST',body:fd});const data=await r.json();
    if(!r.ok)throw Error(data.detail||'Upload failed');
    item.id=data.fileId;item.status='uploaded';
    const chat=getChat();if(chat){chat.fileIds=chat.fileIds||[];if(!chat.fileIds.includes(item.id))chat.fileIds.push(item.id);save()}
  }catch(e){item.status='failed: '+e.message}finally{renderAttachments()}})();
 }
}
async function waitUploads(){await Promise.all(pending.map(item=>item.promise).filter(Boolean));const failed=pending.find(x=>!x.id);if(failed)throw Error('Upload failed: '+failed.name+' — '+failed.status)}
function conversationFileIds(){return [...new Set([...(getChat()?.fileIds||[]),...pending.map(f=>f.id).filter(Boolean)])].slice(-5)}
function busy(v){$('send').classList.toggle('hidden',v);$('stop').classList.toggle('hidden',!v);$('prompt').disabled=v;$('attach').disabled=v}
async function send(){
 if(controller)return;
 const text=$('prompt').value.trim();if(!text&&!pending.length)return;
 const c=getChat();const files=[...pending];const previous=c.messages.map(m=>({role:m.role,content:m.content}));
 controller=new AbortController();busy(true);
 try{
  await waitUploads();const ids=conversationFileIds();
  c.messages.push({role:'user',content:text||'Analyze the attached files.',files:files.map(f=>f.name)});
  if(c.title==='New conversation')c.title=(text||files[0]?.name||'New conversation').slice(0,40);
  save();$('prompt').value='';pending=[];render();
  const reply={role:'assistant',content:''};c.messages.push(reply);const body=addBubble('assistant','Thinking…');
  try{
   const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,model:$('modelSelect').value,history:previous,fileIds:ids}),signal:controller.signal});
   if(!response.ok){let detail=await response.text();try{detail=JSON.parse(detail).detail||detail}catch{}throw Error(detail)}
   const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
   while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;const part=JSON.parse(line);if(part.error)throw Error(part.error);if(part.text){reply.content+=part.text;body.textContent=reply.content;$('messages').scrollTop=$('messages').scrollHeight}}}
   if(!reply.content)reply.content='No response generated.';
  }catch(e){reply.content+=(reply.content?'\n\n':'')+(e.name==='AbortError'?'[Stopped]':'Error: '+e.message)}
  finally{body.textContent=reply.content;save()}
 }catch(e){alert(e.message)}finally{controller=null;busy(false);$('prompt').focus()}
}
$('newChat').onclick=newChat;$('send').onclick=send;$('stop').onclick=()=>controller?.abort();$('attach').onclick=()=>$('fileInput').click();$('fileInput').onchange=e=>{addFiles([...e.target.files]);e.target.value=''};$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};$('prompt').onpaste=e=>{const files=[...e.clipboardData.items].filter(x=>x.kind==='file').map(x=>x.getAsFile()).filter(Boolean).map((f,i)=>new File([f],f.name?.includes('.')?f.name:`pasted-${Date.now()}-${i}.png`,{type:f.type}));if(files.length){e.preventDefault();addFiles(files)}};
for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.add('drag')});for(const event of ['dragleave','drop'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('drag')});$('dropzone').addEventListener('drop',e=>addFiles([...e.dataTransfer.files]));$('menu').onclick=()=>$('sidebar').classList.toggle('open');$('theme').onclick=()=>{document.body.classList.toggle('light');localStorage.setItem('kad-theme',document.body.classList.contains('light')?'light':'dark')};if(localStorage.getItem('kad-theme')==='light')document.body.classList.add('light');if(!chats.length)newChat();else{current=chats[0].id;render()}

async function loadModels(){
  try{const r=await fetch('/api/models');if(!r.ok)throw Error('Models unavailable');const d=await r.json();
    const auto=$('modelSelect').querySelector('option[value="auto"]');if(auto&&d.auto)auto.textContent=`Auto (${d.auto.text||d.auto.vision||'none installed'})`;
    for(const name of d.models){const opt=document.createElement('option');opt.value=name;opt.textContent=name+((d.details||[]).find(m=>m.name===name)?.vision?' 👁':'');$('modelSelect').append(opt)}
  }catch(e){console.warn(e.message)}
}
let lastWorkbookId=null;
$('createWorkbook').onclick=()=>{
  $('workbookModal').classList.remove('hidden');
  if(!$('workbookInstructions').value.trim())$('workbookInstructions').value=$('prompt').value.trim();
};
$('closeWorkbook').onclick=()=>$('workbookModal').classList.add('hidden');
$('workbookModal').onclick=e=>{if(e.target===$('workbookModal'))$('workbookModal').classList.add('hidden')};
$('generateWorkbook').onclick=async()=>{
 const instructions=$('workbookInstructions').value.trim();
 if(!instructions){$('workbookStatus').textContent='Please describe the Excel you want.';return}
 const revise=$('reviseWorkbook').checked;
 if(revise&&!lastWorkbookId){$('workbookStatus').textContent='No workbook to revise yet.';return}
 $('generateWorkbook').disabled=true;$('downloadWorkbook').classList.add('hidden');
 $('workbookStatus').textContent='Reading saved files and generating Excel. CPU inference may take several minutes…';
 try{
  await waitUploads();const fileIds=conversationFileIds();
  if(!revise&&!fileIds.length)throw Error('Attach source files first. They upload automatically.');
  const response=await fetch('/api/workbook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instructions,model:$('modelSelect').value,previousId:revise?lastWorkbookId:'',fileIds})});
  const result=await response.json();if(!response.ok)throw Error(result.detail||'Workbook generation failed');
  lastWorkbookId=result.id;
  $('workbookStatus').textContent=`Created ${result.sheets.length} sheet(s), ${result.sourceCount} extracted records. Model: ${result.model}. `+result.sheets.map(s=>`${s.name} (${s.rows} rows)`).join('; ')+(result.warnings?.length?'\nWarnings: '+result.warnings.join('; '):'');
  const link=$('downloadWorkbook');link.href='/api/workbook/'+encodeURIComponent(result.id)+'/download';link.setAttribute('download',result.filename);link.classList.remove('hidden');
 }catch(e){$('workbookStatus').textContent='Error: '+e.message}
 finally{$('generateWorkbook').disabled=false}
};
async function pruneMissingFiles(){
  let changed=false;
  for(const chat of chats){
    const ids=chat.fileIds||[];const keep=[];
    for(const id of ids){try{const r=await fetch('/api/files/'+id);if(r.ok)keep.push(id);else changed=true}catch{keep.push(id)}}
    chat.fileIds=keep;
  }
  if(changed)save();
}
loadModels();pruneMissingFiles();

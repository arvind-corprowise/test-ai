import ExcelJS from 'exceljs';

export function normalizeSpec(raw){
  const spec=typeof raw==='string'?JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,'')):raw;
  if(!spec||typeof spec!=='object'||!Array.isArray(spec.sheets)||!spec.sheets.length||spec.sheets.length>15)throw Error('Invalid workbook specification (1–15 sheets required)');
  let cells=0;
  const sheets=spec.sheets.map((sheet,index)=>{
    const name=String(sheet.name||`Sheet ${index+1}`).replace(/[\\/?*\[\]:]/g,' ').slice(0,31);
    const columns=Array.isArray(sheet.columns)?sheet.columns.map(c=>String(c).slice(0,100)):[];
    if(!columns.length||columns.length>60)throw Error('Each sheet needs 1–60 columns');
    if(!Array.isArray(sheet.rows)||sheet.rows.length>15000)throw Error('Too many rows');
    cells+=sheet.rows.length*columns.length;
    const rows=sheet.rows.map(row=>{
      if(!Array.isArray(row))throw Error('Rows must be arrays');
      return columns.map((_,i)=>{
        let value=row[i]??null;
        if(typeof value==='object'&&value!==null){
          if(typeof value.formula==='string'){
            const f=value.formula.replace(/^=/,'');
            if(f.length>150||!/^\s*(?:SUM|AVERAGE|COUNT|COUNTA|MIN|MAX|ROUND|IF|ABS|SUBTOTAL|SUMIF|COUNTIF|[A-Z]{1,3}[1-9]\d{0,6}|[\d\s+*/().,:$!<>=\-"'])*\s*$/i.test(f)||/\b(?:HYPERLINK|WEBSERVICE|DDE|CMD|EXEC|INDIRECT|IMPORT|CALL)\b/i.test(f))throw Error('Unsupported formula');
            return {formula:f};
          }
          throw Error('Unsupported cell object');
        }
        if(typeof value==='string'){
          value=value.slice(0,32000);
          // Prevent Excel formula injection from user-provided source text.
          if(/^[=+@\-\t\r]/.test(value))value="'"+value;
        }
        return value;
      });
    });
    const highlights=Array.isArray(sheet.highlights)?sheet.highlights.filter(h=>Number.isInteger(h.row)&&h.row>=1&&h.row<=rows.length).slice(0,5000):[];
    return {name,columns,rows,highlights};
  });
  if(cells>150000)throw Error('Workbook exceeds 150,000 cells');
  const seen=new Set();for(const s of sheets){let n=s.name||'Sheet';let j=2;while(seen.has(n.toLowerCase()))n=(s.name.slice(0,27)+` ${j++}`).slice(0,31);s.name=n;seen.add(n.toLowerCase())}
  return {filename:String(spec.filename||'kad-ai-report').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80),sheets,notes:String(spec.notes||'').slice(0,2000)};
}
export async function makeWorkbook(spec){
  const wb=new ExcelJS.Workbook();wb.creator='KAD Local AI';wb.created=new Date();
  for(const sheet of spec.sheets){
    const ws=wb.addWorksheet(sheet.name);ws.addRow(sheet.columns);ws.views=[{state:'frozen',ySplit:1}];
    ws.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rows.length+1),column:sheet.columns.length}};
    const header=ws.getRow(1);header.font={bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F3655'}};header.height=24;
    sheet.rows.forEach((row,i)=>{const r=ws.addRow(row);if(i%2===1)r.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F6FA'}};});
    sheet.columns.forEach((col,i)=>{ws.getColumn(i+1).width=Math.min(44,Math.max(13,col.length+4));});
    for(const h of sheet.highlights){const r=ws.getRow(h.row+1);const color=h.color==='yellow'?'FFFFE8A3':h.color==='green'?'FFDDF2DE':'FFFFD9D9';r.fill={type:'pattern',pattern:'solid',fgColor:{argb:color}};}
    ws.eachRow(row=>row.eachCell(cell=>{cell.alignment={vertical:'middle',wrapText:true};if(typeof cell.value==='number')cell.numFmt='#,##0.00;[Red](#,##0.00)';}));
  }
  return wb.xlsx.writeBuffer();
}

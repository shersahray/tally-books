'use strict';
// Only run this process inside the locked-down audit worker container.
// Input and output are bounded JSON over stdin/stdout.
const {extractPdf,MAX_PDF_BYTES}=require('./audit-pdf');
let chunks=[],length=0;
process.stdin.on('data',chunk=>{
 length+=chunk.length;
 if(length>Math.ceil(MAX_PDF_BYTES*1.4)+4096){process.stderr.write('Request too large');process.exit(1);}
 chunks.push(chunk);
});
process.stdin.on('end',async()=>{
 try{
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(typeof input.pdf!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.pdf))throw new Error('Invalid input');
  const bytes=Buffer.from(input.pdf,'base64');
  const result=await extractPdf(bytes,{ocr:input.ocr!==false,language:input.language||'eng'});
  process.stdout.write(JSON.stringify(result));
 }catch(error){process.stderr.write('PDF processing failed');process.exitCode=1;}
});

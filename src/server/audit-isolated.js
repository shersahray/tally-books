'use strict';
// Explicitly isolated PDF/OCR execution boundary: the application never runs
// poppler or tesseract on user bytes in its own OS process tree when enabled.
// The worker command must be externally provisioned, sandboxed and audited.
// No shell is used. Without a configured worker, fail closed.
const {spawn}=require('node:child_process');
const {validatePdf}=require('./audit-pdf');
function runWorker(pdf,{ocr=true,language='eng',command=process.env.AUDIT_AI_WORKER_BIN,args=[],timeout=120000}={}) {
 validatePdf(pdf);
 if(!['eng','fra','eng+fra'].includes(language))throw new TypeError('Unsupported OCR language');
 if(typeof command!=='string'||!command.trim())throw new Error('Isolated Audit AI worker is not configured');
 if(!Array.isArray(args)||args.some(x=>typeof x!=='string'))throw new TypeError('Invalid worker args');
 return new Promise((resolve,reject)=>{
  const child=spawn(command,[...args],{shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{PATH:process.env.PATH||''}});
  let out='',err='',size=0,settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('Audit AI worker timed out'));},timeout);
  child.on('error',e=>finish(new Error('Isolated Audit AI worker could not start')));
  child.stdout.on('data',data=>{size+=data.length;if(size>300000){child.kill('SIGKILL');finish(new Error('Audit AI worker output exceeded limit'));}else out+=data.toString('utf8');});
  child.stderr.on('data',data=>{err+=data.toString('utf8').slice(0,1024);});
  child.on('close',code=>{
   if(code!==0)return finish(new Error('Isolated PDF processing failed'));
   try{
    const result=JSON.parse(out);
    if(typeof result.text!=='string'||result.text.length>200000||!Number.isSafeInteger(result.pages)||result.pages<1||result.pages>25||!['pdf-text','ocr'].includes(result.method))throw new Error('Invalid worker result');
    finish(null,result);
   }catch{finish(new Error('Invalid isolated PDF worker response'));}
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({pdf:pdf.toString('base64'),ocr,language}));
 });
}
module.exports={runWorker};

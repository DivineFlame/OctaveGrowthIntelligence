const redis=require('redis');
const client=redis.createClient({url:process.env.REDIS_URL});
client.connect();
async function processJob(){
  while(true){
    try{
      const job=await client.brPop('transformer:queue:*',5);
      if(job){
        const payload=JSON.parse(job.element);
        console.log('Transforming asset',payload.asset_id,'channels',payload.channels);
        try{
          await fetch(`http://${process.env.PAPERCLIP_SERVICE || 'paperclip-transformer:8000'}/transform`,{method:'POST',body:JSON.stringify(payload),headers:{'Content-Type':'application/json'}});
          console.log('Paperclip transformed',payload.asset_id);
        }catch(e){ console.error('Paperclip error',e.message); }
      }
    }catch(e){ console.error(e); await new Promise(r=>setTimeout(r,1000)); }
  }
}
processJob();
console.log('Transformer worker started - 2 replicas');

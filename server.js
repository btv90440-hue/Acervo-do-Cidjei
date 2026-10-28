// CINÉ ACERVO — ponte de mídia para uso pessoal. Node.js 18+.
// Escuta apenas loopback. Nunca exponha esta ponte diretamente à internet.
'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const crypto=require('node:crypto');
const PORT=8787, HOST='127.0.0.1';
const sessions=new Map();
const html=path.join(__dirname,'index.html');
const send=(res,status,msg,headers={})=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',...headers});res.end(msg)};
const origin='http://localhost:'+PORT;
function cookie(req){return /(?:^|;\s*)cine_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1]}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(req.headers.host!==`localhost:${PORT}` && req.headers.host!==`${HOST}:${PORT}`)return send(res,403,'Host não permitido');
    if(url.pathname==='/api/session'){
      if(!['POST','DELETE'].includes(req.method))return send(res,405,'Método inválido');
      if(req.headers.origin && req.headers.origin!==origin && req.headers.origin!==`http://${HOST}:${PORT}`)return send(res,403,'Origem inválida');
      const previous=cookie(req);if(previous)sessions.delete(previous);
      if(req.method==='DELETE'){res.writeHead(204,{'Set-Cookie':'cine_session=; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=0'});return res.end()}
      let raw='';for await(const b of req){raw+=b;if(raw.length>8192)return send(res,413,'Dados excessivos')}
      let token;try{token=JSON.parse(raw).token}catch{};
      if(typeof token!=='string'||token.length<20||token.length>4096)return send(res,400,'Token inválido');
      const id=crypto.randomBytes(32).toString('hex');sessions.set(id,{token,expires:Date.now()+50*60*1000});
      res.writeHead(204,{'Cache-Control':'no-store','Set-Cookie':`cine_session=${id}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=3000`});return res.end();
    }
    if(url.pathname.startsWith('/api/stream/')){
      if(!['GET','HEAD'].includes(req.method))return send(res,405,'Método inválido');
      const id=url.pathname.slice('/api/stream/'.length);
      if(!/^[\w-]{10,200}$/.test(id))return send(res,400,'ID inválido');
      const session=sessions.get(cookie(req));if(!session||session.expires<Date.now())return send(res,401,'Reconecte ao Google Drive');
      const range=req.headers.range;
      if(range && !/^bytes=\d*-\d*$/.test(range))return send(res,416,'Intervalo inválido');
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const upstream=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true',{
        method:req.method,headers:{Authorization:'Bearer '+session.token,...(range?{Range:range}:{})},signal:controller.signal,redirect:'follow'});
      if(!upstream.ok && upstream.status!==206){return send(res,upstream.status===401?401:upstream.status,upstream.status===401?'Sessão expirada':'Drive recusou a mídia ('+upstream.status+').')}
      const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Type':upstream.headers.get('content-type')||'application/octet-stream'};
      for(const h of ['content-length','content-range','etag','last-modified'])if(upstream.headers.has(h))headers[h]=upstream.headers.get(h);
      res.writeHead(upstream.status,headers);
      if(req.method==='HEAD'||!upstream.body)return res.end();
      Readable.fromWeb(upstream.body).on('error',()=>res.destroy()).pipe(res);return;
    }
    if((url.pathname==='/'||url.pathname==='/index.html')&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return fs.createReadStream(html).pipe(res)
    }
    return send(res,404,'Não encontrado');
  }catch(e){if(!res.headersSent)send(res,500,'Falha na ponte de streaming');else res.destroy();}
});
server.listen(PORT,HOST,()=>console.log(`Ciné Acervo: http://localhost:${PORT} (apenas neste computador)`));

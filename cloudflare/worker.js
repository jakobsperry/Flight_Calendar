const enc=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const hash=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
async function pass(password,salt){const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:210000,hash:'SHA-256'},key,256))}
const json=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
const bad=(message,status=400)=>json({error:message},status);
async function current(req,db){const token=/\bfc_session=([a-f0-9]{64})\b/.exec(req.headers.get('cookie')||'')?.[1];if(!token)return null;return db.prepare('SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').bind(await hash(token),Date.now()).first()}
const cookie=(token,maxAge)=>'fc_session='+token+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age='+maxAge;
export default {async fetch(req,env){
const u=new URL(req.url),path=u.pathname,db=env.DB;
const headers={'cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'"};
if(path==='/'&&req.method==='GET')return new Response(PAGE,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
if(!path.startsWith('/api/'))return bad('Not found',404);
if(req.method==='POST'&&req.headers.get('origin')!==u.origin)return bad('Origin rejected',403);
let data={};if(['POST','PUT','DELETE'].includes(req.method)){if(Number(req.headers.get('content-length')||0)>8192)return bad('Request too large',413);try{data=await req.json()}catch{return bad('Invalid JSON')}}
try{
if(path==='/api/health'&&req.method==='GET'){try{await db.prepare('SELECT 1 AS ok').first();return json({database:'ok'})}catch(e){return bad('Database connection unavailable',503)}}
if(path==='/api/register'&&req.method==='POST'){
const username=String(data.username||'').trim(),password=String(data.password||'');
if(username.length<3||username.length>80||/[\u0000-\u001f\u007f]/.test(username)||password.length<8||password.length>128)return bad('Username must be 3–80 characters; password must be 8–128 characters');
const id=crypto.randomUUID(),salt=random();let password_hash;try{password_hash=await pass(password,salt)}catch(e){return bad('Password hashing unavailable',503)}
try{await db.prepare('INSERT INTO users(id,username,salt,password_hash) VALUES(?,?,?,?)').bind(id,username,salt,password_hash).run()}catch{return bad('Username unavailable',409)}
await db.prepare('INSERT INTO calendars(id,owner_id,title) VALUES(?,?,?)').bind(crypto.randomUUID(),id,username+"'s calendar").run();
const token=random();await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(token),id,Date.now()+2592000000).run();
return json({username},200,{'set-cookie':cookie(token,2592000)});
}
if(path==='/api/login'&&req.method==='POST'){
const username=String(data.username||''),password=String(data.password||'');
const user=await db.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
const salt=user?.salt||'invalid-salt';const computed=await pass(password,salt);
if(!user||computed!==user.password_hash)return bad('Invalid username or password',401);
const token=random();await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await hash(token),user.id,Date.now()+2592000000).run();
return json({username:user.username},200,{'set-cookie':cookie(token,2592000)});
}
const me=await current(req,db);if(!me)return bad('Sign in required',401);
if(path==='/api/me'&&req.method==='GET')return json({username:me.username});
if(path==='/api/logout'&&req.method==='POST'){const token=/\bfc_session=([a-f0-9]{64})\b/.exec(req.headers.get('cookie')||'')?.[1];if(token)await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(token)).run();return json({ok:true},200,{'set-cookie':cookie('',0)})}
if(path==='/api/calendars'&&req.method==='GET'){
const rows=await db.prepare("SELECT c.id,c.title,CASE WHEN c.owner_id=? THEN 'owner' ELSE 'viewer' END AS role FROM calendars c LEFT JOIN calendar_access a ON a.calendar_id=c.id AND a.user_id=? WHERE c.owner_id=? OR a.user_id=?").bind(me.id,me.id,me.id,me.id).all();return json({calendars:rows.results})}
const m=/^\/api\/calendars\/([0-9a-f-]+)\/(shares|flights)$/.exec(path);
if(m){const cal=await db.prepare('SELECT * FROM calendars WHERE id=?').bind(m[1]).first();if(!cal)return bad('Not found',404);
const owner=cal.owner_id===me.id,access=owner||!!(await db.prepare('SELECT 1 FROM calendar_access WHERE calendar_id=? AND user_id=?').bind(cal.id,me.id).first());
if(!access)return bad('Forbidden',403);
if(m[2]==='flights'&&req.method==='GET'){const r=await db.prepare('SELECT id,flight_json FROM flights WHERE calendar_id=?').bind(cal.id).all();return json({flights:r.results.map(x=>({id:x.id,...JSON.parse(x.flight_json)}))})}
if(m[2]==='shares'&&req.method==='GET'&&owner){const r=await db.prepare('SELECT u.username FROM calendar_access a JOIN users u ON u.id=a.user_id WHERE a.calendar_id=?').bind(cal.id).all();return json({shares:r.results})}
if(m[2]==='shares'&&req.method==='POST'&&owner){const target=await db.prepare('SELECT id FROM users WHERE username=?').bind(String(data.username||'')).first();if(!target||target.id===me.id)return bad('User not found');await db.prepare("INSERT OR IGNORE INTO calendar_access(calendar_id,user_id,role) VALUES(?,?,'viewer')").bind(cal.id,target.id).run();return json({ok:true})}
if(m[2]==='shares'&&req.method==='DELETE'&&owner){const target=await db.prepare('SELECT id FROM users WHERE username=?').bind(String(data.username||'')).first();if(target)await db.prepare('DELETE FROM calendar_access WHERE calendar_id=? AND user_id=?').bind(cal.id,target.id).run();return json({ok:true})}
}
return bad('Not found',404)
}catch(e){return bad('Server error: '+(String(e?.message||'').includes('D1')?'database unavailable':'account operation failed'),500)}
}};
const PAGE=`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Flight Calendar — Test</title><style>body{font:16px system-ui;background:#101217;color:#eee;max-width:550px;margin:40px auto;padding:0 20px}input,button{font:inherit;padding:12px;border-radius:8px;margin:5px 0}input{background:#222833;color:white;border:1px solid #566;width:100%;box-sizing:border-box}button{background:#315fdb;color:white;border:0;cursor:pointer}section{background:#1d222b;padding:22px;border-radius:12px;margin:15px 0}small{color:#abb}li{padding:8px 0}#msg{color:#f8bc7e}a{color:#aaccff}</style><h1>Flight Calendar <small>TEST</small></h1><p>Private accounts and calendar sharing experiment. Main website is unaffected.</p><section id="auth"><h2>Sign in</h2><input id="user" autocomplete="username" placeholder="Username"><input id="pass" type="password" autocomplete="current-password" placeholder="Password (8+ characters to register)"><button id="login">Sign in</button> <button id="register">Create account</button><p><small>Choose any username, including an email address. No email verification. Password recovery is not available yet.</small></p></section><section id="app" hidden><h2 id="welcome"></h2><button id="logout">Sign out</button><h3>Your calendars</h3><div id="calendars"></div></section><p id="msg" role="status"></p><script>
const $=id=>document.getElementById(id);const msg=s=>$('msg').textContent=s;
async function api(path,method='GET',body){const r=await fetch('/api/'+path,{method,credentials:'same-origin',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
async function refresh(){try{const me=await api('me');$('auth').hidden=true;$('app').hidden=false;$('welcome').textContent='Signed in as '+me.username;const d=await api('calendars');$('calendars').replaceChildren();for(const c of d.calendars){const s=document.createElement('section'),h=document.createElement('h4');h.textContent=c.title+' ('+c.role+')';s.append(h);const f=await api('calendars/'+c.id+'/flights');const p=document.createElement('p');p.textContent=f.flights.length+' private flights';s.append(p);if(c.role==='owner'){const inp=document.createElement('input');inp.placeholder='Username to share with';const b=document.createElement('button');b.textContent='Grant view access';b.onclick=async()=>{try{await api('calendars/'+c.id+'/shares','POST',{username:inp.value});msg('Shared with '+inp.value);refresh()}catch(e){msg(e.message)}};s.append(inp,b);const shares=await api('calendars/'+c.id+'/shares');for(const sh of shares.shares){const row=document.createElement('div');row.textContent=sh.username+' ';const rm=document.createElement('button');rm.textContent='Revoke';rm.onclick=async()=>{await api('calendars/'+c.id+'/shares','DELETE',{username:sh.username});refresh()};row.append(rm);s.append(row)}}$('calendars').append(s)}}catch{$('auth').hidden=false;$('app').hidden=true}}
for(const type of ['login','register'])$(type).onclick=async()=>{try{await api(type,'POST',{username:$('user').value,password:$('pass').value});$('pass').value='';msg('');await refresh()}catch(e){msg(e.message)}};
$('logout').onclick=async()=>{await api('logout','POST',{});refresh()};refresh();
</script></html>`;

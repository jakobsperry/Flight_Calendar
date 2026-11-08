// All provider traffic, including manual lookups, must pass through lookup().
// Tier 2 single-day calls cost 2 units. Flight-plan extras are explicitly disabled.
const HOUR=3600000, RETENTION=7*24*HOUR;
const normalize=n=>String(n||'').replace(/\s/g,'').toUpperCase();
const airports={};
for(const [zone,codes] of Object.entries({
 'America/Los_Angeles':'LGB LAX SFO SJC RNO LAS SEA PDX SAN',
 'America/Phoenix':'PHX','America/Denver':'DEN SLC',
 'America/Chicago':'ORD DFW IAH MDW DAL HOU',
 'America/New_York':'JFK EWR BOS ATL MIA DTW CLT FLL DCA IAD',
 'Asia/Shanghai':'PEK PKX SZX XMN PVG SHA CAN HGH CTU TFU',
 'Asia/Hong_Kong':'HKG','Asia/Ho_Chi_Minh':'SGN HAN VII DAD',
 'Asia/Tokyo':'HND NRT KIX','Asia/Seoul':'ICN GMP',
 'Asia/Singapore':'SIN','Asia/Bangkok':'BKK DMK',
 'Europe/London':'LHR LGW','Europe/Paris':'CDG ORY','Europe/Amsterdam':'AMS'
}))for(const code of codes.split(' '))airports[code]=zone;

export function departureInstant(f){
 if(!/^\d{4}-\d\d-\d\d$/.test(f.date||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.depart||''))return null;
 const local=f.date+'T'+f.depart+':00',tz=String(f.departTZ||'').trim();
 const explicit=/^[+-](0\d|1[0-4]):[0-5]\d$/.test(tz)?Date.parse(local+tz):null;
 if(explicit!==null)return Number.isFinite(explicit)?explicit:null;
 const zone=airports[f.from]||(tz.includes('/')?tz:null);
 if(zone){try{
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const target=Date.parse(local+'Z');let instant=target;
  const wall=ms=>{const p=Object.fromEntries(fmt.formatToParts(ms).map(p=>[p.type,p.value]));return p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second};
  for(let i=0;i<3;i++)instant+=target-Date.parse(wall(instant)+'Z');
  return wall(instant)===local?instant:null;
 }catch{return null}}
 const offsets={UTC:0,GMT:0,ICT:420,HKT:480,JST:540,KST:540,PST:-480,PDT:-420,MST:-420,MDT:-360,EST:-300,EDT:-240,CDT:-300,AKST:-540,AKDT:-480,HST:-600};
 // Ambiguous CST requires a known airport. Unknown zones fail closed.
 return Object.hasOwn(offsets,tz)?Date.parse(local+'Z')-offsets[tz]*60000:null;
}
const clean=v=>typeof v==='string'?v.slice(0,160):'';
function movement(m={}){
 const time=t=>({local:clean(t?.local),utc:clean(t?.utc)});
 return {airport:{iata:clean(m.airport?.iata)},scheduledTime:time(m.scheduledTime),revisedTime:time(m.revisedTime),runwayTime:time(m.runwayTime),terminal:clean(m.terminal),gate:clean(m.gate),baggageBelt:clean(m.baggageBelt),quality:Array.isArray(m.quality)?m.quality.map(clean):[]};
}
function cleanFlight(a){return {number:normalize(a.number),status:clean(a.status),airline:{name:clean(a.airline?.name)},departure:movement(a.departure),arrival:movement(a.arrival)}}
function cached(row,now){return row?.fetched_at&&now-row.fetched_at<RETENTION?JSON.parse(row.flights_json||'[]'):[]}

export async function lookup(env,number,date,now=Date.now()){
 const db=env.DB,key=normalize(number)+'|'+date;
 const row=await db.prepare('SELECT * FROM flight_api_cache WHERE cache_key=?').bind(key).first();
 const old=cached(row,now);
 if(row&&now-row.attempted_at<HOUR)return {flights:old,fetchedAt:row.fetched_at,lastAttemptAt:row.attempted_at,error:row.error,cached:true};
 if(!env.AERODATABOX_KEY)return {flights:old,fetchedAt:row?.fetched_at,error:'missing_key'};
 try{
  // A single SQL insert runs both budget and cooldown checks atomically in D1.
  // Reservations are never refunded, including errors, timeouts and crashed runs.
  await db.prepare('INSERT INTO flight_api_requests(id,cache_key,attempted_at,units) VALUES(?,?,?,2)').bind(crypto.randomUUID(),key,now).run();
 }catch(e){
  const message=String(e?.message||e);
  if(message.includes('flight_api_budget_exhausted'))return {flights:old,fetchedAt:row?.fetched_at,error:'budget_exhausted'};
  if(message.includes('flight_api_cooldown'))return {flights:old,fetchedAt:row?.fetched_at,error:'refresh_pending'};
  throw e; // Database uncertainty must never cause an unaccounted provider call.
 }
 await db.prepare('INSERT INTO flight_api_cache(cache_key,attempted_at) VALUES(?,?) ON CONFLICT(cache_key) DO UPDATE SET attempted_at=excluded.attempted_at').bind(key,now).run();
 let flights,error=null;
 try{
  const url='https://aerodatabox.p.rapidapi.com/flights/number/'+encodeURIComponent(normalize(number))+'/'+date+'?dateLocalRole=Departure&withAircraftImage=false&withLocation=false&withFlightPlan=false';
  const response=await fetch(url,{headers:{'X-RapidAPI-Key':env.AERODATABOX_KEY,'X-RapidAPI-Host':'aerodatabox.p.rapidapi.com',Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(response.status===204||response.status===404)flights=[];
  else if(!response.ok)error=response.status===429?'provider_quota':response.status===401||response.status===403?'provider_unauthorized':'provider_error';
  else{
   const payload=await response.json();
   if(!Array.isArray(payload))throw Error('invalid_payload');
   flights=payload.slice(0,30).map(cleanFlight).filter(f=>f.number===normalize(number)&&f.departure.scheduledTime.local.slice(0,10)===date);
  }
 }catch{error='provider_unavailable'}
 if(error){await db.prepare('UPDATE flight_api_cache SET error=? WHERE cache_key=?').bind(error,key).run();return {flights:old,fetchedAt:row?.fetched_at,lastAttemptAt:now,error}}
 await db.prepare('UPDATE flight_api_cache SET fetched_at=?,flights_json=?,error=NULL WHERE cache_key=?').bind(now,JSON.stringify(flights),key).run();
 return {flights,fetchedAt:now,lastAttemptAt:now};
}
export function matchFlight(f,matches){
 const exact=matches.filter(a=>a.number===normalize(f.number)&&a.departure.scheduledTime.local.slice(0,10)===f.date&&(!f.from||a.departure.airport.iata===f.from)&&(!f.to||a.arrival.airport.iata===f.to));
 if(exact.length===1)return exact[0];
 const atTime=exact.filter(a=>a.departure.scheduledTime.local.slice(11,16)===f.depart);
 return atTime.length===1?atTime[0]:null;
}
export async function enrichFlights(db,flights,now=Date.now()){
 if(!flights.length)return flights;
 const keys=[...new Set(flights.map(f=>normalize(f.number)+'|'+f.date))];const rows=[];
 for(let i=0;i<keys.length;i+=80){const group=keys.slice(i,i+80);const r=await db.prepare('SELECT * FROM flight_api_cache WHERE cache_key IN ('+group.map(()=>'?').join(',')+')').bind(...group).all();rows.push(...r.results)}
 const byKey=new Map(rows.map(r=>[r.cache_key,r]));
 return flights.map(f=>{const row=byKey.get(normalize(f.number)+'|'+f.date),a=matchFlight(f,cached(row,now));return {...f,live:{source:'AeroDataBox',updatedAt:row?.fetched_at||null,lastAttemptAt:row?.attempted_at||null,error:row?.error||null,stale:!row?.fetched_at||now-row.fetched_at>=HOUR,found:!!a,...(a?{status:a.status,departure:a.departure,arrival:a.arrival}:{})}}});
}
export async function refreshInfo(env,now=Date.now()){
 const r=await env.DB.prepare('SELECT COALESCE(SUM(units),0) AS used FROM flight_api_requests WHERE attempted_at>?').bind(now-31*24*HOUR).first();
 const s=await env.DB.prepare('SELECT checked_at,state FROM flight_api_scheduler WHERE id=1').first();
 return {configured:!!env.AERODATABOX_KEY,budgetLimit:400,budgetUsed:r.used,budgetWindow:'rolling 31 days',checkedAt:s?.checked_at||null,state:!env.AERODATABOX_KEY?'missing_key':s?.state||'waiting',intervalMinutes:60,leadHours:6};
}
export function imminent(f,now){
 const start=departureInstant(f);if(start===null||start-now>6*HOUR)return false;
 if(f.live?.found&&/^(Arrived|Canceled|Cancelled|Diverted)$/i.test(f.live.status||''))return false;
 // Keep a departed flight updated until arrival, with a finite 24-hour cutoff.
 return now<start+24*HOUR;
}
export async function refreshFlights(env,now=Date.now()){
 const db=env.DB;
 await db.prepare('UPDATE flight_api_cache SET fetched_at=NULL,flights_json=NULL WHERE fetched_at<?').bind(now-RETENTION).run();
 await db.prepare('DELETE FROM flight_api_cache WHERE attempted_at<?').bind(now-RETENTION).run();
 let state='missing_key';
 if(env.AERODATABOX_KEY){
  const rows=await db.prepare('SELECT flight_json FROM flights').all();
  const flights=await enrichFlights(db,rows.results.map(r=>JSON.parse(r.flight_json)),now);
  const due=flights.filter(f=>imminent(f,now)).sort((a,b)=>departureInstant(a)-departureInstant(b));
  const seen=new Set();state='waiting';
  for(const f of due){const key=normalize(f.number)+'|'+f.date;if(seen.has(key))continue;seen.add(key);
   const r=await lookup(env,f.number,f.date,now);state=r.error||'ok';
   if(r.error==='budget_exhausted'||r.error==='provider_unauthorized'||r.error==='provider_quota')break;
  }
 }
 await db.prepare('INSERT INTO flight_api_scheduler(id,checked_at,state) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,state=excluded.state').bind(now,state).run();
 return {state};
}

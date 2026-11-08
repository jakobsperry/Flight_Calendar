const assert = require('node:assert/strict');
const vm = require('node:vm');
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const {webcrypto} = require('node:crypto');
async function runTests(root){
 const schema=fs.readFileSync(root+'/live-schema.sql','utf8');
 const code=fs.readFileSync(root+'/live.js','utf8').replaceAll('export ','');
 let calls=0,mode='ok';
 const sample={number:'MF 859',status:'Expected',departure:{airport:{iata:'XMN'},scheduledTime:{local:'2026-11-08T12:55+08:00',utc:'2026-11-08T04:55Z'},revisedTime:{local:'2026-11-08T13:25+08:00'},gate:'12',terminal:'3'},arrival:{airport:{iata:'HAN'},scheduledTime:{local:'2026-11-08T14:40+07:00'}}};
 const sandbox={Intl,Date,AbortSignal,crypto:webcrypto,fetch:async(url,options)=>{calls++;assert.match(url,/withFlightPlan=false/);assert.equal(options.redirect,'error');if(mode==='throw')throw Error('network');if(mode==='401')return new Response('',{status:401});if(mode==='404')return new Response('',{status:404});if(mode==='malformed')return Response.json({bad:true});return Response.json([sample])}};
 vm.createContext(sandbox);vm.runInContext(code+'\nglobalThis.api={lookup,departureInstant,imminent,enrichFlights,refreshFlights,refreshInfo,matchFlight};',sandbox);
 const api=sandbox.api;
 function database(){const sql=new DatabaseSync(':memory:');sql.exec(schema+'; CREATE TABLE flights(id TEXT,flight_json TEXT);');const db={prepare(query){const args=[];return {bind(...values){args.push(...values);return this},async run(){const result=sql.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}}},async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}}}}};return {sql,db}}
 const {sql,db}=database(),env={DB:db,AERODATABOX_KEY:'test-only'},now=Date.parse('2026-11-08T00:00Z');
 const f={number:'MF859',date:'2026-11-08',depart:'12:55',departTZ:'CST',from:'XMN',to:'HAN'};
 assert.equal(api.departureInstant(f),Date.parse('2026-11-08T04:55Z'));
 assert.equal(api.departureInstant({...f,from:'ORD',depart:'12:55'}),Date.parse('2026-11-08T18:55Z'));
 assert.equal(api.departureInstant({...f,date:'2026-07-08',from:'ORD'}),Date.parse('2026-07-08T17:55Z'));
 assert.equal(api.departureInstant({...f,from:'ZZZ'}),null);
 assert.equal(api.departureInstant({...f,departTZ:'+08:00'}),Date.parse('2026-11-08T04:55Z'));
 const dep=api.departureInstant(f);
 assert.equal(api.imminent(f,dep-6*3600000-1),false);assert.equal(api.imminent(f,dep-6*3600000),true);
 assert.equal(api.imminent(f,dep+24*3600000),false);
 assert.equal(api.imminent({...f,live:{found:true,status:'Arrived'}},dep),false);
 const missing=await api.lookup({DB:db},f.number,f.date,now);assert.equal(missing.error,'missing_key');assert.equal(calls,0);
 const both=await Promise.all([api.lookup(env,'MF 859',f.date,now),api.lookup(env,'MF859',f.date,now)]);
 assert.equal(calls,1);assert.ok(both.some(r=>r.error==='refresh_pending'));assert.equal(sql.prepare('SELECT SUM(units) AS u FROM flight_api_requests').get().u,2);
 await api.lookup(env,f.number,f.date,now+3599999);assert.equal(calls,1);
 let enriched=await api.enrichFlights(db,[f],now+1);assert.equal(enriched[0].live.departure.gate,'12');assert.equal(enriched[0].live.updatedAt,now);
 assert.equal(enriched[0].depart,'12:55');assert.equal(api.matchFlight({...f,from:'LAX'},both.find(r=>!r.error).flights),null);
 mode='throw';let failed=await api.lookup(env,f.number,f.date,now+3600000);assert.equal(calls,2);assert.equal(failed.error,'provider_unavailable');assert.equal(failed.fetchedAt,now);assert.equal(failed.flights[0].departure.gate,'12');
 await api.lookup(env,f.number,f.date,now+3600001);assert.equal(calls,2);
 mode='401';failed=await api.lookup(env,'UA1',f.date,now+3600000);assert.equal(failed.error,'provider_unauthorized');
 mode='malformed';failed=await api.lookup(env,'UA2',f.date,now+3600000);assert.equal(failed.error,'provider_unavailable');
 mode='404';const empty=await api.lookup(env,'UA3',f.date,now+3600000);assert.equal(empty.flights.length,0);assert.equal(empty.error,undefined);
 // Simultaneous reservations at the final two units cannot overspend.
 const budget=database();for(let i=0;i<199;i++)budget.sql.prepare('INSERT INTO flight_api_requests VALUES(?,?,?,2)').run('r'+i,'key'+i,now);
 mode='ok';let before=calls;
 const exhausted=await Promise.all([api.lookup({DB:budget.db,AERODATABOX_KEY:'test'},'MF859',f.date,now),api.lookup({DB:budget.db,AERODATABOX_KEY:'test'},'UA5',f.date,now)]);
 assert.equal(calls-before,1);assert.ok(exhausted.some(r=>r.error==='budget_exhausted'));assert.equal(budget.sql.prepare('SELECT SUM(units) AS u FROM flight_api_requests').get().u,400);
 await api.lookup({DB:budget.db,AERODATABOX_KEY:'test'},'UA6','2026-12-01',now+30*86400000);assert.equal(calls-before,1);
 await api.lookup({DB:budget.db,AERODATABOX_KEY:'test'},'UA6','2026-12-10',now+31*86400000+1);assert.equal(calls-before,2);
 // Scheduler handles duplicated calendars and subsequent flights inside the window.
 const scheduled=database();for(const [i,flight] of [f,f,{...f,number:'UA10',depart:'13:55'},{...f,number:'UA20',depart:'23:55'}].entries())scheduled.sql.prepare('INSERT INTO flights VALUES(?,?)').run(String(i),JSON.stringify(flight));
 before=calls;await api.refreshFlights({DB:scheduled.db,AERODATABOX_KEY:'test'},now);assert.equal(calls-before,2);
 await api.refreshFlights({DB:scheduled.db,AERODATABOX_KEY:'test'},now+300000);assert.equal(calls-before,2);
 await api.refreshFlights({DB:scheduled.db,AERODATABOX_KEY:'test'},now+3600000);assert.equal(calls-before,4);
 const off=database();before=calls;await api.refreshFlights({DB:off.db},now);assert.equal(calls,before);assert.equal((await api.refreshInfo({DB:off.db},now)).state,'missing_key');
 // D1 errors must fail closed.
 await assert.rejects(()=>api.lookup({DB:{prepare(){throw Error('D1 unavailable')}},AERODATABOX_KEY:'test'},'MF859',f.date,now));
 const stale=await api.enrichFlights(db,[f],now+8*86400000);assert.equal(stale[0].live.found,false);
 return 'PASS: timezone/DST, six-hour boundary, terminal cutoff, missing key, concurrent dedupe, hourly cache, route matching, persisted status, failures, 400-unit concurrent budget, month boundary, rolling reset, subsequent flights, duplicate calendars, scheduler, retention, database fail-closed';
}
module.exports=runTests;
if(require.main===module)runTests(__dirname).then(console.log).catch(e=>{console.error(e);process.exitCode=1});

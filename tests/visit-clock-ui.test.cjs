const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
function harness(){
 let time=100000,emit,startCalls=0,stops=0,refreshes=0,active=false;
 const intervals=new Map(),handlers=new Map(),elements=new Map();let id=0;
 for(const name of ['visit-status','visit-start','visit-stop','visit-timer','visit-progress','visit-distance','visit-accuracy','visit-freshness','visit-login','visit-name','visit-condition','visit-back','visit-reload','visit-build','visit-diagnostics']){
  const listeners={};elements.set(name,{textContent:'',hidden:false,disabled:false,dataset:{},value:0,max:60000,href:'',addEventListener:(event,fn)=>listeners[event]=fn,click:()=>listeners.click?.(),setAttribute(){},removeAttribute(){}});
 }
 const document={hidden:false,getElementById:n=>elements.get(n)||null,querySelector:()=>({content:'fixture-build'}),addEventListener:(n,f)=>handlers.set('document:'+n,f)};
 const session={start:()=>{startCalls++;active=true;},stop:message=>{stops++;active=false;emit({phase:'stopped',active:false,elapsedMs:0,requiredMs:60000,confirmedAt:null,message});},isActive:()=>active};
 const user={uid:'fixture'};
 const context={document,location:{search:'?space=indoor-01',reload(){}},performance:{now:()=>time},navigator:{geolocation:{}},isSecureContext:true,URLSearchParams,console,
  SpaceCycleAuth:{isReady:true,getUser:()=>user,getToken:async()=>'',refreshFoundSpaces:async()=>{refreshes++;}},
  SpaceCycleSpaces:require('../public/js/space-data.js'),SpaceCycleQrPolicy:require('../public/js/qr-policy.js'),SpaceCycleVisitClock:require('../public/js/visit-clock.js'),
  SpaceCycleVisitRequest:{createVisitRequest:()=>async()=>{}},SpaceCycleVisit:{createVisitSession:options=>{emit=options.onState;return session;}},
  setInterval:(fn)=>{const n=++id;intervals.set(n,fn);return n;},clearInterval:n=>intervals.delete(n),setTimeout:()=>++id,clearTimeout(){},
  addEventListener:(name,fn)=>handlers.set('window:'+name,fn)};
 context.window=context;vm.runInNewContext(fs.readFileSync(path.join(root,'public/js/visit.js'),'utf8'),context);
 return {elements,session,get refreshes(){return refreshes;},get startCalls(){return startCalls;},get stops(){return stops;},get intervalCount(){return intervals.size;},
  sample:s=>{active=s.active;emit({requiredMs:60000,elapsedMs:0,confirmedAt:time,maxGapMs:12000,sampleEveryMs:3000,distanceM:0,accuracyM:5,message:'서버 위치 확인',...s});},
  advance:ms=>{time+=ms;for(const fn of [...intervals.values()])fn();},
  event:(name,value)=>{if(name==='visibilitychange')document.hidden=value;handlers.get((['visibilitychange','click'].includes(name)?'document:':'window:')+name)?.({target:{}});},
 };
}

test('UI ticks between responses, waits at zero, and never saves before server completion',async()=>{
 const h=harness();h.elements.get('visit-start').click();h.sample({phase:'dwelling',active:true,elapsedMs:20000});
 assert.equal(h.elements.get('visit-timer').textContent,'00:40');h.advance(1000);assert.equal(h.elements.get('visit-timer').textContent,'00:39');h.advance(1000);assert.equal(h.elements.get('visit-timer').textContent,'00:38');
 assert.equal(h.elements.get('visit-progress').value,22000);assert.equal(h.refreshes,0);
 assert.equal(h.intervalCount,1);
 h.sample({phase:'dwelling',active:true,elapsedMs:22000});assert.equal(h.intervalCount,1,'new confirmations do not spawn extra UI tickers');
 h.sample({phase:'dwelling',active:true,elapsedMs:59000});h.advance(1000);
 assert.equal(h.elements.get('visit-timer').textContent,'00:00');assert.match(h.elements.get('visit-status').textContent,/마지막 위치 확인 중/);assert.equal(h.elements.get('visit-status').dataset.phase,'dwelling');assert.equal(h.refreshes,0);assert.equal(h.elements.get('visit-start').disabled,true);
 h.sample({phase:'complete',active:false,elapsedMs:60000,persisted:true,newlyFound:true,foundSpaceCount:1,message:'서버 승인 완료'});
 assert.equal(h.elements.get('visit-status').textContent,'서버 승인 완료');assert.equal(h.refreshes,1);assert.equal(h.intervalCount,0);
});

test('server resets, offline and background immediately replace estimated progress',()=>{
 const h=harness();h.elements.get('visit-start').click();h.sample({phase:'dwelling',active:true,elapsedMs:20000});h.advance(2000);
 h.sample({phase:'outside',active:true,elapsedMs:0});h.advance(1000);assert.equal(h.elements.get('visit-timer').textContent,'01:00');
 h.sample({phase:'uncertain',active:true,elapsedMs:0});h.advance(1000);assert.equal(h.elements.get('visit-progress').value,0);
 h.sample({phase:'dwelling',active:true,elapsedMs:0});h.advance(1000);assert.equal(h.elements.get('visit-timer').textContent,'00:59');
 h.event('visibilitychange',true);assert.equal(h.elements.get('visit-timer').textContent,'01:00');assert.equal(h.intervalCount,0);h.advance(5000);assert.equal(h.elements.get('visit-timer').textContent,'01:00');
 h.event('visibilitychange',false);assert.equal(h.elements.get('visit-status').dataset.phase,'stopped');
 h.sample({phase:'dwelling',active:true,elapsedMs:10000});h.event('offline');assert.equal(h.elements.get('visit-timer').textContent,'01:00');assert.equal(h.refreshes,0);
});

test('short GPS retries pause projection without zeroing confirmed progress or approving completion',()=>{
 const h=harness();h.elements.get('visit-start').click();h.sample({phase:'dwelling',active:true,elapsedMs:20000});
 h.advance(9000);
 h.sample({phase:'dwelling',active:true,elapsedMs:20000,confirmedAt:100000,locationPending:true,message:'위치 응답이 늦어 다시 확인 중이에요.'});
 assert.equal(h.elements.get('visit-timer').textContent,'00:40','known location loss must show confirmed progress only');
 h.advance(1000);assert.equal(h.elements.get('visit-timer').textContent,'00:40');
 assert.match(h.elements.get('visit-status').textContent,/다시 확인/);assert.equal(h.refreshes,0);assert.equal(h.elements.get('visit-start').disabled,true);
 assert.match(h.elements.get('visit-freshness').textContent,/재확인 중.*확인값/,'retry copy must not call paused confirmed progress an estimate');
 h.sample({phase:'dwelling',active:true,elapsedMs:31000,locationPending:false});h.advance(1000);
 assert.equal(h.elements.get('visit-timer').textContent,'00:28','a real server confirmation resumes projection');
});

test('safe local GPS diagnostics explain old fixes without coordinates, raw timestamps or private errors',()=>{
 const h=harness();h.elements.get('visit-start').click();
 h.sample({phase:'dwelling',active:true,elapsedMs:20000,locationPending:true,locationIssue:{code:'gps_stale',fixAgeMs:5300,requestMs:6200,latitude:36.7,longitude:126.9}});
 assert.match(h.elements.get('visit-build').textContent,/gps_stale/);
 assert.match(h.elements.get('visit-diagnostics').textContent,/5\.3초/);
 assert.match(h.elements.get('visit-diagnostics').textContent,/6\.2초/);
 assert.doesNotMatch(h.elements.get('visit-diagnostics').textContent,/36\.7|126\.9/);
 h.sample({phase:'error',active:false,errorCode:'location_gap',locationIssue:{code:'gps_duplicate',fixAgeMs:3000,requestMs:0}});
 assert.match(h.elements.get('visit-build').textContent,/location_gap.*gps_duplicate/,'deadline keeps the reason that prevented fresh updates');
 h.sample({phase:'dwelling',active:true,locationIssue:null,locationSample:{fixAgeMs:100,requestMs:300}});
 assert.doesNotMatch(h.elements.get('visit-build').textContent,/gps_stale|gps_duplicate/);
 assert.match(h.elements.get('visit-diagnostics').textContent,/0\.1초/);
});

test('diagnostics preserve confirmation count after failure and show the active acquisition policy',()=>{
 const h=harness();h.elements.get('visit-start').click();
 h.sample({phase:'error',active:false,confirmedAt:null,confirmedSampleCount:1,locationTimeoutMs:15000,maxGapMs:25000,errorCode:'location_gap',locationIssue:{code:'gps_timeout',requestMs:15000,fixAgeMs:null}});
 assert.match(h.elements.get('visit-diagnostics').textContent,/서버 확인 1회/);
 assert.match(h.elements.get('visit-diagnostics').textContent,/획득 최대 15초.*확인 기한 25초/);
 assert.match(h.elements.get('visit-freshness').textContent,/확인 1회.*초기화/,'cleared metrics must not imply GPS never succeeded');
});

test('delayed watchdog cannot let an unconfirmed estimate run indefinitely',()=>{
 const h=harness();h.elements.get('visit-start').click();h.sample({phase:'dwelling',active:true,elapsedMs:55000});h.advance(12000);
 assert.match(h.elements.get('visit-status').textContent,/위치 확인.*지연/);assert.equal(h.refreshes,0);assert.notEqual(h.elements.get('visit-status').dataset.phase,'complete');
 const value=h.elements.get('visit-progress').value;h.advance(30000);assert.equal(h.elements.get('visit-progress').value,value);
});

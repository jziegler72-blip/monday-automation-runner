// WBFC equipment rental scheduled checks. Node 20+, no dependencies.
// Dry-run by default. Set APPLY_CHANGES=true only after reviewing logs.
const BOARD = process.env.MONDAY_EQUIPMENT_BOARD_ID || '18438455065';
const TOKEN = process.env.MONDAY_API_TOKEN;
const APPLY = process.env.APPLY_CHANGES === 'true';
const TZ = 'America/Chicago';
const C = {
 status:'color_mm8spz8j', start:'date_mm8sq443', planned:'date_mm8s2eh4',
 actualEnd:'date_mm8sx8p8', calledOff:'date_mm8sx1jw', anniversary:'date_mm8sc8n7',
 override:'date_mm8s5zr6', approval:'color_mm8sa7ck', revised:'date_mm8spnfh',
 recipients:'multiple_person_mm8sa52', lastEsc:'date_mm8s4vdm',
 lastAnn:'date_mm8s4aqz', attention:'color_mm8sn79f',
 daily:'numeric_mm8s9ahy'
};
if (!TOKEN) throw Error('MONDAY_API_TOKEN secret is required');
const today = new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const date = x => x?.date || null;
const days = (a,b) => Math.round((Date.parse(a+'T12:00:00Z')-Date.parse(b+'T12:00:00Z'))/86400000);
function anniversary(start,n) {
  const [y,m,d]=start.split('-').map(Number), t=new Date(Date.UTC(y,m-1+n,1));
  const end=new Date(Date.UTC(t.getUTCFullYear(),t.getUTCMonth()+1,0)).getUTCDate();
  return [t.getUTCFullYear(),String(t.getUTCMonth()+1).padStart(2,'0'),String(Math.min(d,end)).padStart(2,'0')].join('-');
}
function nextAnniversary(start,asOf) {
  if(!start) return null;
  let n=1, a=anniversary(start,n);
  while(a<asOf && n<1200) a=anniversary(start,++n);
  return a;
}
async function gql(query,variables={}) {
  const res=await fetch('https://api.monday.com/v2',{method:'POST',headers:{Authorization:TOKEN,'Content-Type':'application/json','API-Version':'2025-10'},body:JSON.stringify({query,variables})});
  const body=await res.json();if(!res.ok||body.errors?.length) throw Error(JSON.stringify(body.errors||body));
  return body.data;
}
const parse = v => {try{return JSON.parse(v||'null')}catch{return null}};
function columns(item) {return Object.fromEntries(item.column_values.map(c=>[c.id,{text:c.text,value:parse(c.value)}]))}
const val=(cols,id)=>cols[id]?.value;
const label=(cols,id)=>cols[id]?.text?.trim()||'';
async function update(id,values) {
 if(!Object.keys(values).length)return;
 if(!APPLY){console.log('DRY RUN update',id,values);return}
 await gql('mutation($b:ID!,$i:ID!,$v:JSON!){change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){id}}',{b:BOARD,i:id,v:JSON.stringify(values)});
}
async function notify(item,cols,message) {
 const ids=[...new Set((val(cols,C.recipients)?.personsAndTeams||[]).filter(p=>p.kind==='person').map(p=>Number(p.id)).filter(Number.isFinite))];
 if(!ids.length){console.log('No assigned recipients',item.name);return false}
 for(const userId of ids) {
   if(!APPLY){console.log('DRY RUN notify',userId,item.name,message);continue}
   await gql('mutation($u:ID!,$t:ID!,$m:String!){create_notification(user_id:$u,target_id:$t,text:$m,target_type:Project){text}}',{u:userId,t:item.id,m:message});
 }
 return true;
}
async function run() {
 let cursor=null,items=[];
 do {
  const data=await gql('query($b:ID!,$cursor:String){boards(ids:[$b]){items_page(limit:100,cursor:$cursor){cursor items{id name column_values{id text value}}}}}',{b:BOARD,cursor});
  const page=data.boards[0].items_page;items.push(...page.items);cursor=page.cursor;
 }while(cursor);
 let processed=0;
 for(const item of items){
  const c=columns(item),status=label(c,C.status),start=date(val(c,C.start));
  if(!start || !['On Rent','Call-Off Requested'].includes(status))continue;
  processed++;
  const end=date(val(c,C.actualEnd)),called=date(val(c,C.calledOff));
  const approved=label(c,C.approval)==='Approved';
  const target=(approved && date(val(c,C.revised)))||date(val(c,C.planned));
  const over=target?Math.max(0,days(today,target)):0;
  const override=date(val(c,C.override));
  const next=override||nextAnniversary(start,today);
  const old=date(val(c,C.anniversary));
  const updates={};
  // Preserve the current anniversary through its +1 day native alert.
  if(next && (!old || days(today,old)>1) && old!==next)updates[C.anniversary]={date:next};
  let attention='On Track';
  if(status==='Call-Off Requested' && !end)attention='Awaiting Billing Closure';
  else if(over>0 && !end)attention='Over Plan';
  else if(next && days(next,today)<=3 && days(next,today)>=0)attention='Anniversary Soon';
  if(label(c,C.attention)!==attention)updates[C.attention]={label:attention};
  const lastEsc=date(val(c,C.lastEsc));
  // 3 days after approved plan and every 3 days thereafter.
  if(status==='On Rent' && !called && !end && over>=3 && (!lastEsc||days(today,lastEsc)>=3)){
   const rate=Number(c[C.daily]?.text?.replace(/[^0-9.-]/g,'')||0);
   const message=`Equipment rental over plan: ${item.name}. ${over} days beyond approved end ${target}. Estimated daily-rate overrun: $${(over*rate).toFixed(2)}. Call off or approve extension.`;
   if(await notify(item,c,message))updates[C.lastEsc]={date:today};
  }
  await update(item.id,updates);
 }
 console.log(JSON.stringify({today,items:items.length,activeProcessed:processed,apply:APPLY}));
}
run().catch(e=>{console.error(e);process.exitCode=1});

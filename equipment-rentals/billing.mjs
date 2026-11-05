// Pure 28-day rental billing calculations. Day 1 is the rental start date.
export const days=(a,b)=>Math.round((Date.parse(a+'T12:00:00Z')-Date.parse(b+'T12:00:00Z'))/86400000);
export const addDays=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const nextAnniversary=(start,asOf)=>addDays(start,Math.max(1,Math.ceil(Math.max(1,days(asOf,start))/28))*28);
export function tierCost(length,r) {
 if(length<=0)return 0;
 const full=Math.floor(length/28),remainder=length%28;
 const partial=n=>n<=0?0:n<=2?n*r.daily:n<=9?r.weekly:r.monthly;
 return full*r.monthly+partial(remainder);
}
export function transitionFor(start,asOf) {
 const elapsed=days(asOf,start);
 if(elapsed<0)return null;
 const cycle=Math.floor(elapsed/28),dayInCycle=elapsed%28+1;
 const tier=dayInCycle===3?'Weekly':dayInCycle===10?'Monthly':null;
 if(!tier)return null;
 const cycleStart=addDays(start,cycle*28);
 return {cycleStart,dayInCycle,tier,key:cycleStart+':'+tier};
}

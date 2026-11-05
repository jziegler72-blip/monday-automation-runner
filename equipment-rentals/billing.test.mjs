import test from 'node:test';
import assert from 'node:assert/strict';
import {tierCost,transitionFor,nextAnniversary} from './billing.mjs';
const r={daily:150,weekly:750,monthly:2500};
test('replacement tiers across boundaries',()=>{
 for(const [d,c] of [[0,0],[1,150],[2,300],[3,750],[9,750],[10,2500],[28,2500],[29,2650],[30,2800],[31,3250],[37,3250],[38,5000],[56,5000],[57,5150]])
  assert.equal(tierCost(d,r),c,'days '+d);
});
test('day 3 and day 10 transition and deduplication keys',()=>{
 assert.equal(transitionFor('2026-11-03','2026-11-05')?.key,'2026-11-03:Weekly');
 assert.equal(transitionFor('2026-10-27','2026-11-05')?.key,'2026-10-27:Monthly');
 assert.equal(transitionFor('2026-10-06','2026-11-05')?.key,'2026-11-03:Weekly');
 assert.equal(transitionFor('2026-09-29','2026-11-05')?.key,'2026-10-27:Monthly');
 assert.equal(transitionFor('2026-11-04','2026-11-05'),null);
 assert.equal(transitionFor('2026-11-06','2026-11-05'),null);
});
test('anniversary stays on 28-day calendar',()=>{
 assert.equal(nextAnniversary('2026-10-01','2026-11-05'),'2026-11-26');
 assert.equal(nextAnniversary('2026-10-01','2026-10-29'),'2026-10-29');
 assert.equal(nextAnniversary('2026-10-01','2026-10-30'),'2026-11-26');
});

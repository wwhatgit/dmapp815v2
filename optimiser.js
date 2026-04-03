/* ═══════════════════════════════════════════════════
   DMapp · BIS — optimiser.js  v6
   Directional Sweep Optimiser with Cluster-Run support

   KEY INSIGHT: Links are not just points — they have
   direction (FROM→TO). The driver travels in a heading.
   The best next link is not just the nearest centroid,
   but the one most "ahead" in the current travel bearing,
   weighted by distance. This prevents the algo from
   sending the driver backwards to pick up nearby links
   that were behind them.

   Algorithm:
   1. Compute link centroids + bearing vectors
   2. Directional-weighted NN: score = dist / cos(angle_diff)
      — links in the same heading direction are preferred
      — links behind the driver are penalised
   3. Cluster by proximity after ordering (not before)
      — group consecutive links within threshold distance
   4. Within each cluster: chain-maximise (prefer ToStop=FromStop)
   5. Expand: Zone Run1→Run2 before moving to next zone
   6. Per-link run2 skip support (skipRun2 flag)
════════════════════════════════════════════════════ */

'use strict';

function optHaversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1=lat1*Math.PI/180, p2=lat2*Math.PI/180;
  const dp=(lat2-lat1)*Math.PI/180, dl=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// Bearing in radians from point A to point B
function bearing(lat1,lng1,lat2,lng2) {
  const toR=Math.PI/180;
  const dL=(lng2-lng1)*toR;
  const y=Math.sin(dL)*Math.cos(lat2*toR);
  const x=Math.cos(lat1*toR)*Math.sin(lat2*toR)-Math.sin(lat1*toR)*Math.cos(lat2*toR)*Math.cos(dL);
  return Math.atan2(y,x); // -π to π
}

// Angular difference between two bearings (-π to π, wrapped)
function angleDiff(a,b) {
  let d=b-a;
  while(d>Math.PI)  d-=2*Math.PI;
  while(d<-Math.PI) d+=2*Math.PI;
  return d;
}

// ─────────────────────────────────────────────────
//  LINK PROPERTIES
// ─────────────────────────────────────────────────
function getLinkProps(link, stops) {
  const f=stops[link.fromStop], t=stops[link.toStop];
  if (!f||!t||!f.lat||!t.lat) return null;
  return {
    fromLat:f.lat, fromLng:f.lng,
    toLat:t.lat,   toLng:t.lng,
    centLat:(f.lat+t.lat)/2, centLng:(f.lng+t.lng)/2,
    brg: bearing(f.lat,f.lng,t.lat,t.lng),
    dist: optHaversine(f.lat,f.lng,t.lat,t.lng)
  };
}

// ─────────────────────────────────────────────────
//  DIRECTIONAL WEIGHTED NN
//  Scores candidate links by: dist_to_fromStop * dirPenalty
//  dirPenalty: links in forward direction = 1.0
//              links at 90° off = ~1.5
//              links directly behind = 3.0
//  Also strongly prefer chain (toStop=fromStop of next) = 0.01
// ─────────────────────────────────────────────────
function directionalScore(curLat, curLng, curBrg, candProp, chainBonus) {
  if (!candProp) return Infinity;
  const d = optHaversine(curLat, curLng, candProp.fromLat, candProp.fromLng);
  if (d < 5) return chainBonus ? 0.01 : 1; // same location = best

  // Direction from current pos to candidate's from-stop
  const brgToCand = bearing(curLat, curLng, candProp.fromLat, candProp.fromLng);
  const diff = Math.abs(angleDiff(curBrg, brgToCand));

  // Penalty: 1.0 at 0°, 2.5 at 180°
  const dirPenalty = 1.0 + 1.5 * (diff / Math.PI);

  if (chainBonus) return 0.01; // chain: ignore direction, always prefer
  return d * dirPenalty;
}

// ─────────────────────────────────────────────────
//  DIRECTIONAL SWEEP — main link ordering
//  Produces an ordered array of planIdx
// ─────────────────────────────────────────────────
function directionalSweep(plan, stops, originLat, originLng) {
  const n = plan.length;
  const props = plan.map(l => getLinkProps(l, stops));

  const visited = new Array(n).fill(false);
  const order = [];

  // Start position
  let curLat = originLat, curLng = originLng, curBrg = 0;
  if (curLat == null) {
    // Use centroid of all links as starting reference
    const valid = props.filter(Boolean);
    if (valid.length) {
      curLat = valid.reduce((s,p)=>s+p.centLat,0)/valid.length;
      curLng = valid.reduce((s,p)=>s+p.centLng,0)/valid.length;
    }
  }

  for (let step = 0; step < n; step++) {
    let bestIdx = -1, bestScore = Infinity;

    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      // Chain check: does prev link's toStop === this link's fromStop?
      const isChain = order.length > 0 &&
        plan[order[order.length-1]].toStop === plan[j].fromStop;
      const score = directionalScore(curLat, curLng, curBrg, props[j], isChain);
      if (score < bestScore) { bestScore = score; bestIdx = j; }
    }

    if (bestIdx === -1) {
      // Fallback: pick first unvisited
      for (let j=0;j<n;j++) { if(!visited[j]){bestIdx=j;break;} }
    }

    visited[bestIdx] = true;
    order.push(bestIdx);

    // Update position and bearing
    const p = props[bestIdx];
    if (p) {
      // After measuring link, driver is at toStop heading link's direction
      curLat = p.toLat; curLng = p.toLng;
      curBrg = p.brg; // carry forward the link's direction as travel heading
    }
  }

  return order;
}

// ─────────────────────────────────────────────────
//  2-OPT ON ORDERED RESULT
//  Swaps pairs to reduce total dead-mileage.
//  Runs max 2 passes to stay fast.
// ─────────────────────────────────────────────────
function twoOpt(order, plan, stops, originLat, originLng) {
  let best = order.slice();
  let bestCost = routeCostSimple(best, plan, stops, originLat, originLng);
  let improved = true, passes = 0;

  while (improved && passes < 2) {
    improved = false; passes++;
    for (let i=0;i<best.length-1;i++) {
      for (let j=i+1;j<best.length;j++) {
        const cand = best.slice();
        // Reverse segment i..j
        let lo=i,hi=j; while(lo<hi){[cand[lo],cand[hi]]=[cand[hi],cand[lo]];lo++;hi--;}
        const c = routeCostSimple(cand, plan, stops, originLat, originLng);
        if (c < bestCost-1) { best=cand; bestCost=c; improved=true; }
      }
    }
  }
  return best;
}

function routeCostSimple(order, plan, stops, originLat, originLng) {
  let cost=0, curLat=originLat, curLng=originLng;
  order.forEach(i => {
    const f=stops[plan[i].fromStop], t=stops[plan[i].toStop];
    if (!f||!f.lat) return;
    if (curLat!=null) cost+=optHaversine(curLat,curLng,f.lat,f.lng);
    if (t&&t.lat){curLat=t.lat;curLng=t.lng;}
  });
  return cost;
}

// ─────────────────────────────────────────────────
//  SEQUENTIAL CLUSTERING
//  After ordering, group consecutive links within
//  a distance threshold into zones.
//  This respects travel direction — no backtracking.
// ─────────────────────────────────────────────────
function sequentialCluster(order, plan, stops, overrideThresholdM) {
  if (!order.length) return [];

  // Auto-threshold: 15% of total route span (overridden by user slider)
  const props = plan.map(l=>getLinkProps(l,stops));
  const validC = order.filter(i=>props[i]).map(i=>props[i]);
  let threshold = 1000; // metres default
  if (overrideThresholdM != null) {
    threshold = overrideThresholdM;
  } else if (validC.length > 1) {
    const lats=validC.map(p=>p.centLat), lngs=validC.map(p=>p.centLng);
    const diag=optHaversine(Math.min(...lats),Math.min(...lngs),Math.max(...lats),Math.max(...lngs));
    threshold = Math.min(Math.max(diag*0.18, 600), 2500);
  }

  const clusters = [];
  let current = [order[0]];

  for (let k=1;k<order.length;k++) {
    const prev = order[k-1], cur = order[k];
    const pProp = props[prev], cProp = props[cur];

    // Dead-mile from prev toStop to cur fromStop
    let gap = Infinity;
    if (pProp && cProp) {
      gap = optHaversine(pProp.toLat, pProp.toLng, cProp.fromLat, cProp.fromLng);
    }

    if (gap <= threshold) {
      current.push(cur);
    } else {
      clusters.push(current);
      current = [cur];
    }
  }
  clusters.push(current);
  return { clusters, threshold };
}

// ─────────────────────────────────────────────────
//  WITHIN-CLUSTER CHAIN OPTIMISATION
//  Re-order within each cluster to maximise chains
//  (toStop[i] = fromStop[i+1]) while keeping the
//  cluster entry point close to the approach direction.
// ─────────────────────────────────────────────────
function optimiseClusterLinks(memberIndices, plan, stops, entryLat, entryLng, entryBrg) {
  if (memberIndices.length <= 1) return memberIndices.slice();
  const n = memberIndices.length;
  const props = memberIndices.map(i => getLinkProps(plan[i], stops));

  let best=null, bestScore=Infinity;
  for (let s=0;s<n;s++) {
    const visited=new Array(n).fill(false);
    const ord=[s]; visited[s]=true;
    let curLat=entryLat||props[s]?.fromLat||0;
    let curLng=entryLng||props[s]?.fromLng||0;
    let curBrg=entryBrg||0;
    let cost=0;

    if (entryLat!=null&&props[s]) cost+=optHaversine(entryLat,entryLng,props[s].fromLat,props[s].fromLng);

    for (let step=1;step<n;step++) {
      let bj=-1,bd=Infinity;
      for (let j=0;j<n;j++) {
        if (visited[j]) continue;
        const chain=plan[memberIndices[ord[ord.length-1]]].toStop===plan[memberIndices[j]].fromStop;
        const sc=directionalScore(curLat,curLng,curBrg,props[j],chain);
        if (sc<bd){bd=sc;bj=j;}
      }
      if (bj===-1){for(let j=0;j<n;j++){if(!visited[j]){bj=j;break;}}}
      visited[bj]=true; ord.push(bj);
      cost+=bd<Infinity?bd:0;
      if(props[bj]){curLat=props[bj].toLat;curLng=props[bj].toLng;curBrg=props[bj].brg;}
    }
    if (cost<bestScore){bestScore=cost;best=ord;}
  }
  return best.map(i=>memberIndices[i]);
}

// ─────────────────────────────────────────────────
//  EXPAND TO JOURNEY STEPS with per-link run2 skip
// ─────────────────────────────────────────────────
function expandJourney(clusters, plan, stops, totalRuns) {
  const steps=[];
  clusters.forEach((members, cIdx) => {
    // Entry point for this cluster
    let entryLat=null, entryLng=null, entryBrg=0;
    if (steps.length>0) {
      const last=steps[steps.length-1];
      const t=stops[plan[last.planIdx].toStop];
      if(t&&t.lat){entryLat=t.lat;entryLng=t.lng;}
      const lp=getLinkProps(plan[last.planIdx],stops);
      if(lp) entryBrg=lp.brg;
    }

    // Optimise links within cluster respecting approach direction
    const ordered=optimiseClusterLinks(members, plan, stops, entryLat, entryLng, entryBrg);

    for (let run=1;run<=totalRuns;run++) {
      ordered.forEach(planIdx => {
        // Skip run2 if flagged
        if (run===2 && plan[planIdx].skipRun2) return;
        steps.push({ planIdx, run, clusterId:cIdx, clusterSeq:cIdx });
      });
    }
  });
  return steps;
}

// ─────────────────────────────────────────────────
//  JOURNEY STATS
// ─────────────────────────────────────────────────
function journeyStats(steps, plan, stops, originLat, originLng, speedKmh) {
  let deadMetre=0, linkMetre=0;
  let curLat=originLat, curLng=originLng;

  steps.forEach(step=>{
    const link=plan[step.planIdx];
    const f=stops[link.fromStop], t=stops[link.toStop];
    if(!f||!f.lat) return;
    if(curLat!=null) deadMetre+=optHaversine(curLat,curLng,f.lat,f.lng);
    if(t&&t.lat){
      linkMetre+=optHaversine(f.lat,f.lng,t.lat,t.lng);
      curLat=t.lat; curLng=t.lng;
    }
  });

  const totalKm=(deadMetre+linkMetre)/1000;
  const timeHr=totalKm/speedKmh;
  const timeMin=Math.round(timeHr*60);

  return {
    deadKm: deadMetre/1000,
    linkKm: linkMetre/1000,
    totalKm,
    timeMin,
    timeStr: timeMin>=60 ? `${Math.floor(timeMin/60)}h ${timeMin%60}m` : `${timeMin}m`
  };
}

// ─────────────────────────────────────────────────
//  HELPERS for app.js (must stay global)
// ─────────────────────────────────────────────────
function linkDistance(plan, stops) {
  let t=0;
  plan.forEach(l=>{const f=stops[l.fromStop],to=stops[l.toStop];if(f&&to&&f.lat&&to.lat)t+=optHaversine(f.lat,f.lng,to.lat,to.lng);});
  return t/1000;
}
function calcDeadMileForOrder(plan, stops, order, oLat, oLng) {
  let t=0,cLat=oLat,cLng=oLng;
  order.forEach(i=>{const f=stops[plan[i].fromStop],to=stops[plan[i].toStop];if(!f||!f.lat)return;if(cLat!=null)t+=optHaversine(cLat,cLng,f.lat,f.lng);if(to&&to.lat){cLat=to.lat;cLng=to.lng;}});
  return t/1000;
}

// ─────────────────────────────────────────────────
//  MAIN: optimiseRoute
// ─────────────────────────────────────────────────
function optimiseRoute(plan, stops, originLat, originLng, totalRuns, speedKmh, customThresholdKm) {
  totalRuns=totalRuns||2; speedKmh=speedKmh||50;
  if(!plan.length) return {journeySteps:[],clusters:[],deadKm:0,linkKm:0,totalKm:0,timeMin:0,timeStr:'0m',savings:0,numClusters:0,threshold:0};

  // Baseline (original flat order, no optimisation)
  const origOrder=plan.map((_,i)=>i);
  const origDead=calcDeadMileForOrder(plan,stops,origOrder,originLat,originLng)*totalRuns;

  // Step 1: Directional sweep to get ordered sequence
  let order=directionalSweep(plan,stops,originLat,originLng);

  // Step 2: 2-opt refinement
  order=twoOpt(order,plan,stops,originLat,originLng);

  // Step 3: Sequential clustering (respects travel direction)
  // customThresholdKm overrides auto-calculation when provided
  const customThresholdM = customThresholdKm ? customThresholdKm * 1000 : null;
  const {clusters,threshold}=sequentialCluster(order,plan,stops,customThresholdM);

  // Step 4: Expand to full journey with run support
  const journeySteps=expandJourney(clusters,plan,stops,totalRuns);

  // Step 5: Compute stats
  const stats=journeyStats(journeySteps,plan,stops,originLat,originLng,speedKmh);
  const savings=Math.max(0,origDead-stats.deadKm);

  return {
    journeySteps, clusters, order,
    deadKm:stats.deadKm, linkKm:stats.linkKm, totalKm:stats.totalKm,
    timeMin:stats.timeMin, timeStr:stats.timeStr,
    savings, numClusters:clusters.length, threshold,
    originalDead:origDead
  };
}

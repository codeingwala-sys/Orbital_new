// ================================================================
//  musicMode.js  v15
//
//  CORE BEHAVIOUR:
//  ─────────────────────────────────────────────────────────────
//  1. SPREAD — particles live in a wide 3D galaxy spread.
//     Core is LIGHTER (25% of particles, smaller radius).
//     Arms are WIDER — particles fill the whole screen.
//
//  2. OUTWARD ONLY — ALL music forces push particles AWAY
//     from their rest position. Nothing pulls inward.
//     The spring is the only thing that brings them home.
//     This means: music = spread out. Silence = drift back.
//
//  3. GENTLE SPRING HOME — when no music is detected, the
//     soft spring (RESTORE = 0.022) slowly pulls every particle
//     back to its rest position. Not a snap — a gentle float.
//     VEL_DAMP = 0.92 so particles glide back smoothly.
//
//  4. LIGHT BASS SENSITIVITY — bass threshold lowered, the
//     sub-bass penalty removed. Even quiet bass lines are felt.
//     This covers gentle tabla, soft kick, harmonium bass.
//
//  5. TIERED PARTICLE COUNT — energy-adaptive:
//     QUIET  35% | MEDIUM 55% | ACTIVE 72%
//     Dev panel (#dev-particles) synced every frame.
//
//  6. INSTRUMENT SIGNATURES — each pushes outward differently:
//     KICK   → spherical burst from core rest pos
//     DHOL   → equatorial fan-out (XZ only, no Y)
//     DAYAN  → mid-shell tangential spin + outward scatter
//     SNARE  → horizontal ring burst at mid-height
//     BASS   → slow radial swell, strongest at core
//     MELODY → outer arms orbit + gentle outward billow
//     FLUTE  → vertical standing wave (Y-axis breathing)
//     SITAR  → diagonal ripple across surface
//     SHIMMER→ arm-tip + top rapid micro-scatter
//     DROP   → full-body outward burst → slow return
// ================================================================

(function () {
  'use strict';

  let active = false, audioCtx = null, analyser = null;
  let dataArray = null, sourceNode = null, displayStream = null;
  let rafId = null;

  const FFT = 2048;

  // ── TIERED PARTICLE COUNT ─────────────────────────────────────
  const TIER = { QUIET: 0.35, MEDIUM: 0.55, ACTIVE: 0.72 };
  let tierCurrent = TIER.MEDIUM;
  let tierTarget  = TIER.MEDIUM;
  let activeCount = 0;
  let lastTierMs  = 0;
  const TIER_MS   = 900;

  // ── GALAXY SPREAD ─────────────────────────────────────────────
  let galaxyBase     = null;
  let savedShape     = null;
  let galaxyMorphT   = 0;
  let galaxyMorphDir = 0;
  const MORPH_SPEED  = 0.010;   // ~100 frames = 1.7s transition

  // ── FREQUENCY BINS ────────────────────────────────────────────
  // Frequency bins — tuned for Indian + Western instruments:
  // harmonium/sarangi:  250–900 Hz (lowMid + mid overlap)
  // bansuri:            500–2000 Hz (flute)
  // tabla dayan:        350–1500 Hz (dayan)
  // tabla bayan/mridangam: 60–320 Hz (dhol + kick overlap)
  // sitar pluck attack: 800–4000 Hz (sitar)
  // manjira/ghungroo:   4000–16000 Hz (air)
  // shehnai/nadaswaram: 600–3500 Hz (flute + mid overlap)
  // mridangam:          55–280 Hz (taiko)
  // dholak:             80–380 Hz (dhol)
  const BINS = {
    sub:    [20,   70  ],   // sub-bass thud
    kick:   [60,   200 ],   // kick, tabla bayan, mridangam low
    dhol:   [80,   400 ],   // dhol, dholak, harmonium bass
    bass:   [70,   350 ],   // bass guitar, harmonium, veena bass
    dayan:  [320,  1600],   // tabla dayan, mridangam treble
    snare:  [160,  560 ],   // snare, thali, clap, kanjira
    lowMid: [220,  1100],   // harmonium, sarangi, veena, guitar
    mid:    [650,  3200],   // vocals, piano, sitar, shehnai
    hiMid:  [2000, 6000],   // violin, shehnai high, guitar pick
    air:    [4500, 18000],  // manjira, ghungroo, hi-hat, triangle
    flute:  [480,  2200],   // bansuri, flute, shehnai low
    sitar:  [900,  4500],   // sitar pluck, guitar attack, sarangi
    taiko:  [40,   260 ],   // taiko, mridangam, djembe, cajon
  };
  const KEYS = Object.keys(BINS);
  const KLEN = KEYS.length;
  const KI   = {}; KEYS.forEach((k, i) => { KI[k] = i; });

  const raw  = new Float32Array(KLEN);
  const smV  = new Float32Array(KLEN);
  const pkV  = new Float32Array(KLEN).fill(0.001);
  const fast = new Float32Array(KLEN).fill(0.001);
  const slow = new Float32Array(KLEN).fill(0.001);
  const nVal = new Float32Array(KLEN);
  let Ntotal = 0;

  // ── INSTRUMENT ENVELOPES ──────────────────────────────────────
  const E = {
    kick:0, kickFire:false,
    dhol:0, dholFire:false,
    dayan:0, dayanFire:false,
    snare:0, snareFire:false,
    taiko:0, taikoFire:false,
    bass:0, melody:0, flute:0, sitar:0, shimmer:0,
    energy:0, beat:0, drop:0,
  };
  let cdKick=false, cdDhol=false, cdDayan=false, cdSnare=false, cdTaiko=false;
  let silenceN=0, dropArmed=false, lastMorphT=0;
  const MORPH_GAP = 55000;

  // ── PHYSICS ───────────────────────────────────────────────────
  // RESTORE is very gentle — particles float back home, not snap.
  // DAMP is high — gliding deceleration, no bounce.
  // MAX_D is generous — music can push particles far outward.
  // ALL forces are OUTWARD from rest. Spring is the only inward.
  let velArr = null;
  const DAMP    = 0.93;   // high damp = smooth glide back to rest
  const RESTORE = 0.016;  // very soft spring — lazy drift home
  const MAX_D   = 35.0;   // large — particles spread far on big beats
  const MAX_V   = 2.5;    // velocity cap

  // ── PHASE ACCUMULATORS ────────────────────────────────────────
  let phBass=0, phMel=0, phShim=0, phFlute=0, phSitar=0, phDayan=0, phAmb=0;

  // ── WAKE-UP GATE ──────────────────────────────────────────────
  // Starts at 0 when music begins, reaches 1 after a few beats.
  // Prevents full-force reactions before calibration settles.
  let scatter = 0;

  // ── GLOW ──────────────────────────────────────────────────────
  let glKick=0, glBass=0, glMel=0, glShim=0, glDrop=0;
  let cHue=0, cSat=0, cLit=0, ambAmp=0;

  // ── PER-FRAME PRE-COMPUTED SCALARS ────────────────────────────
  let _sP=0, _fKick=0, _fDhol=0, _fDayan=0, _fSnare=0;
  let _fBass=0, _fMel=0, _fFlute=0, _fSitar=0, _fShim=0;
  let _fDrop=0, _fAmb=0, _silentFrame=false;

  // ── DEV PANEL ─────────────────────────────────────────────────
  let panel=null, pCanvas=null, pCtx=null;

  window.musicModeActive = false;
  window.__musicEnergy__ = { bass:0, mid:0, high:0, total:0, beat:false, beatPulse:0 };

  // ================================================================
  //  GALAXY SPREAD BUILDER
  //
  //  SPREAD-OUT design:
  //  - Only 25% of particles go to core (radius < 18)
  //  - 75% fill the arms, spread to rMax=115 (fills screen)
  //  - Arms have more angular spread (armSpread=0.40) for a
  //    softer, more nebula-like appearance
  //  - Y-thickness: ±24 at core → ±6 at edge (3D volume)
  //  - Per-arm tilt makes it genuinely 3D (not a flat disk)
  // ================================================================
  function buildGalaxyBase(count) {
    const base      = new Float32Array(count * 3);
    const arms      = 4;
    const rMax      = 145;   // very wide — particles truly fill screen
    const coreR     = 12;    // tiny core — NOT dense, just a small nucleus
    const spin      = 2.5;
    const armSpread = 0.55;  // loose arms — nebula, not razor-thin lines

    // Only 12% core — 88% spread across the arms
    const coreCount = Math.floor(count * 0.12);

    for (let i = 0; i < count; i++) {
      let x, y, z;

      if (i < coreCount) {
        // ── TINY NUCLEUS — small, NOT overcrowded ─────────────
        const r   = Math.sqrt(Math.random()) * coreR;
        const ang = Math.random() * Math.PI * 2;
        x = Math.cos(ang) * r;
        z = Math.sin(ang) * r;
        y = (Math.random() - 0.5) * 20 * (1.0 - r / coreR * 0.45);

      } else {
        // ── SPIRAL ARMS — spread wide all the way to rMax ─────
        // Use linear distribution (power 1.0) so particles are
        // evenly spread from inner to outer — NOT bunched at center.
        // A small minimum radius pushes them away from the nucleus.
        const rFrac = Math.random();                         // uniform 0→1
        const r     = coreR * 1.2 + rFrac * (rMax - coreR * 1.2);

        const armIdx  = Math.floor(Math.random() * arms);
        const armBase = (armIdx / arms) * Math.PI * 2;
        const angle   = armBase + r * 0.038 * spin + (Math.random() - 0.5) * armSpread;

        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;

        // Y-thickness: ±26 near inner → ±5 at tips (real 3D volume)
        const tFrac = Math.min(1, (r - coreR) / (rMax - coreR));
        const yMax  = 26 * (1.0 - tFrac * 0.81);
        y = (Math.random() - 0.5) * yMax;

        // Per-arm tilt — each arm leans a different direction
        const tilt = 0.12 * Math.sin(armBase * 1.4 + r * 0.022);
        y += z * tilt * 0.08;
      }

      base[i * 3]     = x;
      base[i * 3 + 1] = y;
      base[i * 3 + 2] = z;
    }
    return base;
  }

  // ================================================================
  //  AUDIO CAPTURE
  // ================================================================
  function ensureCtx() {
    if (!audioCtx || audioCtx.state === 'closed')
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function mkAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = FFT;
    a.smoothingTimeConstant = 0.50;
    dataArray = new Uint8Array(a.frequencyBinCount);
    return a;
  }
  async function captureAudio() {
    if (displayStream) {
      const alive = displayStream.getAudioTracks().some(t => t.readyState === 'live');
      if (alive) {
        ensureCtx();
        if (!analyser) analyser = mkAnalyser(audioCtx);
        if (!sourceNode) { sourceNode = audioCtx.createMediaStreamSource(displayStream); sourceNode.connect(analyser); }
        return true;
      }
    }
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, sampleRate:44100 }
      });
    } catch(e) { console.warn('[MusicMode] denied:', e); return false; }
    displayStream.getVideoTracks().forEach(t => t.stop());
    ensureCtx();
    analyser   = mkAnalyser(audioCtx);
    sourceNode = audioCtx.createMediaStreamSource(displayStream);
    sourceNode.connect(analyser);
    displayStream.getAudioTracks().forEach(t => {
      t.addEventListener('ended', () => { sourceNode=null; displayStream=null; if(active) stop(); });
    });
    return true;
  }
  function disconnectSrc() {
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
  }
  function bandE(lo, hi) {
    if (!analyser || !dataArray) return 0;
    const nyq = audioCtx.sampleRate * 0.5, bc = dataArray.length;
    const a = Math.max(1, (lo / nyq * bc) | 0);
    const b = Math.min(bc - 1, Math.ceil(hi / nyq * bc));
    if (a >= b) return 0;
    let s = 0;
    for (let i = a; i <= b; i++) s += dataArray[i];
    return s / ((b - a + 1) * 255);
  }

  // ================================================================
  //  GALAXY MORPH — smooth enter/exit transition
  //  Only runs during the initial enter (galaxyMorphDir === 1).
  //  During silence the silent-frame path controls tp directly.
  // ================================================================
  function advanceGalaxyMorph() {
    // Only drive morph during the initial entry phase.
    // Silence-retreat and music-resume are handled inside applyReactions.
    if (galaxyMorphDir !== 1) return;
    const tp = window.__targetPositions__;
    if (!tp || !galaxyBase || !savedShape) return;
    const cnt = Math.min(activeCount, (tp.length / 3) | 0);

    galaxyMorphT = Math.min(1, galaxyMorphT + MORPH_SPEED);
    const t  = galaxyMorphT * galaxyMorphT * (3 - 2 * galaxyMorphT);
    const t1 = 1 - t;

    for (let i = 0; i < cnt; i++) {
      const i3 = i * 3;
      tp[i3]   = savedShape[i3]   * t1 + galaxyBase[i3]   * t;
      tp[i3+1] = savedShape[i3+1] * t1 + galaxyBase[i3+1] * t;
      tp[i3+2] = savedShape[i3+2] * t1 + galaxyBase[i3+2] * t;
    }

    if (galaxyMorphT >= 1) galaxyMorphDir = 0;
  }

  // ================================================================
  //  ANALYSIS
  // ================================================================
  function analyse() {
    if (!analyser) return;
    analyser.getByteFrequencyData(dataArray);

    for (let i = 0; i < KLEN; i++) {
      const b = BINS[KEYS[i]];
      raw[i] = bandE(b[0], b[1]);
    }

    const Ks = KI;
    const tot =
      raw[Ks.sub]*0.06 + raw[Ks.kick]*0.12 + raw[Ks.dhol]*0.13 + raw[Ks.bass]*0.12 +
      raw[Ks.dayan]*0.10 + raw[Ks.snare]*0.08 + raw[Ks.lowMid]*0.12 +
      raw[Ks.mid]*0.12 + raw[Ks.hiMid]*0.06 + raw[Ks.air]*0.04 +
      raw[Ks.flute]*0.02 + raw[Ks.sitar]*0.01;

    for (let i = 0; i < KLEN; i++) {
      fast[i] += (raw[i] - fast[i]) * 0.45;
      slow[i] += (raw[i] - slow[i]) * 0.016;
      smV[i]  += (raw[i] - smV[i])  * 0.10;
      if (smV[i] > pkV[i]) pkV[i] = smV[i];
      else pkV[i] = Math.max(0.002, pkV[i] - 0.0003);
      nVal[i] = Math.min(1, smV[i] / (pkV[i] + 0.002));
    }

    Ntotal =
      nVal[Ks.sub]*0.06 + nVal[Ks.kick]*0.12 + nVal[Ks.dhol]*0.13 + nVal[Ks.bass]*0.12 +
      nVal[Ks.dayan]*0.10 + nVal[Ks.snare]*0.08 + nVal[Ks.lowMid]*0.12 +
      nVal[Ks.mid]*0.12 + nVal[Ks.hiMid]*0.06 + nVal[Ks.air]*0.04;

    const rSub  = fast[Ks.sub]   / (slow[Ks.sub]   + 0.002);
    const rKick = fast[Ks.kick]  / (slow[Ks.kick]  + 0.002);
    const rDhol = fast[Ks.dhol]  / (slow[Ks.dhol]  + 0.002);
    const rBass = fast[Ks.bass]  / (slow[Ks.bass]  + 0.002);
    const rDayan= fast[Ks.dayan] / (slow[Ks.dayan] + 0.002);
    const rSnare= fast[Ks.snare] / (slow[Ks.snare] + 0.002);
    const rHiMid= fast[Ks.hiMid] / (slow[Ks.hiMid] + 0.002);
    const rMid  = fast[Ks.mid]   / (slow[Ks.mid]   + 0.002);
    const rTaiko= fast[Ks.taiko] / (slow[Ks.taiko] + 0.002);
    const nKick = nVal[Ks.kick], nDhol = nVal[Ks.dhol];
    const nDayan= nVal[Ks.dayan], nHiMid= nVal[Ks.hiMid];
    const nTaiko= nVal[Ks.taiko];

    // ── TRANSIENT DETECTION ──────────────────────────────────────
    // We use fast/slow ratio to catch hits.
    // Thresholds are LOW to catch soft tabla, gentle harmonium bass,
    // quiet folk instruments — not just loud western kicks.
    // fast slew=0.45, slow slew=0.016 → ratio peaks sharply on attack.

    // KICK / TABLA BAYAN / MRIDANGAM LOW / TAIKO
    {
      // Combine sub + kick + taiko — catches heavy AND soft low hits
      const r = Math.max(rSub * 0.85, rKick, rTaiko * 0.80,
                         fast[Ks.taiko]/(slow[Ks.taiko]+0.001) * 0.70);
      if (!cdKick && r > 1.18 && Ntotal > 0.012) {
        E.kickFire = true;
        E.kick = Math.max(0.18, Math.min(1, (r-1.18)*0.85 + Math.max(nVal[Ks.sub],nKick,nTaiko)*0.45));
        cdKick = true; setTimeout(() => cdKick = false, 120);
      } else E.kickFire = false;
      E.kick *= 0.52;
    }
    // DHOL / DHOLAK / HARMONIUM BASS THUMP
    {
      const r = Math.max(rDhol, rBass*0.70, rKick*0.55);
      const wk = rSub>1.4 && rKick>1.2; // only suppress if very strong kick
      if (!cdDhol && r > 1.14 && !wk && nDhol > 0.05) {
        E.dholFire = true;
        E.dhol = Math.max(0.14, Math.min(1, (r-1.14)*0.90 + nDhol*0.50));
        cdDhol = true; setTimeout(() => cdDhol = false, 100);
      } else E.dholFire = false;
      E.dhol *= 0.50;
    }
    // TABLA DAYAN / KANJIRA / MRIDANGAM HIGH / DHOLAK TREBLE
    {
      // Don't over-suppress with low-band check — dayan coexists with bass
      const low = rSub>1.6 || rKick>1.6;
      if (!cdDayan && rDayan > 1.12 && !low && nDayan > 0.04) {
        E.dayanFire = true;
        E.dayan = Math.max(0.10, Math.min(1, (rDayan-1.12)*0.92 + nDayan*0.55));
        cdDayan = true; setTimeout(() => cdDayan = false, 85);
      } else E.dayanFire = false;
      E.dayan *= 0.48;
    }
    // SNARE / CLAP / THALI / KANJIRA CRACK
    {
      const low = rSub>1.25 || rKick>1.25 || rDhol>1.25;
      const cr  = Math.max(rSnare, rHiMid*0.85, rMid*0.55);
      const cl  = Math.max(nVal[Ks.snare], nHiMid*0.75);
      if (!cdSnare && !low && cr > 1.12 && cl > 0.03) {
        E.snareFire = true;
        E.snare = Math.max(0.12, Math.min(1, (cr-1.12)*0.92 + cl*0.55));
        cdSnare = true; setTimeout(() => cdSnare = false, 140);
      } else E.snareFire = false;
      E.snare *= 0.55;
    }
    // TAIKO / DJEMBE / CAJON / MRIDANGAM BODY
    {
      if (!cdTaiko && rTaiko > 1.16 && nTaiko > 0.04) {
        E.taikoFire = true;
        E.taiko = Math.max(0.08, Math.min(1, (rTaiko-1.16)*0.85 + nTaiko*0.45));
        cdTaiko = true; setTimeout(() => cdTaiko = false, 130);
      } else E.taikoFire = false;
      E.taiko *= 0.52;
    }

    E.beat += (Math.max(E.kick, E.dhol, E.dayan*0.70, E.snare*0.60, E.taiko*0.80) - E.beat) * 0.35;

    // BASS — tabla bayan, harmonium drone, tanpura, bass guitar, veena bass
    // Higher weight on sub + dhol to catch soft Indian bass.
    // No gating — bass reacts from the very first note.
    E.bass += (Math.max(0,
      nVal[Ks.bass]*0.60 + nVal[Ks.sub]*0.20 + nDhol*0.30 +
      nVal[Ks.kick]*0.14 + nTaiko*0.10
    ) - E.bass) * 0.13;

    // MELODY — harmonium, sarangi, shehnai, vocals, piano, guitar, veena
    E.melody += (nVal[Ks.mid]*0.35 + nVal[Ks.lowMid]*0.33 +
                 nVal[Ks.flute]*0.18 + nVal[Ks.sitar]*0.14 - E.melody) * 0.08;

    // FLUTE — bansuri, shehnai, nadaswaram, flute
    E.flute += (nVal[Ks.flute]*0.58 + nVal[Ks.mid]*0.24 +
                nVal[Ks.lowMid]*0.12 + nHiMid*0.06 - E.flute) * 0.08;

    // SITAR — sitar, sarangi, guitar, veena, rubab, santoor
    E.sitar += (nVal[Ks.sitar]*0.52 + nHiMid*0.24 +
                nDayan*0.14 + nVal[Ks.mid]*0.10 - E.sitar) * 0.10;

    // SHIMMER — manjira, ghungroo, cymbals, triangle, bells, kanjira
    E.shimmer += (nVal[Ks.air]*0.52 + nHiMid*0.34 +
                  nVal[Ks.sitar]*0.08 + nDayan*0.06 - E.shimmer) * 0.09;

    E.energy += (Ntotal - E.energy) * 0.10;
    ambAmp   += (E.energy*0.50 + 0.03 - ambAmp) * 0.04;

    // Scatter wake-up gate — reaches 1 quickly for any music
    if (E.kickFire||E.dholFire||E.taikoFire) scatter = Math.min(1, scatter+0.25);
    if (E.dayanFire||E.snareFire)             scatter = Math.min(1, scatter+0.16);
    scatter += (1.0 - scatter) * 0.010; // ambient ramp-up for no-drum music

    // DROP
    const isQ = Ntotal < 0.06;
    silenceN = isQ ? silenceN+1 : 0;
    if (silenceN > 50) dropArmed = true;
    if (dropArmed && !isQ && E.energy > 0.20) {
      E.drop = 1.0; dropArmed = false; silenceN = 0;
      const now = performance.now();
      if (now - lastMorphT > MORPH_GAP) {
        lastMorphT = now;
        setTimeout(() => { window.switchShape?.(1); window.musicModeOnShapeSwitch?.(); }, 400);
      }
    }
    E.drop *= 0.88;

    phBass  += 0.006 + E.bass    * 0.018;
    phMel   += 0.010 + E.melody  * 0.020;
    phShim  += 0.025 + E.shimmer * 0.042;
    phFlute += 0.007 + E.flute   * 0.013;
    phSitar += 0.022 + E.sitar   * 0.038;
    phDayan += 0.030 + E.dayan   * 0.060;
    phAmb   += 0.003 + E.energy  * 0.005;

    window.__musicEnergy__ = {
      bass: nVal[Ks.bass], mid: nVal[Ks.mid], high: nVal[Ks.air], total: Ntotal,
      beat: E.kickFire||E.dholFire||E.taikoFire,
      beatPulse: Math.max(E.kick, E.dhol, E.taiko)
    };
  }

  // ── TIER MANAGEMENT ──────────────────────────────────────────
  function updateTier(now) {
    if (now - lastTierMs < TIER_MS) return;
    lastTierMs = now;
    if (Ntotal < 0.09 && E.energy < 0.09) tierTarget = TIER.QUIET;
    else if (Ntotal > 0.35 || E.beat > 0.25 || E.drop > 0.10) tierTarget = TIER.ACTIVE;
    else tierTarget = TIER.MEDIUM;
    tierCurrent += (tierTarget - tierCurrent) * 0.28;

    const profiles = window.__PARTICLE_PROFILES__;
    const geo      = window.__orbitalGeometry__;
    if (!profiles || !geo) return;
    const newCount = Math.floor(profiles.FULL * tierCurrent);
    if (Math.abs(newCount - activeCount) > 150) {
      activeCount = newCount;
      window.__effectiveParticleCount__ = newCount;
      geo.setDrawRange(0, newCount);
    }
  }

  // ── PRE-COMPUTE PER-FRAME SCALARS ─────────────────────────────
  function preCompute() {
    _sP     = scatter;
    // Percussion — gated by scatter (needs a few beats to calibrate)
    _fKick  = E.kick    * _sP;
    _fDhol  = E.dhol    * _sP;
    _fDayan = E.dayan   * _sP;
    _fSnare = E.snare   * _sP;
    // Sustained instruments — NO scatter gate, react from beat 0
    // This means bass/melody/flute react even in ambient music
    _fBass  = E.bass;
    _fMel   = E.melody;
    _fFlute = E.flute;
    _fSitar = E.sitar;
    _fShim  = E.shimmer;
    _fDrop  = E.drop;
    _fAmb   = ambAmp;
    // _silentFrame: true when all signals are truly quiet.
    // Use a slightly higher ambAmp threshold (0.055) so that
    // the genuine-silence path fires even with tiny ambient noise.
    _silentFrame =
      _fKick+_fDhol+_fDayan+_fSnare < 0.003 &&
      _fBass+_fMel+_fFlute+_fSitar+_fShim < 0.018 &&
      _fDrop < 0.003 && _fAmb < 0.055;
  }

  // ── DEV PANEL SYNC ───────────────────────────────────────────
  function syncDevCount() {
    const devEl = document.getElementById('dev-particles');
    if (devEl) devEl.textContent = activeCount;
    const lbl = document.getElementById('mm-tier-label');
    if (lbl) {
      const name = tierCurrent < 0.46 ? 'QUIET' : tierCurrent < 0.64 ? 'MEDIUM' : 'ACTIVE';
      lbl.textContent = `${name} · ${activeCount.toLocaleString()} pts`;
    }
  }

  // ================================================================
  //  PARTICLE REACTIONS
  //
  //  KEY PRINCIPLE: every force pushes OUTWARD from the particle's
  //  rest position (tp[i3..i3+2]). The spring (RESTORE) is the only
  //  homeward force. With no music, spring slowly pulls them back.
  //
  //  "Outward from rest position" means: the force direction is
  //  computed from the rest pos vector (not current pos), so the
  //  particle always flies away from where it should be, then
  //  drifts back when quiet.
  //
  //  ZONE MAP (based on normalized radius of rest position):
  //  CORE   nR < 0.16  — small bright core, strong bass reaction
  //  INNER  nR 0.10–0.45
  //  MID    nR 0.35–0.65
  //  OUTER  nR > 0.55  — the wide arms, melody + shimmer zone
  //  TOP    elev > 0.28
  //  BOT    elev < -0.28
  //  EQ     |elev| < 0.25
  // ================================================================
  function applyReactions() {
    const geo = window.__orbitalGeometry__;
    const tp  = window.__targetPositions__;
    const cnt = activeCount;
    if (!geo || !tp || cnt < 10) return;

    const pos = geo.attributes.position.array;
    if (!pos || pos.length < cnt * 3) return;

    if (!velArr || velArr.length < cnt * 3) {
      velArr = new Float32Array((window.__PARTICLE_PROFILES__?.FULL || cnt) * 3);
    }

    // ── SILENT FRAME — reform original shape ────────────────────
    // No music: blend tp from galaxy back to savedShape (original form).
    // KEY FIXES:
    //  - Use profiles.FULL (not activeCount) for ALL particle updates
    //  - Zero velocities on the very first silence frame so particles
    //    don't carry old outward momentum and jump to wrong positions
    //  - Stronger restore (3.5×) so shape reforms clearly and fully
    if (_silentFrame) {
      const ss  = savedShape;
      const gb  = galaxyBase;
      const fullN  = (window.__PARTICLE_PROFILES__?.FULL) || cnt;
      const blendN = Math.min(fullN, (tp.length/3)|0, ss ? ss.length/3|0 : cnt);

      if (ss && gb && galaxyMorphT > 0) {
        // Zero velocities on first silence frame — stops particles jumping
        if (!applyReactions._wasSilent && velArr) velArr.fill(0);
        applyReactions._wasSilent = true;

        // Retreat 0.004/frame = ~2.5s to fully reform shape
        galaxyMorphT = Math.max(0, galaxyMorphT - 0.004);
        const t  = galaxyMorphT * galaxyMorphT * (3 - 2 * galaxyMorphT);
        const t1 = 1 - t;
        for (let i = 0; i < blendN; i++) {
          const i3 = i * 3;
          tp[i3]   = ss[i3]   * t1 + gb[i3]   * t;
          tp[i3+1] = ss[i3+1] * t1 + gb[i3+1] * t;
          tp[i3+2] = ss[i3+2] * t1 + gb[i3+2] * t;
        }
      } else {
        applyReactions._wasSilent = false;
      }

      // Spring ALL particles toward current tp (now blending to original shape)
      const restoreS = RESTORE * 3.5;
      for (let i = 0; i < blendN; i++) {
        const i3 = i * 3;
        let vx=velArr[i3], vy=velArr[i3+1], vz=velArr[i3+2];
        vx -= (pos[i3]  -tp[i3])   * restoreS;
        vy -= (pos[i3+1]-tp[i3+1]) * restoreS;
        vz -= (pos[i3+2]-tp[i3+2]) * restoreS;
        vx *= DAMP; vy *= DAMP; vz *= DAMP;
        pos[i3]  +=vx; pos[i3+1]+=vy; pos[i3+2]+=vz;
        velArr[i3]=vx; velArr[i3+1]=vy; velArr[i3+2]=vz;
      }
      geo.attributes.position.needsUpdate = true;
      return;
    }
    // Music playing — clear silence flag
    applyReactions._wasSilent = false;
    // If morphT retreated during silence, re-advance toward galaxy spread.
    if (galaxyMorphT < 1 && savedShape && galaxyBase) {
      galaxyMorphT = Math.min(1, galaxyMorphT + 0.010);
      const t  = galaxyMorphT * galaxyMorphT * (3 - 2 * galaxyMorphT);
      const t1 = 1 - t;
      const fullN  = (window.__PARTICLE_PROFILES__?.FULL) || cnt;
      const blendN = Math.min(fullN, (tp.length/3)|0, savedShape.length/3|0);
      for (let i = 0; i < blendN; i++) {
        const i3 = i * 3;
        tp[i3]   = savedShape[i3]   * t1 + galaxyBase[i3]   * t;
        tp[i3+1] = savedShape[i3+1] * t1 + galaxyBase[i3+1] * t;
        tp[i3+2] = savedShape[i3+2] * t1 + galaxyBase[i3+2] * t;
      }
    }

    // Skip frames when energy is low — halves CPU cost during quiet sections
    if (!window._mmReactFrame) window._mmReactFrame = 0;
    window._mmReactFrame++;
    const _skipReact = Ntotal < 0.08 && (window._mmReactFrame % 2 !== 0);
    if (_skipReact) {
      geo.attributes.position.needsUpdate = true;
      return;
    }


    // ── FULL REACTION LOOP ────────────────────────────────────
    for (let i = 0; i < cnt; i++) {
      const i3 = i * 3;

      // REST position — where this particle belongs
      const bx=tp[i3], by=tp[i3+1], bz=tp[i3+2];
      // CURRENT position + velocity
      let px=pos[i3], py=pos[i3+1], pz=pos[i3+2];
      let vx=velArr[i3], vy=velArr[i3+1], vz=velArr[i3+2];

      // ── Spatial properties from REST position (inline sqrt) ──
      const r2   = bx*bx + by*by + bz*bz;
      const r    = r2 > 0.0001 ? Math.sqrt(r2) : 0.01;
      const rXZ2 = bx*bx + bz*bz;
      const rXZ  = rXZ2 > 0.0001 ? Math.sqrt(rXZ2) : 0.01;
      const invR   = 1.0 / r;
      const invRXZ = 1.0 / rXZ;

      // Normalize radius against galaxy spread (rMax=145)
      const nR   = Math.min(r / 145, 1.0);
      const elev = by * invR;
      const az   = Math.atan2(bz, bx);

      // ── GROUP PHASE — the key to synchronized movement ───────
      // Instead of a unique per-particle phase (i * constant) which
      // makes every particle go a different direction, we derive a
      // shared phase from the particle's POSITION in the galaxy.
      //
      // Arm sector: az snapped to the nearest of 4 arms (π/2 apart).
      // Particles in the same arm share the same armSector value,
      // so they all get the same sin() sign → same direction.
      //
      // Radial band: nR quantized into coarse shells (0.15 wide).
      // Particles in the same shell share the same radial phase.
      //
      // Result: whole arm sections pulse together, whole shells
      // swell together. Looks choreographed, not random.
      const armSector  = Math.round(az / (Math.PI * 0.5)) * (Math.PI * 0.5);
      const radialBand = Math.floor(nR / 0.15) * 0.15;
      // Tiny per-particle jitter (0.04 × i-based) so particles
      // in the same group aren't perfectly identical — just mostly
      // in sync. Keeps it organic while looking coordinated.
      const jitter     = (i % 64) * 0.0012;

      // Group phases per instrument — each instrument uses a different
      // combination of armSector / radialBand so groups don't all
      // collapse to the same phase across instruments.
      const gpBass   = phBass  + radialBand * 6.28 + jitter;
      const gpKick   = armSector + radialBand * 3.14;   // kick: per-arm groups
      const gpMel    = phMel   + armSector * 0.80  + jitter;
      const gpFlute  = phFlute + radialBand * 4.71  + jitter;
      const gpSitar  = phSitar + armSector  * 1.20  + radialBand * 2.0 + jitter;
      const gpShim   = phShim  + armSector  * 0.60  + jitter;
      const gpDayan  = phDayan + armSector  * 1.57  + jitter;
      const gpSnare  = armSector * 2.0 + radialBand * 3.14;
      const gpAmb    = phAmb   + armSector  * 0.40  + radialBand * 2.5 + jitter;

      // Zone weights (from rest position geometry)
      // Core zone matches coreR=12, which is nR ≈ 0.083
      const zCore  = nR < 0.09 ? (1.0 - nR * 11.1) : 0.0;
      const _ti    = nR < 0.22 ? nR*4.55 : Math.max(0, 1.0-(nR-0.22)*2.27);
      const zInner = Math.max(0, Math.min(1, _ti));
      const zMid   = Math.max(0, 1.0 - Math.abs(nR - 0.50) * 4.2);
      const zOuter = nR > 0.55 ? Math.min(1, (nR-0.55)*2.22) : 0.0;
      const zTop   = elev >  0.28 ? Math.min(1,(elev-0.28)*3.5) : 0.0;
      const zBot   = elev < -0.28 ? Math.min(1,(-elev-0.28)*3.5) : 0.0;
      const zEq    = Math.max(0, 1.0 - Math.abs(elev) * 4.5);

      // Outward direction from rest position
      const outX = bx * invR;
      const outY = by * invR;
      const outZ = bz * invR;

      let fx=0, fy=0, fz=0;

      // ── AMBIENT BREATH ───────────────────────────────────────
      // Each arm breathes together — in sync per arm sector.
      if (_fAmb > 0.018) {
        const br = Math.sin(gpAmb) * _fAmb * 3.5;
        fx += outX * br * 0.10;
        fy += outY * br * 0.10;
        fz += outZ * br * 0.10;
        if (zOuter > 0.1) {
          const dr = Math.sin(gpAmb * 0.55) * _fAmb * 2.2;
          fx += (-bz*invRXZ)*dr*0.06;
          fz += ( bx*invRXZ)*dr*0.06;
        }
      }

      // ── KICK / BAYAN / TAIKO — SYNCHRONIZED OUTWARD BURST ───
      // All particles in the same arm sector burst together.
      // No random sign flipping — whole arms pulse as one unit.
      if (_fKick > 0.004) {
        const k2    = _fKick * _fKick;
        // gpKick is shared per arm — same sign for whole arm
        const pulse = Math.abs(Math.sin(gpKick)) * 0.6 + 0.4; // always 0.4→1.0
        const burst = (zCore*k2*9.0 + zInner*k2*4.0 + zMid*k2*1.5 + zOuter*k2*0.4) * pulse;
        fx += outX * burst;
        fy += outY * burst;
        fz += outZ * burst;
        fy -= zBot * k2 * 3.0;
      }

      // ── DHOL / DHOLAK — SYNCHRONIZED EQUATORIAL FAN-OUT ─────
      // Equatorial particles in the same arm fan outward together.
      if (_fDhol > 0.004) {
        const d2    = _fDhol * _fDhol;
        // All equatorial particles in the same arm share gpKick phase
        const pulse = Math.abs(Math.sin(gpKick)) * 0.5 + 0.5;
        const eq    = zEq * d2 * 4.5 * pulse;
        fx += bx*invRXZ * eq;
        fz += bz*invRXZ * eq;
        fx += outX * zMid * d2 * 2.5 * pulse;
        fz += outZ * zMid * d2 * 2.5 * pulse;
        fy -= zBot * zCore * d2 * 2.0;
      }

      // ── DAYAN / TABLA — SYNCHRONIZED ARM ROTATION ───────────
      // Each arm rotates as a unit — all particles in an arm spin
      // together in the same direction at the same moment.
      if (_fDayan > 0.003) {
        // gpDayan is per-arm — whole arm gets same twist sign
        const twist = zMid * _fDayan * Math.sin(gpDayan) * 3.0;
        fx += (-bz*invRXZ)*twist*0.60;
        fz += ( bx*invRXZ)*twist*0.60;
        // Outward scatter also per-arm
        const sc = zMid * _fDayan*_fDayan * (1.5 + Math.sin(gpDayan*0.5)*0.5);
        fx += outX*sc*0.45; fz += outZ*sc*0.45;
      }

      // ── SNARE / CLAP / THALI — SYNCHRONIZED RING BURST ──────
      // The ring expands outward uniformly — all particles at the
      // same radius move the same direction at the same moment.
      if (_fSnare > 0.004) {
        const midH = Math.max(0, 1.0 - Math.abs(elev)*2.6);
        const c2   = _fSnare * _fSnare;
        // gpSnare is shared per radial band → same-shell = same push
        const pulse = Math.abs(Math.sin(gpSnare)) * 0.5 + 0.5;
        fx += bx*invRXZ * c2*midH * 6.0 * pulse;
        fz += bz*invRXZ * c2*midH * 6.0 * pulse;
        // Rotational whip — all outer particles in arm spin same way
        const whip = c2*zOuter*Math.sin(gpDayan)*2.2;
        fx += (-bz*invRXZ)*whip; fz += (bx*invRXZ)*whip;
      }

      // ── BASS SUSTAIN — SYNCHRONIZED RADIAL SWELL ────────────
      // Each radial band (shell) swells and contracts together.
      // Particles at the same radius move as one — like a breathing
      // shell, not a cloud of random jitter.
      if (_fBass > 0.001) {
        // gpBass is per radial band — same shell, same phase
        const coreSw = Math.sin(gpBass) * _fBass * zCore * 5.0;
        fx += outX*coreSw; fy += outY*coreSw; fz += outZ*coreSw;
        const innSw  = Math.sin(gpBass * 0.85) * _fBass * zInner * 3.0;
        fx += outX*innSw; fy += outY*innSw*0.28; fz += outZ*innSw;
        const tide   = Math.sin(gpBass * 0.65) * _fBass * zOuter * 1.8;
        fx += outX*tide; fz += outZ*tide;
      }

      // ── MELODY — SYNCHRONIZED ORBITAL SWEEP ─────────────────
      // Each arm orbits as a unit. All particles in the same arm
      // sweep clockwise together — looks like a galaxy arm rotating.
      if (_fMel > 0.001) {
        if (zOuter > 0.05) {
          // gpMel is per-arm — whole arm sweeps together
          const sp = Math.sin(gpMel) * zOuter * _fMel * 3.2;
          fx += (-bz*invRXZ)*sp;
          fz += ( bx*invRXZ)*sp;
          fy += Math.sin(gpMel*0.55) * zOuter * _fMel * 1.4;
        }
        // Mid billow — per radial band, not random per particle
        const mb = Math.sin(gpMel * 0.70) * _fMel;
        const ma = (0.12+nR*0.60) * _fMel * 2.0 * mb;
        fx += outX*ma*0.32; fy += outY*ma*0.22; fz += outZ*ma*0.32;
      }

      // ── FLUTE / BANSURI — SYNCHRONIZED VERTICAL WAVE ────────
      // Each radial shell lifts and falls together — a clean wave
      // travels outward from the center, shell by shell.
      if (_fFlute > 0.001) {
        // gpFlute is per radial band → wave front is a ring, not noise
        const wave = Math.sin(gpFlute) * _fFlute;
        fy += wave * 3.2;
        const billow = Math.abs(wave) * _fFlute * 0.70;
        fx += outX*billow; fz += outZ*billow;
      }

      // ── SITAR / GUITAR — SYNCHRONIZED DIAGONAL RIPPLE ────────
      // Ripple travels along each arm as a unit. Particles in the
      // same arm at the same radius move as one traveling wave.
      if (_fSitar > 0.001) {
        // gpSitar mixes arm + radius so the ripple travels along the arm
        const rp = Math.sin(gpSitar) * _fSitar;
        const rA = 1.8 * (0.18 + zMid*0.82);
        fx += (outX*0.55+(-bz*invRXZ)*0.45)*rp*rA;
        fy +=  outY*rp*rA*0.44;
        fz += (outZ*0.55+( bx*invRXZ)*0.45)*rp*rA;
      }

      // ── SHIMMER — SYNCHRONIZED ARM-TIP SPARKLE ───────────────
      // Top particles in the same arm sparkle together (same phase).
      // Looks like the arm tip flares, not random star noise.
      if (_fShim > 0.001) {
        if (zTop > 0) {
          // gpShim is per arm — whole arm-top flares together
          const sa = _fShim * zTop * 2.5;
          fx += Math.sin(gpShim)*sa;
          fy += Math.cos(gpShim*0.52)*sa*0.30;
          fz += Math.sin(gpShim*1.35+1.1)*sa;
        }
        if (zOuter > 0 && nVal[KI.air] > 0.04) {
          const aa = nVal[KI.air]*zOuter*(zTop*0.45+0.30)*2.0;
          fx += Math.sin(gpShim*0.80)*aa;
          fz += Math.cos(gpShim*0.75)*aa;
        }
      }

      // ── DROP — FULL SYNCHRONIZED OUTWARD BURST ───────────────
      // All particles burst outward uniformly — no phase variation,
      // the whole galaxy expands as one on a drop.
      if (_fDrop > 0.01) {
        const df = _fDrop*(1.4-nR*0.40)*7.0;
        fx += outX*df; fy += outY*df; fz += outZ*df;
      }

      // ── INTEGRATE ─────────────────────────────────────────────
      vx += fx; vy += fy; vz += fz;
      // Spring toward REST position — gentle pull home
      vx -= (px-bx)*RESTORE;
      vy -= (py-by)*RESTORE;
      vz -= (pz-bz)*RESTORE;
      // Damping
      vx *= DAMP; vy *= DAMP; vz *= DAMP;
      // Velocity cap (branch = faster than Math.min/max in hot loop)
      if (vx> MAX_V)vx= MAX_V;else if(vx<-MAX_V)vx=-MAX_V;
      if (vy> MAX_V)vy= MAX_V;else if(vy<-MAX_V)vy=-MAX_V;
      if (vz> MAX_V)vz= MAX_V;else if(vz<-MAX_V)vz=-MAX_V;

      px+=vx; py+=vy; pz+=vz;

      // ── DISPLACEMENT CAP — squared check before sqrt ──────────
      const dx=px-bx, dy=py-by, dz=pz-bz;
      const d2=dx*dx+dy*dy+dz*dz;
      if (d2 > MAX_D*MAX_D) {
        const d=Math.sqrt(d2), sc=MAX_D/d;
        px=bx+dx*sc; py=by+dy*sc; pz=bz+dz*sc;
        // Kill only the outward velocity component
        const dxN=dx/d,dyN=dy/d,dzN=dz/d;
        const vd=vx*dxN+vy*dyN+vz*dzN;
        if(vd>0){vx-=dxN*vd*0.8;vy-=dyN*vd*0.8;vz-=dzN*vd*0.8;}
      }

      velArr[i3]=vx; velArr[i3+1]=vy; velArr[i3+2]=vz;
      pos[i3]=px;   pos[i3+1]=py;   pos[i3+2]=pz;
    }

    geo.attributes.position.needsUpdate = true;
  }

  // ── GLOW ──────────────────────────────────────────────────────
  function applyGlow() {
    const mat = window.__orbitalMaterial__;
    if (!mat || !window.THREE) return;

    glKick += (Math.max(E.kick,E.dhol)*3.2 - glKick)*0.20;
    glBass += (E.bass*1.5               - glBass)*0.06;
    glMel  += (E.melody*1.2             - glMel) *0.06;
    glShim += (E.shimmer*1.8            - glShim)*0.08;
    glDrop += (E.drop*4.5               - glDrop)*0.12;

    const tg = 1.0+glKick*1.3+glBass*0.55+glMel*0.38+glShim*0.60
             + E.snare*0.90+E.dayan*0.65+glDrop*2.0+ambAmp*0.22;
    mat.uniforms.uGlowBoost.value = Math.min(4.8, tg);

    if (mat.uniforms.uSize) {
      if (!window.__baseMusicSize__) window.__baseMusicSize__ = mat.uniforms.uSize.value;
      const bs = window.__baseMusicSize__;
      mat.uniforms.uSize.value = bs*(1+glKick*0.40+glDrop*0.75+E.snare*0.25+E.dayan*0.22+ambAmp*0.08);
    }

    if (!mat.__musicColorBase) {
      mat.__musicColorBase     = mat.uniforms.uMidColor.value.clone();
      mat.__musicHighlightBase = mat.uniforms.uHighlightColor.value.clone();
      cHue=0; cSat=0; cLit=0;
    }

    // ── COLOUR SYSTEM ────────────────────────────────────────────────
    // Color ONLY shifts on beat or bass events (not continuously).
    // On each hit we pick a vivid target hue and snap toward it
    // with a moderate lerp. Between beats the colour holds.
    //
    // Hue palette (full 0–1 range for maximum colour variety):
    //   Kick/dhol hit   → warm red-orange       hue ~ 0.04
    //   Bass swell      → deep electric blue     hue ~ 0.62
    //   Dayan/tabla     → amber-gold             hue ~ 0.12
    //   Snare crack     → hot magenta-pink       hue ~ 0.88
    //   Melody          → lush green-teal        hue ~ 0.45
    //   Shimmer/air     → cool cyan              hue ~ 0.55
    //   Drop            → violet-purple          hue ~ 0.78
    //
    // Saturation is pushed HIGH (0.6–1.0) so the shift is vivid.
    // Lightness boost on hits makes particles flash bright.

    const beatHit = E.kickFire || E.dholFire || E.taikoFire || E.snareFire || E.dayanFire;
    const bassHit = E.bass > 0.18;  // low threshold — catches soft bass too

    if (beatHit || bassHit) {
      // Pick dominant instrument this frame
      const wKick  = Math.max(E.kick, E.dhol, E.taiko) * 2.0;
      const wBass  = E.bass  * 1.6;
      const wDayan = E.dayan * 1.5;
      const wSnare = E.snare * 1.8;
      const wMel   = E.melody * 1.2;
      const wShim  = E.shimmer * 1.0;
      const wDrop  = E.drop * 2.5;
      const wTot   = wKick + wBass + wDayan + wSnare + wMel + wShim + wDrop + 0.001;

      // Weighted hue target
      const targetHue =
        (wKick*0.04 + wBass*0.62 + wDayan*0.12 + wSnare*0.88 +
         wMel*0.45  + wShim*0.55 + wDrop*0.78) / wTot;

      // Snap speed: fast on hard beat, moderate on bass
      const hueSpeed = beatHit ? 0.18 : 0.08;
      cHue += (targetHue - cHue) * hueSpeed;

      // Saturation: push high so colour is vivid, not washed out
      const targetSat = Math.min(0.85,
        wKick*0.80 + wBass*0.55 + wDayan*0.60 +
        wSnare*0.75 + wShim*0.65 + wDrop*0.90);
      cSat += (targetSat - cSat) * 0.22;

      // Lightness: flash bright on hard hits
      const targetLit = Math.min(0.45,
        Math.max(E.kick,E.dhol)*0.40 + E.snare*0.30 +
        E.dayan*0.20 + E.drop*0.45 + ambAmp*0.10);
      cLit += (targetLit - cLit) * 0.22;
    }

    // Decay back to neutral when quiet — moderate speed so colour lingers
    cSat *= 0.985;
    cLit *= 0.980;

    // Apply — use full hue range (multiply by 1.0, not 0.44)
    // and fast lerp (0.08) so colour change is actually visible
    const nm = mat.__musicColorBase.clone().offsetHSL(cHue, cSat, cLit);
    const nh = mat.__musicHighlightBase.clone().offsetHSL(cHue * 0.65, cSat * 0.60, cLit * 2.0);
    mat.uniforms.uMidColor.value.lerp(nm, 0.08);
    mat.uniforms.uHighlightColor.value.lerp(nh, 0.08);
    // Mark uniforms dirty so Three.js re-uploads them
    if (mat.uniforms.uMidColor.value.needsUpdate !== undefined)
      mat.uniforms.uMidColor.value.needsUpdate = true;
  }

  window.musicModeOnShapeSwitch = function () {
    const cnt = activeCount || (window.__PARTICLE_PROFILES__?.FULL || 20000);
    galaxyBase = buildGalaxyBase(cnt);
    const tp = window.__targetPositions__;
    if (tp) savedShape = tp.slice(0, cnt * 3);
    galaxyMorphT=0; galaxyMorphDir=1;
    const mat = window.__orbitalMaterial__;
    if (mat){mat.__musicColorBase=null;mat.__musicHighlightBase=null;}
    window.__baseMusicSize__=null;
    if (velArr) velArr.fill(0);
  };

  // ── RAF PATCH ─────────────────────────────────────────────────
  let _patched=false, _postWork=null;
  function patchRAF() {
    if (_patched) return; _patched=true;
    const _orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = cb =>
      _orig(ts => { cb(ts); if(_postWork)_postWork(); });
  }

  function tick() {
    if (!active) return;
    rafId = requestAnimationFrame(tick);
    // Only analyse every other frame when signal is very low — saves FFT overhead
    if (!tick._frame) tick._frame = 0;
    tick._frame++;
    if (Ntotal < 0.03 && tick._frame % 2 !== 0) {
      // still run postwork so particles don't freeze
    } else {
      analyse();
    }
    const now = performance.now();
    updateTier(now);
    preCompute();
    syncDevCount();
    _postWork = () => { advanceGalaxyMorph(); applyReactions(); applyGlow(); };
    if (panel && panel.classList.contains('mm-open')) { drawSpec(); updateUI(); }
  }

  // ── START ─────────────────────────────────────────────────────
  async function start() {
    if (active) return;
    const ok = await captureAudio(); if (!ok) return;

    for (let i=0;i<KLEN;i++){pkV[i]=0.002;fast[i]=0.001;slow[i]=0.001;}
    if (velArr) velArr.fill(0);
    scatter=0; tierCurrent=TIER.MEDIUM; tierTarget=TIER.MEDIUM; lastTierMs=0;

    const profiles = window.__PARTICLE_PROFILES__;
    const geo      = window.__orbitalGeometry__;
    const tp       = window.__targetPositions__;
    if (profiles && geo && tp) {
      activeCount = Math.floor(profiles.FULL * TIER.MEDIUM);
      window.__effectiveParticleCount__ = activeCount;
      geo.setDrawRange(0, activeCount);
      savedShape     = tp.slice(0, profiles.FULL * 3);
      galaxyBase     = buildGalaxyBase(profiles.FULL);
      galaxyMorphT   = 0;
      galaxyMorphDir = 1;
      const devEl = document.getElementById('dev-particles');
      if (devEl) devEl.textContent = activeCount;
    }

    patchRAF();
    active=true; window.musicModeActive=true;
    document.body.classList.add('music-mode-active');
    lastMorphT=performance.now();
    if (window.devModeActive) showPanel();
    tick();
    window.addChatMessage?.('orbital','Music mode on — the universe is listening.');
  }

  // ── STOP ──────────────────────────────────────────────────────
  function stop() {
    if (!active) return;
    active=false; window.musicModeActive=false;
    cancelAnimationFrame(rafId); disconnectSrc();
    _postWork=null;

    Object.keys(E).forEach(k=>{if(typeof E[k]==='number')E[k]=0;});
    E.kickFire=false;E.dholFire=false;E.dayanFire=false;E.snareFire=false;E.taikoFire=false;
    glKick=0;glBass=0;glMel=0;glShim=0;glDrop=0;
    ambAmp=0;scatter=0;silenceN=0;dropArmed=false;
    for(let i=0;i<KLEN;i++){pkV[i]=0.002;fast[i]=0.001;slow[i]=0.001;}
    if (velArr) velArr.fill(0);
    window.__baseMusicSize__=null;

    // Restore original shape — write savedShape into BOTH tp and pos
    // Use profiles.FULL (not activeCount) so ALL particles are restored,
    // not just the tiered subset. This prevents half-galaxy, half-shape.
    const tp  = window.__targetPositions__;
    const geo = window.__orbitalGeometry__;
    const profiles2 = window.__PARTICLE_PROFILES__;
    if (tp && geo && savedShape) {
      const fullCnt = profiles2 ? profiles2.FULL : (savedShape.length / 3 | 0);
      const cnt = Math.min(fullCnt, savedShape.length/3|0, tp.length/3|0);
      // Step 1: immediately write savedShape into tp so the target is correct
      for (let i=0;i<cnt;i++){
        const i3=i*3;
        tp[i3]=savedShape[i3]; tp[i3+1]=savedShape[i3+1]; tp[i3+2]=savedShape[i3+2];
      }
      // Step 2: smoothly spring pos toward tp over ~60 frames
      let settle=0;
      const SETTLE_FRAMES=65;
      const pos0=new Float32Array(geo.attributes.position.array.slice(0, cnt*3));
      function settleTick() {
        if (settle>=SETTLE_FRAMES) {
          // Hard-set final positions to be exact
          const pa=geo.attributes.position.array;
          for(let i=0;i<cnt;i++){
            const i3=i*3;
            pa[i3]=savedShape[i3]; pa[i3+1]=savedShape[i3+1]; pa[i3+2]=savedShape[i3+2];
          }
          geo.attributes.position.needsUpdate=true;
          return;
        }
        const t=settle/SETTLE_FRAMES;
        const ease=t*t*(3-2*t); // smoothstep
        const pa=geo.attributes.position.array;
        for(let i=0;i<cnt;i++){
          const i3=i*3;
          pa[i3]  =pos0[i3]  +(savedShape[i3]  -pos0[i3]  )*ease;
          pa[i3+1]=pos0[i3+1]+(savedShape[i3+1]-pos0[i3+1])*ease;
          pa[i3+2]=pos0[i3+2]+(savedShape[i3+2]-pos0[i3+2])*ease;
        }
        geo.attributes.position.needsUpdate=true;
        settle++;
        requestAnimationFrame(settleTick);
      }
      requestAnimationFrame(settleTick);
    }

    // Restore full particle count
    const profiles = window.__PARTICLE_PROFILES__;
    if (profiles && geo) {
      activeCount=profiles.FULL;
      window.__effectiveParticleCount__=profiles.FULL;
      geo.setDrawRange(0, profiles.FULL);
      const devEl=document.getElementById('dev-particles');
      if(devEl)devEl.textContent=profiles.FULL;
    }

    const mat=window.__orbitalMaterial__;
    if(mat){
      mat.uniforms.uGlowBoost.value=1.0;
      mat.__musicColorBase=null;mat.__musicHighlightBase=null;
    }
    window.__musicEnergy__={bass:0,mid:0,high:0,total:0,beat:false,beatPulse:0};
    hidePanel();
    document.body.classList.remove('music-mode-active');
    window.addChatMessage?.('orbital','Music mode off.');
  }

  function toggle(){active?stop():start();}

  function handleVoice(t){
    t=t.toLowerCase().replace(/[^\w\s]/g,'');
    if(/music mode|start music|enable music|turn on music|music on/.test(t))            {if(!active)start();return true;}
    if(/exit music|stop music|disable music|turn off music|music off|end music/.test(t)){if(active)stop(); return true;}
    if(/toggle music|music toggle/.test(t)){toggle();return true;}
    return false;
  }

  window.musicMode={start,stop,toggle,isActive:()=>active,getEnergy:()=>window.__musicEnergy__,handleVoice};

  // ================================================================
  //  DEV PANEL
  // ================================================================
  function buildPanel(){
    if(panel)return;
    panel=document.createElement('div');panel.id='mmPanel';
    panel.innerHTML=`
      <div class="mmp-title">MUSIC REACTOR v15</div>
      <canvas id="mmSpec" width="196" height="52"></canvas>
      <div class="mmp-tier-row">
        <div class="mmp-tier-bar"><div class="mmp-tier-fill" id="mm-tier-fill"></div></div>
        <div class="mmp-tier-lbl" id="mm-tier-label">MEDIUM · 0 pts</div>
      </div>
      <div class="mmp-grid">
        <div class="mmp-zone" style="--zc:#ff3300"><div class="mmp-zb"><div class="mmp-zf" id="mz-kick"></div></div><span>KICK</span></div>
        <div class="mmp-zone" style="--zc:#ff7700"><div class="mmp-zb"><div class="mmp-zf" id="mz-dhol"></div></div><span>DHOL</span></div>
        <div class="mmp-zone" style="--zc:#ffcc00"><div class="mmp-zb"><div class="mmp-zf" id="mz-dayan"></div></div><span>DAYAN</span></div>
        <div class="mmp-zone" style="--zc:#ff88cc"><div class="mmp-zb"><div class="mmp-zf" id="mz-snare"></div></div><span>SNARE</span></div>
        <div class="mmp-zone" style="--zc:#4488ff"><div class="mmp-zb"><div class="mmp-zf" id="mz-bass"></div></div><span>BASS</span></div>
        <div class="mmp-zone" style="--zc:#aa66ff"><div class="mmp-zb"><div class="mmp-zf" id="mz-melody"></div></div><span>MELO</span></div>
        <div class="mmp-zone" style="--zc:#88ffdd"><div class="mmp-zb"><div class="mmp-zf" id="mz-flute"></div></div><span>FLUTE</span></div>
        <div class="mmp-zone" style="--zc:#ffaa44"><div class="mmp-zb"><div class="mmp-zf" id="mz-sitar"></div></div><span>SITAR</span></div>
        <div class="mmp-zone" style="--zc:#00ffcc"><div class="mmp-zb"><div class="mmp-zf" id="mz-shimmer"></div></div><span>SHIM</span></div>
        <div class="mmp-zone" style="--zc:#ffffff"><div class="mmp-zb"><div class="mmp-zf" id="mz-energy"></div></div><span>ENRG</span></div>
      </div>
      <div class="mmp-droprow">
        <div class="mmp-droparm" id="mmp-arm">ARMED</div>
        <div class="mmp-dropmeter"><div id="mmp-df"></div></div>
        <div class="mmp-droparm" id="mmp-fire">DROP!</div>
      </div>
      <div class="mmp-glows">
        <div class="mmp-gd" id="mg-k" style="--gc:255,60,0"></div>
        <div class="mmp-gd" id="mg-b" style="--gc:60,140,255"></div>
        <div class="mmp-gd" id="mg-g" style="--gc:160,90,255"></div>
        <div class="mmp-gd" id="mg-c" style="--gc:0,220,180"></div>
        <div class="mmp-gd" id="mg-s" style="--gc:255,170,60"></div>
        <div class="mmp-gd" id="mg-d" style="--gc:155,77,255"></div>
      </div>`;

    if(!document.getElementById('mmPS')){
      const s=document.createElement('style');s.id='mmPS';
      s.textContent=`
        #mmPanel{position:fixed;top:12px;left:calc(290px + clamp(300px,35vw,440px) + 16px);
          width:218px;padding:11px;border-radius:16px;z-index:999;
          background:rgba(4,2,12,.74);backdrop-filter:blur(28px) saturate(170%);
          -webkit-backdrop-filter:blur(28px) saturate(170%);
          border:1px solid rgba(255,255,255,.07);
          box-shadow:0 0 0 1px rgba(155,77,255,.18),0 10px 44px rgba(0,0,0,.82);
          display:none;flex-direction:column;gap:7px;opacity:0;transform:translateX(-10px);
          transition:opacity .3s,transform .3s;font-family:monospace;}
        #mmPanel.mm-open{opacity:1;transform:translateX(0);}
        .mmp-title{font-size:.38rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.20);text-align:center;}
        #mmSpec{border-radius:6px;background:rgba(255,255,255,.025);display:block;width:100%;height:auto;}
        .mmp-tier-row{display:flex;flex-direction:column;gap:3px;}
        .mmp-tier-bar{width:100%;height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;}
        .mmp-tier-fill{height:100%;width:55%;background:linear-gradient(90deg,#9b4dff,#ff3cac);border-radius:2px;transition:width .7s ease;}
        .mmp-tier-lbl{font-size:.31rem;letter-spacing:.13em;color:rgba(155,77,255,.75);text-transform:uppercase;text-align:right;}
        .mmp-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;}
        .mmp-zone{display:flex;flex-direction:column;align-items:center;gap:2px;}
        .mmp-zone span{font-size:.24rem;color:rgba(255,255,255,.20);text-transform:uppercase;}
        .mmp-zb{width:100%;height:28px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden;display:flex;align-items:flex-end;}
        .mmp-zf{width:100%;height:0%;background:var(--zc);border-radius:3px 3px 0 0;box-shadow:0 0 5px var(--zc);transition:height .04s;}
        .mmp-droprow{display:flex;align-items:center;gap:5px;}
        .mmp-droparm{font-size:.32rem;letter-spacing:.08em;color:rgba(255,255,255,.14);padding:2px 5px;border-radius:4px;border:1px solid rgba(255,255,255,.06);}
        .mmp-droparm.on{color:#fff;background:rgba(155,77,255,.38);box-shadow:0 0 10px rgba(155,77,255,.65);}
        .mmp-dropmeter{flex:1;height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;}
        #mmp-df{height:100%;width:0%;background:linear-gradient(90deg,#9b4dff,#ff3cac);border-radius:2px;transition:width .05s;}
        .mmp-glows{display:flex;gap:4px;justify-content:center;}
        .mmp-gd{width:9px;height:9px;border-radius:50%;background:rgba(var(--gc),.12);transition:background .07s,box-shadow .07s;}`;
      document.head.appendChild(s);
    }
    document.body.appendChild(panel);
    pCanvas=document.getElementById('mmSpec');
    pCtx=pCanvas.getContext('2d');
  }

  function showPanel(){if(!panel)buildPanel();panel.style.display='flex';requestAnimationFrame(()=>panel.classList.add('mm-open'));}
  function hidePanel(){if(!panel)return;panel.classList.remove('mm-open');setTimeout(()=>{if(panel)panel.style.display='none';},320);}
  window.musicModeDevSync=on=>{if(on&&active)showPanel();else hidePanel();};

  function drawSpec(){
    if(!pCtx||!analyser)return;
    const w=pCanvas.width,h=pCanvas.height,bars=42;
    analyser.getByteFrequencyData(dataArray);
    pCtx.clearRect(0,0,w,h);
    for(let i=0;i<bars;i++){
      const bin=Math.floor((i/bars)*(dataArray.length*0.44));
      const v=dataArray[bin]/255,pct=i/bars;
      const hue=pct<0.18?14:pct<0.36?38:pct<0.55?215:pct<0.72?270:168;
      pCtx.fillStyle=`hsla(${hue},80%,${36+v*48}%,${.16+v*.84})`;
      const x=(i/bars)*w,bw=(w/bars)*.72,bh=v*h*.90;
      pCtx.beginPath();
      if(pCtx.roundRect)pCtx.roundRect(x,h-bh,bw,bh,[2,2,0,0]);else pCtx.rect(x,h-bh,bw,bh);
      pCtx.fill();
    }
  }

  function sH(id,v){const el=document.getElementById(id);if(el)el.style.height=Math.min(100,v*100).toFixed(1)+'%';}
  function sG(id,v){
    const el=document.getElementById(id);if(!el)return;
    const a=Math.min(1,v);
    el.style.background=`rgba(var(--gc),${.10+a*.90})`;
    el.style.boxShadow=a>.07?`0 0 ${5+a*14}px rgba(var(--gc),${a*.78})`:'none';
  }

  function updateUI(){
    sH('mz-kick',E.kick);sH('mz-dhol',E.dhol);sH('mz-dayan',E.dayan);sH('mz-snare',E.snare);
    sH('mz-bass',E.bass);sH('mz-melody',E.melody);sH('mz-flute',E.flute);
    sH('mz-sitar',E.sitar);sH('mz-shimmer',E.shimmer);sH('mz-energy',E.energy);
    const df=document.getElementById('mmp-df');if(df)df.style.width=(E.drop*100).toFixed(1)+'%';
    document.getElementById('mmp-arm')?.classList.toggle('on',dropArmed);
    document.getElementById('mmp-fire')?.classList.toggle('on',E.drop>0.10);
    sG('mg-k',glKick);sG('mg-b',glBass);sG('mg-g',glMel);
    sG('mg-c',glShim);sG('mg-s',E.sitar+E.flute);sG('mg-d',glDrop);
    const fill=document.getElementById('mm-tier-fill');
    if(fill)fill.style.width=(tierCurrent*100).toFixed(1)+'%';
  }

  console.log('[MusicMode v15] Outward spread · gentle spring home · light bass · wide galaxy · dev synced');
})();
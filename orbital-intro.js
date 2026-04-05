/**
 * orbital-intro.js
 * Minimal 3D intro — Three.js required (already loaded in index.html)
 * Tagline: "The universe responds to you."
 * Duration: ~3s build-up → shatter outward → calls onComplete()
 */

(function () {

  // Safety: if Three.js hasn't loaded yet, wait for it
  if (typeof THREE === "undefined") {
    window.addEventListener("load", () => {
      if (typeof THREE !== "undefined") init();
    });
    return;
  }

  init();

  function init() {

  const TAGLINE = "The universe responds to you.";
  
  const SHATTER_AT = 3000;
const TOTAL_DURATION = 4400;

  /* ─── Create DOM container ─── */
  const container = document.getElementById("loader");
  container.style.cssText = `
    position:fixed;inset:0;background:#000;
    display:grid;place-items:center;
    z-index:10;overflow:hidden;
  `;

  /* ─── Three.js scene ─── */
  const W = window.innerWidth, H = window.innerHeight;
  const renderer2 = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer2.setSize(W, H);
  renderer2.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer2.domElement.style.cssText = "position:absolute;inset:0;";
  container.appendChild(renderer2.domElement);

  const scene2 = new THREE.Scene();
  const camera2 = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
  camera2.position.z = 5;

  /* ─── Ambient fog ─── */
  scene2.fog = new THREE.FogExp2(0x000000, 0.045);

  /* ─── Central glowing orb ─── */
  const orbGeo = new THREE.SphereGeometry(0.55, 64, 64);
  const orbMat = new THREE.MeshBasicMaterial({ color: 0x9b4dff });
  const orb = new THREE.Mesh(orbGeo, orbMat);
  scene2.add(orb);

  /* ─── Outer glow ring (additive torus) ─── */
  const ringGeo = new THREE.TorusGeometry(0.85, 0.018, 16, 120);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.55 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  scene2.add(ring);

  const ring2Geo = new THREE.TorusGeometry(1.18, 0.010, 12, 120);
  const ring2Mat = new THREE.MeshBasicMaterial({ color: 0x7c3aed, transparent: true, opacity: 0.30 });
  const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
  ring2.rotation.x = Math.PI * 0.28;
  scene2.add(ring2);

  /* ─── Floating particles ─── */
  const PARTICLE_COUNT = 1800;
  const pPositions = new Float32Array(PARTICLE_COUNT * 3);
  const pVelocities = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const r = 1.6 + Math.random() * 3.2;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    pPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pPositions[i * 3 + 2] = r * Math.cos(phi);
    pVelocities.push({
      r, theta, phi,
      speed: 0.003 + Math.random() * 0.006,
      drift: (Math.random() - 0.5) * 0.001
    });
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPositions, 3));
  const pMat = new THREE.PointsMaterial({
    color: 0xb78bff,
    size: 0.022,
    transparent: true,
    opacity: 0.0,
    sizeAttenuation: true
  });
  const particles = new THREE.Points(pGeo, pMat);
  scene2.add(particles);

  /* ─── Shatter shards (hidden until shatter) ─── */
  const SHARD_COUNT = 260;
  const shards = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const size = 0.04 + Math.random() * 0.14;
    const geo = new THREE.TetrahedronGeometry(size, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(0.72 + Math.random() * 0.12, 0.9, 0.55 + Math.random() * 0.3),
      transparent: true,
      opacity: 0
    });
    const mesh = new THREE.Mesh(geo, mat);
    // start at orb center
    mesh.position.set(
      (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 0.4
    );
    const dir = mesh.position.clone().normalize();
    if (dir.length() === 0) dir.set(0, 1, 0);
    mesh.userData.vel = dir.multiplyScalar(0.08 + Math.random() * 0.18);
    mesh.userData.rot = new THREE.Vector3(
      (Math.random() - 0.5) * 0.18,
      (Math.random() - 0.5) * 0.18,
      (Math.random() - 0.5) * 0.18
    );
    mesh.visible = false;
    scene2.add(mesh);
    shards.push(mesh);
  }

  /* ─── Tagline DOM overlay ─── */
  const tagEl = document.createElement("div");
  tagEl.textContent = TAGLINE;
  tagEl.style.cssText = `
    position:absolute;
    bottom:18%;
    left:50%;
    transform:translateX(-50%);
    font-family:'Cormorant Garamond',Georgia,serif;
    font-size:clamp(1rem,2.2vw,1.5rem);
    font-weight:300;
    letter-spacing:0.38em;
    text-transform:uppercase;
    color:rgba(210,190,255,0.0);
    white-space:nowrap;
    transition:color 1.4s ease, letter-spacing 1.8s ease, opacity 0.8s ease;
    pointer-events:none;
    z-index:2;
  `;
  container.appendChild(tagEl);

  /* Google Font */
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400&display=swap";
  document.head.appendChild(fontLink);

  /* ─── State ─── */
  let phase = "build"; // build → shatter → done
  let startTime = performance.now();
  let shatterStartTime = 0;
  let raf2;

  /* ─── Animate ─── */
  function tick() {
    raf2 = requestAnimationFrame(tick);
    const now = performance.now();
    const elapsed = now - startTime;
    const t = elapsed / 1000;

    if (phase === "build") {

      // Orb breathes in
      const breathe = 1 + 0.06 * Math.sin(t * 2.2);
      orb.scale.setScalar(breathe);

      // Orb color pulses: deep purple → bright violet
      const pulse = (Math.sin(t * 1.8) + 1) / 2;
      orbMat.color.setHSL(0.74, 0.85, 0.28 + pulse * 0.18);

      // Rings rotate
      ring.rotation.z = t * 0.35;
      ring.rotation.x = Math.sin(t * 0.4) * 0.3;
      ring2.rotation.z = -t * 0.22;
      ring2.rotation.y = t * 0.18;

      // Camera slow drift
      camera2.position.x = Math.sin(t * 0.18) * 0.25;
      camera2.position.y = Math.cos(t * 0.14) * 0.15;
      camera2.lookAt(0, 0, 0);

      // Particles orbit + fade in
      const fadeIn = Math.min(1, elapsed / 1200);
      pMat.opacity = fadeIn * 0.72;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const v = pVelocities[i];
        v.theta += v.speed;
        v.phi   += v.drift;
        pPositions[i * 3]     = v.r * Math.sin(v.phi) * Math.cos(v.theta);
        pPositions[i * 3 + 1] = v.r * Math.sin(v.phi) * Math.sin(v.theta);
        pPositions[i * 3 + 2] = v.r * Math.cos(v.phi);
      }
      pGeo.attributes.position.needsUpdate = true;

      // Tagline fades in after 1s
      if (elapsed > 1000) {
        const tf = Math.min(1, (elapsed - 1000) / 800);
        tagEl.style.color = `rgba(210,190,255,${tf * 0.82})`;
        tagEl.style.letterSpacing = `${0.38 + tf * 0.08}em`;
      }

      // Trigger shatter
      if (elapsed >= SHATTER_AT && window.systemReady) {
        phase = "shatter";
        shatterStartTime = now;
        shards.forEach(s => {
          s.visible = true;
          s.material.opacity = 1;
        });
        // hide orb + rings + particles immediately
        orb.visible = false;
        ring.visible = false;
        ring2.visible = false;
        tagEl.style.opacity = "0";
      }

    } else if (phase === "shatter") {

      const sp = (now - shatterStartTime) / 1000;

      shards.forEach(s => {
        s.position.addScaledVector(s.userData.vel, 1);
        s.userData.vel.multiplyScalar(0.93); // drag
        s.rotation.x += s.userData.rot.x;
        s.rotation.y += s.userData.rot.y;
        s.rotation.z += s.userData.rot.z;
        s.material.opacity = Math.max(0, 1 - sp * 1.1);
      });

      // Fade particles out during shatter
      pMat.opacity = Math.max(0, 0.72 - sp * 1.4);

    }

    renderer2.render(scene2, camera2);
  }

  tick();

  /* ─── Completion ─── */
  setTimeout(() => {
    if (!window.systemReady) {
      // Server not ready yet — restart the intro loop
      cancelAnimationFrame(raf2);
      phase = "build";
      startTime = performance.now();
      shatterStartTime = 0;
      orb.visible = true;
      ring.visible = true;
      ring2.visible = true;
      tagEl.style.opacity = "1";
      pMat.opacity = 0;
      shards.forEach(s => { s.visible = false; s.position.set(
        (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 0.4
      ); });
      tick();
      // check again after another full cycle
      setTimeout(arguments.callee, TOTAL_DURATION);
    } else {
      cancelAnimationFrame(raf2);
      renderer2.dispose();
      window._introAnimDone = true;
    }
  }, TOTAL_DURATION);

  /* ─── Resize ─── */
  window.addEventListener("resize", () => {
    const nW = window.innerWidth, nH = window.innerHeight;
    renderer2.setSize(nW, nH);
    camera2.aspect = nW / nH;
    camera2.updateProjectionMatrix();
  });
}
})();
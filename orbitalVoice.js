// ===== GLOBAL AUDIO STATE =====
let micAnalyser  = null;
let micDataArray = null;
let micAudioContext = null;
window.orbitalActive = false;
let smoothAiEnergy = 0;

// ================= ORBITAL VOICE MODULE =================

export function initOrbitalVoice({ backendUrl, onPulse }) {

  let lastSpokenText = "";
  let isSpeaking    = false;
  let speakingUntil = 0;

  // ── FEATURE 1+2: Conversation memory (session) ──
  const conversationHistory = [];
  const MAX_HISTORY = 8; // 4 full exchanges

  // ── FEATURE 4: Active persona (syncs with server) ──
  let currentPersona = "default";

  // ── FEATURE 3: Location + timezone for weather/time ──
  let userLocation = null;
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  let locationPermissionDenied = false;
  function requestLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation || locationPermissionDenied) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        pos => { userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude }; resolve(userLocation); },
        err  => { if (err.code === err.PERMISSION_DENIED) locationPermissionDenied = true; resolve(null); },
        { timeout: 8000, maximumAge: 300000 }
      );
    });
  }
  requestLocation();

  // ── FEATURE 4: Persona voice settings (rate + pitch base) ──
  const PERSONA_VOICE = {
    default: { rate: 0.95, pitch: 1.00 },
    mentor:  { rate: 0.88, pitch: 0.92 },
    hype:    { rate: 1.08, pitch: 1.10 },
    drywit:  { rate: 0.93, pitch: 0.95 },
    zen:     { rate: 0.80, pitch: 0.88 }
  };

  // ── FEATURE 4: Preferred TTS voice names per persona ──
  const PERSONA_VOICE_NAME = {
    default: ["Samantha", "Google UK English Female", "Aria", "Zira", "Google US English"],
    mentor:  ["Daniel", "Google UK English Male", "Alex", "Samantha"],
    hype:    ["Samantha", "Google US English", "Aria"],
    drywit:  ["Daniel", "Alex", "Google UK English Male"],
    zen:     ["Samantha", "Karen", "Google UK English Female"]
  };

  // ── Load user persona from server on init ──
  (async () => {
    try {
      const token = localStorage.getItem("token");
      const r = await fetch(`${backendUrl}/api/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.ok) {
        const user = await r.json();
        if (user.persona) currentPersona = user.persona;
      }
    } catch {}
  })();

  // ===== MIC SETUP =====
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    micAudioContext = new AudioContext();
    micAnalyser = micAudioContext.createAnalyser();
    micAnalyser.fftSize = 512;
    const source = micAudioContext.createMediaStreamSource(stream);
    source.connect(micAnalyser);
    micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
  }).catch(() => {
    console.warn("Microphone permission denied.");
  });

  function getMicVolume() {
    if (!micAnalyser) return 0;
    micAnalyser.getByteFrequencyData(micDataArray);
    let sum = 0;
    for (let i = 0; i < micDataArray.length; i++) sum += micDataArray[i];
    return sum / micDataArray.length / 255;
  }

  function monitorUserVoice() {
    const volume = getMicVolume();
    if (!isSpeaking) {
      if (volume > 0.05) document.body.classList.add("user-speaking");
      else document.body.classList.remove("user-speaking");
    }
    requestAnimationFrame(monitorUserVoice);
  }
  monitorUserVoice();

  // ===== SPEECH RECOGNITION =====
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("Speech recognition not supported.");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.interimResults = true; // REQUIRED for wake-word interrupt mid-speech
  recognition.continuous     = true;
  recognition.lang           = "en-US";

  let recognitionActive = false;
  let aiSpeakingLock    = false;

  function addToHistory(role, content) {
    conversationHistory.push({ role, content });
    while (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();
  }

  // Recognition stays running even while AI speaks — needed for interrupt
  function startRecognition() {
    if (!recognitionActive) {
      try { recognition.start(); recognitionActive = true; } catch {}
    }
  }

  function stopRecognition() {
    if (recognitionActive) {
      try { recognition.abort(); } catch {}
      recognitionActive = false;
    }
  }

  // ===== RESULT HANDLER =====
  recognition.onresult = async (event) => {

    // ── While AI is speaking: only check for wake word ──
    if (isSpeaking) {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript.toLowerCase().trim();
        if (isWakeWord(t)) {
          console.log("Wake word mid-speech:", t);
          speechSynthesis.cancel();
          isSpeaking     = false;
          aiSpeakingLock = false;
          speakingUntil  = 0;
          lastSpokenText = "";
          document.body.classList.remove("ai-speaking");
          onPulse(false);
          window.orbitalActive = true;
          document.body.classList.add("orbital-activated");
          setTimeout(() => document.body.classList.remove("orbital-activated"), 1200);
          const cleaned = stripWakeWord(t);
          if (cleaned.length > 2) await handleTranscript(cleaned);
          else speak("I'm here.");
          return;
        }
      }
      return;
    }

    // ── Only process final results for commands ──
    const result = event.results[event.results.length - 1];
    if (!result.isFinal) return;

    let transcript = result[0].transcript.toLowerCase().trim();

    // Echo shield
    if (lastSpokenText && isSimilarToSpoken(transcript, lastSpokenText)) {
      console.log("Blocked echo of AI speech");
      return;
    }

    // Post-speech cooldown
    if (Date.now() < speakingUntil + 800) {
      console.log("Blocked: cooldown active");
      return;
    }

    transcript = transcript.replace(/[^\w\s']/g, "").trim();
    if (!transcript) return;
    console.log("Heard:", transcript);
    if (typeof window.addChatMessage === "function") window.addChatMessage("user", transcript);
    if (window.orbitalActive && typeof window.setOrbState === "function") window.setOrbState("listening");

    // Wake word (when not already active)
    if (!window.orbitalActive && isWakeWord(transcript)) {
      window.orbitalActive = true;
      document.body.classList.add("orbital-activated");
      setTimeout(() => document.body.classList.remove("orbital-activated"), 1200);
      onPulse(true);
      const cleaned = stripWakeWord(transcript);
      if (cleaned.length > 2) await handleTranscript(cleaned);
      else speak("I'm here.");
      return;
    }

    // Active conversation
    if (window.orbitalActive) {
      if (
        transcript.includes("go to sleep") ||
        transcript.includes("chup") ||
        transcript.includes("sleep") ||
        transcript.includes("stop listening") ||
        transcript.includes("good night")
      ) {
        speak("Alright, going quiet.");
        window.orbitalActive = false;
        onPulse(false);
        conversationHistory.length = 0;
        return;
      }
      analyzeUserEnergy(transcript);
      await handleTranscript(transcript);
    }
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    console.warn("Voice error:", e.error);
    recognitionActive = false;
    setTimeout(() => startRecognition(), 500);
  };

  recognition.onend = () => {
    recognitionActive = false;
    // Always restart — recognition must stay alive while AI speaks
    setTimeout(() => startRecognition(), 150);
  };

  // ===== HANDLE TRANSCRIPT — smart routing =====
  async function handleTranscript(transcript) {

    analyzeUserEnergy(transcript);

    // ── MUSIC MODE voice hook ──
    if (window.musicMode && window.musicMode.handleVoice(transcript)) {
      const on = window.musicMode.isActive();
      speak(on ? "Music mode on." : "Music mode off.");
      const btn = document.getElementById("musicModeBtn");
      if (btn) btn.textContent = on ? "♫ Exit Music" : "♫ Music Mode";
      return;
    }

    // ── SPOTIFY: Voice-controlled music ──
    const spotifyCmd = detectSpotifyCommand(transcript);
    if (spotifyCmd) {
      await handleSpotifyCommand(spotifyCmd);
      return;
    }

    // ── FEATURE 5: Voice-controlled vibe switching ──
    const vibeCmd = detectVibeCommand(transcript);
    if (vibeCmd) {
      applyVibeLocally(vibeCmd);
      speak(`Switching to ${vibeCmd} mode.`);
      return;
    }

    // ── FEATURE 5: Voice-controlled shape switching ──
    const shapeCmd = detectShapeCommand(transcript);
    if (shapeCmd) {
      // Speak confirmation first, THEN apply shape change.
      // This way the spoken word isn't mid-morph, and the echo shield
      // blocks the mic from picking up our own reply and re-routing it.
      if (shapeCmd === "next") {
        speak("Shifting to the next shape.");
        setTimeout(() => applyShapeLocally("next"), 300);
      } else if (shapeCmd === "prev") {
        speak("Going back to the previous shape.");
        setTimeout(() => applyShapeLocally("prev"), 300);
      } else {
        speak(`Switching to ${shapeCmd}.`);
        setTimeout(() => applyShapeLocally(shapeCmd), 300);
      }
      return;
    }

    // ── FEATURE 4: Voice-controlled persona switching ──
    const personaCmd = detectPersonaCommand(transcript);
    if (personaCmd) {
      await applyPersona(personaCmd);
      const descriptions = {
        default: "Back to myself.",
        mentor:  "Mentor mode. I'm here to guide.",
        hype:    "Hype mode. Let's go.",
        drywit:  "Dry wit mode. I'll contain my enthusiasm.",
        zen:     "Zen mode. Breathe. I'm here."
      };
      speak(descriptions[personaCmd] || "Done.");
      return;
    }

    // ── FEATURE 3: Real-world data ──
    const needsWeather = /\b(weather|temperature|rain|sunny|cold|hot|forecast|outside)\b/.test(transcript);
    const needsSearch = (() => {
      const t = transcript.toLowerCase();
      // Explicit search requests
      if (/\b(search|look up|look it up|find out|google|find me|search for|find information|find more|get information|get more|fetch|browse|check online|check the web|from the web|on the web|web search|internet)\b/.test(t)) return true;
      // Questions about facts/people/places/things
      if (/\b(what is|what are|what was|what were|who is|who are|who was|who were|where is|where are|when is|when was|when did)\b/.test(t)) return true;
      // Current events / time-sensitive
      if (/\b(latest|recent|right now|currently|today|this week|this year|happening|going on|situation|conflict|war|crisis|attack|protest|election|update|updates|status)\b/.test(t)) return true;
      // News and results
      if (/\b(news|score|result|match|winner|won|lost|beat|defeated|announced|released|launched|died|arrested|fired|resigned)\b/.test(t)) return true;
      // How/why questions
      if (/\b(how does|how do|how did|how much|how many|why does|why did|why is|why are|how to|how can)\b/.test(t)) return true;
      // Explanations and definitions
      if (/\b(tell me about|explain|definition of|meaning of|describe|summarize|overview of|details on|info on|information on|information about|more about|about the)\b/.test(t)) return true;
      // Financial / rankings
      if (/\b(price|cost|worth|stock|rate|rank|ranking|value|market|economy)\b/.test(t)) return true;
      return false;
    })();
    const needsTime    = /\b(time|date|day|today|what day|what time)\b/.test(transcript);

    let weatherContext = null;
    let searchContext  = null;
    let timeContext    = null;

    const token = localStorage.getItem("token");

    await Promise.all([
      needsWeather ? fetchWeather(token).then(r => { weatherContext = r; })  : Promise.resolve(),
      needsSearch  ? fetchSearch(token, transcript).then(r => { searchContext = r; }) : Promise.resolve(),
      needsTime    ? fetchTime(token).then(r => { timeContext = r; })         : Promise.resolve()
    ]);

    const chatContext = (typeof window.getChatContext === "function") ? window.getChatContext(10) : null;
    await sendToOrbital(transcript, { weatherContext, searchContext, timeContext, chatContext });
  }

  // ===== FEATURE 3: Real-world fetchers =====

  async function fetchWeather(token) {
    try {
      if (!userLocation) await requestLocation();
      if (!userLocation) {
        return locationPermissionDenied
          ? "Location access denied — cannot get local weather. Ask user to allow location in browser settings."
          : "Could not determine user location — cannot get local weather.";
      }
      const qs = `?lat=${userLocation.lat}&lon=${userLocation.lon}`;
      const r  = await fetch(`${backendUrl}/api/weather${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      const d  = await r.json();
      return d.summary || null;
    } catch { return null; }
  }

  async function fetchSearch(token, query) {
    try {
      const cleanQ = query
        .replace(/\b(hey orbital|orbital|search for|search|look up|look it up|find out about|find out|find me|google|tell me about|what is|what are|what was|who is|who are|who was|how does|how do|how did|why is|why did|explain|latest news on|news about|tell me)\b/gi, "")
        .replace(/\s{2,}/g, " ").trim();
      if (!cleanQ || cleanQ.length < 2) return null;
      const r = await fetch(`${backendUrl}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: cleanQ })
      });
      const d = await r.json();
      if (!d.results?.length) return null;
      return d.results.map(s => `[${s.title}]\n${s.snippet}`).join("\n\n");
    } catch { return null; }
  }

  async function fetchTime(token) {
    try {
      const r = await fetch(`${backendUrl}/api/time?tz=${encodeURIComponent(userTimezone)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const d = await r.json();
      return `${d.date}, ${d.time}`;
    } catch { return null; }
  }

  // ===== SEND TO ORBITAL =====
  async function sendToOrbital(message, { weatherContext, searchContext, timeContext, chatContext } = {}) {
    if (!navigator.onLine) { handleOfflineMode(); return; }

    const token = localStorage.getItem("token");

    // Snapshot history BEFORE adding current message
    const historySnapshot = [...conversationHistory];
    addToHistory("user", message);

    try {
      const res = await fetch(`${backendUrl}/api/ai`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          message,
          vibe:             window.currentVibe,
          locked:           window.isLocked,
          history:          historySnapshot,
          energyLevel:      window.userEnergyLevel,
          weatherContext:   weatherContext || null,
          searchContext:    searchContext  || null,
          chatContext:    chatContext    || null,
          timeContext:      timeContext    || null,
          currentShape:     (() => {
                              const shapes = window.SHAPES;
                              const idx    = window.currentShapeIndex;
                              return (shapes && idx != null) ? shapes[idx] : null;
                            })(),
          allShapes:        window.SHAPES ? [...window.SHAPES] : null,
          currentShapeIndex: window.currentShapeIndex != null ? window.currentShapeIndex : null
        })
      });

      if (!res.ok) throw new Error("Server error");

      const data = await res.json();
      const reply = data.reply;
      addToHistory("assistant", reply);

      // ── FEATURE 5: Apply server-detected commands ──
      if (data.vibeCommand)  applyVibeLocally(data.vibeCommand);
      if (data.shapeCommand) applyShapeLocally(data.shapeCommand);
      if (data.personaCommand && data.personaCommand !== currentPersona) {
        currentPersona = data.personaCommand;
      }

      if (typeof window.addChatMessage === "function") window.addChatMessage("orbital", reply);
      speak(buildSpokenReply(reply, message));

    } catch (error) {
      console.warn("Network or server error:", error);
      handleOfflineMode();
    }
  }

  // ===== FEATURE 5: Local vibe / shape / persona detection =====

  // ===== SPOTIFY VOICE COMMANDS =====

  function detectSpotifyCommand(text) {
    // Unambiguous Spotify-specific
    if (/\b(connect|link|setup|sign in to|login to)\s+spotify\b/.test(text)) return { action: "connect" };
    if (/\b(disconnect|unlink)\s+spotify\b/.test(text))                        return { action: "disconnect" };
    if (/\b(what('?s| is) (playing|on|this song|this track)|current(ly playing)?|what song)\b/.test(text)) return { action: "status" };

    // Shape/vibe guard — never steal these
    const looksLikeShapeCmd = /\b(sphere|infinity|heart|saturn|spiral|butterfly)\b/.test(text);
    const looksLikeVibeCmd  = /\b(calm|focused|energetic|mystic)\s*(mode|vibe)?\b/.test(text);
    if (looksLikeShapeCmd || looksLikeVibeCmd) return null;

    // ── SONG SEARCH — must be checked BEFORE generic play ──
    const songMatch = text.match(/\b(?:play|put on|i want to hear|play song|play the song)\s+(.+)$/i);
    if (songMatch) {
      let rawQuery = songMatch[1].trim();
      const isGeneric = /^(music|something|anything|it|this|that|a song|some music)$/i.test(rawQuery);
      if (!isGeneric && rawQuery.length > 1) {
        rawQuery = rawQuery.replace(/^(the song called|the song|a song called|a song)\s*/i, "").trim();
        rawQuery = rawQuery.replace(/\s+(please|now|for me|okay|ok)$/i, "").trim();
        const byMatch = rawQuery.match(/^(.+?)\s+by\s+(.+)$/i);
        if (byMatch) return { action: "play-song", query: rawQuery, song: byMatch[1].trim(), artist: byMatch[2].trim() };
        return { action: "play-song", query: rawQuery, song: rawQuery, artist: null };
      }
    }

    // Music context guard for ambiguous commands
    const hasMusicContext = /\b(spotify|music|song|track|playlist|album|artist)\b/.test(text);

    if (hasMusicContext && /\b(next|skip|next song|skip song|next track)\b/.test(text))      return { action: "next" };
    if (hasMusicContext && /\b(previous|go back|last song|previous song|prev)\b/.test(text)) return { action: "previous" };

    if (/\b(stop (the )?(music|song)|pause (the )?(music|song))\b/.test(text)) return { action: "pause" };
    if (hasMusicContext && /\bpause\b/.test(text))                               return { action: "pause" };

    if (/\b(resume|start (the )?music|play (the )?music|play (the )?song)\b/.test(text)) return { action: "play" };
    if (hasMusicContext && /\bplay\b/.test(text))                                         return { action: "play" };

    if (hasMusicContext) {
      const volMatch = text.match(/\b(volume|set volume|turn (it )?up|turn (it )?down)\b/);
      if (volMatch) {
        const numMatch = text.match(/\b(\d{1,3})\b/);
        if (numMatch) return { action: "volume", volume: parseInt(numMatch[1]) };
        if (/\b(up|louder|higher)\b/.test(text))        return { action: "volume", volume: 80 };
        if (/\b(down|quieter|lower|softer)\b/.test(text)) return { action: "volume", volume: 30 };
      }
    }

    return null;
  }

  async function handleSpotifyCommand(cmd) {
    const token = localStorage.getItem("token");

    // Connect — open OAuth popup
    if (cmd.action === "connect") {
      speak("Opening Spotify login. Sign in and I'll be connected.");
      const popup = window.open(
        `${backendUrl}/api/spotify/login?token=${encodeURIComponent(localStorage.getItem("token") || "")}`,
        "spotify-login",
        "width=480,height=700,left=200,top=100"
      );
      // Listen for popup to close after auth
      window.addEventListener("message", async (e) => {
        if (e.data === "spotify-connected") {
          speak("Spotify connected. I can now control your music.");
        }
      }, { once: true });
      return;
    }

    // Disconnect
    if (cmd.action === "disconnect") {
      try {
        await fetch(`${backendUrl}/api/spotify/disconnect`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` }
        });
        speak("Spotify disconnected.");
      } catch { speak("Couldn't disconnect Spotify right now."); }
      return;
    }

    // Status — what's playing
    if (cmd.action === "status") {
      try {
        const r = await fetch(`${backendUrl}/api/spotify/status`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const d = await r.json();
        if (!d.connected) {
          speak("Spotify isn't connected. Say: connect Spotify.");
          return;
        }
        if (!d.playing || !d.track) {
          speak("Nothing is playing on Spotify right now.");
          return;
        }
        speak(`Playing ${d.track} by ${d.artist}.`);
      } catch { speak("Couldn't reach Spotify right now."); }
      return;
    }

    // Play a specific song by search query
    if (cmd.action === "play-song") {
      speak("Searching for that.");
      try {
        const r = await fetch(`${backendUrl}/api/spotify/play-song`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ query: cmd.query, song: cmd.song || null, artist: cmd.artist || null })
        });
        const d = await r.json();
        if (!r.ok || !d.ok) {
          speak(d.message || "Couldn't find or play that track.");
        } else {
          if (typeof window.updateMusicCard === "function") window.updateMusicCard(d.track, d.artist);
          speak(`Playing ${d.track} by ${d.artist}.`);
        }
      } catch { speak("Couldn't reach Spotify right now."); }
      return;
    }

    // All other controls (play, pause, next, previous, volume)
    try {
      const r = await fetch(`${backendUrl}/api/spotify/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: cmd.action, volume: cmd.volume })
      });
      const d = await r.json();

      if (!r.ok) {
        if (r.status === 401) {
          speak("Spotify isn't connected. Say: connect Spotify.");
        } else {
          speak("Spotify didn't respond. Make sure it's open on a device.");
        }
        return;
      }

      const confirmations = {
        play:     "Resuming.",
        pause:    "Paused.",
        next:     "Skipping.",
        previous: "Going back.",
        volume:   `Volume set to ${cmd.volume}.`
      };
      speak(confirmations[cmd.action] || "Done.");

    } catch { speak("Couldn't reach Spotify."); }
  }

  // ── VIBE: only triggers on explicit "switch/change/go to X mode/vibe" phrases ──
  function detectVibeCommand(text) {
    const intentPrefix = /\b(switch|change|go|set|use|activate|turn on)\b.{0,15}/;
    const modeSuffix   = /\s*(mode|vibe)?\b/;

    if (intentPrefix.test(text) && /\b(calm|chill|relax)\b/.test(text))    return "calm";
    if (intentPrefix.test(text) && /\bfocus(ed)?\b/.test(text))             return "focused";
    if (intentPrefix.test(text) && /\b(energetic|energy|intense)\b/.test(text)) return "energetic";
    if (intentPrefix.test(text) && /\b(mystic(al)?|cosmic)\b/.test(text))  return "mystic";

    // Also allow direct "X mode" / "X vibe" without switch prefix
    if (/\bcalm\s+mode\b/.test(text))     return "calm";
    if (/\bfocus(ed)?\s+mode\b/.test(text)) return "focused";
    if (/\benergetic\s+mode\b/.test(text)) return "energetic";
    if (/\bmystic\s+mode\b/.test(text))   return "mystic";

    return null;
  }

  // -- SHAPE: triggers on named shapes OR next/previous navigation --
  function detectShapeCommand(text) {
    const intentPrefix = /\b(show|morph|change|switch|make|go to|turn into)\b.{0,20}/;

    // Named shapes
    if (intentPrefix.test(text) && /\bsphere\b/.test(text))    return "sphere";
    if (intentPrefix.test(text) && /\binfinity\b/.test(text))  return "infinity";
    if (intentPrefix.test(text) && /\bheart\b/.test(text))     return "heart";
    if (intentPrefix.test(text) && /\bsaturn\b/.test(text))    return "saturn";
    if (intentPrefix.test(text) && /\bspiral\b/.test(text))    return "spiral";
    if (intentPrefix.test(text) && /\bbutterfly\b/.test(text)) return "butterfly";

    // Next/prev with shape context: "next shape", "next one", "previous form"
    const shapeContext = /\b(shape|form|one)\b/.test(text);
    if (shapeContext && /\b(next|forward|ahead)\b/.test(text))             return "next";
    if (shapeContext && /\b(previous|prev|back|before|last)\b/.test(text)) return "prev";

    // Intent prefix + next/prev: "change to next", "switch to previous"
    if (intentPrefix.test(text) && /\b(next|forward)\b/.test(text))          return "next";
    if (intentPrefix.test(text) && /\b(previous|prev|go back)\b/.test(text)) return "prev";

    return null;
  }

  // ── PERSONA: only triggers on explicit "X mode" or "be more X" phrasing ──
  function detectPersonaCommand(text) {
    if (/\b(reset personality|back to normal|be yourself|default mode)\b/.test(text)) return "default";
    if (/\bmentor\s+mode\b/.test(text) || /\bact (like a |as a )?mentor\b/.test(text)) return "mentor";
    if (/\bhype\s+mode\b/.test(text)   || /\bact (like a )?hype( man)?\b/.test(text))  return "hype";
    if (/\bdry wit\s+mode\b/.test(text) || /\bbe (more )?(sarcastic|dry|deadpan)\b/.test(text)) return "drywit";
    if (/\bzen\s+mode\b/.test(text)    || /\bact (more )?zen\b/.test(text))             return "zen";
    return null;
  }

  function applyVibeLocally(vibe) {
    window.ACTIVE_VIBE = vibe;
    window.currentVibe = vibe;
    if (typeof window.applyVibe === "function") window.applyVibe(vibe);
    // Silently persist to backend
    const token = localStorage.getItem("token");
    fetch(`${backendUrl}/api/update-vibe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vibe })
    }).catch(() => {});
  }

  function applyShapeLocally(shape) {
    const shapes   = window.SHAPES;
    const switchFn = window.switchShape;
    if (!shapes || typeof switchFn !== "function") {
      console.warn("Shape globals not ready yet");
      return;
    }

    // next/prev: single step, switchShape handles the morph
    if (shape === "next") { switchFn(1);  return; }
    if (shape === "prev") { switchFn(-1); return; }

    // Named shape: switchShape only accepts +1/-1 and blocks if already morphing.
    // Calling it in a loop is broken — only the first call gets through.
    // Fix: manually set currentShapeIndex to one before the target, then
    // call switchShape(1) once — lands exactly on target in a single morph.
    const targetIdx  = shapes.indexOf(shape);
    if (targetIdx === -1) return;
    const currentIdx = window.currentShapeIndex != null ? window.currentShapeIndex : 0;
    if (targetIdx === currentIdx) return;

    window.currentShapeIndex = (targetIdx - 1 + shapes.length) % shapes.length;
    switchFn(1);
  }

  async function applyPersona(persona) {
    currentPersona = persona;
    const token = localStorage.getItem("token");
    try {
      await fetch(`${backendUrl}/api/persona`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ persona })
      });
    } catch {}
  }

  // ===== ENERGY ANALYSIS =====
  function analyzeUserEnergy(transcript) {
    const wordCount   = transcript.split(" ").length;
    const hasQuestion = /\?|what|why|how|when|where|who|is|are|can|will|do|did/.test(transcript);
    const hasEmotion  = /wow|amazing|terrible|love|hate|angry|upset|excited|please/.test(transcript);

    if (wordCount <= 4 && !hasQuestion) window.userEnergyLevel = "quick";
    else if (hasQuestion && wordCount > 6) window.userEnergyLevel = "deep";
    else if (hasEmotion) window.userEnergyLevel = "excited";
    else window.userEnergyLevel = "calm";
  }

  // ===== ECHO DETECTION =====
  function isSimilarToSpoken(heard, spoken) {
    if (!spoken || !heard) return false;
    const hw = heard.split(" ").filter(w => w.length > 3);
    const sw = spoken.split(" ").filter(w => w.length > 3);
    if (!hw.length || !sw.length) return false;
    let matches = 0;
    for (const w of hw) {
      if (sw.some(s => s.includes(w) || w.includes(s))) matches++;
    }
    return (matches / Math.min(hw.length, sw.length)) > 0.55;
  }

  // ===== ADAPTIVE REPLY LENGTH =====
  function buildSpokenReply(reply, originalMessage) {
    const energy     = window.userEnergyLevel || "calm";
    const sentences  = reply.match(/[^.!?]+[.!?]+/g) || [reply];
    const isQuestion = /\?|what|why|how|when|where|who|tell me|explain/.test(originalMessage);
    const wantsList  = /list|give me|options|ideas|examples|steps|ways/.test(originalMessage);

    if (energy === "quick" && !isQuestion && !wantsList) {
      let compact = [], total = 0;
      for (const s of sentences) {
        if (total + s.length > 200) break;
        compact.push(s);
        total += s.length;
        if (compact.length >= 2) break;
      }
      return compact.join(" ").trim();
    }

    if (energy === "deep" || isQuestion || wantsList) {
      if (reply.length > 800) {
        let cut = reply.slice(0, 800);
        const lp = cut.lastIndexOf(".");
        if (lp > 300) cut = cut.slice(0, lp + 1);
        return cut;
      }
      return reply;
    }

    if (reply.length > 500) {
      let cut = reply.slice(0, 500);
      const lp = cut.lastIndexOf(".");
      if (lp > 150) cut = cut.slice(0, lp + 1);
      return cut;
    }

    return reply;
  }

  function handleOfflineMode() {
    const energy = window.userEnergyLevel || "calm";
    const quick  = ["Looks like I'm offline.", "No connection right now.", "Network seems down."];
    const calm   = ["I'm having trouble reaching the network right now.", "It seems we're offline at the moment."];
    speak((energy === "quick" ? quick : calm)[Math.floor(Math.random() * 3) % (energy === "quick" ? 3 : 2)]);
  }

  // ===== SPEAK =====
  function speak(text) {
    speechSynthesis.cancel();

    lastSpokenText = text.toLowerCase();
    speakingUntil  = Date.now() + (text.split(" ").length / 140) * 60000;
    isSpeaking     = true;

    const utterance = new SpeechSynthesisUtterance(text);

    // ── FEATURE 4: Persona-aware voice selection ──
    const voices        = speechSynthesis.getVoices();
    const preferredNames = PERSONA_VOICE_NAME[currentPersona] || PERSONA_VOICE_NAME.default;
    const chosen = preferredNames.reduce((found, name) => {
      return found || voices.find(v => v.name.includes(name));
    }, null);
    if (chosen) utterance.voice = chosen;

    // ── FEATURE 4: Persona base + energy adjustment ──
    const base   = PERSONA_VOICE[currentPersona] || PERSONA_VOICE.default;
    const energy = window.userEnergyLevel || "calm";
    let rate  = base.rate;
    let pitch = base.pitch;

    if (energy === "quick")   { rate += 0.10; pitch += 0.05; }
    else if (energy === "deep")    { rate -= 0.05; pitch -= 0.03; }
    else if (energy === "excited") { rate += 0.08; pitch += 0.08; }
    if (text.includes("!")) { rate += 0.04; pitch += 0.04; }
    if (text.includes("?")) { pitch += 0.07; }
    rate  += (Math.random() - 0.5) * 0.03;
    pitch += (Math.random() - 0.5) * 0.03;
    utterance.rate   = Math.max(0.82, Math.min(1.18, rate));
    utterance.pitch  = Math.max(0.88, Math.min(1.22, pitch));
    utterance.volume = 1;

    utterance.onstart = () => {
      // KEY: Do NOT stop recognition here — it must stay alive to catch wake word
      aiSpeakingLock = true;
      document.body.classList.add("ai-speaking");
      isSpeaking = true;
      onPulse(true);
      if (typeof window.setOrbState === "function") window.setOrbState("speaking");
      smoothAiEnergy = 0.6;
    };

    utterance.onend = () => {
      if (typeof window.setOrbState === "function") window.setOrbState(window.orbitalActive ? "listening" : "idle");
      document.body.classList.remove("ai-speaking");
      isSpeaking     = false;
      aiSpeakingLock = false;
      onPulse(false);
      smoothAiEnergy = 0;
      setTimeout(() => { lastSpokenText = ""; }, 1500);
      setTimeout(() => startRecognition(), 200);
    };

    speechSynthesis.speak(utterance);

    // Keep-alive: browser can kill recognition mid-speech, restart if needed
    const keepAlive = setInterval(() => {
      if (!isSpeaking) { clearInterval(keepAlive); return; }
      if (!recognitionActive) {
        try { recognition.start(); recognitionActive = true; } catch {}
      }
    }, 1000);
  }

  // ===== WAKE WORD =====
  function isWakeWord(text) {
    return [
      /hello\s+orbital/, /hey\s+orbital/, /hay\s+orbital/,
      /hello\s+orbit/,   /yellow\s+orbital/, /hello\s+or\s*beetle/,
      /hello\s+orbit\s*all/, /hi\s+orbital/, /halo\s+orbital/,
      /orbital\s+(wake|listen|start)/
    ].some(p => p.test(text));
  }

  function stripWakeWord(t) {
    return t
      .replace(/hello\s+orbital/i,        "").replace(/hey\s+orbital/i,      "")
      .replace(/hay\s+orbital/i,           "").replace(/hi\s+orbital/i,       "")
      .replace(/yellow\s+orbital/i,        "").replace(/hello\s+orbit/i,      "")
      .replace(/hello\s+or\s*beetle/i,     "").replace(/hello\s+orbit\s*all/i,"")
      .replace(/halo\s+orbital/i,          "").trim();
  }

  startRecognition();
  console.log("Orbital Voice Initialized");
}


// ===== AUDIO ENERGY EXPORT =====
let smoothUserEnergy = 0;
let smoothUserBass   = 0;

export function getUserAudioEnergy() {
  let userEnergy = 0, userBass = 0;

  if (micAnalyser) {
    micAnalyser.getByteFrequencyData(micDataArray);
    let total = 0, bass = 0;
    for (let i = 0; i < micDataArray.length; i++) {
      total += micDataArray[i];
      if (i < 30) bass += micDataArray[i];
    }
    userEnergy = (total / micDataArray.length) / 255;
    userBass   = (bass / 30) / 255;
  }

  smoothUserEnergy += (userEnergy - smoothUserEnergy) * 0.08;
  smoothUserBass   += (userBass   - smoothUserBass)   * 0.08;
  smoothAiEnergy   += (0          - smoothAiEnergy)   * 0.06;

  return {
    energy: Math.max(smoothUserEnergy, smoothAiEnergy),
    bass:   smoothUserBass
  };
}
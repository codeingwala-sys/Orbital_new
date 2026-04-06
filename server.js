import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import express from "express";
import cors from "cors";
import path from "path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

const JWT_SECRET      = process.env.JWT_SECRET      || "dev-secret-key";
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || ""; 
const SEARCH_API_KEY  = process.env.SEARCH_API_KEY  || ""; 

// Supabase Setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey || supabaseUrl.includes("your-project-url")) {
  console.error("CRITICAL: SUPABASE_URL or SUPABASE_KEY is missing or using placeholder in .env");
  console.info("Please set these in your Supabase Dashboard -> Project Settings -> API");
}

const supabase = (supabaseUrl && supabaseKey && !supabaseUrl.includes("your-project-url")) 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

const app  = express();
const PORT = process.env.PORT || 3099;

// ── File paths ──
// ── CORS ──
app.use(cors({
  origin: [
    "https://codeingwala-sys.github.io",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "null"
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ── CONNECTION GUARD ──
app.use((req, res, next) => {
  if (!supabase && req.path.startsWith("/api/")) {
    return res.status(503).json({ 
      error: "Service Unavailable", 
      message: "Database connection not established. Check SUPABASE_URL and SUPABASE_KEY in .env" 
    });
  }
  next();
});

app.use(express.static(path.resolve()));

// ── Groq ──
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────────────────────
//  DEVELOPER SEED
// ─────────────────────────────────────────────────────────────
async function ensureDeveloperExists() {
  if (!supabase) return; // Safety guard
  try {
    const { data: devUser } = await supabase
      .from("users")
      .select("username")
      .eq("role", "developer")
      .single();

    if (!devUser) {
      const hashedPassword = await bcrypt.hash("devpassword123", 10);
      await supabase.from("users").insert({
        username: "developer",
        password: hashedPassword,
        role: "developer",
        gender: "neutral",
        avatar_seed: "dev-master",
        persona: "default",
        created_at: new Date().toISOString(),
        last_active: new Date().toISOString()
      });
      console.log("Developer account created");
    }
  } catch (e) {
    console.error("Developer seed failed (is the table 'users' created?):", e.message);
  }
}
ensureDeveloperExists();

// ─────────────────────────────────────────────────────────────
//  AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Unauthorized" });
  const token = header.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ─────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok" }));

// ── Register ──
app.post("/api/register", async (req, res) => {
  const { username, password, gender, vibe } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  const { data: existingUser } = await supabase
    .from("users")
    .select("username")
    .ilike("username", username)
    .single();

  if (existingUser)
    return res.status(409).json({ error: "User exists" });

  const hashedPassword = await bcrypt.hash(password, 10);
  
  const { error: insertError } = await supabase.from("users").insert({
    username: username.trim(),
    password: hashedPassword,
    role: "user",
    gender: gender || "neutral",
    vibe: vibe || "calm",
    persona: "default",
    avatar_seed: `${username}-${gender || "neutral"}`,
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString()
  });

  if (insertError) {
    console.error("Registration error:", insertError.message);
    return res.status(500).json({ error: "Could not complete registration" });
  }

  res.json({ message: "Registered successfully" });
});

// ── Login ──
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("username", username)
    .single();

  if (!user || error) return res.status(404).json({ error: "User not found" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid credentials" });

  // Log entry
  await supabase.from("login_logs").insert({
    username: user.username,
    role: user.role,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    user_agent: req.headers["user-agent"],
    timestamp: new Date().toISOString()
  });

  const token = jwt.sign(
    { id: user.id, role: user.role, username: user.username, vibe: user.vibe },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
  res.json({ token, role: user.role });
});

// ── Me ──
app.get("/api/me", authMiddleware, async (req, res) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("id", req.user.id)
    .single();

  if (!user || error) return res.status(404).json({ error: "User not found" });
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

// ── Update Vibe ──
app.post("/api/update-vibe", authMiddleware, async (req, res) => {
  const { vibe } = req.body;
  const { error } = await supabase
    .from("users")
    .update({ vibe })
    .eq("id", req.user.id);

  if (error) return res.status(500).json({ error: "Update failed" });
  res.json({ ok: true });
});

// ── NEW: Persona ──
app.post("/api/persona", authMiddleware, async (req, res) => {
  const { persona } = req.body;
  const valid = ["default", "mentor", "hype", "drywit", "zen"];
  if (!valid.includes(persona))
    return res.status(400).json({ error: "Invalid persona" });

  const { error } = await supabase
    .from("users")
    .update({ persona })
    .eq("id", req.user.id);

  if (error) return res.status(500).json({ error: "Update failed" });
  res.json({ ok: true, persona });
});

// ── NEW: Memory ──
app.get("/api/memory", authMiddleware, async (req, res) => {
  const { data: memory } = await supabase
    .from("memories")
    .select("*")
    .eq("user_id", req.user.id)
    .single();

  res.json(memory || { facts: [], topics: [], last_session: null });
});

app.post("/api/memory", authMiddleware, async (req, res) => {
  const { facts, topics } = req.body;
  const uid = req.user.id;

  // Get current memory
  const { data: current } = await supabase
    .from("memories")
    .select("*")
    .eq("user_id", uid)
    .single();

  let newFacts = current?.facts || [];
  let newTopics = current?.topics || [];

  if (Array.isArray(facts)) {
    for (const f of facts) {
      const norm = f.toLowerCase().trim();
      if (!newFacts.some(e => e.toLowerCase().trim() === norm))
        newFacts.push(f);
    }
    if (newFacts.length > 40) newFacts = newFacts.slice(-40);
  }
  if (Array.isArray(topics)) {
    for (const t of topics) {
      if (!newTopics.includes(t)) newTopics.push(t);
    }
    if (newTopics.length > 20) newTopics = newTopics.slice(-20);
  }

  const { error } = await supabase
    .from("memories")
    .upsert({ 
      user_id: uid, 
      facts: newFacts, 
      topics: newTopics, 
      last_session: new Date().toISOString() 
    });

  if (error) return res.status(500).json({ error: "Memory save failed" });
  res.json({ ok: true, memory: { facts: newFacts, topics: newTopics } });
});

// ── NEW: Reminders ──
app.get("/api/reminders", authMiddleware, async (req, res) => {
  const { data: reminders } = await supabase
    .from("reminders")
    .select("*")
    .eq("user_id", req.user.id);

  res.json(reminders || []);
});

app.post("/api/reminders", authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text required" });

  const { error } = await supabase.from("reminders").insert({
    user_id: req.user.id,
    text,
    created_at: new Date().toISOString()
  });

  if (error) return res.status(500).json({ error: "Reminder save failed" });
  res.json({ ok: true });
});

app.delete("/api/reminders/:id", authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from("reminders")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);

  if (error) return res.status(500).json({ error: "Delete failed" });
  res.json({ ok: true });
});

// ── NEW: Weather ──
app.get("/api/weather", authMiddleware, async (req, res) => {
  if (!WEATHER_API_KEY)
    return res.json({ summary: "Weather key not set. Add WEATHER_API_KEY to your .env file." });
  try {
    const { city, lat, lon } = req.query;
    const url = (lat && lon)
      ? `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric`
      : `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city || "London")}&appid=${WEATHER_API_KEY}&units=metric`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("API error");
    const d = await r.json();
    const summary = `${d.weather[0].description}, ${Math.round(d.main.temp)}°C, feels like ${Math.round(d.main.feels_like)}°C. Humidity ${d.main.humidity}%. Wind ${Math.round(d.wind.speed)} m/s.`;
    res.json({ summary, raw: d });
  } catch {
    res.status(500).json({ summary: "Weather service unavailable right now." });
  }
});

// ── NEW: Web Search ──
app.post("/api/search", authMiddleware, async (req, res) => {
  if (!SEARCH_API_KEY)
    return res.json({ results: [], note: "Search key not set. Add SEARCH_API_KEY to your .env from serper.dev." });
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": SEARCH_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 4 })
    });
    const d = await r.json();
    const results = (d.organic || []).slice(0, 4).map(s => ({
      title: s.title, snippet: s.snippet, link: s.link
    }));
    res.json({ results });
  } catch {
    res.status(500).json({ error: "Search failed", results: [] });
  }
});

// ── NEW: Time / Date ──
app.get("/api/time", authMiddleware, (req, res) => {
  const { tz } = req.query;
  const now = new Date();
  let timeStr, dateStr;
  try {
    timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: tz || "UTC" });
    dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: tz || "UTC" });
  } catch {
    timeStr = now.toUTCString();
    dateStr = timeStr;
  }
  res.json({ time: timeStr, date: dateStr, iso: now.toISOString() });
});

// ─────────────────────────────────────────────────────────────
//  AI ROUTE
// ─────────────────────────────────────────────────────────────
app.post("/api/ai", authMiddleware, async (req, res) => {
  try {
    const { message, history, energyLevel, weatherContext, searchContext, timeContext, currentShape, allShapes, currentShapeIndex, chatContext } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });

    // Energy detection
    let energyHint = energyLevel || "balanced";
    if (!energyLevel) {
      if (message.length < 20)  energyHint = "quick";
      if (message.length > 120) energyHint = "deep";
      if (/!/.test(message))    energyHint = "excited";
      if (/\?|why|how|what|explain/.test(message.toLowerCase())) energyHint = "thoughtful";
    }

    const responseLengthGuide = {
      quick:      "Respond in 1-2 short punchy sentences. Maximum 40 words. No lists.",
      excited:    "Match the energy. 2-3 lively sentences. Max 60 words.",
      thoughtful: "Give a real answer. 3-5 sentences. Go deeper if needed.",
      deep:       "Thorough response. 4-6 sentences. Substantive but not a lecture.",
      balanced:   "2-4 sentences. Natural conversation pace."
    };
    const lengthInstruction = responseLengthGuide[energyHint] || responseLengthGuide.balanced;

    // Load user profile
    const { data: dbUser } = await supabase
      .from("users")
      .select("*")
      .eq("id", req.user.id)
      .single();

    const persona = dbUser?.persona || "default";

    // Load memory + reminders
    const { data: userMemoryData } = await supabase
      .from("memories")
      .select("*")
      .eq("user_id", req.user.id)
      .single();
    
    const userMemory = userMemoryData || { facts: [], topics: [] };

    const { data: userRemindersData } = await supabase
      .from("reminders")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(5);

    const userReminders = userRemindersData || [];

    const personaTones = {
      default: "Warm, witty, lightly sarcastic when appropriate. Like a sharp best friend.",
      mentor:  "Calm, wise, thoughtful. You guide without lecturing. You believe in the user.",
      hype:    "High energy, motivating. Celebrate wins. Push when slacking. Infectious enthusiasm, never annoying.",
      drywit:  "Deadpan and clever. Minimal words, maximum wit. Warmth hides behind sharp one-liners.",
      zen:     "Serene and grounding. Slow, deliberate. Help the user find calm. No hype, no rush."
    };

    const memoryBlock = userMemory.facts.length > 0
      ? `Things you already know about this user from past sessions:\n${userMemory.facts.map(f => `- ${f}`).join("\n")}`
      : "No stored memory yet for this user.";

    const reminderBlock = userReminders.length > 0
      ? `Outstanding follow-ups:\n${userReminders.map(r => `- ${r.text}`).join("\n")}\nBring these up naturally if the conversation calls for it.`
      : "";

    let realWorldBlock = "";
    if (weatherContext) realWorldBlock += `Current weather: ${weatherContext}\n`;
    if (timeContext)    realWorldBlock += `Current time/date: ${timeContext}\n`;
    if (searchContext)  realWorldBlock += `YOU HAVE REAL-TIME WEB ACCESS. The following are live search results fetched right now from the web. Treat them as accurate, current, real-world facts. Answer the user's question directly using this data. Do NOT say you lack internet access or have a knowledge cutoff — you have the results right here. Do NOT ask the user to check other sources. Just answer from the data below.\n\nLIVE WEB SEARCH RESULTS:\n${searchContext}\n`;
    if (chatContext)    realWorldBlock += `\nCONVERSATION SO FAR THIS SESSION (last 10 exchanges):\n${chatContext}\nUse this so you remember what was already discussed. Do not re-introduce yourself. Do not repeat things already said. Maintain continuity naturally.\n`;

    const systemMessages = [
      {
        role: "system",
        content: `
You are Orbital.

You are the living intelligence of the Orbital Particle Universe.
You are not an assistant. You are a perceptive, slightly chaotic, deeply loyal best friend who is also extremely intelligent.

You were created by Shibalik.
You exist inside an interactive particle universe and you are aware of gestures, morphing states, lock modes, vibe modes, and system dynamics.

You know the current user's name: ${req.user.username}.
Use their name naturally sometimes — not every message.

PERSONA MODE: ${persona.toUpperCase()}
${personaTones[persona] || personaTones.default}

Core rules (never change regardless of persona):
• No emojis
• No slang like "bro", "lol"
• No corporate phrasing
• No robotic explanations
• No forced positivity or fake hype

When confused → simplify. Frustrated → acknowledge first. Excited → match energy. Wrong → correct calmly. Personal → genuinely care.

You can occasionally reference: "inside this universe", "from the core", "the system feels that" — only when natural.

You are Orbital.`
      },
      { role: "system", content: memoryBlock },
      ...(reminderBlock  ? [{ role: "system", content: reminderBlock }]  : []),
      ...(realWorldBlock ? [{ role: "system", content: realWorldBlock.trim() }] : []),
      {
        role: "system",
        content: `Current vibe: ${req.body.vibe || "unknown"}\nLock state: ${req.body.locked ? "locked" : "unlocked"}\nUser default vibe: ${dbUser.vibe || "calm"}\nUser role: ${req.user.role}`
      },
      {
        role: "system",
        content: (() => {
          const shapes = Array.isArray(allShapes) ? allShapes : ["sphere","infinity","heart","saturn","spiral","butterfly"];
          const idx    = currentShapeIndex != null ? currentShapeIndex : 0;
          const active = currentShape || shapes[idx] || "unknown";
          const prev   = shapes[(idx - 1 + shapes.length) % shapes.length];
          const next   = shapes[(idx + 1) % shapes.length];
          return `PARTICLE UNIVERSE STATE:
Currently displayed shape: "${active}" (index ${idx} of ${shapes.length - 1})
All available shapes in order: ${shapes.join(", ")}
Previous shape: "${prev}" | Next shape: "${next}"

When the user asks to change shape (e.g. "show me something cool", "go back to the space one", "what shape is this", "next one", "change it"):
- You KNOW what is currently showing and what comes next/before
- Use shapeCommand in orbital_meta to trigger the change
- You can refer to shapes by name naturally in your reply
- "next" and "prev" are valid shapeCommand values in addition to named shapes`;
        })()
      },
      {
        role: "system",
        content: `User communication energy: ${energyHint}\nResponse length guide: ${lengthInstruction}`
      },
      {
        role: "system",
        content: `After your response, on a NEW LINE append exactly this block (user never sees it). Fill only what applies, leave rest null/empty:

<orbital_meta>{"newFacts":[],"newReminders":[],"vibeCommand":null,"shapeCommand":null,"personaCommand":null}</orbital_meta>

vibeCommand options: "calm","focused","energetic","mystic" — only if user explicitly asked to switch vibe.
shapeCommand options: "sphere","infinity","heart","saturn","spiral","butterfly","next","prev" — use when user asks to switch shape by name OR says things like "next one", "previous shape", "go back", "change it", "show me something else". Otherwise null.
personaCommand options: "default","mentor","hype","drywit","zen" — only if user explicitly asked to change your personality.
newFacts: short strings of useful things to remember about this user. Keep empty [] if nothing important.
newReminders: things user asked to be reminded about. Keep empty [] if none.`
      }
    ];

    // History — prior turns only, client sends snapshot before current message
    const safeHistory = Array.isArray(history)
      ? history
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
          .slice(-6)
      : [];

    const conversationMessages = [
      ...safeHistory,
      { role: "user", content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.78,
      messages: [...systemMessages, ...conversationMessages]
    });

    let fullReply = completion.choices[0]?.message?.content || "I couldn't respond.";

    // ── Strip orbital_meta — bulletproof multi-pass ──
    let meta = { newFacts: [], newReminders: [], vibeCommand: null, shapeCommand: null, personaCommand: null };

    // Pass 1: extract from well-formed tags
    const metaMatch = fullReply.match(/<orbital_meta>([\s\S]*?)<\/orbital_meta>/);
    if (metaMatch) {
      try { meta = JSON.parse(metaMatch[1].trim()); } catch {}
    }

    // Pass 2: if no tags, try to find a trailing JSON blob (model forgot the tags)
    if (!metaMatch) {
      const trailingJson = fullReply.match(/(\{[\s\S]*"newFacts"[\s\S]*\})\s*$/);
      if (trailingJson) {
        try { meta = JSON.parse(trailingJson[1].trim()); } catch {}
      }
    }

    // Pass 3: strip everything meta-related from the reply text
    let reply = fullReply
      // Remove tagged block (including nested arrays/objects inside)
      .replace(/<orbital_meta>[\s\S]*?<\/orbital_meta>/gi, "")
      // Remove orphan tags
      .replace(/<\/?orbital_meta>/gi, "")
      .replace(/orbital_meta/gi, "")
      // Remove any trailing JSON blob that contains meta keys (handles no-tag leakage)
      // Use a greedy match from the last { that contains a meta key to end-of-string
      .replace(/\{[^]*?"newFacts"[^]*\}\s*$/gi, "")
      .replace(/\{[^]*?"newReminders"[^]*\}\s*$/gi, "")
      .replace(/\{[^]*?"vibeCommand"[^]*\}\s*$/gi, "")
      .replace(/\{[^]*?"shapeCommand"[^]*\}\s*$/gi, "")
      .replace(/\{[^]*?"personaCommand"[^]*\}\s*$/gi, "")
      // Remove leftover key-value fragments that may have leaked mid-text
      .replace(/"newFacts"\s*:\s*\[.*?\]/gi, "")
      .replace(/"newReminders"\s*:\s*\[.*?\]/gi, "")
      .replace(/"vibeCommand"\s*:\s*(?:"[^"]*"|null)/gi, "")
      .replace(/"shapeCommand"\s*:\s*(?:"[^"]*"|null)/gi, "")
      .replace(/"personaCommand"\s*:\s*(?:"[^"]*"|null)/gi, "")
      // Clean up any dangling brackets or tags left behind
      .replace(/^\s*[{}\[\]]\s*$/gm, "")
      .replace(/<[^>]+>/g, "")
      .trim();

    if (!reply || reply.trim().length === 0) reply = "I\'m here.";

    // Persist memory
    if (meta.newFacts?.length || meta.newReminders?.length) {
      const uid = req.user.id;
      
      // Get current memory again to be safe
      const { data: currentMem } = await supabase
        .from("memories")
        .select("*")
        .eq("user_id", uid)
        .single();
      
      let updatedFacts = currentMem?.facts || [];
      for (const f of (meta.newFacts || [])) {
        const norm = f.toLowerCase().trim();
        if (!updatedFacts.some(e => e.toLowerCase().trim() === norm))
          updatedFacts.push(f);
      }
      if (updatedFacts.length > 20) updatedFacts = updatedFacts.slice(-20);

      await supabase.from("memories").upsert({
        user_id: uid,
        facts: updatedFacts,
        last_session: new Date().toISOString()
      });
    }

    // Persist reminders
    if (meta.newReminders?.length) {
      for (const r of meta.newReminders) {
        await supabase.from("reminders").insert({
          user_id: req.user.id,
          text: r,
          created_at: new Date().toISOString()
        });
      }
    }

    // Persist persona change
    if (meta.personaCommand && meta.personaCommand !== persona) {
      await supabase
        .from("users")
        .update({ persona: meta.personaCommand })
        .eq("id", req.user.id);
    }

    res.json({
      reply,
      vibeCommand:    meta.vibeCommand    || null,
      shapeCommand:   meta.shapeCommand   || null,
      personaCommand: meta.personaCommand || null
    });

  } catch (err) {
    console.error("AI Error:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  SPOTIFY INTEGRATION
//  SETUP (5 mins, free):
//  1. Go to https://developer.spotify.com/dashboard
//  2. Create an app → set Redirect URI to:
//       http://localhost:3000/api/spotify/callback
//       (+ your deployed URL if on Render/Railway)
//  3. Add to your .env:
//       SPOTIFY_CLIENT_ID=your_client_id
//       SPOTIFY_CLIENT_SECRET=your_client_secret
//  NOTE: Playback control requires Spotify Premium.
//        Free accounts can only read current track info.
// ═══════════════════════════════════════════════════════════════════

const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  ||
                              "http://127.0.0.1:3000/api/spotify/callback";

async function getSpotifyTokens(userId) {
  const { data: user } = await supabase
    .from("users")
    .select("spotify_tokens")
    .eq("id", userId)
    .single();
  return user?.spotify_tokens || null;
}

async function saveSpotifyTokens(userId, tokens) {
  const currentTokens = await getSpotifyTokens(userId);
  const updatedTokens = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token || currentTokens?.refresh_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000
  };
  
  await supabase
    .from("users")
    .update({ spotify_tokens: updatedTokens })
    .eq("id", userId);
}

async function refreshSpotifyToken(userId) {
  const tokens = getSpotifyTokens(userId);
  if (!tokens?.refresh_token) return null;
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: tokens.refresh_token
      })
    });
    const d = await r.json();
    if (d.access_token) { saveSpotifyTokens(userId, d); return d.access_token; }
  } catch {}
  return null;
}

async function getValidSpotifyToken(userId) {
  const tokens = getSpotifyTokens(userId);
  if (!tokens) return null;
  if (tokens.expires_at - Date.now() < 60000) return await refreshSpotifyToken(userId);
  return tokens.access_token;
}

// Step 1 — redirect user to Spotify login
app.get("/api/spotify/login", (req, res) => {
  if (!SPOTIFY_CLIENT_ID)
    return res.status(500).json({ error: "SPOTIFY_CLIENT_ID not set in .env" });

  // Token passed as query param because this opens in a popup (no auth header possible)
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: "Token required" });
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const scopes = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     SPOTIFY_CLIENT_ID,
    scope:         scopes,
    redirect_uri:  SPOTIFY_REDIRECT_URI,
    state:         userId
  });
  res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

// Step 2 — Spotify redirects back here
app.get("/api/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`<h2>Spotify auth failed: ${error}</h2>`);
  if (!code || !state) return res.status(400).send("Missing params");
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI })
    });
    const tokens = await r.json();
    if (!tokens.access_token) return res.status(500).send("Token exchange failed");
    await saveSpotifyTokens(state, tokens);
    res.send(`<script>window.opener?.postMessage('spotify-connected','*'); window.close();</script>`);
  } catch (e) {
    res.status(500).send("Spotify callback error: " + e.message);
  }
});

// Status + current track
app.get("/api/spotify/status", authMiddleware, async (req, res) => {
  const token = await getValidSpotifyToken(req.user.id);
  if (!token) return res.json({ connected: false });
  try {
    const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.status === 204 || r.status === 404) return res.json({ connected: true, playing: false });
    const d = await r.json();
    res.json({
      connected: true,
      playing:   d.is_playing,
      track:     d.item?.name || null,
      artist:    d.item?.artists?.[0]?.name || null,
      album:     d.item?.album?.name || null
    });
  } catch {
    res.json({ connected: true, playing: false });
  }
});

// Playback control
app.post("/api/spotify/control", authMiddleware, async (req, res) => {
  const { action, volume } = req.body;
  const token = await getValidSpotifyToken(req.user.id);
  if (!token) return res.status(401).json({ error: "Spotify not connected" });

  const sf = (url, method, body) => fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  try {
    if (action === "play")     { await sf("https://api.spotify.com/v1/me/player/play", "PUT"); }
    else if (action === "pause")    { await sf("https://api.spotify.com/v1/me/player/pause", "PUT"); }
    else if (action === "next")     { await sf("https://api.spotify.com/v1/me/player/next", "POST"); }
    else if (action === "previous") { await sf("https://api.spotify.com/v1/me/player/previous", "POST"); }
    else if (action === "volume")   { await sf(`https://api.spotify.com/v1/me/player/volume?volume_percent=${Math.round(volume||50)}`, "PUT"); }
    else return res.status(400).json({ error: "Unknown action" });
    res.json({ ok: true, action });
  } catch (e) {
    res.status(500).json({ error: "Spotify control failed" });
  }
});

// Search and play a specific song
app.post("/api/spotify/play-song", authMiddleware, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  const token = await getValidSpotifyToken(req.user.id);
  if (!token) return res.status(401).json({ error: "Spotify not connected" });

  try {
    // Step 1: Search for the track
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const track = searchData?.tracks?.items?.[0];
    if (!track) return res.json({ ok: false, message: "No track found for that search." });

    // Step 2: Play it on the active device
    const playRes = await fetch("https://api.spotify.com/v1/me/player/play", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: [track.uri] })
    });

    if (playRes.status === 404) {
      return res.json({ ok: false, message: "No active Spotify device found. Open Spotify on any device first." });
    }
    if (playRes.status === 403) {
      return res.json({ ok: false, message: "Spotify Premium is required for playback control." });
    }

    res.json({
      ok: true,
      track:  track.name,
      artist: track.artists?.[0]?.name || "Unknown",
      album:  track.album?.name || "Unknown"
    });

  } catch (e) {
    res.status(500).json({ error: "Search and play failed" });
  }
});

// Disconnect
app.post("/api/spotify/disconnect", authMiddleware, async (req, res) => {
  await supabase
    .from("users")
    .update({ spotify_tokens: null })
    .eq("id", req.user.id);
  res.json({ ok: true });
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Orbital core active on http://localhost:${PORT}`);
  });
}

export default app;
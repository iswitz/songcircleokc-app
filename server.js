const http = require("http");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const rootPrefix = `${root}${path.sep}`;
const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const dataDirectory = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(root, "data");
const databasePath = path.join(dataDirectory, "song-circle.db");
const songsDirectory = path.join(root, "songs");
const manifestPath = path.join(songsDirectory, "manifest.json");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

fs.mkdirSync(dataDirectory, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    song_key TEXT NOT NULL,
    youtube_url TEXT NOT NULL DEFAULT '',
    lyrics_markdown TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function send(response, status, body, contentType = "text/html; charset=utf-8", headers = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    ...headers
  });
  response.end(body);
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { Location: location, ...headers });
  response.end();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value = "") {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(cookieHeader.split(";").map((cookie) => {
    const [name, ...valueParts] = cookie.trim().split("=");
    return [name, decodeURIComponent(valueParts.join("=") || "")];
  }).filter(([name]) => name));
}

function themePreference(request) {
  return parseCookies(request.headers.cookie).theme === "dark";
}

function sessionCookie(token, expiresAt) {
  const secure = isProduction ? "; Secure" : "";
  return `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expiresAt).toUTCString()}${secure}`;
}

function clearSessionCookie() {
  const secure = isProduction ? "; Secure" : "";
  return `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passwordHash = crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
  return { passwordHash, salt };
}

function verifyPassword(password, user) {
  const { passwordHash } = hashPassword(password, user.password_salt);
  return crypto.timingSafeEqual(Buffer.from(passwordHash, "hex"), Buffer.from(user.password_hash, "hex"));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expiresAt);
  return { token, expiresAt };
}

function getCurrentUser(request) {
  const token = parseCookies(request.headers.cookie).session;

  if (!token) {
    return null;
  }

  const session = db.prepare(`
    SELECT sessions.token, sessions.expires_at, users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token);

  if (!session) {
    return null;
  }

  if (session.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  return { id: session.id, email: session.email, token };
}

function isDatastarRequest(request) {
  return request.headers["datastar-request"] === "true";
}

function parseFrontMatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: normalized.trim() };
  }

  const endIndex = normalized.indexOf("\n---", 4);

  if (endIndex === -1) {
    return { metadata: {}, body: normalized.trim() };
  }

  const metadata = {};
  const frontMatter = normalized.slice(4, endIndex).trim();
  const body = normalized.slice(endIndex + 4).trim();

  frontMatter.split("\n").forEach((line) => {
    const dividerIndex = line.indexOf(":");

    if (dividerIndex === -1) {
      return;
    }

    const key = line.slice(0, dividerIndex).trim().toLowerCase();
    const value = line.slice(dividerIndex + 1).trim();
    metadata[key] = value;
  });

  return { metadata, body };
}

function parseSections(body) {
  const sections = [];
  let currentSection = null;

  body.split("\n").forEach((rawLine) => {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+)$/);

    if (heading) {
      currentSection = { label: heading[1].trim(), lines: [] };
      sections.push(currentSection);
      return;
    }

    if (!currentSection) {
      if (!line.trim()) {
        return;
      }

      currentSection = { label: "Lyrics", lines: [] };
      sections.push(currentSection);
    }

    if (line.trim() || currentSection.lines.length) {
      currentSection.lines.push(line);
    }
  });

  return sections
    .map((section) => ({
      ...section,
      lines: section.lines.filter((line, index, lines) => line.trim() || index < lines.length - 1)
    }))
    .filter((section) => section.lines.length);
}

function getYouTubeEmbedUrl(value = "") {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  try {
    const url = new URL(trimmedValue);

    if (url.hostname.includes("youtube.com") && url.pathname === "/watch") {
      const videoId = url.searchParams.get("v");
      return videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}` : "";
    }

    if (url.hostname === "youtu.be") {
      const videoId = url.pathname.replace("/", "");
      return videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}` : "";
    }

    if (url.hostname.includes("youtube.com") && (url.pathname === "/embed" || url.pathname.startsWith("/embed/"))) {
      return url.toString();
    }
  } catch (error) {
    return "";
  }

  return "";
}

function normalizeSong(row) {
  return {
    id: row.slug,
    dbId: row.id,
    title: row.title,
    origin: row.origin,
    key: row.song_key,
    youtubeUrl: row.youtube_url || "",
    youtube: getYouTubeEmbedUrl(row.youtube_url || ""),
    lyricsMarkdown: row.lyrics_markdown,
    sections: parseSections(row.lyrics_markdown)
  };
}

function parseSongMarkdown(markdown, fileName) {
  const { metadata, body } = parseFrontMatter(markdown);
  const fallbackTitle = fileName
    .replace(/\.md$/i, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const title = metadata.title || fallbackTitle;

  return {
    slug: slugify(metadata.id || title || fileName),
    title,
    origin: metadata.origin || metadata.source || "Unknown",
    songKey: metadata.key || "-",
    youtubeUrl: metadata.youtube || "",
    lyricsMarkdown: body
  };
}

function seedSongsFromMarkdown() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM songs").get();

  if (existing.count > 0) {
    return;
  }

  let files = [];

  try {
    files = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (fs.existsSync(songsDirectory)) {
      files = fs.readdirSync(songsDirectory).filter((fileName) => fileName.endsWith(".md"));
    }
  }

  const insertSong = db.prepare(`
    INSERT INTO songs (slug, title, origin, song_key, youtube_url, lyrics_markdown)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  files.forEach((fileName) => {
    const filePath = path.join(songsDirectory, fileName);

    if (!fs.existsSync(filePath)) {
      return;
    }

    const song = parseSongMarkdown(fs.readFileSync(filePath, "utf8"), fileName);
    insertSong.run(song.slug, song.title, song.origin, song.songKey, song.youtubeUrl, song.lyricsMarkdown);
  });
}

seedSongsFromMarkdown();

function loadSongs() {
  return db.prepare("SELECT * FROM songs ORDER BY title COLLATE NOCASE").all().map(normalizeSong);
}

function selectedSong(songs, requestedId) {
  return songs.find((song) => song.id === requestedId) || songs[0] || null;
}

function filteredSongs(songs, query = "") {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return songs;
  }

  return songs.filter((song) => [song.title, song.origin, song.key].join(" ").toLowerCase().includes(normalizedQuery));
}

function formatChordLine(line) {
  return escapeHtml(line).replace(/\[([^\]]+)\]/g, '<span class="chord">$1</span>');
}

function getSongPayload(form) {
  const title = String(form.title || "").trim();
  const origin = String(form.origin || "").trim();
  const key = String(form.key || "").trim();
  const youtube = String(form.youtube || "").trim();
  const lyrics = String(form.lyrics || "").trim();

  if (!title || !origin || !key || !lyrics) {
    return { error: "Title, origin, key, and lyrics are required." };
  }

  return {
    slug: slugify(title) || "song",
    title,
    origin,
    key,
    youtube,
    lyrics
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 250000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readForm(request) {
  const body = await readRequestBody(request);
  return querystring.parse(body);
}

function songListHtml(songs, currentSongId, query = "") {
  const visibleSongs = filteredSongs(songs, query);

  return `
    <nav class="song-list" id="songList" aria-label="Songs">
      ${visibleSongs.length ? visibleSongs.map((song) => `
        <a
          class="song-item"
          href="/songs/${encodeURIComponent(song.id)}"
          data-song-id="${escapeAttr(song.id)}"
          aria-current="${song.id === currentSongId}"
          data-on:click__prevent="@get('/songs/${encodeURIComponent(song.id)}')"
        >
          <span class="song-item-title">${escapeHtml(song.title)}</span>
          <span class="song-item-meta">
            <span>${escapeHtml(song.origin)}</span>
            <span>Key ${escapeHtml(song.key)}</span>
          </span>
        </a>
      `).join("") : '<p class="empty-state">No matching songs.</p>'}
    </nav>
  `;
}

function authLinksHtml(user) {
  if (user) {
    return `
      <div class="auth-bar" id="authBar">
        <span>${escapeHtml(user.email)}</span>
        <form method="post" action="/logout">
          <button class="text-button" type="submit">Log out</button>
        </form>
      </div>
    `;
  }

  return `
    <div class="auth-bar" id="authBar">
      <a href="/login" data-on:click__prevent="@get('/login')">Log in</a>
      <a href="/signup" data-on:click__prevent="@get('/signup')">Sign up</a>
    </div>
  `;
}

function lyricsHtml(song, user) {
  if (!song) {
    return `
      <main class="lyrics-stage" id="content">
        <section class="song-header">
          <div>
            <p class="song-meta">Library</p>
            <h2>No songs found</h2>
          </div>
        </section>
        <article class="lyrics-card">
          <p class="empty-state">Add songs after signing in.</p>
        </article>
      </main>
    `;
  }

  return `
    <main class="lyrics-stage" id="content">
      <section class="song-header" aria-live="polite">
        <div>
          <p class="song-meta">${escapeHtml(song.origin)}</p>
          <h2>${escapeHtml(song.title)}</h2>
        </div>
        <div class="song-header-actions">
          ${user ? `<a class="tool-button" href="/songs/${encodeURIComponent(song.id)}/edit" data-on:click__prevent="@get('/songs/${encodeURIComponent(song.id)}/edit')">Edit</a>` : ""}
          ${user ? `
            <form class="inline-action-form" method="post" action="/songs/${encodeURIComponent(song.id)}/delete" onsubmit="return confirm('Delete this song? This cannot be undone.');">
              <button class="tool-button danger-button" type="submit">Delete</button>
            </form>
          ` : ""}
          <div class="key-badge" aria-label="Song key">${escapeHtml(song.key)}</div>
        </div>
      </section>

      <article class="lyrics-card" tabindex="0" aria-label="Selected song lyrics">
        <div class="lyrics-content" data-class:columns="$columns">
          ${song.sections.map((section) => `
            <section class="lyric-section">
              <div class="section-label">${escapeHtml(section.label)}</div>
              ${section.lines.map((line) => `<div class="lyric-line">${formatChordLine(line)}</div>`).join("")}
            </section>
          `).join("")}
        </div>
        ${song.youtube ? `
          <div class="video-embed">
            <iframe
              src="${escapeAttr(song.youtube)}"
              title="${escapeAttr(`${song.title} video`)}"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
            ></iframe>
          </div>
        ` : ""}
      </article>
    </main>
  `;
}

function songFormHtml({ mode, song = null, error = "" }) {
  const isEdit = mode === "edit";
  const action = isEdit ? `/songs/${encodeURIComponent(song.id)}` : "/songs";
  const backUrl = song?.id ? `/songs/${encodeURIComponent(song.id)}` : "/songs";

  return `
    <main class="lyrics-stage" id="content">
      <section class="form-view">
        <div class="form-header">
          <div>
            <p class="song-meta">Library</p>
            <h2>${isEdit ? "Edit Song" : "Add Song"}</h2>
          </div>
          <a class="tool-button" href="${backUrl}" data-on:click__prevent="@get('${backUrl}')">Back</a>
        </div>

        <form class="song-form" method="post" action="${action}">
          <label>
            <span>Title</span>
            <input name="title" type="text" value="${escapeAttr(song?.title || "")}" required autocomplete="off">
          </label>

          <div class="form-grid">
            <label>
              <span>Origin</span>
              <input name="origin" type="text" value="${escapeAttr(song?.origin || "")}" required autocomplete="off">
            </label>

            <label>
              <span>Key</span>
              <input name="key" type="text" value="${escapeAttr(song?.key || "")}" required autocomplete="off">
            </label>
          </div>

          <label>
            <span>YouTube URL</span>
            <input name="youtube" type="url" value="${escapeAttr(song?.youtubeUrl || "")}" autocomplete="off">
          </label>

          <label>
            <span>Lyrics</span>
            <textarea name="lyrics" required spellcheck="false" placeholder="## Verse 1&#10;&#10;[G]First lyric line&#10;Second lyric line&#10;&#10;## Chorus&#10;&#10;Chorus lyric line">${escapeHtml(song?.lyricsMarkdown || "")}</textarea>
          </label>

          <div class="form-actions">
            <button class="primary-button" type="submit">${isEdit ? "Update Song" : "Save Song"}</button>
            <p class="form-status" aria-live="polite">${escapeHtml(error)}</p>
          </div>
        </form>
      </section>
    </main>
  `;
}

function authFormHtml({ mode, error = "", next = "/" }) {
  const isSignup = mode === "signup";
  const action = isSignup ? "/signup" : "/login";

  return `
    <main class="lyrics-stage" id="content">
      <section class="form-view auth-view">
        <div class="form-header">
          <div>
            <p class="song-meta">Account</p>
            <h2>${isSignup ? "Sign Up" : "Log In"}</h2>
          </div>
          <a class="tool-button" href="/" data-on:click__prevent="@get('/')">Back</a>
        </div>

        <form class="song-form auth-form" method="post" action="${action}">
          <input type="hidden" name="next" value="${escapeAttr(next)}">
          <label>
            <span>Email</span>
            <input name="email" type="email" required autocomplete="email">
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" required autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="8">
          </label>
          <div class="form-actions">
            <button class="primary-button" type="submit">${isSignup ? "Create Account" : "Log In"}</button>
            <p class="form-status" aria-live="polite">${escapeHtml(error)}</p>
          </div>
          <p class="auth-switch">
            ${isSignup
              ? 'Already have an account? <a href="/login" data-on:click__prevent="@get(\'/login\')">Log in</a>.'
              : 'Need an account? <a href="/signup" data-on:click__prevent="@get(\'/signup\')">Sign up</a>.'}
          </p>
        </form>
      </section>
    </main>
  `;
}

function appHtml({ songs, currentSong, query = "", content = "", user = null, dark = false }) {
  const currentSongId = currentSong?.id || "";
  const signals = `{query: ${JSON.stringify(query)}, dark: ${dark ? "true" : "false"}, columns: false, lyricSize: 26, menuOpen: false}`;

  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Song Circle OKC Lyrics</title>
        <link rel="stylesheet" href="/styles.css">
        <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@main/bundles/datastar.js"></script>
        <script>
          (() => {
            const maxAge = 60 * 60 * 24 * 365;
            const themeCookie = (isDark) => {
              document.cookie = "theme=" + (isDark ? "dark" : "light") + "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax";
            };
            const storedTheme = localStorage.getItem("song-circle-theme");

            if (storedTheme === "dark" || storedTheme === "light") {
              document.documentElement.dataset.theme = storedTheme;
              themeCookie(storedTheme === "dark");
            }

            window.addEventListener("click", (event) => {
              if (!event.target.closest("[data-theme-toggle]")) {
                return;
              }

              window.setTimeout(() => {
                const isDark = document.body.classList.contains("dark");
                document.documentElement.dataset.theme = isDark ? "dark" : "light";
                localStorage.setItem("song-circle-theme", isDark ? "dark" : "light");
                themeCookie(isDark);
              }, 0);
            });
          })();
        </script>
        <script>
          (() => {
            let wakeLock = null;
            const isMobile = () => window.matchMedia("(max-width: 820px), (pointer: coarse)").matches;

            async function requestWakeLock() {
              if (!isMobile() || !("wakeLock" in navigator) || document.visibilityState !== "visible") {
                return;
              }

              try {
                wakeLock = await navigator.wakeLock.request("screen");
                wakeLock.addEventListener("release", () => {
                  wakeLock = null;
                });
              } catch (error) {
                wakeLock = null;
              }
            }

            function releaseWakeLock() {
              if (wakeLock) {
                wakeLock.release();
                wakeLock = null;
              }
            }

            document.addEventListener("visibilitychange", () => {
              if (document.visibilityState === "visible") {
                requestWakeLock();
              } else {
                releaseWakeLock();
              }
            });

            window.addEventListener("resize", () => {
              if (isMobile()) {
                requestWakeLock();
              } else {
                releaseWakeLock();
              }
            });

            ["pointerdown", "touchstart", "click"].forEach((eventName) => {
              window.addEventListener(eventName, requestWakeLock, { once: true, passive: true });
            });

            requestWakeLock();
          })();
        </script>
      </head>
      <body class="${dark ? "dark" : ""}" data-signals="${escapeAttr(signals)}" data-class:dark="$dark">
        <div class="app-shell" data-style="{'--lyric-size': $lyricSize + 'px'}">
          <button
            class="menu-button"
            type="button"
            aria-label="Open song library"
            data-attr:aria-expanded="$menuOpen ? 'true' : 'false'"
            data-on:click="$menuOpen = !$menuOpen"
          >
            <span class="hamburger-lines" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </span>
            <span>Menu</span>
          </button>

          <div class="menu-backdrop" data-show="$menuOpen" data-on:click="$menuOpen = false"></div>

          <aside class="library-panel" aria-label="Song library" data-class:open="$menuOpen">
            <div class="brand-row">
              <div>
                <p class="eyebrow">Song Circle OKC</p>
                <h1>Lyrics</h1>
              </div>
              <button class="close-menu-button" type="button" aria-label="Close song library" data-on:click="$menuOpen = false">Close</button>
            </div>

            ${authLinksHtml(user)}

            <label class="search-field">
              <span class="visually-hidden">Search songs</span>
              <input
                type="search"
                placeholder="Search songs or keys"
                autocomplete="off"
                data-bind:query
                data-on:input="@get('/library?query=' + encodeURIComponent($query))"
              >
            </label>

            <div class="toolbar-row" aria-label="Lyrics controls">
              <button class="tool-button" type="button" aria-label="Decrease lyric size" title="Decrease lyric size" data-on:click="$lyricSize = Math.max(18, $lyricSize - 2)">A-</button>
              <button class="tool-button" type="button" aria-label="Increase lyric size" title="Increase lyric size" data-on:click="$lyricSize = Math.min(42, $lyricSize + 2)">A+</button>
              <button class="tool-button" type="button" aria-label="Toggle dark mode" title="Toggle dark mode" data-theme-toggle data-on:click="$dark = !$dark" data-text="$dark ? 'Light' : 'Dark'">Dark</button>
              <button class="tool-button" type="button" aria-label="Toggle lyric columns" title="Toggle lyric columns" data-on:click="$columns = !$columns">Cols</button>
            </div>

            ${user ? '<a class="add-song-button" href="/songs/new" data-on:click__prevent="@get(\'/songs/new\')">Add Song</a>' : '<a class="add-song-button" href="/login?next=/songs/new" data-on:click__prevent="@get(\'/login?next=/songs/new\')">Log in to Add</a>'}

            ${songListHtml(songs, currentSongId, query)}
          </aside>

          ${content || lyricsHtml(currentSong, user)}
        </div>
      </body>
    </html>`;
}

function renderShell(response, request, content = "", selectedId = "", status = 200) {
  const user = getCurrentUser(request);
  const songs = loadSongs();
  const currentSong = selectedSong(songs, selectedId);
  send(response, status, appHtml({ songs, currentSong, content, user, dark: themePreference(request) }));
}

function guardedContent(response, request, content, selectedId = "", status = 200) {
  if (isDatastarRequest(request)) {
    send(response, status, content);
    return;
  }

  renderShell(response, request, content, selectedId, status);
}

function requireUser(response, request, next = request.url) {
  const user = getCurrentUser(request);

  if (user) {
    return user;
  }

  const loginPath = `/login?next=${encodeURIComponent(next)}`;

  if (isDatastarRequest(request)) {
    send(response, 401, authFormHtml({ mode: "login", next, error: "Log in to continue." }));
    return null;
  }

  redirect(response, loginPath);
  return null;
}

function createSong(request, response, user) {
  readForm(request).then((form) => {
    const payload = getSongPayload(form);

    if (payload.error) {
      guardedContent(response, request, songFormHtml({ mode: "add", song: form, error: payload.error }), "", 400);
      return;
    }

    const existing = db.prepare("SELECT id FROM songs WHERE slug = ?").get(payload.slug);

    if (existing) {
      guardedContent(response, request, songFormHtml({ mode: "add", song: form, error: "A song with that title already exists." }), "", 409);
      return;
    }

    db.prepare(`
      INSERT INTO songs (slug, title, origin, song_key, youtube_url, lyrics_markdown, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(payload.slug, payload.title, payload.origin, payload.key, payload.youtube, payload.lyrics, user.id, user.id);

    const songs = loadSongs();
    const song = selectedSong(songs, payload.slug);
    if (isDatastarRequest(request)) {
      send(response, 201, `${songListHtml(songs, song.id)}${lyricsHtml(song, user)}`);
      return;
    }

    redirect(response, `/songs/${encodeURIComponent(song.id)}`);
  }).catch((error) => {
    console.error(error);
    send(response, 500, "Server error", "text/plain; charset=utf-8");
  });
}

function updateSong(request, response, user, currentSlug) {
  readForm(request).then((form) => {
    const payload = getSongPayload(form);

    if (payload.error) {
      guardedContent(response, request, songFormHtml({ mode: "edit", song: { ...form, id: currentSlug }, error: payload.error }), currentSlug, 400);
      return;
    }

    const current = db.prepare("SELECT * FROM songs WHERE slug = ?").get(currentSlug);

    if (!current) {
      guardedContent(response, request, lyricsHtml(null, user), "", 404);
      return;
    }

    const duplicate = db.prepare("SELECT id FROM songs WHERE slug = ? AND slug != ?").get(payload.slug, currentSlug);

    if (duplicate) {
      guardedContent(response, request, songFormHtml({ mode: "edit", song: { ...form, id: currentSlug }, error: "A song with that title already exists." }), currentSlug, 409);
      return;
    }

    db.prepare(`
      UPDATE songs
      SET slug = ?, title = ?, origin = ?, song_key = ?, youtube_url = ?, lyrics_markdown = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE slug = ?
    `).run(payload.slug, payload.title, payload.origin, payload.key, payload.youtube, payload.lyrics, user.id, currentSlug);

    const songs = loadSongs();
    const song = selectedSong(songs, payload.slug);
    if (isDatastarRequest(request)) {
      send(response, 200, `${songListHtml(songs, song.id)}${lyricsHtml(song, user)}`);
      return;
    }

    redirect(response, `/songs/${encodeURIComponent(song.id)}`);
  }).catch((error) => {
    console.error(error);
    send(response, 500, "Server error", "text/plain; charset=utf-8");
  });
}

function deleteSong(request, response, user, currentSlug) {
  const current = db.prepare("SELECT * FROM songs WHERE slug = ?").get(currentSlug);

  if (!current) {
    guardedContent(response, request, lyricsHtml(null, user), "", 404);
    return;
  }

  db.prepare("DELETE FROM songs WHERE slug = ?").run(currentSlug);

  const songs = loadSongs();
  const currentSong = selectedSong(songs, "");

  if (isDatastarRequest(request)) {
    send(response, 200, `${songListHtml(songs, currentSong?.id || "")}${lyricsHtml(currentSong, user)}`);
    return;
  }

  redirect(response, currentSong ? `/songs/${encodeURIComponent(currentSong.id)}` : "/songs");
}

async function createAccount(request, response) {
  const form = await readForm(request);
  const email = String(form.email || "").trim().toLowerCase();
  const password = String(form.password || "");
  const next = String(form.next || "/");

  if (!email || password.length < 8) {
    guardedContent(response, request, authFormHtml({ mode: "signup", next, error: "Use an email and a password with at least 8 characters." }), "", 400);
    return;
  }

  const { passwordHash, salt } = hashPassword(password);

  try {
    const result = db.prepare("INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)").run(email, passwordHash, salt);
    const session = createSession(result.lastInsertRowid);
    redirect(response, next, { "Set-Cookie": sessionCookie(session.token, session.expiresAt) });
  } catch (error) {
    if (error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || error.message?.includes("UNIQUE constraint failed: users.email")) {
      guardedContent(response, request, authFormHtml({ mode: "signup", next, error: "An account already exists for that email." }), "", 409);
      return;
    }

    throw error;
  }
}

async function login(request, response) {
  const form = await readForm(request);
  const email = String(form.email || "").trim().toLowerCase();
  const password = String(form.password || "");
  const next = String(form.next || "/");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user || !verifyPassword(password, user)) {
    guardedContent(response, request, authFormHtml({ mode: "login", next, error: "Email or password is incorrect." }), "", 401);
    return;
  }

  const session = createSession(user.id);
  redirect(response, next, { "Set-Cookie": sessionCookie(session.token, session.expiresAt) });
}

function logout(request, response) {
  const token = parseCookies(request.headers.cookie).session;

  if (token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  redirect(response, "/", { "Set-Cookie": clearSessionCookie() });
}

async function serveStatic(response, requestPath) {
  const filePath = path.resolve(root, requestPath.slice(1));

  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      send(response, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Server error", "text/plain; charset=utf-8");
      return;
    }

    send(response, 200, content, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const requestPath = decodeURIComponent(url.pathname);
  const user = getCurrentUser(request);

  try {
    if (request.method === "GET" && requestPath === "/healthz") {
      const songCount = db.prepare("SELECT COUNT(*) AS count FROM songs").get().count;
      send(response, 200, JSON.stringify({ ok: true, songs: songCount }), "application/json; charset=utf-8", {
        "Cache-Control": "no-store"
      });
      return;
    }

    if (request.method === "GET" && requestPath === "/") {
      const songs = loadSongs();
      const currentSong = selectedSong(songs, "");
      send(response, 200, appHtml({ songs, currentSong, user, dark: themePreference(request) }));
      return;
    }

    if (request.method === "GET" && requestPath === "/library") {
      const songs = loadSongs();
      send(response, 200, songListHtml(songs, "", url.searchParams.get("query") || ""));
      return;
    }

    if (request.method === "GET" && requestPath === "/login") {
      guardedContent(response, request, authFormHtml({ mode: "login", next: url.searchParams.get("next") || "/" }));
      return;
    }

    if (request.method === "GET" && requestPath === "/signup") {
      guardedContent(response, request, authFormHtml({ mode: "signup", next: url.searchParams.get("next") || "/" }));
      return;
    }

    if (request.method === "POST" && requestPath === "/signup") {
      await createAccount(request, response);
      return;
    }

    if (request.method === "POST" && requestPath === "/login") {
      await login(request, response);
      return;
    }

    if (request.method === "POST" && requestPath === "/logout") {
      logout(request, response);
      return;
    }

    if (request.method === "GET" && requestPath === "/songs") {
      const songs = loadSongs();
      const currentSong = selectedSong(songs, "");
      const content = `${songListHtml(songs, currentSong?.id || "")}${lyricsHtml(currentSong, user)}`;
      send(response, 200, isDatastarRequest(request) ? content : appHtml({ songs, currentSong, user, dark: themePreference(request) }));
      return;
    }

    if (request.method === "GET" && requestPath === "/songs/new") {
      const authedUser = requireUser(response, request, "/songs/new");

      if (!authedUser) {
        return;
      }

      guardedContent(response, request, songFormHtml({ mode: "add" }));
      return;
    }

    const editMatch = requestPath.match(/^\/songs\/([^/]+)\/edit$/);
    if (request.method === "GET" && editMatch) {
      const authedUser = requireUser(response, request, requestPath);

      if (!authedUser) {
        return;
      }

      const row = db.prepare("SELECT * FROM songs WHERE slug = ?").get(editMatch[1]);

      if (!row) {
        send(response, 404, lyricsHtml(null, authedUser));
        return;
      }

      guardedContent(response, request, songFormHtml({ mode: "edit", song: normalizeSong(row) }));
      return;
    }

    const songMatch = requestPath.match(/^\/songs\/([^/]+)$/);
    if (request.method === "GET" && songMatch) {
      const songs = loadSongs();
      const currentSong = selectedSong(songs, songMatch[1]);
      const content = `${songListHtml(songs, currentSong?.id || "")}${lyricsHtml(currentSong, user)}`;
      send(response, 200, isDatastarRequest(request) ? content : appHtml({ songs, currentSong, user, dark: themePreference(request) }));
      return;
    }

    if (request.method === "POST" && requestPath === "/songs") {
      const authedUser = requireUser(response, request, "/songs/new");

      if (!authedUser) {
        return;
      }

      createSong(request, response, authedUser);
      return;
    }

    const updateMatch = requestPath.match(/^\/songs\/([^/]+)$/);
    if (request.method === "POST" && updateMatch) {
      const authedUser = requireUser(response, request, `/songs/${updateMatch[1]}/edit`);

      if (!authedUser) {
        return;
      }

      updateSong(request, response, authedUser, updateMatch[1]);
      return;
    }

    const deleteMatch = requestPath.match(/^\/songs\/([^/]+)\/delete$/);
    if (request.method === "POST" && deleteMatch) {
      const authedUser = requireUser(response, request, `/songs/${deleteMatch[1]}`);

      if (!authedUser) {
        return;
      }

      deleteSong(request, response, authedUser, deleteMatch[1]);
      return;
    }

    if (request.method === "GET" && ["/styles.css", "/songs/manifest.json"].includes(requestPath)) {
      await serveStatic(response, requestPath);
      return;
    }

    if (request.method === "GET" && requestPath.startsWith("/songs/") && requestPath.endsWith(".md")) {
      await serveStatic(response, requestPath);
      return;
    }

    if (request.method === "GET" && requestPath === "/index.html") {
      redirect(response, "/");
      return;
    }

    send(response, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    console.error(error);
    send(response, 500, "Server error", "text/plain; charset=utf-8");
  }
});

server.listen(port, host, () => {
  console.log(`Song Circle OKC Lyrics running at http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});

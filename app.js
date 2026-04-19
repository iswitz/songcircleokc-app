const songs = [
  {
    id: "amazing-grace",
    title: "Amazing Grace",
    source: "Traditional",
    key: "G",
    tempo: "Slow",
    feel: "Straight, spacious",
    leader: "Open",
    sections: [
      {
        label: "Verse 1",
        lines: [
          "[G]Amazing grace, how [C]sweet the [G]sound",
          "That saved a wretch like [D]me",
          "I [G]once was lost, but [C]now am [G]found",
          "Was blind, but [D]now I [G]see"
        ]
      },
      {
        label: "Verse 2",
        lines: [
          "Twas grace that taught my heart to fear",
          "And grace my fears relieved",
          "How precious did that grace appear",
          "The hour I first believed"
        ]
      }
    ]
  },
  {
    id: "shenandoah",
    title: "Shenandoah",
    source: "Traditional",
    key: "D",
    tempo: "Ballad",
    feel: "Rubato",
    leader: "Open",
    sections: [
      {
        label: "Verse 1",
        lines: [
          "Oh [D]Shenandoah, I long to [G]hear you",
          "Away, you rolling [A]river",
          "Oh Shenandoah, I long to hear you",
          "Away, I am bound away",
          "Across the wide Missouri"
        ]
      },
      {
        label: "Verse 2",
        lines: [
          "Oh Shenandoah, I love your daughter",
          "Away, you rolling river",
          "For her I would cross your roaming waters",
          "Away, I am bound away",
          "Across the wide Missouri"
        ]
      }
    ]
  },
  {
    id: "swing-low",
    title: "Swing Low, Sweet Chariot",
    source: "Traditional",
    key: "C",
    tempo: "Medium",
    feel: "Gospel sway",
    leader: "Open",
    sections: [
      {
        label: "Chorus",
        lines: [
          "[C]Swing low, sweet chariot",
          "Coming for to carry me [G]home",
          "[C]Swing low, sweet [F]chariot",
          "[C]Coming for to [G]carry me [C]home"
        ]
      },
      {
        label: "Verse",
        lines: [
          "I looked over Jordan, and what did I see",
          "Coming for to carry me home",
          "A band of angels coming after me",
          "Coming for to carry me home"
        ]
      }
    ]
  },
  {
    id: "red-river-valley",
    title: "Red River Valley",
    source: "Traditional",
    key: "A",
    tempo: "Waltz",
    feel: "Gentle",
    leader: "Open",
    sections: [
      {
        label: "Verse 1",
        lines: [
          "From this [A]valley they say you are going",
          "We will miss your bright eyes and sweet [E]smile",
          "For they [A]say you are taking the [D]sunshine",
          "That has [E]brightened our pathway a [A]while"
        ]
      },
      {
        label: "Chorus",
        lines: [
          "Come and sit by my side if you love me",
          "Do not hasten to bid me adieu",
          "But remember the Red River Valley",
          "And the one who has loved you so true"
        ]
      }
    ]
  }
];

const state = {
  currentSongId: songs[0].id,
  query: "",
  fontSize: 26,
  columns: false
};

const elements = {
  body: document.body,
  list: document.querySelector("#songList"),
  search: document.querySelector("#songSearch"),
  title: document.querySelector("#songTitle"),
  meta: document.querySelector("#songMeta"),
  key: document.querySelector("#songKey"),
  tempo: document.querySelector("#songTempo"),
  feel: document.querySelector("#songFeel"),
  leader: document.querySelector("#songLeader"),
  lyrics: document.querySelector("#lyricsContent"),
  lyricsCard: document.querySelector("#lyricsCard"),
  decreaseFont: document.querySelector("#decreaseFont"),
  increaseFont: document.querySelector("#increaseFont"),
  themeToggle: document.querySelector("#themeToggle"),
  columnsToggle: document.querySelector("#columnsToggle"),
  presentButton: document.querySelector("#presentButton")
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatChordLine(line) {
  return escapeHtml(line).replace(/\[([^\]]+)\]/g, '<span class="chord">$1</span>');
}

function getFilteredSongs() {
  const query = state.query.trim().toLowerCase();

  if (!query) {
    return songs;
  }

  return songs.filter((song) => {
    const haystack = [
      song.title,
      song.source,
      song.key,
      song.tempo,
      song.feel,
      song.leader
    ].join(" ").toLowerCase();

    return haystack.includes(query);
  });
}

function renderSongList() {
  const filteredSongs = getFilteredSongs();

  if (!filteredSongs.length) {
    elements.list.innerHTML = '<p class="empty-state">No matching songs.</p>';
    return;
  }

  elements.list.innerHTML = filteredSongs.map((song) => `
    <button class="song-item" type="button" data-song-id="${song.id}" aria-current="${song.id === state.currentSongId}">
      <span class="song-item-title">${escapeHtml(song.title)}</span>
      <span class="song-item-meta">
        <span>${escapeHtml(song.source)}</span>
        <span>Key ${escapeHtml(song.key)}</span>
      </span>
    </button>
  `).join("");
}

function renderCurrentSong() {
  const song = songs.find((candidate) => candidate.id === state.currentSongId) ?? songs[0];

  elements.title.textContent = song.title;
  elements.meta.textContent = song.source;
  elements.key.textContent = song.key;
  elements.tempo.textContent = song.tempo;
  elements.feel.textContent = song.feel;
  elements.leader.textContent = song.leader;

  elements.lyrics.classList.toggle("columns", state.columns);
  elements.lyrics.innerHTML = song.sections.map((section) => `
    <section class="lyric-section">
      <div class="section-label">${escapeHtml(section.label)}</div>
      ${section.lines.map((line) => `<div class="lyric-line">${formatChordLine(line)}</div>`).join("")}
    </section>
  `).join("");
}

function setFontSize(size) {
  state.fontSize = Math.min(42, Math.max(18, size));
  document.documentElement.style.setProperty("--lyric-size", `${state.fontSize}px`);
}

elements.list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-song-id]");

  if (!button) {
    return;
  }

  state.currentSongId = button.dataset.songId;
  renderSongList();
  renderCurrentSong();
  elements.lyricsCard.focus();
});

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderSongList();
});

elements.decreaseFont.addEventListener("click", () => setFontSize(state.fontSize - 2));
elements.increaseFont.addEventListener("click", () => setFontSize(state.fontSize + 2));

elements.themeToggle.addEventListener("click", () => {
  elements.body.classList.toggle("dark");
  elements.themeToggle.textContent = elements.body.classList.contains("dark") ? "☀" : "☾";
});

elements.columnsToggle.addEventListener("click", () => {
  state.columns = !state.columns;
  renderCurrentSong();
});

elements.presentButton.addEventListener("click", () => {
  elements.body.classList.toggle("presenting");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    elements.body.classList.remove("presenting");
  }
});

renderSongList();
renderCurrentSong();

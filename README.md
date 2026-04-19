# Song Circle OKC Lyrics

A small Node.js web app for displaying song-circle lyrics, with SQLite-backed songs and account-gated add/edit.

## Requirements

- Node.js 25 or newer
- A writable data directory for SQLite

The app uses Node's built-in `node:sqlite` module, so there are no npm runtime dependencies.

## Local Development

```powershell
npm run dev
```

Open:

```text
http://localhost:8000
```

## Configuration

Environment variables:

- `NODE_ENV`: set to `production` in production
- `HOST`: bind address, default `0.0.0.0`
- `PORT`: port, default `8000`
- `DATA_DIR`: directory for `song-circle.db`, default `./data`

In production, persist `DATA_DIR` so songs, users, and sessions survive restarts.

## Deploy

1. Copy the repo to the server.
2. Use Node.js 25+.
3. Set environment variables:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=8000
DATA_DIR=/var/lib/song-circle-okc
```

4. Start the app:

```bash
npm start
```

5. Point your reverse proxy or platform routing at the configured port.

Health check:

```text
/healthz
```

## Data

On first startup, if the database has no songs, the app seeds from the Markdown files in `songs/`.

After that, song add/edit writes to SQLite.

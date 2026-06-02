# UniCentral

## Project
Central web dashboard for remote management of Windows and Linux machines via lightweight agents.

## Tech Stack
- Server: Node.js + Express, SQLite (better-sqlite3), WebSocket (ws)
- Frontend: Vue.js 3 (CDN, no build step)
- Agent: Go single binary
- Deployment: Docker

## Structure
- `server/` - Express backend (routes, WebSocket handlers, services)
- `server/public/` - Vue.js frontend (served statically)
- `agent/` - Go agent source code
- `releases/` - Compiled agent binaries (gitignored)

## Git Commits
- Never add "Co-Authored-By" lines or any AI/Claude attribution to commit messages.
- After every change, commit and push to git.
- With every push, increment the patch version in `package.json` (e.g. 0.1.0 → 0.1.1).

## Commands
- Start: `npm start` or `docker-compose up`
- Dev: `npm run dev` (auto-restart on changes)
- Agent build: `cd agent && go build -o unicentral-agent`

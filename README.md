# AIMSTRIKE

A competitive, skill-first multiplayer first-person shooter that runs in the browser.
No abilities, no aim assist, no random spread, no unlocks — every player has the same
movement and the same six weapons, and the better aim wins.

- **Real online multiplayer.** A Node.js server simulates every match authoritatively;
  browsers only send input. Players on different computers join each other with a
  six-character lobby code.
- **Server-validated hit detection** with per-body-part hitboxes (head, torso, arms, legs, feet),
  walls that stop bullets, and bounded lag compensation.
- **Six original weapons** with distinct, configurable stats and fixed, learnable recoil patterns.
- **Client-side prediction, server reconciliation and entity interpolation** so movement and
  shooting feel immediate on ordinary internet connections.
- Team Deathmatch and Free-for-All, two original maps, lobbies, scoreboard, results, rematch,
  reconnect, settings, synthesised positional audio.

All art, maps, weapon names and sounds are original and generated in code — the repository
contains no third-party game assets.

---

## Quick start

Requires **Node.js 20+**.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The dev script starts the game server on `:2567` and the Vite
client on `:5173` (which proxies `/ws` to the server). In dev the server runs with
`MIN_PLAYERS=1` so you can start a match alone to look around.

To play with someone on your network, give them `http://<your-LAN-IP>:5173`, create a lobby
and tell them the code.

### All commands

| Command | What it does |
|---|---|
| `npm run dev` | Server + client with hot reload |
| `npm run dev:server` / `npm run dev:client` | Run one side only |
| `npm run build` | Production build: `client/dist` (static site) and `server/dist/index.js` (single-file server) |
| `npm start` | Run the production server; it also serves `client/dist` if present |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run typecheck` | Strict TypeScript check of all three packages |
| `npm run e2e` | Two-browser end-to-end test against the production build (needs `npm run build` first and Playwright's Chromium) |

### Production, one process

```bash
npm run build
npm start          # http://localhost:2567 serves the game and the WebSocket endpoint
```

---

## Controls

| Input | Action |
|---|---|
| W / A / S / D | Move |
| Mouse | Look and aim |
| Left mouse | Shoot |
| R | Reload |
| Space | Jump |
| Shift | Walk (silent and fully accurate) |
| 1–6 / mouse wheel | Switch weapon |
| Tab | Scoreboard |
| Esc | Pause / settings |

## How the gunplay works

- **Bullets go where the crosshair is.** Hit-scan rays, no random spread, no critical hits.
- **Recoil is a fixed pattern per weapon.** The view climbs by exactly the recoil offset, so the
  crosshair always marks where the next bullet will go. The first shot is perfectly accurate.
- **Movement inaccuracy is deterministic and visible.** Standing still or walking (Shift) is
  perfectly accurate. Running and jumping add a cone whose size is shown by the crosshair gap.
- **Damage** = weapon damage × body-part multiplier × distance falloff, rounded.

| Hit location | Multiplier |
|---|---|
| Head | 2.5× by default (each weapon sets its own headshot multiplier) |
| Torso | 1.0× |
| Arms | 0.9× |
| Legs | 0.75× |
| Feet | 0.6× |

### Weapons

| # | Weapon | Class | Damage | Head | Fire rate | Mag | Full-damage range | Specialty | Tradeoff |
|---|---|---|---|---|---|---|---|---|---|
| 1 | VX-9 Vanguard | Standard rifle | 30 | 2.5× | 600 rpm auto | 30 | 30 m | Balanced everywhere | Nothing stands out |
| 2 | Halcyon PR | Precision rifle | 38 | 3.0× | 188 rpm semi | 12 | 40 m | One-shot headshots | Slow if you miss |
| 3 | Wasp-45 | Rapid SMG | 19 | 2.2× | 900 rpm auto | 32 | 10 m | Close-range tracking, fastest movement | Halves damage at distance |
| 4 | Trident B3 | Burst rifle | 27 | 2.5× | 3-round burst | 27 | 35 m | Tight, controlled bursts | Long gap between bursts |
| 5 | Bulwark H7 | Heavy rifle | 48 | 2.2× | 277 rpm auto | 20 | 25 m | Highest automatic damage per shot | Slow draw, movement, reload; hard recoil |
| 6 | Longshot M1 | Marksman rifle | 72 | 2.5× | 67 rpm semi | 5 | No falloff | Two body shots at any range | Tiny magazine, slow follow-up |

### Balancing

Everything is data:

- `shared/src/weapons.ts` — damage, headshot multiplier, fire rate, burst, range/falloff, magazine,
  reserve, reload time, draw time, movement multiplier, recoil pattern, movement spread, model and
  sound profile for every weapon.
- `shared/src/constants.ts` — body-part multipliers, movement speeds, gravity, tick rates.
- `shared/src/modes.ts` — score limit, match length, respawn delay, spawn protection.
- `DAMAGE_MULTIPLIERS` (server env var, JSON) overrides body-part multipliers without a rebuild.

Weapon and movement values are used by both client prediction and the server, so rebuild and
redeploy both after changing them.

---

## Architecture

```
shared/   Deterministic game rules used by BOTH sides (TypeScript source, no build step)
            sim.ts        movement + weapon state machine, one fixed 60 Hz tick per input command
            collision.ts  player-vs-map collision and ray-vs-world
            hitbox.ts     body-part hitboxes, ray-vs-player, damage formula
            weapons.ts    weapon table            maps.ts   map geometry + spawns
            modes.ts      game mode rules         protocol.ts  wire message types
server/   Authoritative game server (Node.js + ws)
            GameServer.ts  HTTP + WebSocket, validation, rate limiting, lobby registry, tick loop
            Room.ts        lobby: codes, teams, ready state, host migration, reconnect slots
            Match.ts       simulation: input queues, shots, lag compensation, scores, timers, respawns
client/   Browser client (React + Zustand for UI, Three.js for rendering)
            game/Game.ts   input → prediction → reconciliation → interpolation → render
            game/*         world, player models, first-person weapon, pooled effects, audio, input
            net/           WebSocket connection with reconnect + session resume
            ui/            menus, lobby, settings, HUD, scoreboard, results
```

### Who decides what

| Server (authoritative) | Client |
|---|---|
| Lobby membership, host, teams, ready state | Input capture, pointer lock |
| Spawning and respawning | Rendering and effects |
| Movement (re-simulates every input command) | Predicting its **own** movement and weapon state |
| Whether a weapon fired, and where the bullet went | Interpolating other players ~100 ms in the past |
| Hit detection, damage, health, eliminations | UI, audio |
| Scores, match timer, win condition | Reconciling to the server's state |

### Networking model

- **Input commands.** The client runs the shared simulation at a fixed 60 Hz. Each tick produces a
  command `[seq, buttons, yaw, pitch, weapon]` that is applied locally at once (prediction) and sent
  to the server.
- **Server simulation.** The server runs the *same* `stepSim` function on the same commands. Firing
  is part of the command stream, so fire rate, magazines, reloads and recoil are enforced by the
  server's own weapon state — a client cannot fire faster, skip reloads or fake a hit.
- **Snapshots** go out at 30 Hz with each client's authoritative state and the last command
  sequence the server consumed.
- **Reconciliation.** The client resets to the server state and replays unacknowledged commands.
  Because the simulation is deterministic the result normally matches exactly; small differences are
  blended away instead of snapping the camera.
- **Interpolation.** Other players are drawn between two snapshots, 100 ms behind the server.
- **Lag compensation.** Each command carries the server timestamp the client was rendering. When a
  shot is resolved the server rewinds other players to that time, clamped to at most 250 ms in the
  past and never the future.
- **Anti-abuse.** Per-connection message rate limit, 8 KB frame cap, strict validation of every field,
  a command "time bank" so a client can never simulate faster than real time, duplicate/replayed
  command sequence numbers ignored, and connections that keep sending garbage are closed.
- **Reconnect.** The client retries with backoff and presents a session token; the server holds a
  player's slot for 30 s and drops them back into the lobby or the running match.

### Why `ws` and plain Three.js instead of Colyseus and React Three Fiber

The brief allows substitutions with a technical justification:

- **`ws` rather than Colyseus.** The game needs command-stream simulation, a custom time bank and
  per-shot history rewind. Colyseus' automatic state-diff synchronisation does not model those, so
  the room abstraction would be bypassed for everything that matters while adding a dependency and
  a client SDK. The hand-written protocol is small (`shared/src/protocol.ts`) and fully typed.
- **Three.js directly rather than React Three Fiber.** The frame loop must apply mouse input and
  render with as little latency as possible and without per-frame allocations. Keeping the game loop
  imperative and outside React's reconciler makes that straightforward. React and Zustand are used
  for what they are good at: menus, lobby and HUD.

---

## Hosting the multiplayer server

The server is a single Node process. It needs one port and no database.

```bash
npm install && npm run build
PORT=2567 npm start
```

or with Docker:

```bash
docker build -t aimstrike .
docker run -p 2567:2567 aimstrike
```

or `docker compose up --build`.

- Health check: `GET /health` → `{"ok":true,"rooms":0,"players":0,"protocol":1}`
- WebSocket endpoint: `/ws`
- Configuration: environment variables, documented in [`.env.example`](.env.example)

All matches of one server live in that process's memory. Run one instance per region; do not put
several instances behind a load balancer without sticky routing, because a lobby code only exists on
the instance that created it.

## Deploying online

HTTPS pages can only open secure WebSockets, so in production the server must be reached over
`https://` / `wss://`. Every platform below terminates TLS for you; the client automatically uses
`wss://` whenever the page is served over `https://`.

### Option A — one service (simplest)

Deploy the Docker image (or `npm run build && npm start`) to any host that supports WebSockets:
Render, Railway, Fly.io, a VPS, etc. The server serves the web client itself, so the public URL of
that one service is the game. No build-time configuration is needed because the client connects
back to its own origin.

Example, Render: *New → Web Service → this repository → Runtime: Docker*. Leave the health check
path as `/health`. Open the generated `https://….onrender.com` URL.

Example, Fly.io: `fly launch` (it detects the Dockerfile, internal port `2567`), then `fly deploy`.

Example, VPS: run the container on port 2567 and put Caddy or nginx in front for TLS. Minimal Caddyfile:

```
play.example.com {
    reverse_proxy localhost:2567
}
```

For nginx, remember the WebSocket upgrade headers on `/ws`:

```
location /ws {
    proxy_pass http://127.0.0.1:2567;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

### Option B — static frontend + separate backend

1. Deploy the backend as in option A (set `CLIENT_DIST=` to an empty value if you do not want it to
   serve the site as well).
2. Build the client pointing at it and deploy `client/dist` to any static host (Netlify, Vercel,
   Cloudflare Pages, GitHub Pages, S3):

   ```bash
   VITE_SERVER_URL=https://your-game-server.example.com npm run build -w client
   ```

   On Netlify/Vercel/Cloudflare Pages: build command `npm run build -w client`, output directory
   `client/dist`, environment variable `VITE_SERVER_URL`.
3. Optionally set `ALLOWED_ORIGINS=https://your-frontend.example.com` on the server so only your
   site may connect.

There are no hardcoded `localhost` addresses in the production build: the client uses
`VITE_SERVER_URL` when set and its own origin otherwise.

---

## Testing

### Executed automatically (`npm test`, 53 tests)

`shared/test/sim.test.ts` — rules, with no network:

- Each body part is identified from where the ray lands; hitboxes rotate with the player.
- Damage order head > torso > arms > legs > feet for every weapon; multipliers are configurable; falloff.
- Walls stop rays.
- Acceleration, friction, walk vs run, weapon weight, jumping, landing on crates, no passing through walls,
  staying inside the map.
- The simulation is deterministic.
- All six weapons: distinct stats, fire rates, semi-auto, three-round burst, magazines, reserve,
  manual and automatic reload, draw delay, repeatable recoil, movement accuracy, time-to-kill spread.
- Maps: spawn points are clear, layouts are mirror-symmetric.

`server/test/lobby.test.ts` and `server/test/match.test.ts` — a real server on a real port, driven by
real WebSocket clients speaking the production protocol:

- Create lobby, unique six-character code, host assignment; join by code; live roster.
- Invalid code, unknown code, full lobby, duplicate and unsafe names, team full, non-host actions,
  not-ready and not-enough-players start attempts.
- Host migration on disconnect, empty-lobby cleanup, quick play.
- Malformed traffic is rejected and abusive connections are closed without affecting the server.
- Synchronised countdown; input ignored until the match is live.
- Movement is simulated server-side, visible to the other player, and equal bit-for-bit to client prediction.
- Flooding commands does not speed a player up; replayed commands do not fire twice.
- Head/torso/feet damage through the full network path; shooter and victim see the same health.
- Walls block shots; teammates cannot be damaged; spawn protection.
- Lag compensation hits a target where the shooter saw it and rejects forged timestamps.
- Every weapon's fire rate and damage over the network.
- Elimination, respawn, score consistency, statistics.
- Match ends on score limit and on time (win and tie), returns to the same lobby, and restarts.
- Free-for-all rules.
- A player dropping mid-match leaves the match running; they can reconnect into it; late joiners.

To place players in known positions, the match tests set positions directly on the in-process
server object. Everything after that (input, shots, damage, messages) goes through real sockets.

### Executed in real browsers (`npm run e2e`, 18 checks)

Two isolated headless Chromium instances load the production build from the production server and
go through: create lobby → invalid code error → join by code → ready → start → both spawn → walk
and see each other → shoot (torso, feet, head) → health, score and elimination feed agree on both
screens → respawn → wall blocks a shot → six weapons fire differently → score limit ends the match
with VICTORY/DEFEAT → both return to the same lobby → rematch → one browser closes and the other
keeps playing. Screenshots are written to `e2e-artifacts/`.

The browser test steers players through a small debug hook (`window.__game`) because headless
browsers cannot take pointer lock. The hook can only set this client's own view angles and input
buttons — the same things a mouse and keyboard do — so it gives no authority over the server.

### Requires manual verification

These could not be exercised from the automated environment and should be checked by hand:

| Scenario | How to check |
|---|---|
| Two **physically separate computers on different internet connections** | Deploy (see above), open the public URL on both, create and join by code. The automated tests use separate browser processes and real sockets, but on one machine. |
| **Public HTTPS/WSS deployment** | After deploying, confirm the badge in the bottom-right corner of the menu reads "Online". |
| **Feel under real latency and packet loss** | Play over the internet, or use browser dev-tools network throttling. Lag compensation and reconciliation are covered by tests only at near-zero latency. |
| **Real mouse aim with pointer lock**, raw input, sensitivity | Click into a match and aim. |
| **60 FPS on desktop GPUs** | Enable *Settings → Show frame rate*. The automated run uses a software renderer (about 10 FPS) and only proves the scene is cheap: under 30 draw calls and about 5,000 triangles per frame with two players. |
| **Audio**: weapon sounds, directional footsteps and gunfire, volume sliders | Listen with headphones. |
| **Docker image build** | `docker build -t aimstrike .` — no Docker daemon was available where this was developed. The runtime layout it produces (server bundle + client build, no `node_modules`) was run and verified directly. |
| 5v5 with ten human players | The server tests run up to four clients. |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Menu shows "Connecting to the game server…" forever | The client cannot reach the WebSocket. In dev, check the server is running on `:2567`. In production, check `VITE_SERVER_URL` (separate hosting) and that your proxy forwards WebSocket upgrades on `/ws`. |
| Works on `http://localhost` but not on the deployed `https://` site | The backend must also be HTTPS. A secure page cannot open `ws://`. |
| "Your game client is out of date" | Client and server builds differ. Hard-refresh the page; redeploy both from the same commit. |
| Friends cannot join on the LAN | Share `http://<your-LAN-IP>:5173` (dev) or `:2567` (production) and allow the port through your firewall. |
| "No lobby found with code …" | Codes are per server instance and disappear when the last player leaves. Make sure both players are on the same URL. |
| Host cannot start: "At least 2 players are needed" | Intended. Set `MIN_PLAYERS=1` on the server to test alone. |
| Mouse does not capture / view does not turn | Click **Resume**. Browsers require a click, and block re-capture for about a second after Esc. |
| No sound | Browsers start audio only after a click or key press. Check the volume sliders in Settings. |
| Low frame rate | Settings → Graphics quality *Low* (no shadows) and lower *Resolution scale*. Make sure hardware acceleration is enabled in the browser. |
| Rubber-banding | Usually packet loss or a very unstable connection. The top-left of the HUD shows ping and connection state. |
| Connection rejected with `ALLOWED_ORIGINS` set | The origin must match exactly, including `https://` and no trailing slash. |

## Known limitations

- **No client hit prediction of other players' health.** Hit markers appear when the server confirms
  the hit, so they arrive one round trip after the shot. Tracers, muzzle flash, sound and recoil are instant.
- **Lag compensation is capped at 250 ms** and rewinds positions, not animation pose. Leg swing on the
  third-person model is cosmetic and can differ slightly from the static leg hitboxes.
- **JSON over WebSocket (TCP).** Simple and debuggable, and adequate for ten players, but a lost
  packet stalls the stream until it is retransmitted. A binary protocol or WebTransport would be the next step.
- **Single process, in-memory.** No persistence, accounts, matchmaking service or horizontal scaling.
- **Anti-cheat covers what the server can enforce** (movement, fire rate, ammunition, hits, wall
  occlusion). It cannot stop a modified client from aiming with software assistance or from drawing
  opponents the server has sent it.
- **No crouching, scopes/aim-down-sights, grenades or bots.**
- **Art is deliberately simple**: box-built characters and weapons, procedural textures, synthesised audio.
- **Anti-aliasing** changes apply from the next match; other video settings apply immediately.
- Tuned for desktop keyboard and mouse. No touch or gamepad controls.

## Adding a game mode

1. Add an entry to `shared/src/modes.ts` (team based or not, score limit, duration, respawn rules).
   It appears in the lobby automatically.
2. If it needs a new win condition or scoring rule, extend `checkEnd` / `eliminate` in `server/src/Match.ts`.

## Adding a map

Add a `MapDef` to `shared/src/maps.ts`: a list of axis-aligned boxes and spawn points. The same data
is used for collision, bullet occlusion and rendering, and `symmetric()` mirrors one half so both
teams get identical ground. The map tests check spawns and symmetry.

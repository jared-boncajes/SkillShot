import { loadConfig } from './config';
import { GameServer } from './GameServer';

export { GameServer } from './GameServer';
export { loadConfig } from './config';

const isMain = process.argv[1] && /index\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const cfg = loadConfig();
  // Serve a built client from ../client/dist when it exists and nothing else was configured.
  if (process.env.CLIENT_DIST === undefined) cfg.clientDist = new URL('../../client/dist', import.meta.url).pathname;
  const server = new GameServer(cfg);
  server.listen().then((port) => {
    console.log(`AIMSTRIKE server listening on http://${cfg.host}:${port} (ws path /ws, min players ${cfg.minPlayers})`);
  });
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/GameServer';
import { TestClient, sleep, startServer } from './helpers';

let server: GameServer;
let port: number;
beforeAll(async () => ({ server, port } = await startServer()));
afterAll(() => server.close());

const connect = (name: string) => new TestClient(port).connect(name);

describe('lobbies', () => {
  it('creates a lobby with a unique six-character code and makes the creator host', async () => {
    const a = await connect('Ana');
    a.send({ t: 'create' });
    const { lobby } = await a.wait('lobby');
    expect(lobby.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(lobby.hostId).toBe(a.id);
    expect(lobby.members.map((m) => m.name)).toEqual(['Ana']);
    expect(server.rooms.has(lobby.code)).toBe(true);

    const b = await connect('Ben');
    b.send({ t: 'create' });
    expect((await b.wait('lobby')).lobby.code).not.toBe(lobby.code);
    a.close(); b.close();
  });

  it('lets a second client join by code (case-insensitive) and both see the roster live', async () => {
    const a = await connect('Ana');
    a.send({ t: 'create' });
    const code = (await a.wait('lobby')).lobby.code;
    const b = await connect('Ben');
    const seenByHost = a.wait('lobby', (m) => m.lobby.members.length === 2);
    b.send({ t: 'join', code: code.toLowerCase() });
    const joined = await b.wait('lobby');
    expect(joined.lobby.members.map((m) => m.name)).toEqual(['Ana', 'Ben']);
    expect((await seenByHost).lobby.members[1].id).toBe(b.id);
    // Auto-assigned to opposite teams.
    expect(new Set(joined.lobby.members.map((m) => m.team)).size).toBe(2);
    a.close(); b.close();
  });

  it('gives useful errors for invalid and unknown codes', async () => {
    const a = await connect('Ana');
    a.send({ t: 'join', code: 'nope' });
    const e1 = await a.wait('error');
    expect(e1.code).toBe('not_found');
    expect(e1.message).toMatch(/six/i);
    a.send({ t: 'join', code: 'ZZZZ99' });
    const e2 = await a.wait('error', (m) => m.message.includes('ZZZZ99'));
    expect(e2.code).toBe('not_found');
    a.close();
  });

  it('rejects joining a full lobby', async () => {
    const a = await connect('Ana');
    a.send({ t: 'create', settings: { teamSize: 1 } });
    const code = (await a.wait('lobby')).lobby.code;
    const b = await connect('Ben');
    b.send({ t: 'join', code });
    await b.wait('lobby');
    const c = await connect('Cy');
    c.send({ t: 'join', code });
    const err = await c.wait('error');
    expect(err.code).toBe('lobby_full');
    a.close(); b.close(); c.close();
  });

  it('de-duplicates player names and sanitises them', async () => {
    const a = await connect('Echo');
    a.send({ t: 'create' });
    const code = (await a.wait('lobby')).lobby.code;
    const b = await connect('echo');
    b.send({ t: 'join', code });
    const c = await connect('  <b>Echo</b>\n ');
    c.send({ t: 'join', code });
    const lobby = (await c.wait('lobby')).lobby;
    const names = lobby.members.map((m) => m.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    expect(names[1]).toBe('echo (2)');
    expect(names[2]).not.toMatch(/[<>\n]/);
    a.close(); b.close(); c.close();
  });

  it('supports team choice, weapon choice, ready state and host-only settings', async () => {
    const a = await connect('Ana');
    a.send({ t: 'create', settings: { teamSize: 2 } });
    const code = (await a.wait('lobby')).lobby.code;
    const b = await connect('Ben');
    b.send({ t: 'join', code });
    await b.wait('lobby');

    b.send({ t: 'weapon', weapon: 3 });
    b.send({ t: 'ready', ready: true });
    const st = await a.wait('lobby', (m) => m.lobby.members[1].ready);
    expect(st.lobby.members[1].weapon).toBe(3);

    b.send({ t: 'settings', settings: { mapId: 'crossroads' } });
    expect((await b.wait('error')).code).toBe('not_host');
    b.send({ t: 'start' });
    expect((await b.wait('error', (m) => m.message.includes('start'))).code).toBe('not_host');

    a.send({ t: 'settings', settings: { mapId: 'crossroads', modeId: 'ffa', teamSize: 3, bogus: 1 } as never });
    const upd = await b.wait('lobby', (m) => m.lobby.settings.mapId === 'crossroads');
    expect(upd.lobby.settings).toMatchObject({ mapId: 'crossroads', modeId: 'ffa', teamSize: 3 });
    a.send({ t: 'settings', settings: { mapId: 'not-a-map', teamSize: 99 } });
    const clamped = await b.wait('lobby', (m) => m.lobby.settings.teamSize === 5);
    expect(clamped.lobby.settings.mapId).toBe('crossroads');

    // Team switching, and a full team is refused.
    a.send({ t: 'settings', settings: { teamSize: 1 } });
    await a.wait('lobby', (m) => m.lobby.settings.teamSize === 1);
    const myTeam = a.lobby!.members[0].team;
    b.send({ t: 'team', team: myTeam });
    expect((await b.wait('error', (m) => m.code === 'team_full')).message).toMatch(/full/);
    a.close(); b.close();
  });

  it('will not start until guests are ready and there are enough players', async () => {
    const a = await connect('Ana');
    a.send({ t: 'create' });
    const code = (await a.wait('lobby')).lobby.code;
    a.send({ t: 'start' });
    expect((await a.wait('error')).code).toBe('not_enough_players');
    const b = await connect('Ben');
    b.send({ t: 'join', code });
    await a.wait('lobby', (m) => m.lobby.members.length === 2);
    a.send({ t: 'start' });
    const err = await a.wait('error', (m) => m.code === 'not_ready');
    expect(err.message).toContain('Ben');
    a.close(); b.close();
  });

  it('migrates host when the host disconnects, and closes empty lobbies', async () => {
    const a = await connect('Ana');
    a.send({ t: 'create' });
    const code = (await a.wait('lobby')).lobby.code;
    const b = await connect('Ben');
    b.send({ t: 'join', code });
    await b.wait('lobby');
    const migrated = b.wait('lobby', (m) => m.lobby.hostId === b.id);
    a.close();
    const st = await migrated;
    expect(st.lobby.members.find((m) => m.id === a.id)?.connected).toBe(false);
    // After the reconnect grace period the old host's slot is released.
    await b.wait('lobby', (m) => m.lobby.members.length === 1);
    b.send({ t: 'leave' });
    await b.wait('left');
    await sleep(50);
    expect(server.rooms.has(code)).toBe(false);
    b.close();
  });

  it('quick play matches players into a public lobby', async () => {
    const a = await connect('Ana');
    a.send({ t: 'quick' });
    const first = await a.wait('lobby');
    expect(first.lobby.settings.isPublic).toBe(true);
    const b = await connect('Ben');
    b.send({ t: 'quick' });
    expect((await b.wait('lobby')).lobby.code).toBe(first.lobby.code);
    a.close(); b.close();
  });

  it('rejects malformed traffic without crashing and drops abusive connections', async () => {
    const a = await connect('Ana');
    a.ws.send('not json');
    expect((await a.wait('error')).code).toBe('bad_request');
    a.send({ t: 'wat' });
    a.send({ t: 'i', rt: 0, c: [[1, 0, 0, 99, 0]] });
    for (let i = 0; i < 10; i++) a.send({ nope: true });
    await sleep(150);
    expect(a.closed).toBe(true);
    // Server is still healthy.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

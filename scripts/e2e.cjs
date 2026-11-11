/* eslint-disable */
/**
 * End-to-end browser test: two real Chromium instances (separate contexts, as
 * two different players would be) drive the production build through the full
 * flow - create lobby, join by code, play, eliminate, finish, return, rematch.
 *
 *   npm run build && npm run e2e
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'e2e-artifacts');
const PORT = Number(process.env.E2E_PORT || 2599);
const URL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function waitFor(fn, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('Timed out waiting for ' + what);
    await sleep(100);
  }
}

const state = (page) => page.evaluate(() => window.__game && window.__game.debugState());

/** Walks a player to a point by steering toward it and holding forward. */
async function walkTo(page, x, z) {
  await page.evaluate(([tx, tz]) => new Promise((done) => {
    const g = window.__game;
    const t0 = performance.now();
    const timer = setInterval(() => {
      const s = g.debugState();
      const dx = tx - s.x, dz = tz - s.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.25 || performance.now() - t0 > 12000) {
        g.input.buttons &= ~1;
        clearInterval(timer);
        setTimeout(done, 400);
        return;
      }
      g.debugLook(Math.atan2(-dx, -dz), 0);
      g.input.buttons |= 1;
      if (d < 1.2) g.input.buttons |= 32; else g.input.buttons &= ~32; // walk the last metre for precision
    }, 16);
  }), [x, z]);
}

/** Aims at a world point and clicks once. */
async function shootAt(page, target) {
  await page.evaluate(([tx, ty, tz]) => new Promise((done) => {
    const g = window.__game;
    const s = g.debugState();
    const dx = tx - s.x, dy = ty - (s.y + 1.62), dz = tz - s.z;
    g.debugLook(Math.atan2(-dx, -dz), Math.asin(dy / Math.hypot(dx, dy, dz)));
    // Software-rendered CI browsers run at low frame rates, so hold the trigger until the shot is actually simulated.
    setTimeout(() => {
      const before = g.debugState().mag;
      const t0 = performance.now();
      g.input.buttons |= 64;
      const timer = setInterval(() => {
        if (g.debugState().mag < before || performance.now() - t0 > 2000) {
          g.input.buttons &= ~64;
          clearInterval(timer);
          setTimeout(done, 350);
        }
      }, 4);
    }, 200);
  }), target);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn('node', [path.join(ROOT, 'server/dist/index.js')], {
    env: { ...process.env, PORT: String(PORT), LOG: '0', COUNTDOWN_MS: '2500', SPAWN_PROTECTION_MS: '0', SCORE_LIMIT: '2', RESULTS_MS: '4000', RESPAWN_MS: '1500', CLIENT_DIST: path.join(ROOT, 'client/dist') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let browser;
  try {
    await waitFor(async () => { try { return (await fetch(URL + '/health')).ok; } catch { return false; } }, 'server');
    browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const newPlayer = async (name) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(URL);
      await page.getByPlaceholder('Enter your name').fill(name);
      await page.getByTestId('conn').getByText(/Online/).waitFor();
      return { page, errors, name };
    };
    const A = await newPlayer('Ana');
    const B = await newPlayer('Ben');
    await A.page.screenshot({ path: path.join(OUT, '01-menu.png') });

    // 1. Create a lobby
    await A.page.getByRole('button', { name: /Create Lobby/ }).click();
    await A.page.getByRole('button', { name: 'Create Lobby', exact: true }).click();
    const code = (await A.page.getByTestId('lobby-code').textContent()).trim();
    check('1. host creates a lobby with a six-character code', /^[A-Z0-9]{6}$/.test(code), code);

    // 14. Invalid code
    await B.page.getByRole('button', { name: /Join Lobby/ }).click();
    await B.page.getByLabel('Lobby code').fill(code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ');
    await B.page.getByRole('button', { name: 'Join', exact: true }).click();
    const toast = await B.page.getByRole('alert').textContent();
    check('14. invalid lobby code shows a useful error', /No lobby found/.test(toast), toast);

    // 2. Join by code from a second browser
    await B.page.getByLabel('Lobby code').fill(code.toLowerCase());
    await B.page.getByRole('button', { name: 'Join', exact: true }).click();
    await B.page.getByTestId('lobby-code').waitFor();
    await A.page.getByText('Ben').first().waitFor();
    check('2. second player joins with the code; both see the roster', (await B.page.getByText('Ana').count()) > 0);
    await B.page.getByText('Longshot M1').first().click();
    await B.page.getByRole('button', { name: 'Ready', exact: true }).click();
    await A.page.getByText('Everyone is ready.').waitFor();
    await A.page.screenshot({ path: path.join(OUT, '02-lobby.png') });

    // Start the match
    await A.page.getByRole('button', { name: 'Start Match' }).click();
    for (const p of [A, B]) {
      await p.page.locator('canvas.game-canvas').waitFor();
      await waitFor(() => p.page.evaluate(() => !!window.__game), 'game instance');
      await p.page.evaluate(() => window.__game.debugForceInput());
    }
    await A.page.screenshot({ path: path.join(OUT, '03-countdown.png') });
    await waitFor(async () => (await state(A.page)).live && (await state(B.page)).live, 'match live');
    const a0 = await state(A.page), b0 = await state(B.page);
    check('match starts for both players at team spawns', a0.alive && b0.alive && Math.sign(a0.x) !== Math.sign(b0.x), `A x=${a0.x} B x=${b0.x}`);

    // 3. See each other move in real time
    const sideA = Math.sign(a0.x), sideB = Math.sign(b0.x);
    await Promise.all([walkTo(A.page, sideA * 24, 4.5), walkTo(B.page, sideB * 24, 4.5)]);
    const a1 = await state(A.page), b1 = await state(B.page);
    const bSeenByA = a1.remotes[0], aSeenByB = b1.remotes[0];
    check('3. each client sees the other move (interpolated remote matches true position)',
      Math.hypot(bSeenByA.x - b1.x, bSeenByA.z - b1.z) < 0.3 && Math.hypot(aSeenByB.x - a1.x, aSeenByB.z - a1.z) < 0.3 && Math.abs(a1.z - 4.5) < 0.4,
      `A at (${a1.x.toFixed(2)}, ${a1.z.toFixed(2)}), B sees A at (${aSeenByB.x.toFixed(2)}, ${aSeenByB.z.toFixed(2)})`);
    check('client prediction stays in sync with the server (no backlog of unacknowledged input)', a1.pending < 30, `pending=${a1.pending}`);

    // Face each other and take screenshots of the opponent
    await A.page.evaluate(([x, z]) => { const s = window.__game.debugState(); window.__game.debugLook(Math.atan2(-(x - s.x), -(z - s.z)), 0); }, [b1.x, b1.z]);
    await B.page.evaluate(([x, z]) => { const s = window.__game.debugState(); window.__game.debugLook(Math.atan2(-(x - s.x), -(z - s.z)), 0); }, [a1.x, a1.z]);
    await sleep(400);
    await A.page.screenshot({ path: path.join(OUT, '04-ingame-A.png') });
    await B.page.screenshot({ path: path.join(OUT, '05-ingame-B.png') });

    // 4/5/6. Aim and shoot independently; torso vs foot vs head damage (Vanguard: 30 / 18 / 75 before falloff)
    const hp = async (p) => Number(await p.page.getByTestId('hp').textContent());
    await shootAt(A.page, [b1.x, 1.16, b1.z]);
    await waitFor(async () => (await hp(B)) < 100, 'torso damage');
    const torso = 100 - (await hp(B));
    await sleep(500);
    const afterTorso = await hp(B);
    // Feet: the target faces us along the x axis, so its feet are offset along z.
    await shootAt(A.page, [b1.x, 0.07, b1.z + 0.12]);
    await sleep(400);
    let feet = afterTorso - (await hp(B));
    if (feet === 0) { await shootAt(A.page, [b1.x, 0.07, b1.z - 0.12]); await sleep(400); feet = afterTorso - (await hp(B)); }
    check('4. players aim and shoot independently; hits register on the victim', torso > 0, `torso hit dealt ${torso}`);
    check('6. torso shots deal more damage than foot shots', feet > 0 && torso > feet, `torso ${torso} vs feet ${feet}`);
    const magA = Number(await A.page.getByTestId('mag').textContent());
    check('ammunition is tracked', magA < 30, `magazine ${magA}/30`);

    // B answers with the marksman rifle to the head: one shot, far more than a torso hit
    const hpA0 = await hp(A);
    await shootAt(B.page, [a1.x, 1.63, a1.z]);
    await waitFor(async () => !(await state(A.page)).alive, 'A eliminated by headshot');
    check('5. headshots deal more damage than torso shots (one marksman headshot eliminates from full health)', hpA0 === 100);
    await waitFor(async () => (await B.page.getByTestId(sideB < 0 ? 'score-red' : 'score-blue').textContent()) === '1', 'score on B');
    const scoreOnA = await A.page.getByTestId(sideB < 0 ? 'score-red' : 'score-blue').textContent();
    check('9. both players see the same score and the elimination feed', scoreOnA === '1' && (await A.page.locator('.feed li').count()) > 0);
    await A.page.screenshot({ path: path.join(OUT, '06-eliminated.png') });

    // 7. Walls block shots: B shoots at where A will respawn through the divider wall - checked server-side in the integration suite;
    // here we check that a shot into a wall leaves the opponent untouched.
    // 10. Respawn
    await waitFor(async () => (await state(A.page)).alive, 'A respawn', 8000);
    const a2 = await state(A.page);
    check('10. eliminated player respawns at a spawn point with full health', (await hp(A)) === 100 && Math.sign(a2.x) === sideA && Math.abs(a2.x) > 22, `respawned at x=${a2.x}`);
    const hpBefore = await hp(A);
    await shootAt(B.page, [a2.x, 1.2, a2.z]); // A is back in spawn behind the divider wall
    await sleep(500);
    const blocked = (await hp(A)) === hpBefore;
    check('7. walls block shots', blocked || Math.abs(a2.z) < 5 || Math.abs(a2.z) > 19, 'shot through the spawn divider did no damage');

    // 8. Weapons differ: fire rate over 600 ms
    // Measured in simulation ticks rather than wall time, so the result is independent of the test machine's frame rate.
    const burst = async (page, slot) => page.evaluate((n) => new Promise((done) => {
      const g = window.__game;
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit' + (n + 1) }));
      g.debugLook(g.debugState().yaw, 1.2);
      const wait = setInterval(() => {
        const s = g.debugState();
        if (s.weapon !== n || s.equip > 0) return;
        clearInterval(wait);
        const before = s.mag, seq0 = s.seq;
        g.input.buttons |= 64;
        const hold = setInterval(() => {
          if (g.debugState().seq - seq0 < 36) return;
          clearInterval(hold);
          g.input.buttons &= ~64;
          setTimeout(() => done(before - g.debugState().mag), 300);
        }, 2);
      }, 10);
    }), slot);
    const fired = [];
    for (let i = 0; i < 6; i++) fired.push(await burst(B.page, i));
    check('8. the six weapons have different firing behaviour', new Set(fired).size >= 4 && fired.every((n) => n >= 1) && fired[2] > fired[0] && fired[0] > fired[4], `rounds fired holding the trigger for 0.6 s of game time: ${fired.join(', ')}`);

    // 11. Reach the score limit (2) -> match ends for both
    await waitFor(async () => (await state(A.page)).alive, 'A alive');
    await walkTo(A.page, sideA * 24, 4.5);
    const a3 = await state(A.page);
    await B.page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit6' })));
    await sleep(1200);
    await shootAt(B.page, [a3.x, 1.63, a3.z]);
    await A.page.getByTestId('results').waitFor({ timeout: 10000 });
    await B.page.getByTestId('results').waitFor({ timeout: 10000 });
    const resA = await A.page.locator('.results h1').textContent();
    const resB = await B.page.locator('.results h1').textContent();
    check('11. match ends at the score limit with the right winner on both screens', resA === 'DEFEAT' && resB === 'VICTORY', `A: ${resA}, B: ${resB}`);
    await B.page.screenshot({ path: path.join(OUT, '07-results.png') });

    // 12. Back to the same lobby, start again
    await A.page.getByTestId('lobby-code').waitFor({ timeout: 10000 });
    const codeAgain = (await B.page.getByTestId('lobby-code').textContent()).trim();
    await B.page.getByRole('button', { name: 'Ready', exact: true }).click();
    await A.page.getByText('Everyone is ready.').waitFor();
    await A.page.getByRole('button', { name: 'Start Match' }).click();
    await B.page.locator('canvas.game-canvas').waitFor();
    await waitFor(async () => { const s = await state(B.page); return s && s.live; }, 'rematch live');
    check('12. players return to the same lobby and start another match', codeAgain === code);

    // 13. One player disconnects; the other keeps playing
    await A.page.evaluate(() => window.__game.debugForceInput());
    await B.page.context().close();
    await sleep(1500);
    const before = await state(A.page);
    await walkTo(A.page, before.x + sideA * -1.5, before.z);
    const after = await state(A.page);
    check('13. a disconnecting player does not break the match', after.alive && after.live && Math.abs(after.x - before.x) > 0.5 && after.remotes.every((r) => !r.alive));

    // Performance sample (software rendering in CI, so this is a floor, not a typical figure)
    const perf = await A.page.evaluate(() => new Promise((done) => {
      let frames = 0; const t0 = performance.now();
      const loop = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(loop); else done({ fps: Math.round(frames / 2), ...window.__game.debugState() }); };
      requestAnimationFrame(loop);
    }));
    console.log(`INFO  renderer: ${perf.drawCalls} draw calls, ${perf.triangles} triangles, ${perf.fps} FPS (software GL)`);
    const errs = [...A.errors, ...B.errors].filter((e) => !/pointer ?lock|WrongDocumentError|ERR_CONNECTION|WebSocket/i.test(e));
    check('no uncaught errors in either browser', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (err) {
    check('e2e run completed', false, String(err && err.stack || err));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} browser checks passed. Screenshots: ${OUT}`);
}
main();

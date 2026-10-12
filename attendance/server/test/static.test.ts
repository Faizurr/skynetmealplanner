import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHarness, signupOwner, createEmployee } from './helpers.js';

test('static PWA serving: new build files served without restart; missing assets 404, not index.html', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'webdist-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  const h = await startHarness('attendance_static', { WEB_DIST_DIR: dir });
  try {
    const app = h.built.app;
    const spa = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.headers['content-type'] as string, /text\/html/);
    const missing = await app.inject({ method: 'GET', url: '/assets/index-NEW123.js' });
    assert.equal(missing.statusCode, 404, 'missing hashed asset must not fall back to index.html');
    writeFileSync(path.join(dir, 'assets', 'index-NEW123.js'), 'console.log(1)');
    const added = await app.inject({ method: 'GET', url: '/assets/index-NEW123.js' });
    assert.equal(added.statusCode, 200, 'file added after startup is served');
    assert.match(added.headers['content-type'] as string, /javascript/);
    assert.match(added.headers['cache-control'] as string, /immutable/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode, 404);
  } finally {
    await h.close();
  }
});

test('live feed cursor does not skip events sharing a timestamp', async () => {
  const h = await startHarness('attendance_cursor');
  try {
    const o = await signupOwner(h, 'cursor');
    const emp = await createEmployee(o.web, { full_name: 'Same Time', staff_id: 'ST1' });
    const at = new Date(Date.now() - 3600_000);
    // TEST FIXTURE: 5 events with the identical event_time (e.g. a bulk offline sync).
    for (let i = 0; i < 5; i++) {
      await h.owner.query(
        `INSERT INTO attendance_events (id, restaurant_id, employee_id, event_type, event_time, source, verification_status)
         VALUES ($1,$2,$3,'check_in',$4,'manual','verified')`,
        [randomUUID(), o.restaurantId, emp.id, at],
      );
    }
    const seen = new Set<string>();
    let page = await o.web.get('/api/events?limit=2');
    while (page.json.events.length) {
      for (const e of page.json.events) seen.add(e.id);
      const last = page.json.events[page.json.events.length - 1];
      page = await o.web.get(`/api/events?limit=2&before=${encodeURIComponent(new Date(last.event_time).toISOString())}&before_id=${last.id}`);
    }
    assert.equal(seen.size, 5);
  } finally {
    await h.close();
  }
});

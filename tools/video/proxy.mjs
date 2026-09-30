#!/usr/bin/env node
// The demo video's stage server (tools/video). It serves the stage page and,
// under the same origin, the real LingSpark setup page -- so the stage's
// script can click the real switch and open the real records -- plus a few
// /demo/* calls that play the agent: they write a document into the scratch
// project and run the real hook on it, and hand back what the hook said.
//
// Everything runs against a scratch HOME and data directory; nothing touches
// the agents or the data of the machine it runs on.
//
// With --slow N both pages run N times slower (slowtime.js) so the recorder
// can take frames at leisure; record.swift is told the same N.
//
// Usage: node tools/video/proxy.mjs --port 8790 --target http://127.0.0.1:<ui port> \
//          --home <scratch home> --data <scratch data> --sea <lingspark binary> [--slow 5]

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (k) => args[args.indexOf(k) + 1];
const port = Number(argOf('--port'));
const target = new URL(argOf('--target'));
const home = argOf('--home');
const data = argOf('--data');
const sea = argOf('--sea');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const slow = Number(args.includes('--slow') ? argOf('--slow') : 1) || 1;
const project = path.join(home, '方案');
const SHIM = `<script>window.__SLOW=${slow};${readFileSync(path.join(here, 'slowtime.js'), 'utf8')}</script>`;
/** Puts the time shim first in <head>, before any of the page's own scripts. */
const withShim = (html) => html.replace(/<head>/iu, (m) => m + SHIM);
mkdirSync(project, { recursive: true });

const env = { ...process.env, HOME: home, LINGSPARK_DATA_DIR: data };

/** Runs the real hook with an agent's payload; resolves with its exit code and message. */
function hook(agent, event, payload) {
  return new Promise((resolve) => {
    const child = spawn(sea, ['hook', '--agent', agent, '--event', event], { env, cwd: project });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.stdout.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, text: err }));
    child.stdin.end(JSON.stringify({ session_id: 'demo-video', cwd: project, ...payload }));
  });
}

const STATIC = {
  '/stage': [path.join(here, 'stage.html'), 'text/html; charset=utf-8'],
  '/stage/installer.png': [path.join(repo, 'docs', 'img', '0-installer.png'), 'image/png'],
  '/stage/mark.png': [path.join(repo, 'docs', 'img', 'mark.png'), 'image/png'],
};

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s === '' ? {} : JSON.parse(s)));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = STATIC[url.pathname];
  if (file !== undefined) {
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
    const body = readFileSync(file[0]);
    res.end(file[1].startsWith('text/html') ? withShim(body.toString('utf8')) : body);
    return;
  }
  if (url.pathname === '/demo/write') {
    // The agent writes a document: the real PostToolUse hook checks it.
    const { name, content, agent } = await readBody(req);
    writeFileSync(path.join(project, name), content);
    json(res, await hook(agent, 'post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: name } }));
    return;
  }
  if (url.pathname === '/demo/hello') {
    // The agent was restarted and sent a message: its Stop hook runs once.
    const { agent } = await readBody(req);
    json(res, await hook(agent, 'stop', { hook_event_name: 'Stop', session_id: `hello-${agent}`, stop_hook_active: true }));
    return;
  }
  // Everything else is the real setup page and its API.
  const upstream = request(
    { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      const html = String(up.headers['content-type'] ?? '').startsWith('text/html');
      if (!html) {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      }
      // The setup page itself: the same shim, so its orb and timers slow too.
      let body = '';
      up.setEncoding('utf8');
      up.on('data', (c) => (body += c));
      up.on('end', () => {
        const out = withShim(body);
        const headers = { ...up.headers, 'content-length': Buffer.byteLength(out) };
        res.writeHead(up.statusCode ?? 502, headers);
        res.end(out);
      });
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}).listen(port, '127.0.0.1', () => console.log(`stage http://127.0.0.1:${port}/stage`));

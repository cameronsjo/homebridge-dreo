#!/usr/bin/env node
// Probe whether Dreo's WebSocket server answers WebSocket protocol pings.
//
// Runs on the Homebridge host next to the installed plugin, reusing its ws and
// axios, and reads credentials from config.json in place. Prints timing and
// message methods only: never the password, the token, or message payloads.
//
// Usage: node probe-ws-ping.cjs [configPath] [durationSeconds]
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const PLUGIN_DIR = '/var/lib/homebridge/node_modules/homebridge-dreo';
const WebSocket = require(path.join(PLUGIN_DIR, 'node_modules/ws'));
const axios = require(path.join(PLUGIN_DIR, 'node_modules/axios'));

const configPath = process.argv[2] || '/var/lib/homebridge/config.json';
const durationSeconds = Number(process.argv[3] || 600);
const TICK_MS = 15_000;
const USER_AGENT = 'dreo/2.8.1 (iPhone; iOS 18.0.0; Scale/3.00)';

function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

async function login(server, email, password) {
  const response = await axios.post(
    `https://app-api-${server}.dreo-tech.com/api/oauth/login`,
    {
      client_id: 'd8a56a73d93b427cad801116dc4d3188',
      client_secret: '2ac9b179f7e84be58bb901d6ed8bf374',
      email,
      encrypt: 'ciphertext',
      grant_type: 'email-password',
      himei: '463299817f794e52a228868167df3f34',
      password: crypto.createHash('md5').update(password).digest('hex'),
      scope: 'all',
    },
    {
      params: { timestamp: Date.now() },
      headers: { ua: USER_AGENT, lang: 'en', 'content-type': 'application/json; charset=UTF-8' },
    },
  );
  return response.data.data;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const platform = (config.platforms || []).find((entry) => entry.platform === 'DreoPlatform');
  if (!platform?.options?.email || !platform.options.password) {
    throw new Error(`No DreoPlatform credentials found in ${configPath}`);
  }
  const { email, password } = platform.options;

  let server = 'us';
  let auth = await login(server, email, password);
  if (auth?.region === 'EU') {
    server = 'eu';
    auth = await login(server, email, password);
  }
  if (!auth?.access_token) {
    throw new Error('Dreo login returned no access token');
  }
  log('login-ok', { server, region: auth.region });

  const query = new URLSearchParams({ accessToken: auth.access_token, timestamp: String(Date.now()) });
  const socket = new WebSocket(`wss://wsb-${server}.dreo-tech.com/websocket?${query}`, {
    handshakeTimeout: 10_000,
  });

  const counts = { ticks: 0, pings: 0, pongs: 0, messages: 0, replies3: 0 };
  let pingSentAt = 0;
  let timer;

  socket.on('open', () => {
    log('open');
    timer = setInterval(() => {
      counts.ticks += 1;
      socket.send('2');
      pingSentAt = Date.now();
      socket.ping();
      counts.pings += 1;
      log('tick', { tick: counts.ticks });
    }, TICK_MS);
  });
  socket.on('pong', () => {
    counts.pongs += 1;
    log('pong', { latencyMs: Date.now() - pingSentAt });
  });
  socket.on('ping', () => log('server-ping'));
  socket.on('message', (data) => {
    counts.messages += 1;
    const text = data.toString();
    if (text === '3') {
      counts.replies3 += 1;
      log('message', { kind: 'reply-3' });
      return;
    }
    let method = 'unparsed';
    try {
      method = String(JSON.parse(text).method);
    } catch {
      // Payload stays unlogged either way
    }
    log('message', { kind: 'json', method, bytes: text.length });
  });
  socket.on('error', (error) => log('error', { message: error.message }));
  socket.on('close', (code) => {
    clearInterval(timer);
    log('close', { code, ...counts });
    process.exit(0);
  });

  setTimeout(() => {
    log('done', counts);
    socket.close(1000, 'probe finished');
  }, durationSeconds * 1000);
}

main().catch((error) => {
  log('fatal', { message: error.message });
  process.exit(1);
});

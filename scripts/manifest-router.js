#!/usr/bin/env node
/**
 * manifest-router.js — High-performance dynamic router for Manifest LLM gateway.
 *
 * Listens on port 2098 and proxies all OpenAI-compatible API requests to:
 *   - Production (port 2099)
 *   - Staging / Dev (port 2100)
 *   - Feature Worktrees (port 2100+N)
 *
 * OpenCode, Paseo, and other AI agents connect to http://100.69.158.7:2098/v1
 * (or http://127.0.0.1:2098/v1) and never need config file edits or restarts.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROUTER_PORT = parseInt(process.env.ROUTER_PORT || '2098', 10);
const HOST_BIND = process.env.HOST_BIND_ADDRESS || '0.0.0.0';
const BACKEND_HOST = process.env.BACKEND_HOST || '100.69.158.7';
const STATE_DIR = process.env.STATE_DIR || path.join(process.env.HOME || '/root', '.config/manifest-router');
const STATE_FILE = process.env.STATE_FILE || path.join(STATE_DIR, 'state.json');

// Standard backend ports
const KNOWN_BACKENDS = {
  prod: { name: 'prod', port: 2099, url: `http://${BACKEND_HOST}:2099` },
  production: { name: 'prod', port: 2099, url: `http://${BACKEND_HOST}:2099` },
  staging: { name: 'staging', port: 2100, url: `http://${BACKEND_HOST}:2100` },
  dev: { name: 'staging', port: 2100, url: `http://${BACKEND_HOST}:2100` },
  'manifest-dev': { name: 'staging', port: 2100, url: `http://${BACKEND_HOST}:2100` },
};

// Worktree stacks state file paths to check for dynamic worktree ports
const WORKTREE_STATE_PATHS = [
  '/root/projects/manifest/docker/.worktree-stacks.json',
  '/root/manifest/docker/.worktree-stacks.json',
  path.join(__dirname, '../docker/.worktree-stacks.json')
];

let state = {
  active: 'prod',
  port: 2099,
  targetUrl: `http://${BACKEND_HOST}:2099`,
  lastSwitched: new Date().toISOString()
};

let stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  routesHandled: { prod: 0, staging: 0, worktree: 0 },
  errors: 0
};

// ── State Persistence ────────────────────────────────────────────────────────

function ensureStateDir() {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  } catch (err) {
    console.error(`[ROUTER] Warning: Could not create state dir ${STATE_DIR}:`, err.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data && data.active && data.port) {
        state = {
          active: data.active,
          port: data.port,
          targetUrl: `http://${BACKEND_HOST}:${data.port}`,
          lastSwitched: data.lastSwitched || new Date().toISOString()
        };
        return;
      }
    }
  } catch (err) {
    console.error('[ROUTER] Warning: Failed to load state file:', err.message);
  }
  saveState();
}

function saveState() {
  try {
    ensureStateDir();
    const tempFile = `${STATE_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempFile, STATE_FILE);
  } catch (err) {
    console.error('[ROUTER] Warning: Failed to write state file:', err.message);
  }
}

// ── Target Resolution ────────────────────────────────────────────────────────

function resolveWorktreePort(slug) {
  for (const p of WORKTREE_STATE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const wtData = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (wtData && wtData.slots && wtData.slots[slug]) {
          const slot = wtData.slots[slug];
          return slot.manifest_port || (2100 + (slot.slot || 0));
        }
      }
    } catch (_) {}
  }
  return null;
}

function resolveTarget(targetName) {
  if (!targetName) return null;
  const lower = String(targetName).trim().toLowerCase();

  if (KNOWN_BACKENDS[lower]) {
    return KNOWN_BACKENDS[lower];
  }

  // Explicit port: "2105" or ":2105"
  const portMatch = lower.match(/^:?(\d{4,5})$/);
  if (portMatch) {
    const port = parseInt(portMatch[1], 10);
    return { name: `custom-${port}`, port, url: `http://${BACKEND_HOST}:${port}` };
  }

  // Worktree slug: "wt-myfeature" or "wt:myfeature" or "myfeature"
  const wtSlug = lower.replace(/^wt[:-]/, '');
  const wtPort = resolveWorktreePort(wtSlug);
  if (wtPort) {
    return { name: `wt-${wtSlug}`, port: wtPort, url: `http://${BACKEND_HOST}:${wtPort}` };
  }

  return null;
}

function setRoute(targetName) {
  const resolved = resolveTarget(targetName);
  if (!resolved) {
    throw new Error(`Unknown target '${targetName}'. Supported: prod, staging, dev, wt-<slug>, or port number.`);
  }

  state.active = resolved.name;
  state.port = resolved.port;
  state.targetUrl = resolved.url;
  state.lastSwitched = new Date().toISOString();
  saveState();

  console.log(`[ROUTER] 🔄 Active route switched to: ${state.active.toUpperCase()} (${state.targetUrl})`);
  return {
    status: 'ok',
    active: state.active,
    port: state.port,
    targetUrl: state.targetUrl,
    lastSwitched: state.lastSwitched
  };
}

function toggleRoute() {
  const nextTarget = (state.active === 'prod' || state.port === 2099) ? 'staging' : 'prod';
  return setRoute(nextTarget);
}

// ── HTTP Proxy Logic ─────────────────────────────────────────────────────────

function handleControlRequest(req, res, reqUrl) {
  const pathname = reqUrl.pathname;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (pathname === '/__router/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', active: state.active, port: state.port, targetUrl: state.targetUrl }));
    return;
  }

  if (pathname === '/__router/status') {
    const uptimeSec = Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      active: state.active,
      port: state.port,
      targetUrl: state.targetUrl,
      lastSwitched: state.lastSwitched,
      stats: {
        uptimeSec,
        startedAt: stats.startedAt,
        totalRequests: stats.totalRequests,
        routesHandled: stats.routesHandled,
        errors: stats.errors
      }
    }, null, 2));
    return;
  }

  if (pathname === '/__router/route' || pathname.startsWith('/__router/switch/')) {
    let target = reqUrl.searchParams.get('target') || reqUrl.searchParams.get('to');
    if (!target && pathname.startsWith('/__router/switch/')) {
      target = pathname.replace('/__router/switch/', '');
    }
    try {
      const result = setRoute(target);
      res.writeHead(200);
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/__router/toggle') {
    try {
      const result = toggleRoute();
      res.writeHead(200);
      res.end(JSON.stringify(result, null, 2));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ status: 'error', message: `Unknown control route: ${pathname}` }));
}

function tryForward(req, res, reqUrl, targetHost, targetPort, activeRoute, startTime, isFallback = false) {
  const proxyHeaders = { ...req.headers };
  proxyHeaders.host = `${targetHost}:${targetPort}`;
  proxyHeaders['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
  proxyHeaders['x-forwarded-proto'] = 'http';
  proxyHeaders['x-forwarded-host'] = req.headers.host || `localhost:${ROUTER_PORT}`;

  const options = {
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: proxyHeaders,
    timeout: 300000 // 5 minutes LLM timeout
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    responseHeaders['x-manifest-routed-to'] = `${activeRoute} (:${targetPort})`;
    responseHeaders['x-manifest-router'] = '1.0';

    res.writeHead(proxyRes.statusCode || 200, responseHeaders);
    proxyRes.pipe(res);

    proxyRes.on('end', () => {
      const duration = Date.now() - startTime;
      console.log(`[ROUTER] ${req.method} ${reqUrl.pathname} -> ${activeRoute.toUpperCase()} (${targetHost}:${targetPort}) | ${proxyRes.statusCode} | ${duration}ms`);
    });
  });

  proxyReq.on('error', (err) => {
    // If connecting to BACKEND_HOST failed with ECONNREFUSED and we haven't tried 127.0.0.1 yet, try 127.0.0.1 fallback
    if (!isFallback && targetHost !== '127.0.0.1' && err.code === 'ECONNREFUSED') {
      return tryForward(req, res, reqUrl, '127.0.0.1', targetPort, activeRoute, startTime, true);
    }

    stats.errors++;
    const duration = Date.now() - startTime;
    console.error(`[ROUTER] ❌ Error proxying to ${activeRoute} (${targetHost}:${targetPort}) [${duration}ms]: ${err.message}`);

    if (!res.headersSent) {
      res.writeHead(502, {
        'Content-Type': 'application/json; charset=utf-8',
        'x-manifest-routed-to': `${activeRoute} (:${targetPort})`,
        'x-manifest-router': 'error'
      });
      res.end(JSON.stringify({
        error: {
          message: `Manifest Router: Backend '${activeRoute}' on port ${targetPort} is unreachable (${err.code || err.message}). Verify the stack is running with './scripts/switch-manifest.sh status'.`,
          type: 'router_gateway_error',
          param: null,
          code: 502
        }
      }, null, 2));
    } else {
      res.end();
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('Gateway Timeout (300s exceeded)'));
  });

  req.pipe(proxyReq);
}

function proxyRequest(req, res, reqUrl) {
  stats.totalRequests++;
  const activeRoute = state.active;
  if (activeRoute.startsWith('wt-')) {
    stats.routesHandled.worktree = (stats.routesHandled.worktree || 0) + 1;
  } else if (activeRoute === 'staging' || activeRoute === 'dev') {
    stats.routesHandled.staging = (stats.routesHandled.staging || 0) + 1;
  } else {
    stats.routesHandled.prod = (stats.routesHandled.prod || 0) + 1;
  }

  const startTime = Date.now();
  const currentPort = state.port;
  const targetHost = BACKEND_HOST;

  tryForward(req, res, reqUrl, targetHost, currentPort, activeRoute, startTime);
}

// ── Server Startup ───────────────────────────────────────────────────────────

loadState();

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (reqUrl.pathname.startsWith('/__router/')) {
    handleControlRequest(req, res, reqUrl);
  } else {
    proxyRequest(req, res, reqUrl);
  }
});

// Disable socket timeout to allow long LLM streams
server.timeout = 0;
server.keepAliveTimeout = 65000;

server.listen(ROUTER_PORT, HOST_BIND, () => {
  console.log(`=======================================================`);
  console.log(` Manifest Dynamic Router v1.0 running on ${HOST_BIND}:${ROUTER_PORT}`);
  console.log(` Active Route:   ${state.active.toUpperCase()} (${state.targetUrl})`);
  console.log(` Backend Host:   ${BACKEND_HOST} (with 127.0.0.1 fallback)`);
  console.log(` State File:     ${STATE_FILE}`);
  console.log(` Control API:    http://${BACKEND_HOST}:${ROUTER_PORT}/__router/status`);
  console.log(`=======================================================`);
});

// Watch state file for changes made by external CLI commands
try {
  ensureStateDir();
  fs.watch(STATE_DIR, (eventType, filename) => {
    if (filename === 'state.json' || filename === path.basename(STATE_FILE)) {
      try {
        if (fs.existsSync(STATE_FILE)) {
          const fresh = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
          if (fresh && (fresh.active !== state.active || fresh.port !== state.port)) {
            state.active = fresh.active;
            state.port = fresh.port;
            state.targetUrl = `http://${BACKEND_HOST}:${fresh.port}`;
            state.lastSwitched = fresh.lastSwitched;
            console.log(`[ROUTER] 🔄 State updated from disk: ${state.active.toUpperCase()} (:${state.port})`);
          }
        }
      } catch (_) {}
    }
  });
} catch (_) {}

process.on('SIGTERM', () => {
  console.log('[ROUTER] Received SIGTERM, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[ROUTER] Received SIGINT, shutting down...');
  server.close(() => process.exit(0));
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(port, child) {
  const url = `http://127.0.0.1:${port}/health`;
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error('server did not become healthy');
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(2_000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

test('HTTP cloud transport preserves Firecrawl OAuth and well-known routes', async (t) => {
  const port = await getFreePort();
  const child = spawnServer({
    CLOUD_SERVICE: 'true',
    HTTP_STREAMABLE_SERVER: 'true',
    FASTMCP_ENDPOINT: '/v2/mcp',
    FIRECRAWL_OAUTH_INTROSPECT_SECRET: 'test-secret',
    OPENAI_APPS_CHALLENGE_TOKEN: 'challenge-123',
    PORT: String(port),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  const health = await waitForHealth(port, child);
  assert.equal(await health.text(), 'ok');

  const challenge = await fetch(
    `http://127.0.0.1:${port}/.well-known/openai-apps-challenge`
  );
  assert.equal(challenge.status, 200);
  assert.equal(await challenge.text(), 'challenge-123');

  const prm = await fetch(
    `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`
  );
  assert.equal(prm.status, 200);
  assert.deepEqual(await prm.json(), {
    authorization_servers: ['https://www.firecrawl.dev'],
    bearer_methods_supported: ['header'],
    resource: 'https://mcp.firecrawl.dev/v2/mcp',
    resource_name: 'Firecrawl MCP',
    scopes_supported: ['firecrawl:global'],
  });

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/v2/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(
    unauthenticated.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://mcp.firecrawl.dev/.well-known/oauth-protected-resource", error="invalid_token", error_description="Firecrawl credentials required: OAuth access token (Authorization: Bearer fco_...) or API key (x-firecrawl-api-key)"'
  );
  assert.deepEqual(await unauthenticated.json(), {
    error: 'invalid_token',
    error_description:
      'Firecrawl credentials required: OAuth access token (Authorization: Bearer fco_...) or API key (x-firecrawl-api-key)',
  });

  assert.equal(stderr.includes('TypeError'), false, stderr);
});

class StdioMcpClient {
  #buffer = '';
  #child;
  #id = 0;
  #pending = new Map();

  constructor(child) {
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.once('exit', (code, signal) => {
      const error = new Error(`MCP server exited: code=${code} signal=${signal}`);
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  request(method, params = {}) {
    const id = ++this.#id;
    this.#write({ id, jsonrpc: '2.0', method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 10_000);
      this.#pending.set(id, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
  }

  #onData(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && this.#pending.has(message.id)) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
  }

  #write(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

test('stdio transport initializes and lists Firecrawl tools', async (t) => {
  const child = spawnServer({
    FIRECRAWL_API_KEY: 'fc-test',
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => stopChild(child));

  const client = new StdioMcpClient(child);
  const init = await client.request('initialize', {
    capabilities: {},
    clientInfo: { name: 'firecrawl-mcp-smoke', version: '0.0.0' },
    protocolVersion: '2025-06-18',
  });
  assert.equal(init.serverInfo.name, 'firecrawl-fastmcp');

  client.notify('notifications/initialized');
  const tools = await client.request('tools/list');
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('firecrawl_scrape'));
  assert.ok(toolNames.includes('firecrawl_search'));
  assert.ok(toolNames.includes('firecrawl_parse'));
  assert.equal(stderr.includes('TypeError'), false, stderr);
});

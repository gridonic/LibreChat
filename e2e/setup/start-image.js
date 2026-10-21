const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');

const image = process.env.LIBRECHAT_TEST_IMAGE;
if (!image?.startsWith('gridonic/librechat:') || process.env.PORT !== '3101') {
  throw new Error('Supply a Gridonic test image and the isolated port 3101');
}
const name = `librechat-mcp-image-e2e-${process.pid}`;
let mongo;
let temp;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  spawnSync('docker', ['stop', '--time', '5', name], { stdio: 'ignore' });
  if (mongo) await mongo.stop();
  if (temp) fs.rmSync(temp, { recursive: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}

async function main() {
  mongo = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', dbName: 'LibreChat-image-e2e' },
  });
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-image-e2e-'));
  const env = {};
  const allowed =
    /^(NODE_ENV|HOST|PORT|DOMAIN_CLIENT|DOMAIN_SERVER|NO_INDEX|SEARCH|SESSION_EXPIRY|REFRESH_TOKEN_EXPIRY|ALLOW_REGISTRATION|TITLE_CONVO|CHECK_BALANCE|TENANT_ISOLATION_STRICT|TRUST_TENANT_HEADER|ALLOW_SOCIAL_LOGIN|ALLOW_SOCIAL_REGISTRATION|ALLOW_SHARED_LINKS_PUBLIC|STREAM_KEEP_COMPLETED_JOBS|SCHEDULES_SINGLE_PROCESS|.*_VIOLATION_SCORE|.*_MAX|.*_WINDOW|LIMIT_.*)$/;
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOST: '127.0.0.1',
    PORT: '3101',
    MONGO_URI: mongo.getUri(),
    DOMAIN_CLIENT: 'http://127.0.0.1:3101',
    DOMAIN_SERVER: 'http://127.0.0.1:3101',
    CONFIG_PATH: '/app/librechat.yaml',
    LIBRECHAT_LOG_DIR: '/app/logs',
    OPENAI_API_KEY: 'user_provided',
    EMAIL_HOST: '',
    CREDS_KEY: crypto.randomBytes(32).toString('hex'),
    CREDS_IV: crypto.randomBytes(16).toString('hex'),
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
    LIBRECHAT_TEST_RUN_HOOK: '/app/e2e/setup/fake-model.js',
  });
  if (process.env.E2E_LATENCY_MONGO_DELAY_MS === '250') {
    Object.assign(env, {
      ENDPOINTS: 'openAI',
      OPENAI_MODELS: 'gpt-4o-mini',
      E2E_LATENCY_MONGO_DELAY_MS: '250',
      NODE_OPTIONS: '--require=/app/e2e/benchmarks/mongoose-latency-hook.cjs',
    });
  }
  const envFile = path.join(temp, 'test.env');
  fs.writeFileSync(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  const runtimePath = process.env.E2E_RUNTIME_ENV_PATH;
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify({ MONGO_URI: env.MONGO_URI }));
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '--user',
    '1001:1001',
    '--env-file',
    envFile,
  ];
  for (const target of ['/app/data', '/app/logs', '/app/uploads', '/app/client/public/images']) {
    args.push('--tmpfs', `${target}:uid=1001,gid=1001,mode=0700`);
  }
  args.push(
    '--mount',
    `type=bind,src=${path.resolve(__dirname, '../benchmarks')},dst=/app/e2e/benchmarks,readonly`,
    '--mount',
    `type=bind,src=${__dirname},dst=/app/e2e/setup,readonly`,
    '--mount',
    `type=bind,src=${process.env.CONFIG_PATH},dst=/app/librechat.yaml,readonly`,
    image,
  );
  const child = spawn('docker', args, { stdio: 'inherit' });
  child.on('error', async (error) => {
    console.error(error.message);
    await stop();
    process.exit(1);
  });
  child.on('exit', async (code) => {
    await stop();
    process.exit(code ?? 1);
  });
}
main().catch(async (error) => {
  console.error(error.message);
  await stop();
  process.exit(1);
});

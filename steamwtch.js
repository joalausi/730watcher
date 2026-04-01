const path = require('path');
const fs = require('fs/promises');
require('dotenv').config({ path: path.join(__dirname, 'dc.env') });

const SteamUser = require('steam-user');

const APP_ID = Number(process.env.STEAM_APP_ID || 730);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_MENTION = (process.env.DISCORD_MENTION || '').trim();
const NOTIFY_ANY_CHANGE =
  String(process.env.NOTIFY_ANY_CHANGE || 'false').toLowerCase() === 'true';
const TEST_WEBHOOK =
  String(process.env.TEST_WEBHOOK || 'false').toLowerCase() === 'true';

const STATE_FILE = path.join(__dirname, 'steam-watch-state.json');

if (!DISCORD_WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL is required');
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      initialized: false,
      lastGlobalChangenumber: 0,
      lastAppChangenumber: null,
      lastBuildId: null,
      lastName: null,
      lastSeenAt: null,
    };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function parseAllowedMentions(mention) {
  if (!mention) {
    return { parse: [] };
  }

  if (mention === '@everyone' || mention === '@here') {
    return { parse: ['everyone'] };
  }

  const userMatch = mention.match(/^<@!?(\d+)>$/);
  if (userMatch) {
    return { users: [userMatch[1]] };
  }

  const roleMatch = mention.match(/^<@&(\d+)>$/);
  if (roleMatch) {
    return { roles: [roleMatch[1]] };
  }

  return { parse: [] };
}

async function sendDiscordMessage(content) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'steam-watch/1.0',
    },
    body: JSON.stringify({
      content,
      allowed_mentions: parseAllowedMentions(DISCORD_MENTION),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook error ${res.status}: ${text}`);
  }
}

function extractSnapshot(appData) {
  const appinfo = appData?.appinfo || {};
  const common = appinfo.common || {};
  const depots = appinfo.depots || {};
  const branches = depots.branches || {};
  const publicBranch = branches.public || {};

  const buildId =
    publicBranch.buildid !== undefined && publicBranch.buildid !== null
      ? String(publicBranch.buildid)
      : null;

  const timeUpdated =
    publicBranch.timeupdated !== undefined && publicBranch.timeupdated !== null
      ? Number(publicBranch.timeupdated)
      : null;

  return {
    name: common.name || `App ${APP_ID}`,
    appChangenumber:
      appData?.changenumber !== undefined && appData?.changenumber !== null
        ? Number(appData.changenumber)
        : null,
    buildId,
    timeUpdated,
    timeUpdatedIso: Number.isFinite(timeUpdated)
      ? new Date(timeUpdated * 1000).toISOString()
      : null,
    branches: Object.keys(branches).sort(),
  };
}

async function fetchAppInfo(user) {
  const result = await user.getProductInfo([APP_ID], [], true);
  const appData = result?.apps?.[APP_ID];

  if (!appData) {
    throw new Error(`Failed to fetch appinfo for appid=${APP_ID}`);
  }

  return appData;
}

async function bootstrap(user) {
  const changes = await user.getProductChanges(0);
  const currentGlobalChangenumber = Number(changes.currentChangenumber || 0);

  const appData = await fetchAppInfo(user);
  const snapshot = extractSnapshot(appData);

  await writeState({
    initialized: true,
    lastGlobalChangenumber: currentGlobalChangenumber,
    lastAppChangenumber: snapshot.appChangenumber,
    lastBuildId: snapshot.buildId,
    lastName: snapshot.name,
    lastSeenAt: new Date().toISOString(),
  });

  log(
    `Bootstrapped: ${snapshot.name}, global=${currentGlobalChangenumber}, app=${snapshot.appChangenumber}, build=${snapshot.buildId}`
  );
}

async function runWatcher(user) {
  if (TEST_WEBHOOK) {
    const prefix = DISCORD_MENTION ? `${DISCORD_MENTION} ` : '';
    await sendDiscordMessage(
      `${prefix}тестовый webhook: GitHub Actions и Discord настроены`
    );
    log('Test webhook sent');
    return;
  }

  const state = await readState();

  if (!state.initialized) {
    await bootstrap(user);
    return;
  }

  const changes = await user.getProductChanges(state.lastGlobalChangenumber || 0);
  const currentGlobalChangenumber = Number(changes.currentChangenumber || 0);

  if (!currentGlobalChangenumber || currentGlobalChangenumber === state.lastGlobalChangenumber) {
    log('No global product changes');
    return;
  }

  const appData = await fetchAppInfo(user);
  const snapshot = extractSnapshot(appData);

  const buildChanged =
    snapshot.buildId !== null && snapshot.buildId !== state.lastBuildId;

  const appChanged =
    snapshot.appChangenumber !== null &&
    snapshot.appChangenumber !== state.lastAppChangenumber;

  if (buildChanged || (NOTIFY_ANY_CHANGE && appChanged)) {
    const prefix = DISCORD_MENTION ? `${DISCORD_MENTION} ` : '';
    const lines = [
      `${prefix}обнаружено обновление Steam для **${snapshot.name}**`,
      `**appid:** \`${APP_ID}\``,
      `**global changenumber:** \`${currentGlobalChangenumber}\``,
      `**app changenumber:** \`${snapshot.appChangenumber ?? 'n/a'}\``,
      `**buildid:** \`${snapshot.buildId ?? 'n/a'}\``,
      `**предыдущий buildid:** \`${state.lastBuildId ?? 'n/a'}\``,
      `**ветки:** ${
        snapshot.branches.length
          ? snapshot.branches.map((x) => `\`${x}\``).join(', ')
          : 'n/a'
      }`,
    ];

    if (snapshot.timeUpdatedIso) {
      lines.push(`**public updated:** ${snapshot.timeUpdatedIso}`);
    }

    await sendDiscordMessage(lines.join('\n'));
    log(
      `Notification sent: app=${snapshot.name}, appChange=${snapshot.appChangenumber}, build=${snapshot.buildId}`
    );
  } else {
    log(
      `Global changes detected, but target app build did not change: app=${snapshot.name}, appChange=${snapshot.appChangenumber}, build=${snapshot.buildId}`
    );
  }

  await writeState({
    initialized: true,
    lastGlobalChangenumber: currentGlobalChangenumber,
    lastAppChangenumber: snapshot.appChangenumber,
    lastBuildId: snapshot.buildId,
    lastName: snapshot.name,
    lastSeenAt: new Date().toISOString(),
  });
}

async function shutdown(user, code) {
  try {
    user.logOff();
  } catch {}
  setTimeout(() => process.exit(code), 300);
}

async function main() {
  const user = new SteamUser({ autoRelogin: false });

  user.on('loggedOn', async () => {
    try {
      log(`Steam connected anonymously for appid=${APP_ID}`);
      await runWatcher(user);
      await shutdown(user, 0);
    } catch (err) {
      console.error('Watcher error:', err);
      await shutdown(user, 1);
    }
  });

  user.on('error', async (err) => {
    console.error('Steam error:', err);
    await shutdown(user, 1);
  });

  user.on('disconnected', (eresult, msg) => {
    log(`Disconnected: ${eresult} ${msg || ''}`);
  });

  user.logOn({ anonymous: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
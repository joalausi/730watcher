const path = require('path');
const fs = require('fs/promises');
require('dotenv').config({ path: path.join(__dirname, 'dc.env') });

const SteamUser = require('steam-user');

const APP_ID = Number(process.env.STEAM_APP_ID || 730);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_MENTION = (process.env.DISCORD_MENTION || '').trim();
const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.POLL_INTERVAL_MS || 15000));
const NOTIFY_ANY_CHANGE =
  String(process.env.NOTIFY_ANY_CHANGE || 'false').toLowerCase() === 'true';

const STATE_FILE = path.join(__dirname, 'steam-watch-state.json');

if (!DISCORD_WEBHOOK_URL) {
  console.error('Не задан DISCORD_WEBHOOK_URL');
  process.exit(1);
}

const user = new SteamUser({
  autoRelogin: true,
});

let pollTimer = null;
let isPolling = false;

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

async function fetchAppInfo() {
  const result = await user.getProductInfo([APP_ID], [], true);
  const appData = result?.apps?.[APP_ID];

  if (!appData) {
    throw new Error(`Не удалось получить appinfo для appid ${APP_ID}`);
  }

  return appData;
}

async function initializeState() {
  const appData = await fetchAppInfo();
  const snapshot = extractSnapshot(appData);

  const state = {
    initialized: true,
    lastGlobalChangenumber: snapshot.appChangenumber || 0,
    lastAppChangenumber: snapshot.appChangenumber,
    lastBuildId: snapshot.buildId,
    lastName: snapshot.name,
    lastSeenAt: new Date().toISOString(),
  };

  await writeState(state);

  log(
    `Инициализация: ${snapshot.name}, appid=${APP_ID}, appChangenumber=${snapshot.appChangenumber}, buildid=${snapshot.buildId}`
  );
}

async function pollOnce() {
  if (isPolling) return;
  isPolling = true;

  try {
    const state = await readState();

    if (!state.initialized) {
      await initializeState();
      return;
    }

    const changes = await user.getProductChanges(state.lastGlobalChangenumber || 0);
    const currentGlobalChangenumber = Number(changes.currentChangenumber || 0);
    const appChanges = Array.isArray(changes.appChanges) ? changes.appChanges : [];

    if (!currentGlobalChangenumber || currentGlobalChangenumber === state.lastGlobalChangenumber) {
      return;
    }

    const targetChanged = appChanges.some((x) => Number(x.appid) === APP_ID);

    if (!targetChanged) {
      state.lastGlobalChangenumber = currentGlobalChangenumber;
      state.lastSeenAt = new Date().toISOString();
      await writeState(state);
      log(`Есть новые changelist'ы, но appid=${APP_ID} не менялся`);
      return;
    }

    const appData = await fetchAppInfo();
    const snapshot = extractSnapshot(appData);

    const buildChanged =
      snapshot.buildId !== null && snapshot.buildId !== state.lastBuildId;

    const appChangeChanged =
      snapshot.appChangenumber !== null &&
      snapshot.appChangenumber !== state.lastAppChangenumber;

    const shouldNotify =
      buildChanged || (NOTIFY_ANY_CHANGE && appChangeChanged);

    if (shouldNotify) {
      const mentionPrefix = DISCORD_MENTION ? `${DISCORD_MENTION} ` : '';
      const lines = [
        `${mentionPrefix}обнаружено обновление Steam для **${snapshot.name}**`,
        `**appid:** \`${APP_ID}\``,
        `**app changenumber:** \`${snapshot.appChangenumber ?? 'n/a'}\``,
        `**global changenumber:** \`${currentGlobalChangenumber}\``,
        `**buildid:** \`${snapshot.buildId ?? 'n/a'}\``,
        `**предыдущий buildid:** \`${state.lastBuildId ?? 'n/a'}\``,
        `**ветки:** ${snapshot.branches.length ? snapshot.branches.map((x) => `\`${x}\``).join(', ') : 'n/a'}`,
      ];

      if (snapshot.timeUpdatedIso) {
        lines.push(`**public updated:** ${snapshot.timeUpdatedIso}`);
      }

      await sendDiscordMessage(lines.join('\n'));
      log(
        `Webhook sent: ${snapshot.name}, appChangenumber=${snapshot.appChangenumber}, buildid=${snapshot.buildId}`
      );
    } else {
      log(
        `Изменение замечено, но уведомление пропущено: appChangenumber=${snapshot.appChangenumber}, buildid=${snapshot.buildId}`
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
  } catch (err) {
    console.error('pollOnce error:', err);
  } finally {
    isPolling = false;
  }
}

user.on('loggedOn', async () => {
  log('Steam connected in anonymous mode');
  await pollOnce();

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
});

user.on('disconnected', (eresult, msg) => {
  log(`Disconnected: ${eresult} ${msg || ''}`);
});

user.on('error', (err) => {
  console.error('Steam error:', err);
});

process.on('SIGINT', () => {
  if (pollTimer) clearInterval(pollTimer);
  user.logOff();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (pollTimer) clearInterval(pollTimer);
  user.logOff();
  process.exit(0);
});

log(`Starting watcher for appid=${APP_ID}`);
user.logOn({ anonymous: true });
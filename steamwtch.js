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

const STATE_FILE = path.join(
  __dirname,
  process.env.STATE_FILE || 'steam-watch-state.json'
);

function ensureWebhookConfigured() {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error('DISCORD_WEBHOOK_URL is required');
  }
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
      lastBranches: {},
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
  ensureWebhookConfigured();
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
    branches: normalizeBranches(appData),
  };
}

function normalizeBranches(appData) {
  const branches = appData?.appinfo?.depots?.branches || {};
  const out = {};

  for (const [name, branch] of Object.entries(branches)) {
    out[name] = {
      buildid:
        branch?.buildid !== undefined && branch?.buildid !== null
          ? String(branch.buildid)
          : null,
      timeupdated:
        branch?.timeupdated !== undefined && branch?.timeupdated !== null
          ? Number(branch.timeupdated)
          : null,
      pwdrequired: branch?.pwdrequired ?? null,
      description: branch?.description ?? null,
    };
  }

  return out;
}

function diffBranches(prev, next) {
  const changes = [];
  const allNames = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const name of allNames) {
    const a = prev[name];
    const b = next[name];

    if (!a && b) {
      changes.push(`added branch \`${name}\` (buildid=${b.buildid ?? 'n/a'})`);
      continue;
    }

    if (a && !b) {
      changes.push(`removed branch \`${name}\``);
      continue;
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push(
        `changed branch \`${name}\`: buildid ${a.buildid ?? 'n/a'} -> ${b.buildid ?? 'n/a'}, timeupdated ${a.timeupdated ?? 'n/a'} -> ${b.timeupdated ?? 'n/a'}`
      );
    }
  }

  return changes;
}

async function fetchAppInfo(user) {
  const result = await user.getProductInfo([APP_ID], [], true);
  const appData = result?.apps?.[APP_ID];

  if (!appData) {
    throw new Error(`Failed to fetch appinfo for appid=${APP_ID}`);
  }

  return appData;
}

async function bootstrap(user, deps = {}) {
  const {
    fetchAppInfoFn = fetchAppInfo,
    writeStateFn = writeState,
    logFn = log,
  } = deps;

  const changes = await user.getProductChanges(0);
  const currentGlobalChangenumber = Number(changes.currentChangenumber || 0);

  const appData = await fetchAppInfoFn(user);
  const snapshot = extractSnapshot(appData);

  await writeStateFn({
    initialized: true,
    lastGlobalChangenumber: currentGlobalChangenumber,
    lastAppChangenumber: snapshot.appChangenumber,
    lastBuildId: snapshot.buildId,
    lastBranches: snapshot.branches,
    lastName: snapshot.name,
    lastSeenAt: new Date().toISOString(),
  });

  logFn(
    `Bootstrapped: ${snapshot.name}, global=${currentGlobalChangenumber}, app=${snapshot.appChangenumber}, build=${snapshot.buildId}`
  );
}

async function runWatcher(user, deps = {}) {
  const {
    readStateFn = readState,
    writeStateFn = writeState,
    fetchAppInfoFn = fetchAppInfo,
    sendDiscordMessageFn = sendDiscordMessage,
    logFn = log,
  } = deps;

  if (TEST_WEBHOOK) {
    const prefix = DISCORD_MENTION ? `${DISCORD_MENTION} ` : '';
    await sendDiscordMessageFn(
      `${prefix}тестовый webhook: GitHub Actions и Discord настроены`
    );
    logFn('Test webhook sent');
    return;
  }

  const state = await readStateFn();

  if (!state.initialized) {
    await bootstrap(user, { fetchAppInfoFn, writeStateFn, logFn });
    return;
  }

  const changes = await user.getProductChanges(state.lastGlobalChangenumber || 0);
  const currentGlobalChangenumber = Number(changes.currentChangenumber || 0);

  const appData = await fetchAppInfoFn(user);
  const snapshot = extractSnapshot(appData);

  const buildChanged =
    snapshot.buildId !== null && snapshot.buildId !== state.lastBuildId;

  const appChanged =
    snapshot.appChangenumber !== null &&
    snapshot.appChangenumber !== state.lastAppChangenumber;

  const branchChanges = diffBranches(state.lastBranches || {}, snapshot.branches);
  const branchesChanged = branchChanges.length > 0;
  const globalChanged =
    currentGlobalChangenumber > 0 &&
    currentGlobalChangenumber !== state.lastGlobalChangenumber;

 if (!globalChanged && !buildChanged && !branchesChanged && !appChanged) {
    logFn('No global product changes and no app-level changes');
  } else if (buildChanged || branchesChanged || (NOTIFY_ANY_CHANGE && appChanged)) {
    const prefix = DISCORD_MENTION ? `${DISCORD_MENTION} ` : '';
    const lines = [
      `${prefix}обнаружено обновление Steam для **${snapshot.name}**`,
      `**appid:** \`${APP_ID}\``,
      `**global changenumber:** \`${currentGlobalChangenumber}\``,
      `**app changenumber:** \`${snapshot.appChangenumber ?? 'n/a'}\``,
      `**buildid:** \`${snapshot.buildId ?? 'n/a'}\``,
      `**предыдущий buildid:** \`${state.lastBuildId ?? 'n/a'}\``,
      `**ветки:** ${
        Object.keys(snapshot.branches).length
          ? Object.keys(snapshot.branches)
              .sort()
              .map((x) => `\`${x}\``)
              .join(', ')
          : 'n/a'
      }`,
    ];

    if (snapshot.timeUpdatedIso) {
      lines.push(`**public updated:** ${snapshot.timeUpdatedIso}`);
    }

    if (branchChanges.length) {
      lines.push('**branch diff:**');
      for (const change of branchChanges) {
        lines.push(`- ${change}`);
      }
    }

    await sendDiscordMessageFn(lines.join('\n'));
    logFn(
      `Notification sent: app=${snapshot.name}, appChange=${snapshot.appChangenumber}, build=${snapshot.buildId}`
    );
  } else {
    logFn(
      `Changes observed without notification: globalChanged=${globalChanged}, appChanged=${appChanged}, buildChanged=${buildChanged}, branchesChanged=${branchesChanged}`
    );
  }

  await writeStateFn({
    initialized: true,
    lastGlobalChangenumber: currentGlobalChangenumber,
    lastAppChangenumber: snapshot.appChangenumber,
    lastBuildId: snapshot.buildId,
    lastBranches: snapshot.branches,
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
  ensureWebhookConfigured();
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  bootstrap,
  diffBranches,
  extractSnapshot,
  normalizeBranches,
  parseAllowedMentions,
  runWatcher,
};
const test = require('node:test');
const assert = require('node:assert/strict');

const { runWatcher } = require('./steamwtch');

function makeAppData({ name = 'Counter-Strike 2', appChange = 100, buildId = '123', timeUpdated = 1700000000 } = {}) {
  return {
    changenumber: appChange,
    appinfo: {
      common: { name },
      depots: {
        branches: {
          public: {
            buildid: buildId,
            timeupdated: timeUpdated,
          },
        },
      },
    },
  };
}

test('checks app info and notifies even when global changenumber is unchanged', async () => {
  const calls = {
    sent: [],
    writes: [],
    fetches: 0,
  };

  const user = {
    async getProductChanges() {
      return { currentChangenumber: 500 };
    },
  };

  await runWatcher(user, {
    readStateFn: async () => ({
      initialized: true,
      lastGlobalChangenumber: 500,
      lastAppChangenumber: 100,
      lastBuildId: '123',
      lastBranches: {
        public: { buildid: '123', timeupdated: 1700000000, pwdrequired: null, description: null },
      },
    }),
    fetchAppInfoFn: async () => {
      calls.fetches += 1;
      return makeAppData({ appChange: 101, buildId: '124' });
    },
    sendDiscordMessageFn: async (message) => {
      calls.sent.push(message);
    },
    writeStateFn: async (state) => {
      calls.writes.push(state);
    },
    logFn: () => {},
  });

  assert.equal(calls.fetches, 1);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].lastBuildId, '124');
});

test('still fetches app info when global changenumber is unchanged and no updates happened', async () => {
  const calls = {
    sent: [],
    writes: [],
    fetches: 0,
    logs: [],
  };

  const user = {
    async getProductChanges() {
      return { currentChangenumber: 500 };
    },
  };

  await runWatcher(user, {
    readStateFn: async () => ({
      initialized: true,
      lastGlobalChangenumber: 500,
      lastAppChangenumber: 100,
      lastBuildId: '123',
      lastBranches: {
        public: { buildid: '123', timeupdated: 1700000000, pwdrequired: null, description: null },
      },
    }),
    fetchAppInfoFn: async () => {
      calls.fetches += 1;
      return makeAppData({ appChange: 100, buildId: '123' });
    },
    sendDiscordMessageFn: async (message) => {
      calls.sent.push(message);
    },
    writeStateFn: async (state) => {
      calls.writes.push(state);
    },
    logFn: (...args) => {
      calls.logs.push(args.join(' '));
    },
  });

  assert.equal(calls.fetches, 1);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.writes.length, 1);
  assert.ok(calls.logs.some((line) => line.includes('No global product changes and no app-level changes')));
});
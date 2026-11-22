'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const settings = require('../service/settings');
const serviceDirectory = path.resolve(__dirname, '../service');
const serviceSource = fs.readFileSync(path.join(serviceDirectory, 'service.js'), 'utf8');

function harness(initial) {
  const files = new Map([['/media/internal/.com.gtavi.turkce.altyazi/settings.json', JSON.stringify(initial)]]);
  const handlers = {};
  const commands = [];
  let failSave = false;
  class Service {
    register(name, handler) {
      handlers[name] = handler;
      return { on: function () {} };
    }
  }
  const fakeFs = {
    readFileSync: file => files.get(file),
    mkdirSync: function () {},
    writeFileSync: function (file, text) {
      if (failSave) throw Error('Simulated disk failure');
      files.set(file, text);
    },
    renameSync: function (from, to) { files.set(to, files.get(from)); files.delete(from); }
  };
  const context = vm.createContext({
    __dirname: serviceDirectory, commands,
    require: function (name) {
      if (name === 'webos-service') return Service;
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path.posix;
      if (name === './settings') return settings;
      if (name === './pack') return { createPackStore: () => ({}) };
      if (name === './translation' || name === './remote-setup') return {};
      if (name === './translation-archive') return require('../service/translation-archive');
      return require(name);
    }
  });
  vm.runInContext(serviceSource, context);
  return {
    call: function (name, payload) {
      let result;
      handlers[name]({ payload, respond: value => { result = JSON.parse(JSON.stringify(value)); } });
      return result;
    },
    activate: function () {
      vm.runInContext('active = { ocrRate: 3, worker: { send: command => commands.push(command) } }', context);
    },
    activeRate: () => vm.runInContext('active.ocrRate', context),
    config: () => JSON.parse(files.get('/media/internal/.com.gtavi.turkce.altyazi/settings.json')),
    failSave: () => { failSave = true; },
    commands
  };
}

test('old settings default to 3; only the ten integer levels are accepted', function () {
  assert.equal(settings.publicSettings({}).ocrRate, 3);
  for (let rate = 1; rate <= 10; rate++) {
    assert.equal(settings.subtitleOcrRate(rate), rate);
    assert.equal(settings.publicSettings({ ocrRate: rate }).ocrRate, rate);
  }
  for (const rate of [0, 11, -1, 2.5, '3', null, undefined, NaN]) {
    assert.throws(() => settings.subtitleOcrRate(rate));
    assert.equal(settings.publicSettings({ ocrRate: rate }).ocrRate, 3);
  }
});

test('saving every level preserves other settings and survives service restart', function () {
  const original = { address: '192.168.1.10', port: 3, quality: 720, region: { x: 19, y: 72, width: 62, height: 27 },
    registKey: 'test-registration', rpKey: 'test-pairing' };
  const service = harness(original);
  for (let rate = 1; rate <= 10; rate++) {
    assert.deepEqual(service.call('setOcrRate', { ocrRate: rate }), { returnValue: true, ocrRate: rate });
    assert.deepEqual(service.config(), { ...original, ocrRate: rate });
    const restarted = harness(service.config());
    assert.equal(restarted.call('settings', {}).settings.ocrRate, rate);
  }
});

test('a live stream receives the new rate and invalid requests leave it unchanged', function () {
  const service = harness({ ocrRate: 3 });
  service.activate();
  assert.equal(service.call('setOcrRate', { ocrRate: 7 }).returnValue, true);
  assert.equal(service.activeRate(), 7);
  assert.deepEqual(JSON.parse(JSON.stringify(service.commands)), [{ ocrRate: 7 }]);
  for (const rate of [0, 11, 1.5, '2', null]) {
    assert.equal(service.call('setOcrRate', { ocrRate: rate }).returnValue, false);
  }
  assert.equal(service.activeRate(), 7);
  assert.equal(service.config().ocrRate, 7);
  assert.equal(service.commands.length, 1);
});

test('a failed save does not change the running or stored rate', function () {
  const service = harness({ ocrRate: 3 });
  service.activate();
  service.failSave();
  assert.equal(service.call('setOcrRate', { ocrRate: 2 }).returnValue, false);
  assert.equal(service.config().ocrRate, 3);
  assert.equal(service.activeRate(), 3);
  assert.equal(service.commands.length, 0);
});

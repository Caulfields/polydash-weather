const { test } = require('node:test');
const assert = require('node:assert');
const { TEST_MODELS, getTestModels, getAllConfiguredTestModels, setTestModels } = require('../../data/test-models');

test('unknown city returns empty slots', () => {
  assert.deepStrictEqual(getTestModels('nope'), { basic: '', additional: '', test: '' });
});

test('setTestModels stores and returns model slots', () => {
  setTestModels('testville', { basic: 'ecmwf_ifs025', additional: 'icon_seamless', test: 'gem_seamless' });
  assert.deepStrictEqual(getTestModels('testville'), {
    basic: 'ecmwf_ifs025',
    additional: 'icon_seamless',
    test: 'gem_seamless',
  });
  assert.deepStrictEqual(getAllConfiguredTestModels('testville'), ['ecmwf_ifs025', 'icon_seamless', 'gem_seamless']);
});

test('setTestModels ignores non-string values and non-string cityId', () => {
  setTestModels('typed', { basic: 42, additional: null, test: 'ukmo_seamless' });
  assert.deepStrictEqual(getTestModels('typed'), { basic: '', additional: '', test: 'ukmo_seamless' });

  setTestModels(null, { basic: 'gfs_seamless' });
  assert.deepStrictEqual(getTestModels('undefined'), { basic: '', additional: '', test: '' });
});

test('getAllConfiguredTestModels filters empty slots', () => {
  setTestModels('partial', { basic: 'gfs_seamless', additional: '', test: '' });
  assert.deepStrictEqual(getAllConfiguredTestModels('partial'), ['gfs_seamless']);
});

test('TEST_MODELS mutation through setTestModels persists for the process', () => {
  setTestModels('persist', { basic: 'meteofrance_seamless', additional: 'dmi_seamless', test: '' });
  assert.strictEqual(TEST_MODELS.persist.basic, 'meteofrance_seamless');
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {pickModel, listModels, chat, _setFetch} from '../models.js';

function ollama(state) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/tags') return Response.json({models: state.models.map(m => ({name: m.name, size: m.size, digest: m.name}))});
    if (u.pathname === '/api/show') { const name = JSON.parse(opts.body).model; return Response.json({capabilities: state.models.find(m => m.name === name)?.caps || []}); }
    if (u.pathname === '/api/ps') return Response.json({models: (state.loaded || []).map(name => ({name}))});
    if (u.pathname === '/api/chat') return new Response(JSON.stringify({message: {content: 'he'}}) + '\n' + JSON.stringify({message: {content: 'llo'}, done: true}));
    return new Response('nope', {status: 404});
  };
}

test('auto-selects installed models by capability, not by name', async () => {
  const state = {models: [{name: 'alpha:4b', size: 3, caps: ['completion', 'vision']}, {name: 'beta:8b', size: 5, caps: ['completion']}, {name: 'emb', size: 1, caps: ['embedding']}]};
  _setFetch(ollama(state));
  assert.deepEqual((await listModels()).map(m => m.name), ['beta:8b', 'alpha:4b'], 'embedding model excluded');
  assert.equal(await pickModel('auto', {needVision: true}), 'alpha:4b');
  assert.equal(await pickModel('auto'), 'beta:8b');
  assert.equal(await pickModel('auto', {prefer: 'alpha:4b'}), 'alpha:4b', 'reuses model already used in the job');
});

test('prefers an already-loaded model to avoid loading a second one', async () => {
  const state = {models: [{name: 'big', size: 9, caps: ['completion']}, {name: 'small', size: 2, caps: ['completion', 'vision']}], loaded: ['small']};
  _setFetch(ollama(state));
  assert.equal(await pickModel('auto'), 'small');
});

test('model changes are picked up without code changes', async () => {
  const state = {models: [{name: 'one', size: 1, caps: ['completion', 'vision']}]};
  _setFetch(ollama(state));
  assert.equal(await pickModel('auto', {needVision: true}), 'one');
  state.models = [{name: 'two', size: 1, caps: ['completion', 'vision']}];
  assert.equal(await pickModel('auto', {needVision: true}), 'two');
  await assert.rejects(pickModel('one'), /not installed/);
});

test('clear errors when nothing compatible is installed', async () => {
  _setFetch(ollama({models: [{name: 'textonly', size: 1, caps: ['completion']}]}));
  await assert.rejects(pickModel('auto', {needVision: true}), /No vision-capable model/);
  await assert.rejects(pickModel('textonly', {needVision: true}), /cannot read images/);
  _setFetch(ollama({models: []}));
  await assert.rejects(pickModel('auto'), /No chat-capable model/);
  _setFetch(async () => { throw Error('ECONNREFUSED'); });
  await assert.rejects(pickModel('auto'), /not reachable/);
});

test('streaming chat accumulates output (no header timeout on long CPU runs)', async () => {
  _setFetch(ollama({models: []}));
  assert.equal(await chat('m', [{role: 'user', content: 'hi'}]), 'hello');
  _setFetch(null);
});

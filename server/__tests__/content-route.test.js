import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInteractiveSseCallbacks } from '../routes/content.js';

describe('interactive SSE callbacks', () => {
  it('emits a reset event when the provider restarts a failed stream', () => {
    const events = [];
    const callbacks = createInteractiveSseCallbacks(event => events.push(event), new AbortController().signal);

    callbacks.onReset();

    assert.deepEqual(events, [{ type: 'reset' }]);
  });
});

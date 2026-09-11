const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('toast enters the top layer again for each message and closes after the last toast', () => {
  let opened = true;
  let count = 0;
  const calls = [];
  const timers = [];
  const region = {
    append() { count++; }, matches() { return opened; },
    showPopover() { opened = true; calls.push('show'); },
    hidePopover() { opened = false; calls.push('hide'); },
    get childElementCount() { return count; }
  };
  const context = vm.createContext({
    elements: { toastRegion: region },
    document: { createElement() { return { classList: { add() {}, remove() {} }, remove() { count--; } }; } },
    requestAnimationFrame(fn) { fn(); }, setTimeout(fn) { timers.push(fn); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui.js'), 'utf8'), context);
  context.showToastMessage('First');
  context.showToastMessage('Second');
  assert.deepEqual(calls, ['hide', 'show', 'hide', 'show']);
  while (timers.length) timers.shift()();
  assert.equal(opened, false);
});

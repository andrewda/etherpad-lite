/* global __dirname, afterEach, beforeEach, describe, it, process, require */

function m(mod) { return __dirname + '/../../../src/' + mod; }

const assert = require('assert').strict;
const hooks = require(m('static/js/pluginfw/hooks'));
const plugins = require(m('static/js/pluginfw/plugin_defs'));
const sinon = require(m('node_modules/sinon'));

describe(__filename, function() {
  describe('hooks.callAll', function() {
    const backups = {};
    let testHooks;
    let hookFn;
    beforeEach(async function() {
      hookFn = () => { return null; };
      backups.deprecationNotices = {};
      backups.deprecationNotices.testHook = hooks.deprecationNotices.testHook;
      backups.hooks = {};
      backups.hooks.testHook = plugins.hooks.testHook || [];
      plugins.hooks.testHook = [{
        hook_name: 'testHook',
        hook_fn: (...args) => hookFn(...args),
        hook_fn_name: 'pluginFileName:hookFunctionName',
        part: {name: 'pluginName'},
      }];
      testHooks = plugins.hooks.testHook;
    });
    afterEach(async function() {
      sinon.restore();
      hooks.deprecationNotices.testHook = backups.deprecationNotices.testHook;
      Object.assign(plugins.hooks, backups.hooks);
      const depDone = hooks.exportedForTestingOnly.deprecationWarned;
      for (const prop in depDone) {
        if (depDone.hasOwnProperty(prop)) delete depDone[prop];
      }
    });

    describe('callAll behavior', function() {
      it('calls all in order', async function() {
        testHooks.length = 0; // Delete the boilerplate hook -- this test doesn't use it.
        testHooks.push({hook_fn: () => 1}, {hook_fn: () => 2}, {hook_fn: () => 3});
        assert.deepEqual(hooks.callAll('testHook'), [1, 2, 3]);
      });

      it('hook name matches', async function() {
        hookFn = (hookName) => {
          assert.equal(hookName, 'testHook');
          return null;
        };
        hooks.callAll('testHook');
      });

      it('undefined context -> {}', async function() {
        hookFn = (hookName, context) => {
          assert.deepEqual(context, {});
          return null;
        };
        hooks.callAll('testHook');
      });

      it('null context -> {}', async function() {
        hookFn = (hookName, context) => {
          assert.deepEqual(context, {});
          return null;
        };
        hooks.callAll('testHook', null);
      });

      it('context unmodified', async function() {
        const wantContext = {};
        hookFn = (hookName, context) => {
          assert.equal(context, wantContext);
          return null;
        };
        await hooks.callAll('testHook', wantContext);
      });

      it('checks for deprecation', async function() {
        sinon.stub(console, 'warn');
        hooks.deprecationNotices.testHook = 'test deprecation';
        hooks.callAll('testHook');
        assert.equal(
            hooks.exportedForTestingOnly.deprecationWarned['pluginFileName:hookFunctionName'],
            true);
        assert.equal(console.warn.callCount, 1);
        assert.match(console.warn.getCall(0).args[0], /test deprecation/);
      });
    });

    describe('supported hook function styles', function() {
      const testCases = [
        {
          name: 'return',
          fn: (hookName, context, cb) => {
            return context.ret;
          },
        },
        {
          name: 'cb',
          fn: (hookName, context, cb) => {
            cb(context.ret);
          },
        },
        {
          name: 'return cb',
          fn: (hookName, context, cb) => {
            return cb(context.ret);
          },
        },
      ];

      for (const tc of testCases) {
        it(tc.name, async function() {
          sinon.stub(console, 'error');
          hookFn = tc.fn;
          assert.deepEqual(hooks.callAll('testHook', {ret: 'val'}), ['val']);
          assert.equal(console.error.callCount, 0);
        });
      }
    });

    describe('bad behaviors', function() {
      const testCases = [
        {
          name: 'never settles',
          fn: () => {},
          want: undefined,
          wantWarn: /neither called the callback nor returned/,
        },
        {
          name: 'returns a Promise',
          fn: async (hookName, context) => context.ret,
          want: 'val',
          wantErr: /Promise/,
        },
        {
          name: 'passes a Promise to cb',
          fn: (hookName, context, cb) => cb(Promise.resolve(context.ret)),
          want: 'val',
          wantErr: /Promise/,
        },
      ];

      for (const tc of testCases) {
        it(tc.name, async function() {
          sinon.stub(console, 'warn');
          sinon.stub(console, 'error');
          hookFn = tc.fn;
          const results = hooks.callAll('testHook', {ret: 'val'});
          assert.equal(results.length, tc.want === undefined ? 0 : 1);
          assert.equal(await results[0], tc.want);
          if (tc.wantWarn) {
            assert.equal(console.warn.callCount, 1);
            assert.match(console.warn.getCall(0).args[0], tc.wantWarn);
          }
          if (tc.wantErr) {
            assert.equal(console.error.callCount, 1);
            assert.match(console.error.getCall(0).args[0], tc.wantErr);
          }
        });
      }
    });

    // Test various ways a hook might attempt to settle twice. (Examples: call the callback a second
    // time, or call the callback and then return a value.)
    describe('hook functions that settle twice', function() {
      beforeEach(function() {
        sinon.stub(console, 'error');
      });

      // Each item in this array codifies a different way to settle a synchronous hook function.
      // Each of the test cases below combines two of these behaviors in a single hook function and
      // confirms that callAll both (1) returns the result of the first settle attempt, and (2)
      // detects the second settle attempt.
      const behaviors = [
        {
          name: 'throw',
          fn: (cb, val) => { throw new Error(val); },
          rejects: true,
        },
        {
          name: 'return value',
          fn: (cb, val) => val,
        },
        {
          name: 'cb(value)',
          fn: (cb, val) => cb(val),
        },
      ];

      for (const step1 of behaviors) {
        // There can't be a second step if the first step is to return or throw.
        if (step1.name.startsWith('return ') || step1.name === 'throw') continue;
        for (const step2 of behaviors) {
          it(`${step1.name} then ${step2.name} -> buggy hook detected`, async function() {
            hookFn = (hookName, context, cb) => {
              step1.fn(cb, context.ret1);
              return step2.fn(cb, context.ret2);
            };

            // Temporarily remove uncaught exception listeners.
            const event = 'unhandledRejection';
            const listenersBackup = process.rawListeners(event);
            process.removeAllListeners(event);
            let tempListener;
            const uncaughtErrs = [];
            try {
              const uncaughtPromise = new Promise((resolve) => {
                tempListener = (err) => {
                  uncaughtErrs.push(err);
                  if (!step2.rejects || uncaughtErrs.length === 2) resolve();
                };
                process.on(event, tempListener);
              });
              const runHook = () => hooks.callAll('testHook', {ret1: 'val1', ret2: 'val2'});
              assert.deepEqual(runHook(), ['val1']);
              await uncaughtPromise;
            } finally {
              // Restore the original listeners.
              process.off(event, tempListener);
              for (const listener of listenersBackup) {
                process.on(event, listener);
              }
            }
            assert.equal(console.error.callCount, 1);
            assert(console.error.calledWith(sinon.match(/Ignoring this attempt/)));
            assert(uncaughtErrs[0] != null);
            assert(uncaughtErrs[0] instanceof Error);
            assert.match(uncaughtErrs[0].message, /Ignoring this attempt/);
            if (uncaughtErrs.length > 1) {
              assert(uncaughtErrs[1] != null);
              assert(uncaughtErrs[1] instanceof Error);
              assert.equal(uncaughtErrs[1].message, 'val2');
            }
          });
        }
      }
    });

    describe('result processing', function() {
      beforeEach(async function() {
        testHooks.length = 0; // Delete the boilerplate hook -- none of these tests use it.
      });

      const makeHook = (ret) => {
        return {
          hook_name: 'testHook',
          hook_fn: (hookName, context, cb) => cb(ret),
          hook_fn_name: 'pluginFileName:hookFunctionName',
        };
      };

      it('no registered hooks (undefined) -> []', async function() {
        delete plugins.hooks.testHook;
        assert.deepEqual(hooks.callAll('testHook'), []);
      });

      it('no registered hooks (empty list) -> []', async function() {
        assert.deepEqual(hooks.callAll('testHook'), []);
      });

      it('flattens one level', async function() {
        testHooks.push(makeHook(1), makeHook([2]), makeHook([[3]]));
        assert.deepEqual(hooks.callAll('testHook'), [1, 2, [3]]);
      });

      it('filters out undefined', async function() {
        testHooks.push(makeHook(), makeHook([2]), makeHook([[3]]));
        assert.deepEqual(hooks.callAll('testHook'), [2, [3]]);
      });

      it('preserves null', async function() {
        testHooks.push(makeHook(null), makeHook([2]), makeHook([[3]]));
        assert.deepEqual(hooks.callAll('testHook'), [null, 2, [3]]);
      });

      it('all undefined -> []', async function() {
        testHooks.push(makeHook(), makeHook());
        assert.deepEqual(hooks.callAll('testHook'), []);
      });
    });
  });

  describe('hooks.aCallAll', function() {
    const backups = {};
    let testHooks;
    let hookFn;
    beforeEach(async function() {
      hookFn = async () => {};
      backups.deprecationNotices = {};
      backups.deprecationNotices.testHook = hooks.deprecationNotices.testHook;
      backups.hooks = {};
      backups.hooks.testHook = plugins.hooks.testHook || [];
      plugins.hooks.testHook = [{
        hook_name: 'testHook',
        hook_fn: (...args) => hookFn(...args),
        hook_fn_name: 'pluginFileName:hookFunctionName',
        part: {name: 'pluginName'},
      }];
      testHooks = plugins.hooks.testHook;
    });
    afterEach(async function() {
      sinon.restore();
      hooks.deprecationNotices.testHook = backups.deprecationNotices.testHook;
      Object.assign(plugins.hooks, backups.hooks);
      const depDone = hooks.exportedForTestingOnly.deprecationWarned;
      for (const prop in depDone) {
        if (depDone.hasOwnProperty(prop)) delete depDone[prop];
      }
    });

    describe('aCallAll behavior', function() {
      it('calls all asynchronously', async function() {
        testHooks.length = 0; // Delete the boilerplate hook -- this test doesn't use it.
        let nextIndex = 0;
        const hookPromises = [];
        const hookStarted = [];
        const hookFinished = [];
        const makeHook = () => {
          const i = nextIndex++;
          const entry = {};
          hookPromises[i] = entry;
          entry.promise = new Promise((resolve) => {
            entry.resolve = () => {
              hookFinished[i] = true;
              resolve(i);
            };
          });
          return {hook_fn: () => {
            hookStarted[i] = true;
            return entry.promise;
          }};
        };
        testHooks.push(makeHook(), makeHook());
        const p = hooks.aCallAll('testHook');
        assert.deepEqual(hookStarted, [true, true]);
        assert.deepEqual(hookFinished, []);
        hookPromises[0].resolve();
        await hookPromises[0].promise;
        assert.deepEqual(hookFinished, [true]);
        hookPromises[1].resolve();
        assert.deepEqual(await p, [0, 1]);
      });

      it('hook name matches', async function() {
        hookFn = async (hookName) => {
          assert.equal(hookName, 'testHook');
        };
        await hooks.aCallAll('testHook');
      });

      it('undefined context -> {}', async function() {
        hookFn = async (hookName, context) => {
          assert.deepEqual(context, {});
        };
        await hooks.aCallAll('testHook');
      });

      it('null context -> {}', async function() {
        hookFn = async (hookName, context) => {
          assert.deepEqual(context, {});
        };
        await hooks.aCallAll('testHook', null);
      });

      it('context unmodified', async function() {
        const wantContext = {};
        hookFn = async (hookName, context) => {
          assert.equal(context, wantContext);
        };
        await hooks.aCallAll('testHook', wantContext);
      });

      it('async exception rejects', async function() {
        hookFn = async () => {
          throw new Error('test exception');
        };
        await assert.rejects(hooks.aCallAll('testHook'), {message: 'test exception'});
      });

      it('sync exception rejects', async function() {
        hookFn = () => {
          throw new Error('test exception');
        };
        await assert.rejects(hooks.aCallAll('testHook'), {message: 'test exception'});
      });

      it('checks for deprecation', async function() {
        sinon.stub(console, 'warn');
        hooks.deprecationNotices.testHook = 'test deprecation';
        await hooks.aCallAll('testHook');
        assert.equal(
            hooks.exportedForTestingOnly.deprecationWarned['pluginFileName:hookFunctionName'],
            true);
        assert.equal(console.warn.callCount, 1);
        assert.match(console.warn.getCall(0).args[0], /test deprecation/);
      });
    });

    describe('aCallAll callback', function() {
      it('exception in callback rejects', async function() {
        const p = hooks.aCallAll('testHook', {}, () => {
          throw new Error('test exception');
        });
        await assert.rejects(p, {message: 'test exception'});
      });

      it('propagates error on exception', async function() {
        hookFn = () => {
          throw new Error('test exception');
        };
        await hooks.aCallAll('testHook', {}, (err) => {
          assert(err != null);
          assert(err instanceof Error);
          assert.equal(err.message, 'test exception');
        });
      });

      it('propagages null error on success', async function() {
        await hooks.aCallAll('testHook', {}, (err) => {
          assert(err == null, `got non-null error: ${err}`);
        });
      });

      it('propagages results on success', async function() {
        hookFn = () => 'ret';
        await hooks.aCallAll('testHook', {}, (err, results) => {
          assert.deepEqual(results, ['ret']);
        });
      });

      it('returns callback return value', async function() {
        assert.equal(await hooks.aCallAll('testHook', {}, () => 'ret'), 'ret');
      });
    });

    describe('supported hook function styles', function() {
      const testCases = [
        {
          name: 'legacy async',
          fn: (hookName, context, cb) => {
            process.nextTick(cb, context.ret);
          },
        },
        {
          name: 'sync cb',
          fn: (hookName, context, cb) => {
            cb(context.ret);
          },
        },
        {
          name: 'sync return cb',
          fn: (hookName, context, cb) => {
            return cb(context.ret);
          },
        },
        {
          name: 'sync direct return',
          fn: (hookName, context) => {
            return context.ret;
          },
        },
        {
          name: 'pass resolved Promise to cb',
          fn: (hookName, context, cb) => {
            cb(Promise.resolve(context.ret));
          },
        },
        {
          name: 'pass unresolved Promise to cb',
          fn: (hookName, context, cb) => {
            cb(new Promise((resolve) => process.nextTick(resolve, context.ret)));
          },
        },
        {
          name: 'async with delayed resolution',
          fn: async (hookName, context) => {
            return await new Promise((resolve) => process.nextTick(resolve, context.ret));
          },
        },
        {
          name: 'async with sync resolution',
          fn: async (hookName, context) => {
            return context.ret;
          },
        },
      ];

      for (const tc of testCases) {
        it(tc.name, async function() {
          hookFn = tc.fn;
          assert.deepEqual(await hooks.aCallAll('testHook', {ret: 'val'}), ['val']);
        });
      }
    });

    // Test various ways a hook might attempt to settle twice. (Examples: call the callback a second
    // time, or call the callback and then return a value.)
    describe('hook functions that settle twice', function() {
      beforeEach(function() {
        sinon.stub(console, 'error');
      });

      // Each item in this array codifies a different way to settle an asynchronous hook function.
      // Each of the test cases below combines two of these behaviors in a single hook function and
      // confirms that aCallAll both (1) yields the result of the first settle attempt, and (2)
      // detects the second settle attempt.
      //
      // The 'when' property specifies the relative time that two behaviors will cause the hook
      // function to settle:
      //   * If behavior1.when <= behavior2.when and behavior1 is called before behavior2 then
      //     behavior1 will settle the hook function before behavior2.
      //   * Otherwise, behavior2 will settle the hook function before behavior1.
      const behaviors = [
        {
          name: 'throw',
          fn: (cb, val) => { throw new Error(val); },
          rejects: true,
          when: 0,
        },
        {
          name: 'return value',
          fn: (cb, val) => val,
          // This behavior has a later relative settle time vs. the 'throw' behavior because 'throw'
          // immediately settles the hook function, whereas the 'return value' case is settled by a
          // .then() function attached to a Promise. EcmaScript guarantees that a .then() function
          // attached to a Promise is enqueued on the event loop (not executed immediately) when the
          // Promise settles.
          when: 1,
        },
        {
          name: 'cb(value)',
          fn: (cb, val) => cb(val),
          // This behavior has the same relative time as the 'return value' case because it too is
          // settled by a .then() function attached to a Promise.
          when: 1,
        },
        {
          name: 'return resolvedPromise',
          fn: (cb, val) => Promise.resolve(val),
          // This behavior has the same relative time as the 'return value' case because the return
          // value is wrapped in a Promise via Promise.resolve(). The EcmaScript standard guarantees
          // that Promise.resolve(Promise.resolve(value)) is equivalent to Promise.resolve(value),
          // so returning an already resolved Promise vs. returning a non-Promise value are
          // equivalent.
          when: 1,
        },
        {
          name: 'cb(resolvedPromise)',
          fn: (cb, val) => cb(Promise.resolve(val)),
          when: 1,
        },
        {
          name: 'return rejectedPromise',
          fn: (cb, val) => Promise.reject(new Error(val)),
          rejects: true,
          when: 1,
        },
        {
          name: 'cb(rejectedPromise)',
          fn: (cb, val) => cb(Promise.reject(new Error(val))),
          rejects: true,
          when: 1,
        },
        {
          name: 'return unresolvedPromise',
          fn: (cb, val) => new Promise((resolve) => process.nextTick(resolve, val)),
          when: 2,
        },
        {
          name: 'cb(unresolvedPromise)',
          fn: (cb, val) => cb(new Promise((resolve) => process.nextTick(resolve, val))),
          when: 2,
        },
        {
          name: 'return notYetRejectedPromise',
          fn: (cb, val) => new Promise(
              (resolve, reject) => process.nextTick(reject, new Error(val))),
          rejects: true,
          when: 2,
        },
        {
          name: 'cb(notYetRejectedPromise)',
          fn: (cb, val) => cb(new Promise(
              (resolve, reject) => process.nextTick(reject, new Error(val)))),
          rejects: true,
          when: 2,
        },
      ];

      for (const step1 of behaviors) {
        // There can't be a second step if the first step is to return or throw.
        if (step1.name.startsWith('return ') || step1.name === 'throw') continue;
        for (const step2 of behaviors) {
          it(`${step1.name} then ${step2.name} -> buggy hook detected`, async function() {
            hookFn = (hookName, context, cb) => {
              step1.fn(cb, context.ret1);
              return step2.fn(cb, context.ret2);
            };

            // Temporarily remove unhandled Promise rejection listeners.
            const event = 'unhandledRejection';
            const listenersBackup = process.rawListeners(event);
            process.removeAllListeners(event);
            let tempListener;
            let uncaughtErr;
            try {
              const uncaughtPromise = new Promise((resolve) => {
                tempListener = resolve;
                process.once(event, tempListener);
              });
              const step1Wins = step1.when <= step2.when;
              const winningStep = step1Wins ? step1 : step2;
              const runHook = () => hooks.aCallAll('testHook', {ret1: 'val1', ret2: 'val2'});
              if (winningStep.rejects) {
                await assert.rejects(runHook());
              } else {
                assert.deepEqual(await runHook(), [step1Wins ? 'val1' : 'val2']);
              }
              uncaughtErr = await uncaughtPromise;
            } finally {
              // Restore the original listeners.
              process.off(event, tempListener);
              for (const listener of listenersBackup) {
                process.on(event, listener);
              }
            }
            assert.equal(console.error.callCount, 1);
            assert(console.error.calledWith(sinon.match(/Ignoring this attempt/)));
            assert(uncaughtErr != null);
            assert(uncaughtErr instanceof Error);
            assert.match(uncaughtErr.message, /BUG IN HOOK FUNCTION/);
          });
        }
      }
    });

    describe('result processing', function() {
      beforeEach(async function() {
        testHooks.length = 0; // Delete the boilerplate hook -- none of these tests use it.
      });

      it('no registered hooks (undefined) -> []', async function() {
        delete plugins.hooks.testHook;
        assert.deepEqual(await hooks.aCallAll('testHook'), []);
      });

      it('no registered hooks (empty list) -> []', async function() {
        assert.deepEqual(await hooks.aCallAll('testHook'), []);
      });

      it('flattens one level', async function() {
        testHooks.push({hook_fn: () => 1}, {hook_fn: () => [2]}, {hook_fn: () => [[3]]});
        assert.deepEqual(await hooks.aCallAll('testHook'), [1, 2, [3]]);
      });

      it('filters out undefined', async function() {
        testHooks.push({hook_fn: async () => {}}, {hook_fn: () => [2]}, {hook_fn: () => [[3]]});
        assert.deepEqual(await hooks.aCallAll('testHook'), [2, [3]]);
      });

      it('preserves null', async function() {
        testHooks.push({hook_fn: () => null}, {hook_fn: () => [2]}, {hook_fn: () => [[3]]});
        assert.deepEqual(await hooks.aCallAll('testHook'), [null, 2, [3]]);
      });

      it('all undefined -> []', async function() {
        testHooks.push({hook_fn: async () => {}}, {hook_fn: async () => {}});
        assert.deepEqual(await hooks.aCallAll('testHook'), []);
      });
    });
  });
});

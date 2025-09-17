import { environment, exit as exit$1, stderr } from '@bytecodealliance/preview2-shim/cli';
import { error, streams } from '@bytecodealliance/preview2-shim/io';
const { getEnvironment } = environment;
const { exit } = exit$1;
const { getStderr } = stderr;
const { Error: Error$1 } = error;
const { OutputStream } = streams;

let dv = new DataView(new ArrayBuffer());
const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);

function toInt32(val) {
  return val >> 0;
}

const utf8Encoder = new TextEncoder();
let utf8EncodedLen = 0;
function utf8Encode(s, realloc, memory) {
  if (typeof s !== 'string') throw new TypeError('expected a string');
  if (s.length === 0) {
    utf8EncodedLen = 0;
    return 1;
  }
  let buf = utf8Encoder.encode(s);
  let ptr = realloc(0, 0, 1, buf.length);
  new Uint8Array(memory.buffer).set(buf, ptr);
  utf8EncodedLen = buf.length;
  return ptr;
}

const T_FLAG = 1 << 30;

function rscTableCreateOwn (table, rep) {
  const free = table[0] & ~T_FLAG;
  if (free === 0) {
    table.push(0);
    table.push(rep | T_FLAG);
    return (table.length >> 1) - 1;
  }
  table[0] = table[free << 1];
  table[free << 1] = 0;
  table[(free << 1) + 1] = rep | T_FLAG;
  return free;
}

function rscTableRemove (table, handle) {
  const scope = table[handle << 1];
  const val = table[(handle << 1) + 1];
  const own = (val & T_FLAG) !== 0;
  const rep = val & ~T_FLAG;
  if (val === 0 || (scope & T_FLAG) !== 0) throw new TypeError('Invalid handle');
  table[handle << 1] = table[0] | T_FLAG;
  table[0] = handle | T_FLAG;
  return { rep, scope, own };
}

let curResourceBorrows = [];

let NEXT_TASK_ID = 0n;
function startCurrentTask(componentIdx, isAsync, entryFnName) {
  _debugLog('[startCurrentTask()] args', { componentIdx, isAsync });
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while starting task');
  }
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);

  const nextId = ++NEXT_TASK_ID;
  const newTask = new AsyncTask({ id: nextId, componentIdx, isAsync, entryFnName });
  const newTaskMeta = { id: nextId, componentIdx, task: newTask };

  ASYNC_CURRENT_TASK_IDS.push(nextId);
  ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);

  if (!tasks) {
    ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
    return nextId;
  } else {
    tasks.push(newTaskMeta);
  }

  return nextId;
}

function endCurrentTask(componentIdx, taskId) {
  _debugLog('[endCurrentTask()] args', { componentIdx });
  componentIdx ??= ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
  taskId ??= ASYNC_CURRENT_TASK_IDS.at(-1);
  if (componentIdx === undefined || componentIdx === null) {
    throw new Error('missing/invalid component instance index while ending current task');
  }
  const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
  if (!tasks || !Array.isArray(tasks)) {
    throw new Error('missing/invalid tasks for component instance while ending task');
  }
  if (tasks.length == 0) {
    throw new Error('no current task(s) for component instance while ending task');
  }

  if (taskId) {
    const last = tasks[tasks.length - 1];
    if (last.id !== taskId) {
      throw new Error('current task does not match expected task ID');
    }
  }

  ASYNC_CURRENT_TASK_IDS.pop();
  ASYNC_CURRENT_COMPONENT_IDXS.pop();

  return tasks.pop();
}
const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
const ASYNC_CURRENT_TASK_IDS = [];
const ASYNC_CURRENT_COMPONENT_IDXS = [];

class AsyncTask {
  static State = {
    INITIAL: 'initial',
    CANCELLED: 'cancelled',
    CANCEL_PENDING: 'cancel-pending',
    CANCEL_DELIVERED: 'cancel-delivered',
    RESOLVED: 'resolved',
  }

  static BlockResult = {
    CANCELLED: 'block.cancelled',
    NOT_CANCELLED: 'block.not-cancelled',
  }

  #id;
  #componentIdx;
  #state;
  #isAsync;
  #onResolve = null;
  #returnedResults = null;
  #entryFnName = null;

  cancelled = false;
  requested = false;
  alwaysTaskReturn = false;

  returnCalls =  0;
  storage = [0, 0];
  borrowedHandles = {};

  awaitableResume = null;
  awaitableCancel = null;

  constructor(opts) {
    if (opts?.id === undefined) { throw new TypeError('missing task ID during task creation'); }
    this.#id = opts.id;
    if (opts?.componentIdx === undefined) {
      throw new TypeError('missing component id during task creation');
    }
    this.#componentIdx = opts.componentIdx;
    this.#state = AsyncTask.State.INITIAL;
    this.#isAsync = opts?.isAsync ?? false;
    this.#entryFnName = opts.entryFnName;

    this.#onResolve = (results) => {
      this.#returnedResults = results;
    }
  }

  taskState() { return this.#state.slice(); }
  id() { return this.#id; }
  componentIdx() { return this.#componentIdx; }
  isAsync() { return this.#isAsync; }
  getEntryFnName() { return this.#entryFnName; }

  takeResults() {
    const results = this.#returnedResults;
    this.#returnedResults = null;
    return results;
  }

  mayEnter(task) {
    const cstate = getOrCreateAsyncState(this.#componentIdx);
    if (!cstate.backpressure) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
      return false;
    }
    if (!cstate.callingSyncImport()) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
      return false;
    }
    const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
    if (!callingSyncExportWithSyncPending) {
      _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
      return false;
    }
    return true;
  }

  async enter() {
    _debugLog('[AsyncTask#enter()] args', { taskID: this.#id });

    // TODO: assert scheduler locked
    // TODO: trap if on the stack

    const cstate = getOrCreateAsyncState(this.#componentIdx);

    let mayNotEnter = !this.mayEnter(this);
    const componentHasPendingTasks = cstate.pendingTasks > 0;
    if (mayNotEnter || componentHasPendingTasks) {

      throw new Error('in enter()'); // TODO: remove
      cstate.pendingTasks.set(this.#id, new Awaitable(new Promise()));

      const blockResult = await this.onBlock(awaitable);
      if (blockResult) {
        // TODO: find this pending task in the component
        const pendingTask = cstate.pendingTasks.get(this.#id);
        if (!pendingTask) {
          throw new Error('pending task [' + this.#id + '] not found for component instance');
        }
        cstate.pendingTasks.remove(this.#id);
        this.#onResolve([]);
        return false;
      }

      mayNotEnter = !this.mayEnter(this);
      if (!mayNotEnter || !cstate.startPendingTask) {
        throw new Error('invalid component entrance/pending task resolution');
      }
      cstate.startPendingTask = false;
    }

    if (!this.isAsync) { cstate.callingSyncExport = true; }

    return true;
  }

  async waitForEvent(opts) {
    const { waitableSetRep, isAsync } = opts;
    _debugLog('[AsyncTask#waitForEvent()] args', { taskID: this.#id, waitableSetRep, isAsync });

    if (this.#isAsync !== isAsync) {
      throw new Error('async waitForEvent called on non-async task');
    }

    if (this.status === AsyncTask.State.CANCEL_PENDING) {
      this.#state = AsyncTask.State.CANCEL_DELIVERED;
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
      };
    }

    const state = getOrCreateAsyncState(this.#componentIdx);
    const waitableSet = state.waitableSets.get(waitableSetRep);
    if (!waitableSet) { throw new Error('missing/invalid waitable set'); }

    waitableSet.numWaiting += 1;
    let event = null;

    while (event == null) {
      const awaitable = new Awaitable(waitableSet.getPendingEvent());
      const waited = await this.blockOn({ awaitable, isAsync, isCancellable: true });
      if (waited) {
        if (this.#state !== AsyncTask.State.INITIAL) {
          throw new Error('task should be in initial state found [' + this.#state + ']');
        }
        this.#state = AsyncTask.State.CANCELLED;
        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        };
      }

      event = waitableSet.poll();
    }

    waitableSet.numWaiting -= 1;
    return event;
  }

  waitForEventSync(opts) {
    throw new Error('AsyncTask#yieldSync() not implemented')
  }

  async pollForEvent(opts) {
    const { waitableSetRep, isAsync } = opts;
    _debugLog('[AsyncTask#pollForEvent()] args', { taskID: this.#id, waitableSetRep, isAsync });

    if (this.#isAsync !== isAsync) {
      throw new Error('async pollForEvent called on non-async task');
    }

    throw new Error('AsyncTask#pollForEvent() not implemented');
  }

  pollForEventSync(opts) {
    throw new Error('AsyncTask#yieldSync() not implemented')
  }

  async blockOn(opts) {
    const { awaitable, isCancellable, forCallback } = opts;
    _debugLog('[AsyncTask#blockOn()] args', { taskID: this.#id, awaitable, isCancellable, forCallback });

    if (awaitable.resolved() && !ASYNC_DETERMINISM && _coinFlip()) {
      return AsyncTask.BlockResult.NOT_CANCELLED;
    }

    const cstate = getOrCreateAsyncState(this.#componentIdx);
    if (forCallback) { cstate.exclusiveRelease(); }

    let cancelled = await this.onBlock(awaitable);
    if (cancelled === AsyncTask.BlockResult.CANCELLED && !isCancellable) {
      const secondCancel = await this.onBlock(awaitable);
      if (secondCancel !== AsyncTask.BlockResult.NOT_CANCELLED) {
        throw new Error('uncancellable task was canceled despite second onBlock()');
      }
    }

    if (forCallback) {
      const acquired = new Awaitable(cstate.exclusiveLock());
      cancelled = await this.onBlock(acquired);
      if (cancelled === AsyncTask.BlockResult.CANCELLED) {
        const secondCancel = await this.onBlock(acquired);
        if (secondCancel !== AsyncTask.BlockResult.NOT_CANCELLED) {
          throw new Error('uncancellable callback task was canceled despite second onBlock()');
        }
      }
    }

    if (cancelled === AsyncTask.BlockResult.CANCELLED) {
      if (this.#state !== AsyncTask.State.INITIAL) {
        throw new Error('cancelled task is not at initial state');
      }
      if (isCancellable) {
        this.#state = AsyncTask.State.CANCELLED;
        return AsyncTask.BlockResult.CANCELLED;
      } else {
        this.#state = AsyncTask.State.CANCEL_PENDING;
        return AsyncTask.BlockResult.NOT_CANCELLED;
      }
    }

    return AsyncTask.BlockResult.NOT_CANCELLED;
  }

  async onBlock(awaitable) {
    _debugLog('[AsyncTask#onBlock()] args', { taskID: this.#id, awaitable });
    if (!(awaitable instanceof Awaitable)) {
      throw new Error('invalid awaitable during onBlock');
    }

    // Build a promise that this task can await on which resolves when it is awoken
    const { promise, resolve, reject } = Promise.withResolvers();
    this.awaitableResume = () => {
      _debugLog('[AsyncTask] resuming after onBlock', { taskID: this.#id });
      resolve();
    };
    this.awaitableCancel = (err) => {
      _debugLog('[AsyncTask] rejecting after onBlock', { taskID: this.#id, err });
      reject(err);
    };

    // Park this task/execution to be handled later
    const state = getOrCreateAsyncState(this.#componentIdx);
    state.parkTaskOnAwaitable({ awaitable, task: this });

    try {
      await promise;
      return AsyncTask.BlockResult.NOT_CANCELLED;
    } catch (err) {
      // rejection means task cancellation
      return AsyncTask.BlockResult.CANCELLED;
    }
  }

  // NOTE: this should likely be moved to a SubTask class
  async asyncOnBlock(awaitable) {
    _debugLog('[AsyncTask#asyncOnBlock()] args', { taskID: this.#id, awaitable });
    if (!(awaitable instanceof Awaitable)) {
      throw new Error('invalid awaitable during onBlock');
    }
    // TODO: watch for waitable AND cancellation
    // TODO: if it WAS cancelled:
    // - return true
    // - only once per subtask
    // - do not wait on the scheduler
    // - control flow should go to the subtask (only once)
    // - Once subtask blocks/resolves, reqlinquishControl() will tehn resolve request_cancel_end (without scheduler lock release)
    // - control flow goes back to request_cancel
    //
    // Subtask cancellation should work similarly to an async import call -- runs sync up until
    // the subtask blocks or resolves
    //
    throw new Error('AsyncTask#asyncOnBlock() not yet implemented');
  }

  async yield(opts) {
    const { isCancellable, forCallback } = opts;
    _debugLog('[AsyncTask#yield()] args', { taskID: this.#id, isCancellable, forCallback });

    if (isCancellable && this.status === AsyncTask.State.CANCEL_PENDING) {
      this.#state = AsyncTask.State.CANCELLED;
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload: [0, 0],
      };
    }

    // TODO: Awaitables need to *always* trigger the parking mechanism when they're done...?
    // TODO: Component async state should remember which awaitables are done and work to clear tasks waiting

    const blockResult = await this.blockOn({
      awaitable: new Awaitable(new Promise(resolve => setTimeout(resolve, 0))),
      isCancellable,
      forCallback,
    });

    if (blockResult === AsyncTask.BlockResult.CANCELLED) {
      if (this.#state !== AsyncTask.State.INITIAL) {
        throw new Error('task should be in initial state found [' + this.#state + ']');
      }
      this.#state = AsyncTask.State.CANCELLED;
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload: [0, 0],
      };
    }

    return {
      code: ASYNC_EVENT_CODE.NONE,
      payload: [0, 0],
    };
  }

  yieldSync(opts) {
    throw new Error('AsyncTask#yieldSync() not implemented')
  }

  cancel() {
    _debugLog('[AsyncTask#cancel()] args', { });
    if (!this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
      throw new Error('invalid task state for cancellation');
    }
    if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }

    this.#onResolve([]);
    this.#state = AsyncTask.State.RESOLVED;
  }

  resolve(result) {
    if (this.#state === AsyncTask.State.RESOLVED) {
      throw new Error('task is already resolved');
    }
    if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
    this.#onResolve(result);
    this.#state = AsyncTask.State.RESOLVED;
  }

  exit() {
    // TODO: ensure there is only one task at a time (scheduler.lock() functionality)
    if (this.#state !== AsyncTask.State.RESOLVED) {
      throw new Error('task exited without resolution');
    }
    if (this.borrowedHandles > 0) {
      throw new Error('task exited without clearing borrowed handles');
    }

    const state = getOrCreateAsyncState(this.#componentIdx);
    if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
    if (!this.#isAsync && !state.inSyncExportCall) {
      throw new Error('sync task must be run from components known to be in a sync export call');
    }
    state.inSyncExportCall = false;

    this.startPendingTask();
  }

  startPendingTask(opts) {
    // TODO: implement
  }

}

function unpackCallbackResult(result) {
  _debugLog('[unpackCallbackResult()] args', { result });
  if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
  const eventCode = result & 0xF;
  if (eventCode < 0 || eventCode > 3) {
    throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
  }
  if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
  // TODO: table max length check?
  const waitableSetIdx = result >> 4;
  return [eventCode, waitableSetIdx];
}
const ASYNC_STATE = new Map();

function getOrCreateAsyncState(componentIdx, init) {
  if (!ASYNC_STATE.has(componentIdx)) {
    ASYNC_STATE.set(componentIdx, new ComponentAsyncState());
  }
  return ASYNC_STATE.get(componentIdx);
}

class ComponentAsyncState {
  #callingAsyncImport = false;
  #syncImportWait = Promise.withResolvers();
  #lock = null;

  mayLeave = false;
  waitableSets = new RepTable();
  waitables = new RepTable();

  #parkedTasks = new Map();

  callingSyncImport(val) {
    if (val === undefined) { return this.#callingAsyncImport; }
    if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
    const prev = this.#callingAsyncImport;
    this.#callingAsyncImport = val;
    if (prev === true && this.#callingAsyncImport === false) {
      this.#notifySyncImportEnd();
    }
  }

  #notifySyncImportEnd() {
    const existing = this.#syncImportWait;
    this.#syncImportWait = Promise.withResolvers();
    existing.resolve();
  }

  async waitForSyncImportCallEnd() {
    await this.#syncImportWait.promise;
  }

  parkTaskOnAwaitable(args) {
    if (!args.awaitable) { throw new TypeError('missing awaitable when trying to park'); }
    if (!args.task) { throw new TypeError('missing task when trying to park'); }
    const { awaitable, task } = args;

    let taskList = this.#parkedTasks.get(awaitable.id());
    if (!taskList) {
      taskList = [];
      this.#parkedTasks.set(awaitable.id(), taskList);
    }
    taskList.push(task);

    this.wakeNextTaskForAwaitable(awaitable);
  }

  wakeNextTaskForAwaitable(awaitable) {
    if (!awaitable) { throw new TypeError('missing awaitable when waking next task'); }
    const awaitableID = awaitable.id();

    const taskList = this.#parkedTasks.get(awaitableID);
    if (!taskList || taskList.length === 0) {
      _debugLog('[ComponentAsyncState] no tasks waiting for awaitable', { awaitableID: awaitable.id() });
      return;
    }

    let task = taskList.shift(); // todo(perf)
    if (!task) { throw new Error('no task in parked list despite previous check'); }

    if (!task.awaitableResume) {
      throw new Error('task ready due to awaitable is missing resume', { taskID: task.id(), awaitableID });
    }
    task.awaitableResume();
  }

  async exclusiveLock() {  // TODO: use atomics
  if (this.#lock === null) {
    this.#lock = { ticket: 0n };
  }

  // Take a ticket for the next valid usage
  const ticket = ++this.#lock.ticket;

  _debugLog('[ComponentAsyncState#exclusiveLock()] locking', {
    currentTicket: ticket - 1n,
    ticket
  });

  // If there is an active promise, then wait for it
  let finishedTicket;
  while (this.#lock.promise) {
    finishedTicket = await this.#lock.promise;
    if (finishedTicket === ticket - 1n) { break; }
  }

  const { promise, resolve } = Promise.withResolvers();
  this.#lock = {
    ticket,
    promise,
    resolve,
  };

  return this.#lock.promise;
}

exclusiveRelease() {
  _debugLog('[ComponentAsyncState#exclusiveRelease()] releasing', {
    currentTicket: this.#lock === null ? 'none' : this.#lock.ticket,
  });

  if (this.#lock === null) { return; }

  const existingLock = this.#lock;
  this.#lock = null;
  existingLock.resolve(existingLock.ticket);
}

isExclusivelyLocked() { return this.#lock !== null; }

}

if (!Promise.withResolvers) {
  Promise.withResolvers = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const _debugLog = (...args) => {
  if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
  console.debug(...args);
}
const ASYNC_DETERMINISM = 'random';
const _coinFlip = () => { return Math.random() > 0.5; };
const I32_MAX = 2_147_483_647;
const I32_MIN = -2_147_483_648;
const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;

const base64Compile = str => WebAssembly.compile(Uint8Array.from(atob(str), b => b.charCodeAt(0)));

const fetchCompile = url => fetch(url).then(WebAssembly.compileStreaming);

const symbolCabiDispose = Symbol.for('cabiDispose');

const symbolRscHandle = Symbol('handle');

const symbolRscRep = Symbol.for('cabiRep');

const symbolDispose = Symbol.dispose || Symbol.for('dispose');

const handleTables = [];

function getErrorPayload(e) {
  if (e && hasOwnProperty.call(e, 'payload')) return e.payload;
  if (e instanceof Error) throw e;
  return e;
}

class RepTable {
  #data = [0, null];

  insert(val) {
    _debugLog('[RepTable#insert()] args', { val });
    const freeIdx = this.#data[0];
    if (freeIdx === 0) {
      this.#data.push(val);
      this.#data.push(null);
      return (this.#data.length >> 1) - 1;
    }
    this.#data[0] = this.#data[freeIdx];
    const newFreeIdx = freeIdx << 1;
    this.#data[newFreeIdx] = val;
    this.#data[newFreeIdx + 1] = null;
    return free;
  }

  get(rep) {
    _debugLog('[RepTable#insert()] args', { rep });
    const baseIdx = idx << 1;
    const val = this.#data[baseIdx];
    return val;
  }

  contains(rep) {
    _debugLog('[RepTable#insert()] args', { rep });
    const baseIdx = idx << 1;
    return !!this.#data[baseIdx];
  }

  remove(rep) {
    _debugLog('[RepTable#insert()] args', { idx });
    if (this.#data.length === 2) { throw new Error('invalid'); }

    const baseIdx = idx << 1;
    const val = this.#data[baseIdx];
    if (val === 0) { throw new Error('invalid resource rep (cannot be 0)'); }
    this.#data[baseIdx] = this.#data[0];
    this.#data[0] = idx;
    return val;
  }

  clear() {
    this.#data = [0, null];
  }
}

const hasOwnProperty = Object.prototype.hasOwnProperty;

const instantiateCore = WebAssembly.instantiate;


let exports0;
const handleTable1 = [T_FLAG, 0];
const captureTable1= new Map();
let captureCnt1 = 0;
handleTables[1] = handleTable1;

function trampoline2() {
  _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-stderr');
  const ret = getStderr();
  _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  if (!(ret instanceof OutputStream)) {
    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
  }
  var handle0 = ret[symbolRscHandle];
  if (!handle0) {
    const rep = ret[symbolRscRep] || ++captureCnt1;
    captureTable1.set(rep, ret);
    handle0 = rscTableCreateOwn(handleTable1, rep);
  }
  _debugLog('[iface="wasi:cli/stderr@0.2.6", function="get-stderr"][Instruction::Return]', {
    funcName: 'get-stderr',
    paramCount: 1,
    postReturn: false
  });
  return handle0;
}

let exports1;

function trampoline3(arg0) {
  let variant0;
  switch (arg0) {
    case 0: {
      variant0= {
        tag: 'ok',
        val: undefined
      };
      break;
    }
    case 1: {
      variant0= {
        tag: 'err',
        val: undefined
      };
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for expected');
    }
  }
  _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'exit');
  exit(variant0);
  _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  _debugLog('[iface="wasi:cli/exit@0.2.6", function="exit"][Instruction::Return]', {
    funcName: 'exit',
    paramCount: 0,
    postReturn: false
  });
}

let exports2;
let memory0;
let realloc0;
let realloc1;
const handleTable0 = [T_FLAG, 0];
const captureTable0= new Map();
let captureCnt0 = 0;
handleTables[0] = handleTable0;

function trampoline4(arg0, arg1) {
  var handle1 = arg0;
  var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable0.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Error$1.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/error@0.2.6", function="[method]error.to-debug-string"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]error.to-debug-string');
  const ret = rsc0.toDebugString();
  _debugLog('[iface="wasi:io/error@0.2.6", function="[method]error.to-debug-string"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var ptr3 = utf8Encode(ret, realloc0, memory0);
  var len3 = utf8EncodedLen;
  dataView(memory0).setUint32(arg1 + 4, len3, true);
  dataView(memory0).setUint32(arg1 + 0, ptr3, true);
  _debugLog('[iface="wasi:io/error@0.2.6", function="[method]error.to-debug-string"][Instruction::Return]', {
    funcName: '[method]error.to-debug-string',
    paramCount: 0,
    postReturn: false
  });
}


function trampoline5(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, '[method]output-stream.blocking-write-and-flush');
  let ret;
  try {
    ret = { tag: 'ok', val: rsc0.blockingWriteAndFlush(result3)};
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (sync, @ post-call)');
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  endCurrentTask(0);
  var variant6 = ret;
  switch (variant6.tag) {
    case 'ok': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 0, true);
      break;
    }
    case 'err': {
      const e = variant6.val;
      dataView(memory0).setInt8(arg3 + 0, 1, true);
      var variant5 = e;
      switch (variant5.tag) {
        case 'last-operation-failed': {
          const e = variant5.val;
          dataView(memory0).setInt8(arg3 + 4, 0, true);
          if (!(e instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid "Error" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep = e[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, e);
            handle4 = rscTableCreateOwn(handleTable0, rep);
          }
          dataView(memory0).setInt32(arg3 + 8, handle4, true);
          break;
        }
        case 'closed': {
          dataView(memory0).setInt8(arg3 + 4, 1, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
        }
      }
      break;
    }
    default: {
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:io/streams@0.2.6", function="[method]output-stream.blocking-write-and-flush"][Instruction::Return]', {
    funcName: '[method]output-stream.blocking-write-and-flush',
    paramCount: 0,
    postReturn: false
  });
}


function trampoline6(arg0) {
  _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"] [Instruction::CallInterface] (async? sync, @ enter)');
  const _interface_call_currentTaskID = startCurrentTask(0, false, 'get-environment');
  const ret = getEnvironment();
  _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"] [Instruction::CallInterface] (sync, @ post-call)');
  endCurrentTask(0);
  var vec3 = ret;
  var len3 = vec3.length;
  var result3 = realloc1(0, 0, 4, len3 * 16);
  for (let i = 0; i < vec3.length; i++) {
    const e = vec3[i];
    const base = result3 + i * 16;var [tuple0_0, tuple0_1] = e;
    var ptr1 = utf8Encode(tuple0_0, realloc1, memory0);
    var len1 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 4, len1, true);
    dataView(memory0).setUint32(base + 0, ptr1, true);
    var ptr2 = utf8Encode(tuple0_1, realloc1, memory0);
    var len2 = utf8EncodedLen;
    dataView(memory0).setUint32(base + 12, len2, true);
    dataView(memory0).setUint32(base + 8, ptr2, true);
  }
  dataView(memory0).setUint32(arg0 + 4, len3, true);
  dataView(memory0).setUint32(arg0 + 0, result3, true);
  _debugLog('[iface="wasi:cli/environment@0.2.6", function="get-environment"][Instruction::Return]', {
    funcName: 'get-environment',
    paramCount: 0,
    postReturn: false
  });
}

let exports3;
function trampoline0(handle) {
  const handleEntry = rscTableRemove(handleTable0, handle);
  if (handleEntry.own) {

    const rsc = captureTable0.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable0.delete(handleEntry.rep);
    } else if (Error$1[symbolCabiDispose]) {
      Error$1[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline1(handle) {
  const handleEntry = rscTableRemove(handleTable1, handle);
  if (handleEntry.own) {

    const rsc = captureTable1.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable1.delete(handleEntry.rep);
    } else if (OutputStream[symbolCabiDispose]) {
      OutputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let exports1Add;

function add(arg0, arg1) {
  _debugLog('[iface="add", function="add"] [Instruction::CallWasm] (async? false, @ enter)');
  const _wasm_call_currentTaskID = startCurrentTask(0, false, 'exports1Add');
  const ret = exports1Add(toInt32(arg0), toInt32(arg1));
  endCurrentTask(0);
  _debugLog('[iface="add", function="add"][Instruction::Return]', {
    funcName: 'add',
    paramCount: 1,
    postReturn: false
  });
  return ret;
}

const $init = (() => {
  let gen = (function* init () {
    const module0 = fetchCompile(new URL('./rust_wasm.core.wasm', import.meta.url));
    const module1 = base64Compile('AGFzbQEAAAABLQhgAX8AYAJ/fwBgBH9/f38AYAR/f39/AX9gAAF/YAJ/fwF/YAN/f38Bf2AAAALAAggDZW52Bm1lbW9yeQIAABp3YXNpOmNsaS9lbnZpcm9ubWVudEAwLjIuNg9nZXQtZW52aXJvbm1lbnQAABV3YXNpOmlvL3N0cmVhbXNAMC4yLjYcW3Jlc291cmNlLWRyb3Bdb3V0cHV0LXN0cmVhbQAAE3dhc2k6aW8vZXJyb3JAMC4yLjYUW3Jlc291cmNlLWRyb3BdZXJyb3IAAA9fX21haW5fbW9kdWxlX18MY2FiaV9yZWFsbG9jAAMVd2FzaTpjbGkvc3RkZXJyQDAuMi42CmdldC1zdGRlcnIABBV3YXNpOmlvL3N0cmVhbXNAMC4yLjYuW21ldGhvZF1vdXRwdXQtc3RyZWFtLmJsb2NraW5nLXdyaXRlLWFuZC1mbHVzaAACE3dhc2k6Y2xpL2V4aXRAMC4yLjYEZXhpdAAAAxUUBAADBgABAAUFAgAABAAABAAEAAcGEAN/AUEAC38BQQALfwFBAAsHRQQRZW52aXJvbl9zaXplc19nZXQADwlwcm9jX2V4aXQAEQtlbnZpcm9uX2dldAAOE2NhYmlfaW1wb3J0X3JlYWxsb2MACQr8ExQVAQF/AkAQFiIADQAQEyIAEBcLIAALYgEBfyMAQTBrIgEkACABQSA6AC8gAUL0ysmDwq2at+UANwAnIAFCoMLRg5KM2bDwADcAHyABQu7AmIuWjduy5AA3ABcgAULh5s2rpo7dtO8ANwAPIAFBD2pBIRAMIAAQFQALsAQCAn8BfhAaIwBBMGsiBCQAAkACQAJAAkACQAJAAkACQAJAAkAQByIFKAIAQfXOoYsCRw0AIAUoAvz/A0H1zqGLAkcNASAFKQIEIQYgBUEENgIEIARBEGogBUEUaigCADYCACAEQQhqIAVBDGopAgA3AwAgBCAGNwMAIABFDQIgASADTQ0DIAJBAUYNCUGDAxAIAAtB6xUQCAALQewVEAgACyAEKAIADgUFAwIBBAULQYIDEAgACyAEQQxqIQACQCACQQFGDQAgACACIAMQCiEADAULIAQgBCgCBCICQQFqNgIEAkAgAiAEKAIIRg0AIAQgBCkCDDcCGCAEQRhqQQEgAxAKIQAMBQsgAEEBIAMQCiEADAQLAkAgAkEBRg0AIARBDGogAiADEAohAAwECyAEQQRyQQEgA0EBahAKIQAMAwsCQCACQQFGDQAgBEEIaiACIAMQCiEADAMLIAQgBCgCBCADajYCBCAEIAQpAwg3AhggBEEYakEBIAMQCiEADAILQawDEAsgBEG6wAA7ABggBEEYakECEAwgBELm0p2rp66Zsgo3ACggBELh6L2Th+TYt+4ANwAgIARC7t6BicaN27fjADcAGCAEQRhqQRgQDCAEQQo6ABggBEEYakEBEAwACyAEQQRyIAIgAxAKIQAgBEEENgIACyAFQQRqIgUgBCkDADcCACAFQRBqIARBEGooAgA2AgAgBUEIaiAEQQhqKQMANwIAIARBMGokACAAC5kDAQN/IwBBIGsiAyQAAkACQAJAIAFpQQFHDQAgACgCBCIEIAEgACgCACIFakF/akEAIAFrcSAFayIBSQ0BIAQgAWsiBCACTw0CQcIDEAsgA0G6wAA7AAMgA0EDakECEAwgA0EKOgAfIANB4eSdqwY2ABsgA0Lp5oGh9+2bkOwANwATIANC79yBmZfN3rIgNwALIANC4dix+7asmLrpADcAAyADQQNqQR0QDCADQQo6AAMgA0EDakEBEAwAC0HMAxALIANBusAAOwADIANBA2pBAhAMIANB9BQ7ABMgA0Lh2KW75q3bsu4ANwALIANC6dzZi8atmrIgNwADIANBA2pBEhAMIANBCjoAAyADQQNqQQEQDAALQdADEAsgA0G6wAA7AAMgA0EDakECEAwgA0EKOgAVIANB9MoBOwATIANC78CE48bt27HhADcACyADQubCpePWjJmQ9AA3AAMgA0EDakETEAwgA0EKOgADIANBA2pBARAMAAsgACAEIAJrNgIEIAAgBSABaiIBIAJqNgIAIANBIGokACABC3EBAX8jAEEwayIBJAAgAUEgOgAvIAFB7NK5qwY2ACsgAULhyIWDx66ZuSA3ACMgAUL16JWjhqSYuiA3ABsgAULi2JWD0ozesuMANwATIAFC9dzJq5bsmLThADcACyABQQtqQSUQDCAAEBQgAUEwaiQAC2EBAX8jAEEQayICJAAgAhAENgIMIAJBBGogAkEMaiAAIAEQEAJAIAIoAgQiAUECRg0AIAENACACKAIIIgFBf0YNACABEAILAkAgAigCDCIBQX9GDQAgARABCyACQRBqJAALIgEBfyMAQRBrIgEkACAAEAsgAUEKOgAPIAFBD2pBARAMAAvvAgEGfxAaIwBBIGsiAiQAAkACQAJAEAciAygCAEH1zqGLAkcNACADKAL8/wNB9c6hiwJHDQEgA0GYzQM2AhQgA0F/NgIMIAMgATYCCCADIANBsDBqNgIQIAMoAgQhASADQQI2AgQgAUEERw0CIAJCADcCACACEAAgAigCBCEEIAIoAgAhASADQQQ2AgQCQCAERQ0AA0AgAUEMaigCACEDIAFBCGooAgAhBSABQQRqKAIAIQYgACABKAIAIgc2AgAgByAGakE9OgAAIAUgA2pBADoAACABQRBqIQEgAEEEaiEAIARBf2oiBA0ACwsgAkEgaiQAQQAPC0HrFRAIAAtB7BUQCAALQfgWEAsgAkG6wAA7AAAgAkECEAwgAkEKOgAcIAJBoOaVowc2ABggAkKgwrGT16yYsvkANwAQIAJC7Ni9m5aM3bfyADcACCACQunawfumjp2Q4QA3AAAgAkEdEAwgAkEKOgAAIAJBARAMAAvRAgEEfxAaIwBBIGsiAiQAAkACQAJAAkACQAJAAkAQGEF+ag4DAQABAAtBACEDIABBADYCAAwBCxAHIgMoAgBB9c6hiwJHDQEgAygC/P8DQfXOoYsCRw0CIANBmM0DNgIQIAMgA0GwMGo2AgwgAygCBCEEIANCATcCBCAEQQRHDQMgAkIANwIAIAIQACACKAIEIQQgAygCBCEFIANBBDYCBCAFQQFHDQQgAygCCCEDIAAgBDYCACADIARBAXRqIQMLIAEgAzYCACACQSBqJABBAA8LQesVEAgAC0HsFRAIAAtB+BYQCyACQbrAADsAACACQQIQDCACQQo6ABwgAkGg5pWjBzYAGCACQqDCsZPXrJiy+QA3ABAgAkLs2L2blozdt/IANwAIIAJC6drB+6aOnZDhADcAACACQR0QDCACQQo6AAAgAkEBEAwAC0GEBRANAAtSAgF/AX4jAEEQayIEJAAgASgCACACIAMgBEEEahAFAkACQCAELQAEDQBCAiEFDAELQgEgBDUCDEIghiAELQAIGyEFCyAAIAU3AgAgBEEQaiQAC5kBAQF/EBojAEEwayIBJAAgAEEARxASQZoSEAsgAUG6wAA7AAogAUEKakECEAwgAUGhFDsALiABQeXwpaMHNgAqIAFCoMilo+btibogNwAiIAFC5dzRi8au2rfuADcAGiABQvTApOuGjtuy7QA3ABIgAULo3s2jh6SZvOkANwAKIAFBCmpBJhAMIAFBCjoACiABQQpqQQEQDAALBgAgABAGC38BAX8CQBAYQQJHDQBBAxAZQQBBAEEIQYCABBADIQBBBBAZIABBAjYCpDAgAEEANgIYIABC9c6hi8IANwMAAkBBJUUNACAAQcj/A2pBAEEl/AsACyAAQfXOoYsCNgL8/wMgAEGu3AA7Afj/AyAAQQA2AvD/AyAADwtBixYQCAALPwECfyMAQRBrIgEkAAJAIABFDQAgAEEKbiICEBQgASACQfYBbCAAakEwcjoADyABQQ9qQQEQDAsgAUEQaiQACwYAIAAQFAsEACMBCwYAIAAkAQsEACMCCwYAIAAkAgslACMCQQBGBEBBASQCQQBBAEEIQYCABBADQYCABGokAEECJAILCwDWDgRuYW1lAC0sd2l0LWNvbXBvbmVudDphZGFwdGVyOndhc2lfc25hcHNob3RfcHJldmlldzEB5Q0bAElfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzEyNHdhc2lfY2xpX2dldF9lbnZpcm9ubWVudDE3aGQ5MTM0OWQ3NTExZTg4OWRFAa0BX1pOMTM3XyRMVCR3YXNpX3NuYXBzaG90X3ByZXZpZXcxLi5iaW5kaW5ncy4ud2FzaS4uaW8uLnN0cmVhbXMuLk91dHB1dFN0cmVhbSR1MjAkYXMkdTIwJHdhc2lfc25hcHNob3RfcHJldmlldzEuLmJpbmRpbmdzLi5fcnQuLldhc21SZXNvdXJjZSRHVCQ0ZHJvcDRkcm9wMTdoN2U5ZTBjY2M5N2RiOWE2OEUCpAFfWk4xMjhfJExUJHdhc2lfc25hcHNob3RfcHJldmlldzEuLmJpbmRpbmdzLi53YXNpLi5pby4uZXJyb3IuLkVycm9yJHUyMCRhcyR1MjAkd2FzaV9zbmFwc2hvdF9wcmV2aWV3MS4uYmluZGluZ3MuLl9ydC4uV2FzbVJlc291cmNlJEdUJDRkcm9wNGRyb3AxN2gzMDdlM2I2N2JhMWRiNTBjRQNHX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNVN0YXRlM25ldzEyY2FiaV9yZWFsbG9jMTdoOTUxOTliZDU2NGIwM2U5N0UEYV9aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MThiaW5kaW5nczR3YXNpM2NsaTZzdGRlcnIxMGdldF9zdGRlcnIxMXdpdF9pbXBvcnQwMTdoZmFiMjBmZThmZDcwNWY4YUUFfV9aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MThiaW5kaW5nczR3YXNpMmlvN3N0cmVhbXMxMk91dHB1dFN0cmVhbTI0YmxvY2tpbmdfd3JpdGVfYW5kX2ZsdXNoMTF3aXRfaW1wb3J0MjE3aGFiM2Y1NTMzZTkwY2I3NzRFBlhfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE4YmluZGluZ3M0d2FzaTNjbGk0ZXhpdDRleGl0MTF3aXRfaW1wb3J0MTE3aDc1ZThkNTNmYjIwNjFmYTNFBzlfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE1U3RhdGUzcHRyMTdoMjgwMzQ3OWM2OTUwNTgxZEUIQ19aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTZtYWNyb3MxMWFzc2VydF9mYWlsMTdoYjkzMjRiNGRlNzZjNDkwMEUJE2NhYmlfaW1wb3J0X3JlYWxsb2MKP19aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTlCdW1wQWxsb2M1YWxsb2MxN2gwMzNmZWQzOTdhMGE5ODMxRQtKX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNm1hY3JvczE4ZXByaW50X3VucmVhY2hhYmxlMTdoMWJlNDZkMGRlNjE3NDFjMEUMPF9aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MTZtYWNyb3M1cHJpbnQxN2g3YTVlNDgwYzAwYTlhNzNlRQ1DX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNm1hY3JvczExdW5yZWFjaGFibGUxN2g3MDk2ZTg0MDY1ZTE0ODM0RQ4LZW52aXJvbl9nZXQPEWVudmlyb25fc2l6ZXNfZ2V0EHBfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE4YmluZGluZ3M0d2FzaTJpbzdzdHJlYW1zMTJPdXRwdXRTdHJlYW0yNGJsb2NraW5nX3dyaXRlX2FuZF9mbHVzaDE3aDE3ZTI4Y2QzMzAzNmM0MDFFEQlwcm9jX2V4aXQSS19aTjIyd2FzaV9zbmFwc2hvdF9wcmV2aWV3MThiaW5kaW5nczR3YXNpM2NsaTRleGl0NGV4aXQxN2gxYWE2MzgzZTIyNzNkMDhhRRM5X1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNVN0YXRlM25ldzE3aGE4NDQ5OWQxOTEyYjQ2YzNFFFNfWk4yMndhc2lfc25hcHNob3RfcHJldmlldzE2bWFjcm9zMTBlcHJpbnRfdTMyMTVlcHJpbnRfdTMyX2ltcGwxN2hmMGQ3OGE2NzZjMTk1MDQ3RRVCX1pOMjJ3YXNpX3NuYXBzaG90X3ByZXZpZXcxNm1hY3JvczEwZXByaW50X3UzMjE3aGEzNjg3NDhiNjYyODA4MThFFg1nZXRfc3RhdGVfcHRyFw1zZXRfc3RhdGVfcHRyGBRnZXRfYWxsb2NhdGlvbl9zdGF0ZRkUc2V0X2FsbG9jYXRpb25fc3RhdGUaDmFsbG9jYXRlX3N0YWNrBzgDAA9fX3N0YWNrX3BvaW50ZXIBEmludGVybmFsX3N0YXRlX3B0cgIQYWxsb2NhdGlvbl9zdGF0ZQBNCXByb2R1Y2VycwIIbGFuZ3VhZ2UBBFJ1c3QADHByb2Nlc3NlZC1ieQEFcnVzdGMdMS44OC4wICg2YjAwYmMzODggMjAyNS0wNi0yMyk');
    const module2 = base64Compile('AGFzbQEAAAABGwVgAn9/AGAEf39/fwBgAn9/AX9gAX8AYAF/AAMIBwABAgIDBAEEBQFwAQcHBygIATAAAAExAAEBMgACATMAAwE0AAQBNQAFATYABggkaW1wb3J0cwEAClkHCwAgACABQQARAAALDwAgACABIAIgA0EBEQEACwsAIAAgAUECEQIACwsAIAAgAUEDEQIACwkAIABBBBEDAAsJACAAQQURBAALDwAgACABIAIgA0EGEQEACwAvCXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQ13aXQtY29tcG9uZW50BzAuMjM5LjAArwMEbmFtZQATEndpdC1jb21wb25lbnQ6c2hpbQGSAwcAOmluZGlyZWN0LXdhc2k6aW8vZXJyb3JAMC4yLjQtW21ldGhvZF1lcnJvci50by1kZWJ1Zy1zdHJpbmcBTWluZGlyZWN0LXdhc2k6aW8vc3RyZWFtc0AwLjIuNC1bbWV0aG9kXW91dHB1dC1zdHJlYW0uYmxvY2tpbmctd3JpdGUtYW5kLWZsdXNoAihhZGFwdC13YXNpX3NuYXBzaG90X3ByZXZpZXcxLWVudmlyb25fZ2V0Ay5hZGFwdC13YXNpX3NuYXBzaG90X3ByZXZpZXcxLWVudmlyb25fc2l6ZXNfZ2V0BCZhZGFwdC13YXNpX3NuYXBzaG90X3ByZXZpZXcxLXByb2NfZXhpdAUzaW5kaXJlY3Qtd2FzaTpjbGkvZW52aXJvbm1lbnRAMC4yLjYtZ2V0LWVudmlyb25tZW50Bk1pbmRpcmVjdC13YXNpOmlvL3N0cmVhbXNAMC4yLjYtW21ldGhvZF1vdXRwdXQtc3RyZWFtLmJsb2NraW5nLXdyaXRlLWFuZC1mbHVzaA');
    const module3 = base64Compile('AGFzbQEAAAABGwVgAn9/AGAEf39/fwBgAn9/AX9gAX8AYAF/AAIzCAABMAAAAAExAAEAATIAAgABMwACAAE0AAMAATUABAABNgABAAgkaW1wb3J0cwFwAQcHCQ0BAEEACwcAAQIDBAUGAC8JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDXdpdC1jb21wb25lbnQHMC4yMzkuMAAcBG5hbWUAFRR3aXQtY29tcG9uZW50OmZpeHVwcw');
    ({ exports: exports0 } = yield instantiateCore(yield module2));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      'wasi:cli/stderr@0.2.4': {
        'get-stderr': trampoline2,
      },
      'wasi:io/error@0.2.4': {
        '[method]error.to-debug-string': exports0['0'],
        '[resource-drop]error': trampoline0,
      },
      'wasi:io/streams@0.2.4': {
        '[method]output-stream.blocking-write-and-flush': exports0['1'],
        '[resource-drop]output-stream': trampoline1,
      },
      wasi_snapshot_preview1: {
        environ_get: exports0['2'],
        environ_sizes_get: exports0['3'],
        proc_exit: exports0['4'],
      },
    }));
    ({ exports: exports2 } = yield instantiateCore(yield module1, {
      __main_module__: {
        cabi_realloc: exports1.cabi_realloc,
      },
      env: {
        memory: exports1.memory,
      },
      'wasi:cli/environment@0.2.6': {
        'get-environment': exports0['5'],
      },
      'wasi:cli/exit@0.2.6': {
        exit: trampoline3,
      },
      'wasi:cli/stderr@0.2.6': {
        'get-stderr': trampoline2,
      },
      'wasi:io/error@0.2.6': {
        '[resource-drop]error': trampoline0,
      },
      'wasi:io/streams@0.2.6': {
        '[method]output-stream.blocking-write-and-flush': exports0['6'],
        '[resource-drop]output-stream': trampoline1,
      },
    }));
    memory0 = exports1.memory;
    realloc0 = exports1.cabi_realloc;
    realloc1 = exports2.cabi_import_realloc;
    ({ exports: exports3 } = yield instantiateCore(yield module3, {
      '': {
        $imports: exports0.$imports,
        '0': trampoline4,
        '1': trampoline5,
        '2': exports2.environ_get,
        '3': exports2.environ_sizes_get,
        '4': exports2.proc_exit,
        '5': trampoline6,
        '6': trampoline5,
      },
    }));
    exports1Add = exports1.add;
  })();
  let promise, resolve, reject;
  function runNext (value) {
    try {
      let done;
      do {
        ({ value, done } = gen.next(value));
      } while (!(value instanceof Promise) && !done);
      if (done) {
        if (resolve) resolve(value);
        else return value;
      }
      if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
      value.then(runNext, reject);
    }
    catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
  const maybeSyncReturn = runNext(null);
  return promise || maybeSyncReturn;
})();

await $init;

export { add,  }

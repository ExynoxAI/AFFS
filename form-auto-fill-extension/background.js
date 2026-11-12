// AFFS service worker.
// Orchestrates login, feedback submission, and sign-out for every student.
importScripts('constants.js');

const A = globalThis.AFFS;
const DEFAULT_SETTINGS = A.DEFAULTS;
const FEEDBACK_WAIT_MS = 10 * 60 * 1000;
const REGISTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,39}$/;
const HEADER_KEYS = new Set([
  'regno',
  'registerno',
  'registernumber',
  'registernum',
  'register',
  'registernumber',
  'usn',
  'rollno',
  'rollnumber',
  'studentid',
  'student',
  'id',
  'name',
]);

const VALID_STUDENT_STATUS = new Set([
  'pending',
  'running',
  'success',
  'failed',
]);
const VALID_MODE_STATUS = new Set([
  'pending',
  'success',
  'skipped',
  'failed',
  'stopped',
]);
const VALID_LOG_LEVEL = new Set(['info', 'success', 'warn', 'error']);

class StopError extends Error {
  constructor() {
    super('Run stopped.');
    this.name = 'StopError';
  }
}

let state = {
  students: [],
  settings: normalizeSettings(DEFAULT_SETTINGS),
  logs: [],
  status: 'idle',
  runId: 0,
  currentIndex: -1,
  currentReg: '',
  phase: 'Idle',
  progress: { done: 0, total: 0, success: 0, failed: 0 },
  tabId: null,
};

let stopRequested = false;
let activeRun = null;
let initPromise = null;
let logSeq = 0;
let sessionSaveTimer = null;
let keepAliveTimer = null;
let feedbackWaiters = new Map();
let feedbackProgress = new Map();

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isBusy() {
  return state.status === 'running' || state.status === 'stopping';
}

function assertRunning() {
  if (stopRequested) {
    throw new StopError();
  }
}

async function wait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assertRunning();
    await sleep(Math.min(250, end - Date.now()));
  }
}

function broadcast(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // No side panel is open.
  }
}

function publicState() {
  return {
    students: state.students,
    settings: state.settings,
    logs: state.logs,
    status: state.status,
    runId: state.runId,
    currentIndex: state.currentIndex,
    currentReg: state.currentReg,
    phase: state.phase,
    progress: state.progress,
    version: A.VERSION,
  };
}

function broadcastState() {
  const { logs, ...rest } = publicState();
  broadcast({ type: 'STATE_UPDATE', state: rest });
}

function log(level, message) {
  const safeLevel = VALID_LOG_LEVEL.has(level) ? level : 'info';
  const entry = {
    id: `${Date.now()}-${++logSeq}`,
    ts: Date.now(),
    level: safeLevel,
    message: String(message),
  };

  state.logs.push(entry);
  if (state.logs.length > A.LIMITS.maxLogs) {
    state.logs.splice(0, state.logs.length - A.LIMITS.maxLogs);
  }

  broadcast({ type: 'LOG_ENTRY', entry });
  scheduleSessionSave();
}

function isLogEntry(entry) {
  return Boolean(
    entry &&
      typeof entry.ts === 'number' &&
      typeof entry.message === 'string' &&
      VALID_LOG_LEVEL.has(entry.level)
  );
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

function persistStudentsNow() {
  return chrome.storage.local
    .set({ [A.STORAGE.students]: state.students })
    .catch(() => {});
}

function persistSettingsNow() {
  return chrome.storage.local
    .set({ [A.STORAGE.settings]: state.settings })
    .catch(() => {});
}

function persistSessionNow() {
  const area = chrome.storage.session;
  if (!area) {
    return Promise.resolve();
  }

  return area
    .set({
      logs: state.logs,
      status: state.status,
      runId: state.runId,
      phase: state.phase,
      tabId: state.tabId,
    })
    .catch(() => {});
}

function scheduleSessionSave() {
  if (sessionSaveTimer) {
    return;
  }

  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    persistSessionNow();
  }, 250);
}

function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const modes = Array.isArray(input.modes)
    ? [...new Set(input.modes.filter((mode) => mode === 'mid' || mode === 'end'))]
    : [...DEFAULT_SETTINGS.modes];

  return {
    modes,
    dryRun: Boolean(input.dryRun),
    delayMs: clamp(
      Number.isFinite(Number(input.delayMs))
        ? Number(input.delayMs)
        : DEFAULT_SETTINGS.delayMs,
      0,
      10000
    ),
  };
}

function createStudent(regNo) {
  return {
    regNo,
    status: 'pending',
    message: '',
    midStatus: 'pending',
    endStatus: 'pending',
    updatedAt: null,
  };
}

function normalizeStoredRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const regNo = String(record.regNo || '').trim();
  if (!REGISTER_PATTERN.test(regNo)) {
    return null;
  }

  return {
    regNo,
    status: VALID_STUDENT_STATUS.has(record.status) ? record.status : 'pending',
    message:
      typeof record.message === 'string' ? record.message.slice(0, 300) : '',
    midStatus: VALID_MODE_STATUS.has(record.midStatus)
      ? record.midStatus
      : 'pending',
    endStatus: VALID_MODE_STATUS.has(record.endStatus)
      ? record.endStatus
      : 'pending',
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null,
  };
}

function normalizeStoredStudents(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map(normalizeStoredRecord)
    .filter(Boolean)
    .slice(0, A.LIMITS.maxStudents);
}

function normalizeImportedStudents(raw) {
  if (!Array.isArray(raw)) {
    return { error: 'No register numbers were provided.' };
  }

  const seen = new Set();
  const students = [];
  let duplicates = 0;
  let invalid = 0;
  let headers = 0;
  let truncated = 0;

  for (const item of raw) {
    const regNo = String(item ?? '').trim();
    if (!regNo) {
      continue;
    }

    const headerKey = regNo.toLowerCase().replace(/[\s_-]/g, '');
    if (HEADER_KEYS.has(headerKey)) {
      headers += 1;
      continue;
    }

    if (!REGISTER_PATTERN.test(regNo)) {
      invalid += 1;
      continue;
    }

    const dedupeKey = regNo.toLowerCase();
    if (seen.has(dedupeKey)) {
      duplicates += 1;
      continue;
    }

    if (students.length >= A.LIMITS.maxStudents) {
      truncated += 1;
      continue;
    }

    seen.add(dedupeKey);
    students.push(createStudent(regNo));
  }

  return { students, duplicates, invalid, headers, truncated };
}

// -----------------------------------------------------------------------------
// Tab and page helpers
// -----------------------------------------------------------------------------

async function ensureTab() {
  if (state.tabId) {
    const existing = await chrome.tabs.get(state.tabId).catch(() => null);
    if (existing && !existing.discarded) {
      await chrome.tabs.update(state.tabId, { active: true }).catch(() => {});
      return state.tabId;
    }
    state.tabId = null;
  }

  const tab = await chrome.tabs.create({ url: A.LOGIN_URL, active: true });
  state.tabId = tab.id;
  persistSessionNow();
  return state.tabId;
}

async function getPageInfo(tabId, options = {}) {
  const retries = options.retries ?? 6;
  const interval = options.interval ?? 350;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const info = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (info?.ok) {
        return info;
      }
    } catch {
      // The content script may still be loading.
    }

    if (attempt < retries - 1) {
      await sleep(interval);
    }
  }

  return null;
}

async function navigate(tabId, url) {
  assertRunning();

  try {
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    throw new Error(`Could not open ${url}: ${error.message}`);
  }

  const startedAt = Date.now();
  const deadline = startedAt + 45000;
  let lastUrl = '';
  let stableCount = 0;

  while (Date.now() < deadline) {
    assertRunning();

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('The automation tab was closed.');
    }

    if (tab.status === 'complete') {
      const currentUrl = tab.url || '';
      if (currentUrl === lastUrl) {
        stableCount += 1;
      } else {
        lastUrl = currentUrl;
        stableCount = 0;
      }

      if (stableCount >= 2 && Date.now() - startedAt > 600) {
        await sleep(450);
        return tab;
      }
    } else {
      lastUrl = '';
      stableCount = 0;
    }

    await sleep(250);
  }

  throw new Error(`Timed out loading ${url}.`);
}

async function waitForLogin(tabId) {
  const startedAt = Date.now();
  const deadline = startedAt + 20000;

  while (Date.now() < deadline) {
    if (stopRequested) {
      throw new StopError();
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      throw new Error('The automation tab was closed.');
    }

    const url = tab.url || '';

    if (
      tab.status === 'complete' &&
      /index\.xhtml|pages\/student/i.test(url)
    ) {
      await sleep(400);
      return { ok: true };
    }

    if (
      tab.status === 'complete' &&
      /login\.xhtml/i.test(url) &&
      Date.now() - startedAt > 4000
    ) {
      const info = await getPageInfo(tabId, { retries: 2, interval: 250 });
      if (info?.loginError) {
        return {
          ok: false,
          error: `The portal rejected the sign-in: ${info.loginError}`,
        };
      }
    }

    await sleep(300);
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && /index\.xhtml|pages\/student/i.test(tab.url || '')) {
    return { ok: true };
  }

  return {
    ok: false,
    error: 'The portal did not complete the sign-in in time.',
  };
}

async function logout(tabId) {
  try {
    await chrome.tabs.update(tabId, { url: A.LOGOUT_URL });
  } catch (error) {
    throw new Error(`Could not open the sign-out URL: ${error.message}`);
  }

  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return;
    }

    if (
      tab.status === 'complete' &&
      /login\.xhtml/i.test(tab.url || '')
    ) {
      await sleep(350);
      return;
    }

    await sleep(300);
  }

  throw new Error('The portal did not confirm sign-out.');
}

// -----------------------------------------------------------------------------
// Feedback coordination
// -----------------------------------------------------------------------------

function createFeedbackWaiter(key) {
  const existing = feedbackWaiters.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error('Superseded by a new feedback request.'));
    feedbackWaiters.delete(key);
  }

  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  const timer = setTimeout(() => {
    feedbackWaiters.delete(key);
    reject(new Error('Timed out waiting for feedback to finish.'));
  }, FEEDBACK_WAIT_MS);

  feedbackWaiters.set(key, { promise, resolve, reject, timer });
  return { key, promise };
}

function cancelFeedbackWaiter(key) {
  const waiter = feedbackWaiters.get(key);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timer);
  feedbackWaiters.delete(key);
}

function resolveFeedback(message, isError) {
  if (!message || message.runId !== state.runId) {
    return;
  }

  const key = `${message.runId}:${message.student}:${message.mode}`;
  const waiter = feedbackWaiters.get(key);
  if (!waiter) {
    return;
  }

  clearTimeout(waiter.timer);
  feedbackWaiters.delete(key);

  if (isError) {
    waiter.reject(
      new Error(message.error || 'The feedback automation failed.')
    );
  } else {
    waiter.resolve(message);
  }
}

function handleProgress(message) {
  if (!message || message.runId !== state.runId) {
    return;
  }

  if (message.kind !== 'course') {
    return;
  }

  const progressKey = `${message.runId}:${message.student}:${message.mode}`;
  if (feedbackWaiters.has(progressKey)) {
    feedbackProgress.set(progressKey, message.submitted);
  }

  const mode = message.mode === 'mid' ? 'mid' : 'end';
  log(
    'success',
    `${message.student} · ${mode} · ${message.course} submitted (${message.submitted}/${message.total})`
  );
}

async function detectCompletionText(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const exact = document.getElementById('primefacesmessagedlg');
        const exactText = exact ? exact.textContent || '' : '';
        const visibleText = document.body ? document.body.innerText || '' : '';
        const rawText = document.documentElement
          ? document.documentElement.textContent || ''
          : '';
        const text = [exactText, visibleText, rawText]
          .join('\n')
          .replace(/\s+/g, ' ')
          .trim();
        const match =
          text.match(
            /(?:mid|end)\s+semester\s+feedback\s+status\s*:?\s*completed!?/i
          ) || text.match(/feedback\s+status\s*:?\s*completed!?/i);
        return match ? match[0] : '';
      },
    });

    for (const item of results || []) {
      if (item?.result) {
        return item.result;
      }
    }
  } catch {
    // The tab may be navigating, or a frame may not be injectable.
  }

  return '';
}

async function runFeedbackMode(tabId, reg, mode, settings, totalCourses = 0) {
  const key = `${state.runId}:${reg}:${mode}`;
  const waiter = createFeedbackWaiter(key);

  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      type: 'START_FEEDBACK',
      runId: state.runId,
      student: reg,
      mode,
      dryRun: settings.dryRun,
    });
  } catch (error) {
    cancelFeedbackWaiter(key);
    throw new Error(`Could not start ${mode} feedback: ${error.message}`);
  }

  if (!response?.started) {
    cancelFeedbackWaiter(key);
    throw new Error(
      response?.error || `Could not start ${mode} feedback.`
    );
  }

  // Independent completion monitor. This reads the page text directly from
  // the tab, so a slow/stale content-script detector cannot stall the run.
  let monitoring = false;
  const monitor = setInterval(async () => {
    if (monitoring || !feedbackWaiters.has(key)) {
      return;
    }
    monitoring = true;
    try {
      const detected = await detectCompletionText(tabId);
      if (!detected) {
        return;
      }
      const submitted = feedbackProgress.get(key) || 0;
      resolveFeedback(
        {
          type: 'FEEDBACK_COMPLETE',
          runId: state.runId,
          student: reg,
          mode,
          submitted,
          total: totalCourses,
          remaining: 0,
          stopped: false,
          dryRun: settings.dryRun,
          completed: true,
          completion: detected,
        },
        false
      );
    } finally {
      monitoring = false;
    }
  }, 300);

  try {
    return await waiter.promise;
  } catch (error) {
    cancelFeedbackWaiter(key);
    throw error;
  } finally {
    clearInterval(monitor);
    feedbackProgress.delete(key);
  }
}

// -----------------------------------------------------------------------------
// Student processing
// -----------------------------------------------------------------------------

async function processStudent(student, index, settings) {
  const reg = student.regNo;
  const tabId = state.tabId ?? (await ensureTab());
  let loggedIn = false;

  try {
    state.phase = 'Preparing session';
    broadcastState();

    await navigate(tabId, A.LOGIN_URL);
    let info = await getPageInfo(tabId);
    if (!info) {
      throw new Error('The portal did not respond.');
    }

    if (info.pageType !== 'login') {
      log('info', `${reg} · clearing the previous session`);
      await logout(tabId);
      await navigate(tabId, A.LOGIN_URL);
      info = await getPageInfo(tabId);
    }

    if (!info || info.pageType !== 'login') {
      throw new Error('The sign-in page did not load.');
    }

    state.phase = 'Signing in';
    broadcastState();
    log('info', `${reg} · signing in`);

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'LOGIN',
        username: reg,
        password: reg,
      });
    } catch {
      // The sign-in click navigates away, so the message channel may close.
    }

    const login = await waitForLogin(tabId);
    if (!login.ok) {
      throw new Error(login.error || 'The portal rejected the sign-in.');
    }

    loggedIn = true;
    log('success', `${reg} · signed in`);

    let processedAny = false;

    for (const mode of settings.modes) {
      assertRunning();

      const isMid = mode === 'mid';
      const pageLabel = isMid ? 'mid-term' : 'end-term';
      const statusKey = isMid ? 'midStatus' : 'endStatus';

      state.phase = `${pageLabel} feedback`;
      broadcastState();

      await navigate(tabId, isMid ? A.MID_URL : A.END_URL);
      const pageInfo = await getPageInfo(tabId);
      if (!pageInfo) {
        throw new Error(`The ${pageLabel} page did not respond.`);
      }

      if (pageInfo.pageType === 'login') {
        throw new Error(
          'The portal session ended before feedback could be submitted.'
        );
      }

      if (pageInfo.pageType !== mode) {
        if (!settings.dryRun) {
          student[statusKey] = 'skipped';
          updateStudent(index, { [statusKey]: 'skipped' });
        }
        log('warn', `${reg} · ${pageLabel} page not available; skipped`);
        continue;
      }

      if (/completed!?/i.test(pageInfo.completionDialog || '')) {
        processedAny = true;
        if (!settings.dryRun) {
          student[statusKey] = 'success';
          updateStudent(index, { [statusKey]: 'success' });
        }
        log(
          'success',
          `${reg} · ${pageLabel} already completed`
        );
        continue;
      }

      if (pageInfo.courses.length === 0) {
        if (!settings.dryRun) {
          student[statusKey] = 'skipped';
          updateStudent(index, { [statusKey]: 'skipped' });
        }
        log('info', `${reg} · no ${pageLabel} feedback left`);
        continue;
      }

      processedAny = true;
      log(
        'info',
        `${reg} · ${pageLabel} · ${pageInfo.courses.length} course(s)`
      );

      const result = await runFeedbackMode(
        tabId,
        reg,
        mode,
        settings,
        pageInfo.courses.length
      );

      if (result.stopped) {
        if (!settings.dryRun) {
          student[statusKey] = 'stopped';
          updateStudent(index, { [statusKey]: 'stopped' });
        }
        log(
          'warn',
          `${reg} · ${pageLabel} stopped after ${result.submitted}/${result.total}`
        );
        throw new StopError();
      }

      if (result.alreadyCompleted) {
        if (!settings.dryRun) {
          student[statusKey] = 'success';
          updateStudent(index, { [statusKey]: 'success' });
        }
        log(
          'success',
          `${reg} · ${pageLabel} already completed`
        );
        continue;
      }

      if (!settings.dryRun) {
        student[statusKey] = 'success';
        updateStudent(index, { [statusKey]: 'success' });
      }

      if (result.dryRun) {
        log(
          'success',
          `${reg} · ${pageLabel} dry run · ${result.course || 'first course'} filled (${result.filled || 0} field(s)); submit skipped`
        );
      } else {
        log(
          'success',
          `${reg} · ${pageLabel} · ${result.submitted}/${result.total} course(s) submitted`
        );

        if (/completed!?/i.test(result.completion || '')) {
          log('success', `${reg} · ${pageLabel} · portal reports Completed!`);
        }
      }
    }

    return {
      success: true,
      message: processedAny ? 'Completed' : 'No feedback was pending.',
    };
  } finally {
    if (loggedIn) {
      state.phase = 'Signing out';
      broadcastState();

      try {
        await logout(tabId);
        log('info', `${reg} · signed out`);
      } catch (error) {
        log('warn', `${reg} · sign-out failed: ${error.message}`);
      }
    }
  }
}

function updateStudent(index, patch) {
  const student = state.students[index];
  if (!student) {
    return;
  }

  Object.assign(student, patch, { updatedAt: Date.now() });
  persistStudentsNow();
  broadcastState();
}

// -----------------------------------------------------------------------------
// Run loop
// -----------------------------------------------------------------------------

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function runQueue(queue, settings) {
  let done = 0;
  let success = 0;
  let failed = 0;
  let stopped = false;
  let fatal = null;

  startKeepAlive();

  try {
    await ensureTab();

    for (let i = 0; i < queue.length; i += 1) {
      if (stopRequested) {
        stopped = true;
        break;
      }

      const { student, index } = queue[i];
      const reg = student.regNo;
      const snapshot = settings.dryRun ? { ...student } : null;

      state.currentIndex = index;
      state.currentReg = reg;
      state.phase = 'Starting student';
      state.progress = { done, total: queue.length, success, failed };

      if (!settings.dryRun) {
        student.status = 'running';
        student.message = '';
        student.midStatus = 'pending';
        student.endStatus = 'pending';
        updateStudent(index, {
          status: 'running',
          message: '',
          midStatus: 'pending',
          endStatus: 'pending',
        });
      }

      broadcastState();
      log('info', `${reg} · starting student ${i + 1}/${queue.length}`);

      try {
        const result = await processStudent(student, index, settings);

        if (settings.dryRun) {
          success += 1;
          log('success', `${reg} · dry run complete; nothing submitted`);
        } else {
          student.status = 'success';
          student.message = result?.message || 'Completed';
          updateStudent(index, {
            status: 'success',
            message: student.message,
          });
          success += 1;
          log('success', `${reg} · completed`);
        }
      } catch (error) {
        if (error instanceof StopError) {
          stopped = true;

          if (!settings.dryRun) {
            student.status = 'pending';
            student.message = 'Stopped before completion.';
            updateStudent(index, {
              status: 'pending',
              message: student.message,
            });
          }

          log('warn', `${reg} · stopped`);
          break;
        }

        failed += 1;

        if (settings.dryRun) {
          log('error', `${reg} · dry run failed: ${error.message}`);
        } else {
          student.status = 'failed';
          student.message = error.message || 'Failed';
          updateStudent(index, {
            status: 'failed',
            message: student.message,
          });
          log('error', `${reg} · failed: ${error.message}`);
        }
      } finally {
        if (settings.dryRun && snapshot) {
          Object.assign(student, snapshot);
          updateStudent(index, snapshot);
        }

        if (!stopped) {
          done = i + 1;
        }

        state.progress = { done, total: queue.length, success, failed };
        broadcastState();
      }

      if (!stopped && i < queue.length - 1) {
        await sleep(settings.delayMs);
      }
    }
  } catch (error) {
    if (error instanceof StopError) {
      stopped = true;
    } else {
      fatal = error;
      log('error', `Run error: ${error.message}`);
    }
  } finally {
    stopKeepAlive();

    const finalStopped = stopRequested || stopped;
    state.status = fatal ? 'error' : finalStopped ? 'stopped' : 'complete';
    state.phase = fatal
      ? 'Error'
      : finalStopped
        ? 'Stopped'
        : 'Complete';
    state.currentIndex = -1;
    state.currentReg = '';
    state.progress = { done, total: queue.length, success, failed };

    await persistSessionNow();
    broadcastState();

    if (settings.dryRun) {
      log(
        finalStopped ? 'warn' : 'success',
        `Dry run ${finalStopped ? 'stopped' : 'finished'} · ${done}/${queue.length} checked · ${failed} error(s) · nothing submitted.`
      );
    } else if (fatal) {
      log('error', `Run failed: ${fatal.message}`);
    } else {
      const remaining = queue.length - done;
      log(
        finalStopped ? 'warn' : 'success',
        `Run ${finalStopped ? 'stopped' : 'finished'} · ${success} succeeded · ${failed} failed${remaining > 0 ? ` · ${remaining} not processed` : ''}.`
      );
    }

    stopRequested = false;
    persistSessionNow();
  }
}

// -----------------------------------------------------------------------------
// Side panel commands
// -----------------------------------------------------------------------------

async function importStudents(rawStudents) {
  if (isBusy()) {
    return { error: 'Stop the current run before importing a new list.' };
  }

  const result = normalizeImportedStudents(rawStudents);
  if (result.error) {
    return result;
  }

  if (!result.students.length) {
    return {
      error:
        'No valid register numbers were found. Use one register number per line.',
    };
  }

  state.students = result.students;
  state.status = 'idle';
  state.currentIndex = -1;
  state.currentReg = '';
  state.phase = 'Idle';
  state.progress = { done: 0, total: 0, success: 0, failed: 0 };

  await persistStudentsNow();
  await persistSessionNow();
  broadcastState();

  const details = [];
  if (result.duplicates) details.push(`${result.duplicates} duplicate(s) skipped`);
  if (result.invalid) details.push(`${result.invalid} invalid row(s) skipped`);
  if (result.truncated) details.push(`${result.truncated} beyond the ${A.LIMITS.maxStudents}-student limit skipped`);

  log(
    'info',
    `Imported ${result.students.length} student(s)${details.length ? ` · ${details.join(' · ')}` : ''}.`
  );

  return {
    imported: result.students.length,
    duplicates: result.duplicates,
    invalid: result.invalid,
    truncated: result.truncated,
  };
}

async function clearStudents() {
  if (isBusy()) {
    return { error: 'Stop the current run before clearing the list.' };
  }

  state.students = [];
  state.status = 'idle';
  state.currentIndex = -1;
  state.currentReg = '';
  state.phase = 'Idle';
  state.progress = { done: 0, total: 0, success: 0, failed: 0 };

  await persistStudentsNow();
  await persistSessionNow();
  broadcastState();
  log('info', 'Student list cleared.');

  return { ok: true };
}

async function resetStatuses() {
  if (isBusy()) {
    return { error: 'Stop the current run before resetting statuses.' };
  }

  state.students = state.students.map((student) => ({
    ...student,
    status: 'pending',
    message: '',
    midStatus: 'pending',
    endStatus: 'pending',
    updatedAt: null,
  }));

  await persistStudentsNow();
  broadcastState();
  log('info', 'Student statuses reset.');

  return { ok: true };
}

async function saveSettings(rawSettings) {
  if (isBusy()) {
    return {
      error: 'Stop the current run before changing settings.',
      settings: state.settings,
    };
  }

  state.settings = normalizeSettings(rawSettings);
  await persistSettingsNow();
  broadcastState();
  return { settings: state.settings };
}

async function startRun(rawSettings) {
  if (activeRun || isBusy()) {
    return { error: 'A run is already in progress.' };
  }

  const settings = normalizeSettings(rawSettings);
  if (settings.modes.length === 0) {
    return { error: 'Select at least one feedback type.' };
  }

  const queue = [];
  state.students.forEach((student, index) => {
    if (student.status === 'pending' || student.status === 'failed') {
      queue.push({ student, index });
    }
  });

  if (queue.length === 0) {
    return {
      error:
        'No pending students. Import a CSV or reset statuses before starting.',
    };
  }

  state.settings = settings;
  await persistSettingsNow();

  state.runId += 1;
  state.status = 'running';
  state.phase = 'Starting';
  state.currentIndex = -1;
  state.currentReg = '';
  state.progress = { done: 0, total: queue.length, success: 0, failed: 0 };
  stopRequested = false;

  await persistSessionNow();
  broadcastState();

  const modeLabel = settings.modes
    .map((mode) => (mode === 'mid' ? 'mid-term' : 'end-term'))
    .join(' + ');

  log(
    'info',
    `Run started · ${queue.length} student(s) · ${modeLabel}${settings.dryRun ? ' · dry run' : ''}.`
  );

  activeRun = runQueue(queue, settings).finally(() => {
    activeRun = null;
  });

  return { started: true, runId: state.runId, total: queue.length };
}

async function stopRun() {
  if (!isBusy()) {
    return { error: 'No run is in progress.' };
  }

  if (stopRequested) {
    return { stopped: true };
  }

  stopRequested = true;
  state.status = 'stopping';
  state.phase = 'Stopping';
  await persistSessionNow();
  broadcastState();
  log('warn', 'Stop requested · finishing the current step.');

  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: 'STOP' }).catch(() => {});
  }

  return { stopped: true };
}

async function clearLogs() {
  state.logs = [];
  await persistSessionNow();
  broadcast({ type: 'LOGS_CLEARED' });
  return { ok: true };
}

async function openPortal() {
  const tabId = await ensureTab();
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  return { ok: true, tabId };
}

async function handleUiMessage(message) {
  switch (message.type) {
    case 'GET_STATE':
      return { state: publicState() };
    case 'IMPORT_STUDENTS':
      return importStudents(message.students);
    case 'CLEAR_STUDENTS':
      return clearStudents();
    case 'RESET_STATUSES':
      return resetStatuses();
    case 'SAVE_SETTINGS':
      return saveSettings(message.settings);
    case 'START_RUN':
      return startRun(message.settings);
    case 'STOP_RUN':
      return stopRun();
    case 'CLEAR_LOGS':
      return clearLogs();
    case 'OPEN_PORTAL':
      return openPortal();
    default:
      return { error: 'Unknown command.' };
  }
}

// -----------------------------------------------------------------------------
// Lifecycle and message routing
// -----------------------------------------------------------------------------

async function init() {
  try {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([A.STORAGE.students, A.STORAGE.settings]),
      chrome.storage.session
        ? chrome.storage.session
            .get(['logs', 'status', 'runId', 'phase', 'tabId'])
            .catch(() => ({}))
        : Promise.resolve({}),
    ]);

    state.students = normalizeStoredStudents(local[A.STORAGE.students]);
    state.settings = normalizeSettings(local[A.STORAGE.settings]);
    state.logs = Array.isArray(session.logs)
      ? session.logs
          .filter(isLogEntry)
          .slice(-A.LIMITS.maxLogs)
      : [];
    state.runId = Number.isFinite(session.runId) ? session.runId : 0;
    state.tabId = Number.isInteger(session.tabId) ? session.tabId : null;

    const wasRunning =
      session.status === 'running' || session.status === 'stopping';

    state.status = 'idle';
    state.phase = 'Idle';
    state.currentIndex = -1;
    state.currentReg = '';

    let interruptedStudents = 0;
    for (const student of state.students) {
      if (student.status === 'running') {
        student.status = 'failed';
        student.message = 'The previous run was interrupted.';
        interruptedStudents += 1;
      }
    }

    if (interruptedStudents > 0) {
      await persistStudentsNow();
    }

    if (wasRunning || interruptedStudents > 0) {
      await persistSessionNow();
      log(
        'warn',
        'The previous run was interrupted. Pending and failed students will be retried on the next start.'
      );
    }

    if (state.tabId) {
      const tab = await chrome.tabs.get(state.tabId).catch(() => null);
      if (!tab || tab.discarded) {
        state.tabId = null;
        persistSessionNow();
      }
    }

    try {
      await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: true,
      });
    } catch {
      // Older Chrome builds may not support the side panel behavior call.
    }
  } catch (error) {
    console.error('[AFFS] initialization failed', error);
    state.status = 'idle';
    state.phase = 'Idle';
    log('error', `Initialization failed: ${error.message}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  const senderUrl = sender.url || '';
  const fromExtensionPage = senderUrl.startsWith(chrome.runtime.getURL(''));
  const fromPortal = senderUrl.startsWith(`${A.ORIGIN}/`);

  if (message.type.startsWith('FEEDBACK_')) {
    if (!fromPortal) {
      return false;
    }

    initPromise
      .then(() => {
        if (message.type === 'FEEDBACK_PROGRESS') {
          handleProgress(message);
        } else if (message.type === 'FEEDBACK_COMPLETE') {
          resolveFeedback(message, false);
        } else if (message.type === 'FEEDBACK_ERROR') {
          resolveFeedback(message, true);
        }
      })
      .catch(() => {});

    return false;
  }

  if (!fromExtensionPage) {
    return false;
  }

  initPromise
    .then(() => handleUiMessage(message))
    .then((response) => sendResponse(response))
    .catch((error) =>
      sendResponse({ error: error?.message || 'Unexpected error.' })
    );

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  } catch {
    // Side panel API unavailable.
  }
});

chrome.runtime.onStartup.addListener(() => {
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  } catch {
    // Side panel API unavailable.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.tabId !== tabId) {
    return;
  }

  state.tabId = null;
  persistSessionNow();

  if (isBusy()) {
    stopRequested = true;
    state.status = 'stopping';
    state.phase = 'Stopping';
    broadcastState();
    log('warn', 'The automation tab was closed. Stopping the run.');
  }
});

initPromise = init();

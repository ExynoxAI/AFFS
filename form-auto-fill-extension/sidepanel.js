// AFFS side panel controller.
// Uses Material Web elements for all standard controls. The bundler imports
// the component definitions before this file runs.
(() => {
  const A = globalThis.AFFS;
  if (!A) {
    console.error('[AFFS] constants.js was not loaded before the side panel.');
    return;
  }

  const MAX_LOGS = A.LIMITS?.maxLogs || 500;
  const MAX_VISIBLE_LOGS = 4;
  const MAX_STUDENTS = A.LIMITS?.maxStudents || 500;
  const MAX_FILE_BYTES = A.LIMITS?.maxFileBytes || 2 * 1024 * 1024;
  const MAX_PARSE_ROWS = 1000;
  const DEFAULT_SETTINGS = {
    modes: [...(A.DEFAULTS?.modes || ['mid', 'end'])],
    dryRun: Boolean(A.DEFAULTS?.dryRun),
    delayMs: Number.isFinite(A.DEFAULTS?.delayMs) ? A.DEFAULTS.delayMs : 1200,
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    version: $('version'),
    runDot: $('runDot'),
    runStatus: $('runStatus'),
    runCount: $('runCount'),
    progressBar: $('progressBar'),
    runDetail: $('runDetail'),
    notice: $('notice'),
    modeMid: $('modeMid'),
    modeEnd: $('modeEnd'),
    dryRun: $('dryRun'),
    startBtn: $('startBtn'),
    stopBtn: $('stopBtn'),
    studentsCard: $('studentsCard'),
    csvInput: $('csvInput'),
    importBtn: $('importBtn'),
    resetBtn: $('resetBtn'),
    clearBtn: $('clearBtn'),
    importHint: $('importHint'),
    studentList: $('studentList'),
    studentEmpty: $('studentEmpty'),
    studentCount: $('studentCount'),
    studentActions: $('studentActions'),
    templateBtn: $('templateBtn'),
    templateBtnEmpty: $('templateBtnEmpty'),
    logList: $('logList'),
    logEmpty: $('logEmpty'),
    clearLogsBtn: $('clearLogsBtn'),
  };

  const ui = {
    students: [],
    settings: normalizeSettings(DEFAULT_SETTINGS),
    status: 'idle',
    currentIndex: -1,
    currentReg: '',
    phase: 'Idle',
    progress: { done: 0, total: 0, success: 0, failed: 0 },
    logs: [],
  };

  let studentsSignature = '';
  let lastCurrentIndex = -1;
  let commandPending = false;
  let noticeTimer = null;
  let hintTimer = null;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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

  function isBusy() {
    return ui.status === 'running' || ui.status === 'stopping';
  }

  function runnableCount() {
    return ui.students.filter(
      (student) => student.status === 'pending' || student.status === 'failed'
    ).length;
  }

  function formatTime(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
      return `${Math.round(bytes / (1024 * 1024))} MB`;
    }
    return `${Math.round(bytes / 1024)} KB`;
  }

  async function request(message, retries = 0) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response === undefined) {
          throw new Error('The background service did not respond.');
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(250);
        }
      }
    }

    throw lastError || new Error('The background service did not respond.');
  }

  function clearNotice() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    el.notice.hidden = true;
    el.notice.textContent = '';
  }

  function showNotice(message) {
    el.notice.textContent = message;
    el.notice.hidden = false;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
    }
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      el.notice.hidden = true;
      el.notice.textContent = '';
    }, 6000);
  }

  function resetHint() {
    el.importHint.textContent = '';
    el.importHint.hidden = true;
    el.importHint.classList.remove('is-error', 'is-success');
  }

  function setHint(message, kind) {
    el.importHint.textContent = message;
    el.importHint.hidden = false;
    el.importHint.classList.toggle('is-error', kind === 'error');
    el.importHint.classList.toggle('is-success', kind === 'success');
    if (hintTimer) {
      clearTimeout(hintTimer);
    }
    hintTimer = setTimeout(() => {
      hintTimer = null;
      resetHint();
    }, 6000);
  }

  function downloadTemplate() {
    const content = '\uFEFFRegister Number\r\n';
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'affs-register-numbers.csv';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setHint(
      'Template downloaded. Paste your register numbers below the header, then import the file.',
      'success'
    );
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    renderRun();
    renderSettings();
    renderStudents();
  }

  function renderRun() {
    const busy = isBusy();
    const runnable = runnableCount();
    const total = Number(ui.progress.total) || 0;
    const done = Number(ui.progress.done) || 0;
    const statusLabels = {
      idle: 'Idle',
      running: 'Running',
      stopping: 'Stopping',
      complete: 'Complete',
      stopped: 'Stopped',
      error: 'Error',
    };

    el.runStatus.textContent = statusLabels[ui.status] || 'Idle';
    el.runDot.className = 'status-dot';
    if (ui.status === 'running') {
      el.runDot.classList.add('is-live');
    } else if (ui.status === 'complete') {
      el.runDot.classList.add('is-success');
    } else if (ui.status === 'stopped' || ui.status === 'stopping') {
      el.runDot.classList.add('is-warn');
    } else if (ui.status === 'error') {
      el.runDot.classList.add('is-error');
    }

    el.runCount.textContent = total > 0 ? `${done} / ${total}` : '0 / 0';
    el.progressBar.value = total > 0 ? clamp(done / total, 0, 1) : 0;
    el.progressBar.classList.toggle('is-success', ui.status === 'complete');
    el.progressBar.classList.toggle('is-warn', ui.status === 'stopped');
    el.progressBar.classList.toggle('is-error', ui.status === 'error');

    if (busy) {
      const parts = [];
      if (ui.currentReg) {
        parts.push(ui.currentReg);
      }
      if (ui.phase && ui.phase !== 'Idle') {
        parts.push(ui.phase);
      }
      el.runDetail.textContent = parts.join(' · ') || 'Working';
    } else if (ui.status === 'complete') {
      el.runDetail.textContent = ui.progress.failed
        ? `${ui.progress.success} completed · ${ui.progress.failed} failed.`
        : `${ui.progress.success} of ${total} completed.`;
    } else if (ui.status === 'stopped') {
      el.runDetail.textContent = `Stopped · ${done} of ${total} processed.`;
    } else if (ui.status === 'error') {
      el.runDetail.textContent =
        ui.phase && ui.phase !== 'Error'
          ? ui.phase
          : 'The run hit an error. Check the activity log.';
    } else if (ui.students.length === 0) {
      el.runDetail.textContent = 'Import a CSV to get started.';
    } else if (runnable === 0) {
      el.runDetail.textContent =
        'All students are complete. Reset statuses to run again.';
    } else {
      el.runDetail.textContent = `${runnable} student${
        runnable === 1 ? '' : 's'
      } ready to run.`;
    }

    const lockControls = commandPending || busy;
    el.startBtn.disabled =
      lockControls || ui.settings.modes.length === 0 || runnable === 0;
    el.stopBtn.disabled = commandPending || !busy;
    el.importBtn.disabled = lockControls;
    el.resetBtn.disabled = lockControls || ui.students.length === 0;
    el.clearBtn.disabled = lockControls || ui.students.length === 0;
    el.clearLogsBtn.disabled = commandPending || ui.logs.length === 0;
  }

  function renderSettings() {
    el.modeMid.checked = ui.settings.modes.includes('mid');
    el.modeEnd.checked = ui.settings.modes.includes('end');
    el.dryRun.checked = ui.settings.dryRun;

    const disabled = commandPending || isBusy();
    el.modeMid.disabled = disabled;
    el.modeEnd.disabled = disabled;
    el.dryRun.disabled = disabled;
  }

  function studentsStateSignature() {
    return JSON.stringify({
      status: ui.status,
      currentIndex: ui.currentIndex,
      students: ui.students.map((student) => [
        student.regNo,
        student.status,
        student.message,
      ]),
    });
  }

  function badgeClass(status) {
    if (status === 'running') {
      return 'badge badge-running';
    }
    if (status === 'success') {
      return 'badge badge-success';
    }
    if (status === 'failed') {
      return 'badge badge-failed';
    }
    if (status === 'stopped') {
      return 'badge badge-stopped';
    }
    return 'badge badge-pending';
  }

  function badgeLabel(status) {
    if (status === 'running') {
      return 'Running';
    }
    if (status === 'success') {
      return 'Done';
    }
    if (status === 'failed') {
      return 'Failed';
    }
    if (status === 'stopped') {
      return 'Stopped';
    }
    return 'Pending';
  }

  function createStudentItem(student, index) {
    const item = document.createElement('md-list-item');
    item.className = 'student';

    const isCurrent = isBusy() && index === ui.currentIndex;
    if (isCurrent) {
      item.classList.add('is-current');
      item.setAttribute('aria-current', 'true');
    }

    const headline = document.createElement('span');
    headline.setAttribute('slot', 'headline');
    headline.className = 'student-reg';
    headline.textContent = student.regNo;
    item.append(headline);

    if (student.message) {
      const supporting = document.createElement('span');
      supporting.setAttribute('slot', 'supporting-text');
      supporting.className = 'student-msg';
      supporting.textContent = student.message;
      supporting.title = student.message;
      item.append(supporting);
    }

    const badge = document.createElement('span');
    badge.setAttribute('slot', 'trailing-supporting-text');
    badge.className = badgeClass(student.status);
    badge.textContent = badgeLabel(student.status);
    item.append(badge);

    return item;
  }

  function renderStudents() {
    el.studentCount.textContent = String(ui.students.length);
    el.studentEmpty.hidden = ui.students.length > 0;
    el.studentList.hidden = ui.students.length === 0;
    el.studentActions.hidden = ui.students.length === 0;

    const signature = studentsStateSignature();
    if (signature === studentsSignature) {
      return;
    }

    const previousScrollTop = el.studentList.scrollTop;
    const fragment = document.createDocumentFragment();

    ui.students.forEach((student, index) => {
      fragment.append(createStudentItem(student, index));
    });

    el.studentList.replaceChildren(fragment);
    el.studentList.scrollTop = previousScrollTop;

    if (ui.currentIndex >= 0 && ui.currentIndex !== lastCurrentIndex) {
      const current = el.studentList.children[ui.currentIndex];
      if (current) {
        const listRect = el.studentList.getBoundingClientRect();
        const itemRect = current.getBoundingClientRect();
        if (itemRect.top < listRect.top) {
          el.studentList.scrollTop -= listRect.top - itemRect.top;
        } else if (itemRect.bottom > listRect.bottom) {
          el.studentList.scrollTop += itemRect.bottom - listRect.bottom;
        }
      }
    }

    lastCurrentIndex = ui.currentIndex;
    studentsSignature = signature;
  }

  function createLogItem(entry) {
    const item = document.createElement('li');
    item.className = entry.level === 'info' ? 'log' : `log is-${entry.level}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatTime(entry.ts);
    item.append(time);

    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message;
    item.append(message);

    return item;
  }

  function renderLogs() {
    const fragment = document.createDocumentFragment();
    for (const entry of ui.logs.slice(-MAX_VISIBLE_LOGS)) {
      fragment.append(createLogItem(entry));
    }
    el.logList.replaceChildren(fragment);
    el.logEmpty.hidden = ui.logs.length > 0;
    el.clearLogsBtn.disabled = ui.logs.length === 0;
  }

  function appendLog(entry) {
    if (
      !entry ||
      typeof entry.ts !== 'number' ||
      typeof entry.message !== 'string'
    ) {
      return;
    }

    ui.logs.push(entry);
    if (ui.logs.length > MAX_LOGS) {
      ui.logs.splice(0, ui.logs.length - MAX_LOGS);
    }
    renderLogs();
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  function applyState(next, options = {}) {
    if (!next || typeof next !== 'object') {
      return;
    }

    ui.students = Array.isArray(next.students) ? next.students : [];
    ui.settings = normalizeSettings(next.settings);
    ui.status =
      typeof next.status === 'string' ? next.status : 'idle';
    ui.currentIndex = Number.isInteger(next.currentIndex)
      ? next.currentIndex
      : -1;
    ui.currentReg =
      typeof next.currentReg === 'string' ? next.currentReg : '';
    ui.phase = typeof next.phase === 'string' ? next.phase : 'Idle';

    const progress = next.progress && typeof next.progress === 'object'
      ? next.progress
      : {};
    ui.progress = {
      done: Number(progress.done) || 0,
      total: Number(progress.total) || 0,
      success: Number(progress.success) || 0,
      failed: Number(progress.failed) || 0,
    };

    if (options.replaceLogs && Array.isArray(next.logs)) {
      ui.logs = next.logs.slice(-MAX_LOGS);
      renderLogs();
    }

    if (typeof next.version === 'string' && next.version) {
      el.version.textContent = `v${next.version}`;
    }

    render();
  }

  // ---------------------------------------------------------------------------
  // CSV import
  // ---------------------------------------------------------------------------

  function detectDelimiter(text) {
    const sample = text.slice(0, 4096);
    const counts = { ',': 0, ';': 0, '\t': 0 };
    for (const character of sample) {
      if (Object.prototype.hasOwnProperty.call(counts, character)) {
        counts[character] += 1;
      }
    }

    let delimiter = ',';
    for (const candidate of [',', ';', '\t']) {
      if (counts[candidate] > counts[delimiter]) {
        delimiter = candidate;
      }
    }
    return delimiter;
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];

      if (inQuotes) {
        if (character === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += character;
        }
        continue;
      }

      if (character === '"') {
        inQuotes = true;
      } else if (character === delimiter) {
        row.push(field);
        field = '';
      } else if (character === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (character === '\r') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        if (text[index + 1] === '\n') {
          index += 1;
        }
      } else {
        field += character;
      }
    }

    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  function parseRegisterNumbers(text) {
    const clean = text.replace(/^\uFEFF/, '');
    const delimiter = detectDelimiter(clean);
    const rows = parseDelimited(clean, delimiter);
    const values = [];

    for (const row of rows) {
      const value = row.map((cell) => cell.trim()).find(Boolean);
      if (value) {
        values.push(value);
      }
      if (values.length >= MAX_PARSE_ROWS) {
        break;
      }
    }

    return values;
  }

  async function handleFile(file) {
    if (!file) {
      return;
    }

    if (isBusy()) {
      showNotice('Stop the current run before importing a new list.');
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setHint(
        `That file is too large. The limit is ${formatBytes(MAX_FILE_BYTES)}.`,
        'error'
      );
      return;
    }

    try {
      const text = await file.text();
      const values = parseRegisterNumbers(text);
      if (values.length === 0) {
        setHint('No register numbers were found in that file.', 'error');
        return;
      }

      commandPending = true;
      render();
      const response = await request({
        type: 'IMPORT_STUDENTS',
        students: values,
      });

      if (!response || response.error) {
        setHint(
          response?.error || 'The student list could not be imported.',
          'error'
        );
        return;
      }

      clearNotice();
      const imported = Number(response.imported) || 0;
      const parts = [`Imported ${imported} student(s).`];
      if (response.duplicates) {
        parts.push(`${response.duplicates} duplicate(s) skipped.`);
      }
      if (response.invalid) {
        parts.push(`${response.invalid} invalid row(s) skipped.`);
      }
      if (response.truncated) {
        parts.push(
          `${response.truncated} row(s) beyond the ${MAX_STUDENTS}-student limit skipped.`
        );
      }
      setHint(parts.join(' '), 'success');
    } catch (error) {
      setHint(error?.message || 'That file could not be read.', 'error');
    } finally {
      commandPending = false;
      el.csvInput.value = '';
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  function readSettings() {
    const modes = [];
    if (el.modeMid.checked) {
      modes.push('mid');
    }
    if (el.modeEnd.checked) {
      modes.push('end');
    }

    return {
      modes,
      dryRun: Boolean(el.dryRun.checked),
      delayMs: ui.settings.delayMs,
    };
  }

  async function handleStart() {
    if (commandPending || isBusy()) {
      return;
    }

    clearNotice();
    const settings = readSettings();
    if (settings.modes.length === 0) {
      showNotice('Select at least one feedback type.');
      return;
    }

    if (runnableCount() === 0) {
      showNotice('No pending students. Import a CSV or reset statuses.');
      return;
    }

    commandPending = true;
    render();

    try {
      const response = await request({ type: 'START_RUN', settings });
      if (response?.error) {
        showNotice(response.error);
      }
    } catch (error) {
      showNotice(error?.message || 'The run could not be started.');
    } finally {
      commandPending = false;
      render();
    }
  }

  async function handleStop() {
    if (commandPending) {
      return;
    }

    commandPending = true;
    render();

    try {
      const response = await request({ type: 'STOP_RUN' });
      if (response?.error) {
        showNotice(response.error);
      }
    } catch (error) {
      showNotice(error?.message || 'The run could not be stopped.');
    } finally {
      commandPending = false;
      render();
    }
  }

  async function handleSettingsChange() {
    if (commandPending || isBusy()) {
      return;
    }

    const settings = readSettings();
    ui.settings = settings;
    renderRun();

    try {
      const response = await request({ type: 'SAVE_SETTINGS', settings });
      if (response?.error) {
        showNotice(response.error);
        if (response.settings) {
          ui.settings = normalizeSettings(response.settings);
        }
        render();
        return;
      }

      if (response?.settings) {
        ui.settings = normalizeSettings(response.settings);
      }
      render();
    } catch (error) {
      showNotice(error?.message || 'Settings could not be saved.');
    }
  }

  async function handleReset() {
    if (commandPending || isBusy() || ui.students.length === 0) {
      return;
    }

    commandPending = true;
    render();

    try {
      const response = await request({ type: 'RESET_STATUSES' });
      if (response?.error) {
        showNotice(response.error);
      } else {
        setHint('Student statuses reset. Ready to run again.', 'success');
      }
    } catch (error) {
      showNotice(error?.message || 'Statuses could not be reset.');
    } finally {
      commandPending = false;
      render();
    }
  }

  async function handleClearStudents() {
    if (commandPending || isBusy() || ui.students.length === 0) {
      return;
    }

    if (!window.confirm('Clear all imported students?')) {
      return;
    }

    commandPending = true;
    render();

    try {
      const response = await request({ type: 'CLEAR_STUDENTS' });
      if (response?.error) {
        showNotice(response.error);
      } else {
        setHint('Student list cleared.', 'success');
      }
    } catch (error) {
      showNotice(error?.message || 'The list could not be cleared.');
    } finally {
      commandPending = false;
      render();
    }
  }

  async function handleClearLogs() {
    if (commandPending || ui.logs.length === 0) {
      return;
    }

    commandPending = true;
    render();

    try {
      const response = await request({ type: 'CLEAR_LOGS' });
      if (response?.error) {
        showNotice(response.error);
        return;
      }
      ui.logs = [];
      renderLogs();
    } catch (error) {
      showNotice(error?.message || 'The activity log could not be cleared.');
    } finally {
      commandPending = false;
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function bindEvents() {
    el.startBtn.addEventListener('click', handleStart);
    el.stopBtn.addEventListener('click', handleStop);
    el.resetBtn.addEventListener('click', handleReset);
    el.clearBtn.addEventListener('click', handleClearStudents);
    el.clearLogsBtn.addEventListener('click', handleClearLogs);
    el.importBtn.addEventListener('click', () => el.csvInput.click());
    el.templateBtn.addEventListener('click', downloadTemplate);
    el.templateBtnEmpty.addEventListener('click', downloadTemplate);
    el.csvInput.addEventListener('change', () => {
      const file = el.csvInput.files?.[0];
      if (file) {
        handleFile(file);
      }
    });

    for (const checkbox of [el.modeMid, el.modeEnd, el.dryRun]) {
      checkbox.addEventListener('change', handleSettingsChange);
    }

    const card = el.studentsCard;
    card.addEventListener('dragenter', (event) => {
      event.preventDefault();
      if (!isBusy()) {
        card.classList.add('is-dragover');
      }
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!isBusy()) {
        card.classList.add('is-dragover');
      }
    });
    card.addEventListener('dragleave', (event) => {
      if (!card.contains(event.relatedTarget)) {
        card.classList.remove('is-dragover');
      }
    });
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      card.classList.remove('is-dragover');
      if (isBusy()) {
        showNotice('Stop the current run before importing a new list.');
        return;
      }
      const file = event.dataTransfer?.files?.[0];
      if (file) {
        handleFile(file);
      }
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message.type !== 'string') {
        return false;
      }

      if (message.type === 'STATE_UPDATE') {
        applyState(message.state);
      } else if (message.type === 'LOG_ENTRY') {
        appendLog(message.entry);
      } else if (message.type === 'LOGS_CLEARED') {
        ui.logs = [];
        renderLogs();
      }

      return false;
    });
  }

  async function init() {
    el.version.textContent = `v${A.VERSION}`;
    bindEvents();
    render();
    renderLogs();

    try {
      const response = await request({ type: 'GET_STATE' }, 1);
      if (response?.error) {
        showNotice(response.error);
        return;
      }
      if (response?.state) {
        applyState(response.state, { replaceLogs: true });
      } else {
        showNotice('The background service did not return state.');
      }
    } catch (error) {
      showNotice(
        error?.message ||
          'Could not reach the background service. Reload the extension and try again.'
      );
    }
  }

  init();
})();

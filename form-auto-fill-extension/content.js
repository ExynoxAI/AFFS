// AFFS content script.
// Runs on the feedback portal and performs one page-level task at a time.
(() => {
  if (globalThis.__AFFS_CONTENT_V2__) {
    return;
  }
  globalThis.__AFFS_CONTENT_V2__ = true;

  const A = globalThis.AFFS;
  if (!A) {
    return;
  }

  const VALID_MODES = new Set(['mid', 'end']);
  const HEARTBEAT_MS = 10000;
  const SUBMIT_TIMEOUT_MS = 25000;

  let activeRun = null;
  let stopRequested = false;
  let heartbeatTimer = null;
  let completionDialogSignal = '';
  let completionObserver = null;
  let completionPollTimer = null;
  let courseSuccessSignal = '';
  let courseSuccessAt = 0;

  const COMPLETION_STATUS_RE =
    /(?:mid|end)\s+semester\s+feedback\s+status\s*:?\s*completed!?/i;
  const COMPLETION_TEXT_RE = /feedback\s+status\s*:?\s*completed!?/i;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function jitter(min, max) {
    return sleep(min + Math.random() * (max - min));
  }

  function byId(name) {
    const id = A.IDS[name];
    return id ? document.getElementById(id) : null;
  }

  function setNativeValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      'value'
    );

    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Ratings are mostly 4 or 5, with 3 occasional and 1-2 rare.
  // 5: 44%, 4: 36%, 3: 12%, 2: 5%, 1: 3%.
  function biasedRandom() {
    const value = Math.random();
    if (value < 0.03) return 1;
    if (value < 0.08) return 2;
    if (value < 0.2) return 3;
    if (value < 0.56) return 4;
    return 5;
  }

  async function waitFor(check, options = {}) {
    const timeout = options.timeout ?? 10000;
    const interval = options.interval ?? 200;
    const message = options.message ?? 'page state';
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      let value = null;
      try {
        value = check();
      } catch {
        value = null;
      }
      if (value) {
        return value;
      }
      await sleep(interval);
    }

    throw new Error(`Timed out waiting for ${message}.`);
  }

  function send(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      // The service worker may be restarting; progress messages are best-effort.
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!activeRun) {
        return;
      }
      send({
        type: 'FEEDBACK_HEARTBEAT',
        runId: activeRun.runId,
        student: activeRun.student,
        mode: activeRun.mode,
      });
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Page inspection
  // ---------------------------------------------------------------------------

  function getCourseOptions() {
    const select = byId('courseSelectInput');
    const hiddenOptions = [];

    if (select) {
      Array.from(select.options).forEach((option, index) => {
        const value = (option.value || '').trim();
        const label = (option.textContent || '').trim();
        if (!value) {
          return;
        }

        hiddenOptions.push({
          value: option.value,
          label,
          index: Number.isInteger(option.index) ? option.index : index,
        });
      });
    }

    const hiddenByLabel = new Map();
    for (const option of hiddenOptions) {
      const key = normalizeText(option.label);
      if (key && !hiddenByLabel.has(key)) {
        hiddenByLabel.set(key, option);
      }
    }

    // The portal updates the hidden select immediately after each submission,
    // so it is the authoritative remaining-course list. The visible PrimeFaces
    // menu is only a fallback when the select has not been populated.
    const menuOptions = [];
    const seen = new Set();
    const panel = getCoursePanel();

    for (const item of getCourseMenuItems(panel || document)) {
      const label = (item.getAttribute('data-label') || item.textContent || '').trim();
      if (!label || /^select one$/i.test(label)) {
        continue;
      }

      const key = normalizeText(label);
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      const hidden = hiddenByLabel.get(key);
      const value = (item.getAttribute('data-value') || hidden?.value || '').trim();

      menuOptions.push({
        value,
        label,
        index: menuOptions.length,
      });
    }

    if (hiddenOptions.length > 0) {
      return hiddenOptions;
    }

    return menuOptions;
  }

  function getCourseName() {
    const element = byId('courseNameMid') || byId('courseNameEnd');
    const text = (element?.textContent || '').trim();
    return text && text.toLowerCase() !== 'null' ? text : '';
  }

  function getSelectedLabel() {
    return (byId('courseSelectLabel')?.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function courseTokens(course) {
    return [course?.value, course?.label]
      .map(normalizeText)
      .filter(Boolean);
  }

  function isSameCourse(a, b) {
    const aValue = normalizeText(a?.value);
    const bValue = normalizeText(b?.value);
    const aLabel = normalizeText(a?.label);
    const bLabel = normalizeText(b?.label);
    return (
      (aLabel && bLabel && aLabel === bLabel) ||
      (aValue && bValue && aValue === bValue)
    );
  }

  function isElementVisible(element) {
    if (!element || element.hidden) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      (style.opacity !== '' && Number(style.opacity) === 0)
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getCoursePanel() {
    return (
      byId('courseSelectPanel') ||
      document.getElementById(`${A.IDS.courseSelect}_panel`) ||
      null
    );
  }

  function getCourseMenuItems(scope) {
    return Array.from(
      (scope || document).querySelectorAll('.ui-selectonemenu-item')
    ).filter((element) => !element.classList.contains('ui-state-disabled'));
  }

  function hasVisibleCourseMenu() {
    const panel = getCoursePanel();
    if (panel && isElementVisible(panel)) {
      return true;
    }
    return getCourseMenuItems(panel || document).some(isElementVisible);
  }

  function isCourseMenuReady() {
    const panel = getCoursePanel();
    return (
      hasVisibleCourseMenu() &&
      getCourseMenuItems(panel || document).length > 0
    );
  }

  function findCourseMenuItem(course, items) {
    const tokens = courseTokens(course);
    if (!tokens.length || !items.length) {
      return null;
    }

    const textOf = (element) =>
      normalizeText(
        element.getAttribute('data-label') || element.textContent || ''
      );

    let match = items.find((element) => tokens.includes(textOf(element)));
    if (match) {
      return match;
    }

    match = items.find((element) => {
      const text = textOf(element);
      return (
        text &&
        tokens.some(
          (token) => text.includes(token) || (text.length >= 4 && token.includes(text))
        )
      );
    });
    if (match) {
      return match;
    }

    match = items.find((element) =>
      ['data-value', 'data-item-value', 'aria-label']
        .map((name) => normalizeText(element.getAttribute(name)))
        .filter(Boolean)
        .some((value) => tokens.includes(value))
    );
    if (match) {
      return match;
    }

    // PrimeFaces renders the placeholder as the first item, so the native
    // option index is a reliable last resort when the labels differ.
    if (Number.isInteger(course.index) && items[course.index]) {
      return items[course.index];
    }

    return null;
  }

  function isCourseSelected(course) {
    const label = normalizeText(getSelectedLabel());
    const tokens = courseTokens(course);
    const labelMatches =
      Boolean(label) &&
      tokens.some(
        (token) => label === token || label.includes(token) || token.includes(label)
      );
    const selectValue = normalizeText(byId('courseSelectInput')?.value);
    const valueMatches = Boolean(selectValue) && tokens.includes(selectValue);
    return labelMatches || valueMatches;
  }

  function getPrimeFacesWidget() {
    const registry = globalThis.PrimeFaces?.widgets;
    if (!registry) {
      return null;
    }

    const widgetId = A.IDS.courseSelect;
    const candidates = Array.isArray(registry)
      ? registry
      : Object.values(registry);

    return (
      candidates.find((candidate) => {
        if (!candidate) {
          return false;
        }
        const element = candidate.jq?.[0] || candidate.jq;
        return candidate.id === widgetId || element?.id === widgetId;
      }) || null
    );
  }

  function clickCourseMenuItem(item) {
    const target = item.querySelector('a, button') || item;
    target.click();
  }

  async function openCourseMenu() {
    if (isCourseMenuReady()) {
      return;
    }

    const widget = byId('courseSelect');
    const trigger =
      widget?.querySelector('.ui-selectonemenu-trigger') ||
      byId('courseSelectLabel') ||
      widget;

    if (trigger) {
      trigger.click();
      if (
        await waitFor(isCourseMenuReady, {
          timeout: 2000,
          interval: 100,
          message: 'the course menu to open',
        }).catch(() => false)
      ) {
        return;
      }
    }

    const label = byId('courseSelectLabel');
    if (label && label !== trigger) {
      label.click();
      if (
        await waitFor(isCourseMenuReady, {
          timeout: 1500,
          interval: 100,
          message: 'the course menu to open',
        }).catch(() => false)
      ) {
        return;
      }
    }

    const pfWidget = getPrimeFacesWidget();
    if (pfWidget && typeof pfWidget.show === 'function') {
      try {
        pfWidget.show();
      } catch {
        // Nothing else to try.
      }
      await waitFor(isCourseMenuReady, {
        timeout: 1500,
        interval: 100,
        message: 'the course menu to open',
      }).catch(() => {});
    }
  }

  function collectVisibleText(selector) {
    const texts = new Set();
    for (const node of document.querySelectorAll(selector)) {
      if (!isElementVisible(node)) {
        continue;
      }
      const text = (node.innerText || node.textContent || '').trim();
      if (text) {
        texts.add(text);
      }
    }
    return Array.from(texts).join('\n');
  }

  function cleanDialogText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function setCompletionSignal(value) {
    const text = cleanDialogText(value);
    if (!text || !/completed!?/i.test(text)) {
      return;
    }
    if (text !== completionDialogSignal) {
      completionDialogSignal = text;
      console.debug('[AFFS] completion detected:', text);
    }
  }

  function inspectCompletionDialog() {
    if (completionDialogSignal) {
      return completionDialogSignal;
    }

    const exact = document.getElementById('primefacesmessagedlg');
    if (exact) {
      const text = exact.textContent || '';
      if (/completed!?/i.test(text)) {
        setCompletionSignal(text);
        return completionDialogSignal;
      }
    }

    const title = document.querySelector('.ui-dialog-title');
    if (title) {
      const titleText = cleanDialogText(title.textContent);
      if (/(?:mid|end)\s+semester\s+feedback\s+status/i.test(titleText)) {
        const dialog = title.closest(
          '.ui-dialog, .ui-message-dialog, [role="dialog"]'
        );
        const text = dialog?.textContent || titleText;
        if (/completed!?/i.test(text)) {
          setCompletionSignal(text);
          return completionDialogSignal;
        }
      }
    }

    const pageText = cleanDialogText(document.body?.textContent);
    const direct =
      pageText.match(COMPLETION_STATUS_RE) ||
      pageText.match(COMPLETION_TEXT_RE);
    if (direct) {
      setCompletionSignal(direct[0]);
      return completionDialogSignal;
    }

    const generic = collectVisibleText('.ui-dialog, .ui-dialog-content');
    if (/completed!?/i.test(generic)) {
      setCompletionSignal(generic);
    }

    return completionDialogSignal;
  }

  function getCompletionText() {
    const signal = inspectCompletionDialog();
    if (signal) {
      return signal;
    }
    return collectVisibleText(
      '.ui-dialog, .ui-dialog-content, .ui-growl, .ui-messages, .ui-message'
    );
  }

  function getSubmissionMessageText() {
    const visible = collectVisibleText(
      '.ui-growl, .ui-growl-message, .ui-growl-item, .ui-messages, .ui-message, .ui-message-info, [role="alert"], .alert-success, .toast, .notification'
    );
    if (visible) {
      return visible;
    }

    // PrimeFaces can mark the growl container hidden while it animates. The
    // info summary/detail still contains the portal's confirmation text.
    return Array.from(
      document.querySelectorAll(
        '.ui-messages-info-summary, .ui-messages-info-detail, .ui-growl-title, .ui-growl-message'
      )
    )
      .map((node) => (node.textContent || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  function isCourseSuccessText(text, course) {
    const normalized = normalizeText(text);
    if (!normalized || !/entry/i.test(normalized)) {
      return false;
    }

    // The portal writes variations such as "Sucessfull", "Successful", and
    // "Successfull". Match the success word loosely instead of relying on one
    // exact spelling.
    if (!/\bsu\w*ful+\b/i.test(normalized)) {
      return false;
    }

    if (/\bnot\b|error|fail|invalid|already|pending/i.test(normalized)) {
      return false;
    }

    const tokens = courseTokens(course);
    return tokens.some((token) => normalized.includes(token));
  }

  function inspectCourseSuccess() {
    const text = getSubmissionMessageText();
    if (!text) {
      return courseSuccessSignal;
    }

    const normalized = normalizeText(text);
    if (/entry/i.test(normalized) && /\bsu\w*ful+\b/i.test(normalized)) {
      courseSuccessSignal = text;
      courseSuccessAt = Date.now();
    }

    return courseSuccessSignal;
  }

  function getCourseSuccess(course) {
    const live = getSubmissionMessageText();
    if (isCourseSuccessText(live, course)) {
      return live;
    }

    if (
      courseSuccessSignal &&
      Date.now() - courseSuccessAt < 15000 &&
      isCourseSuccessText(courseSuccessSignal, course)
    ) {
      return courseSuccessSignal;
    }

    return '';
  }

  function getCompletionDialogText() {
    return inspectCompletionDialog();
  }

  function startCompletionObserver() {
    // Actively listen for the completion status for the whole page lifetime.
    // The observer catches DOM changes immediately; the interval is a safety
    // net for changes that don't produce a mutation we can observe.
    if (completionPollTimer === null) {
      completionPollTimer = window.setInterval(() => {
        inspectCompletionDialog();
        inspectCourseSuccess();
      }, 100);
    }

    if (completionObserver || typeof MutationObserver === 'undefined') {
      inspectCompletionDialog();
      inspectCourseSuccess();
      return;
    }

    completionObserver = new MutationObserver(() => {
      inspectCompletionDialog();
      inspectCourseSuccess();
    });

    completionObserver.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
    });

    inspectCompletionDialog();
    inspectCourseSuccess();
  }

  function getLoginError() {
    if (!byId('loginUser')) {
      return '';
    }

    const nodes = document.querySelectorAll(
      '.ui-messages, .ui-growl, .ui-message, .alert, .alert-danger, #messages'
    );
    const text = Array.from(nodes)
      .map((node) => (node.innerText || node.textContent || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      return '';
    }

    if (/invalid|incorrect|failed|error|denied|not found|unknown/i.test(text)) {
      return text.slice(0, 240);
    }

    return '';
  }

  function getPageInfo() {
    const hasLoginForm = Boolean(byId('loginUser') && byId('loginPass'));
    const hasSubmit = Boolean(byId('submit'));
    const midInputs = document.querySelectorAll(
      `input[id^="${A.PREFIXES.midInputs}"]`
    );
    const endSelector = A.PREFIXES.endInputs
      .map((prefix) => `input[id^="${prefix}"]`)
      .join(',');
    const endInputs = document.querySelectorAll(endSelector);
    const courses = getCourseOptions();

    let pageType = 'unknown';
    if (hasLoginForm) {
      pageType = 'login';
    } else if (hasSubmit && midInputs.length > 0) {
      pageType = 'mid';
    } else if (hasSubmit && endInputs.length > 0) {
      pageType = 'end';
    }

    const pageText = byId('pageInfo')?.innerText || '';
    const registerMatch = pageText.match(
      /Register\s*Number[\s:]+([A-Za-z0-9._-]+)/i
    );
    const welcomeMatch = document.body.innerText.match(
      /Welcome\s+([A-Za-z0-9._-]+)/i
    );

    return {
      ok: true,
      url: location.href,
      title: document.title,
      pageType,
      hasLoginForm,
      hasSubmit,
      loggedIn: !hasLoginForm && Boolean(byId('pageInfo') || welcomeMatch),
      student: registerMatch?.[1] || welcomeMatch?.[1] || '',
      courses,
      courseCount: courses.length,
      midInputCount: midInputs.length,
      endInputCount: endInputs.length,
      courseName: getCourseName(),
      selectedLabel: getSelectedLabel(),
      submissionMessage: getSubmissionMessageText(),
      loginError: hasLoginForm ? getLoginError() : '',
      completion: getCompletionText(),
      completionDialog: getCompletionDialogText(),
      activeFeedback: Boolean(activeRun),
      stopRequested,
    };
  }

  // ---------------------------------------------------------------------------
  // Sign in
  // ---------------------------------------------------------------------------

  function handleLogin(message) {
    const user = byId('loginUser');
    const password = byId('loginPass');
    const submit = byId('loginSubmit');

    if (!user || !password || !submit) {
      return { submitted: false, error: 'The sign-in form was not found.' };
    }

    // Discourage Chrome's password manager from offering to save the
    // automation's credentials after each student signs in.
    const form = user.closest('form');
    if (form) {
      form.setAttribute('autocomplete', 'off');
    }
    user.setAttribute('autocomplete', 'off');
    password.setAttribute('autocomplete', 'new-password');

    setNativeValue(user, String(message.username || ''));

    // Chrome is less likely to recognise this as a login save when the
    // password field is not type=password at the moment of submission.
    // Keep the text field visually masked while the form submits.
    const passwordType = password.type;
    password.style.setProperty('-webkit-text-security', 'disc');
    password.type = 'text';
    setNativeValue(password, String(message.password || ''));
    submit.click();

    setTimeout(() => {
      if (password.isConnected) {
        password.type = passwordType;
        password.style.removeProperty('-webkit-text-security');
      }
    }, 1200);

    return { submitted: true };
  }

  // ---------------------------------------------------------------------------
  // Feedback form
  // ---------------------------------------------------------------------------

  function getVisibleCourseMenuItem(course) {
    if (!hasVisibleCourseMenu()) {
      return null;
    }

    const panel = getCoursePanel();
    const items = getCourseMenuItems(panel || document);
    const item = findCourseMenuItem(course, items);
    return item && isElementVisible(item) ? item : null;
  }

  async function closeCourseMenu() {
    if (!hasVisibleCourseMenu()) {
      return;
    }

    const widget = byId('courseSelect');
    const trigger =
      widget?.querySelector('.ui-selectonemenu-trigger') ||
      byId('courseSelectLabel') ||
      widget;

    if (!trigger) {
      return;
    }

    trigger.click();
    await waitFor(() => !hasVisibleCourseMenu(), {
      timeout: 1500,
      interval: 100,
      message: 'the course menu to close',
    }).catch(() => {});
  }

  async function selectCourseWithMenu(course) {
    const widget = byId('courseSelect');
    if (!widget) {
      throw new Error('The course menu was not found.');
    }

    const label = course.label || course.value;
    let lastOptions = [];

    // Drive the visible dropdown exactly like a user: open the menu, wait for
    // the target item to render, click it, and verify. This runs the portal's
    // own AJAX handler so the course data updates immediately. If the menu is
    // still showing the previous render, close it and reopen it rather than
    // forcing the hidden <select> value behind the scenes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await openCourseMenu();

      let item = null;
      try {
        item = await waitFor(() => getVisibleCourseMenuItem(course), {
          timeout: attempt === 0 ? 5000 : 3000,
          interval: 150,
          message: `the course menu to show ${label}`,
        });
      } catch {
        item = null;
      }

      if (item) {
        clickCourseMenuItem(item);

        try {
          await waitFor(() => isCourseSelected(course), {
            timeout: 8000,
            interval: 150,
            message: 'the course to be selected',
          });
          await jitter(450, 750);
          return;
        } catch {
          // The click did not take; fall through and reopen the menu.
        }
      }

      const panel = getCoursePanel();
      lastOptions = getCourseMenuItems(panel || document)
        .slice(0, 8)
        .map((element) =>
          (element.getAttribute('data-label') || element.textContent || '').trim()
        )
        .filter(Boolean);

      await closeCourseMenu();
      await jitter(250, 450);
    }

    // Last resort only: ask the PrimeFaces widget to select by value.
    const pfWidget = getPrimeFacesWidget();
    if (pfWidget && course.value && typeof pfWidget.selectValue === 'function') {
      try {
        pfWidget.selectValue(course.value);
        const selected = await waitFor(() => isCourseSelected(course), {
          timeout: 5000,
          interval: 150,
          message: 'the course to be selected',
        }).catch(() => false);
        if (selected) {
          await jitter(450, 750);
          return;
        }
      } catch {
        // Fall through to the diagnostic error.
      }
    }

    const suffix = lastOptions.length
      ? ` Options: ${lastOptions.join(', ')}.`
      : '';
    throw new Error(
      `Course ${label} was not found in the course menu.${suffix}`
    );
  }

  async function selectCourse(course) {
    const select = byId('courseSelectInput');
    if (!select) {
      throw new Error('The course dropdown was not found.');
    }

    const widget = byId('courseSelect');
    const usesMenu = Boolean(
      widget?.querySelector('.ui-selectonemenu-trigger, .ui-selectonemenu-label')
    );

    if (usesMenu) {
      await selectCourseWithMenu(course);
    } else {
      select.value = course.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      await waitFor(() => isCourseSelected(course), {
        timeout: 8000,
        interval: 200,
        message: 'the course details',
      });
    }

    // Let the AJAX response finish replacing the form fields.
    await jitter(450, 750);

    if (!isCourseSelected(course)) {
      if (usesMenu) {
        // The dropdown reverted during the AJAX render. Retry with a real
        // click instead of assigning the hidden <select> value, which does
        // not run the portal's own selection handler.
        await selectCourseWithMenu(course);
      } else {
        select.value = course.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));

        try {
          await waitFor(() => isCourseSelected(course), {
            timeout: 3000,
            interval: 200,
            message: 'the course details',
          });
        } catch {
          throw new Error(
            `The portal did not select ${course.label || course.value}.`
          );
        }
      }
    }
  }

  function getRatingInputs(mode) {
    const selector =
      mode === 'mid'
        ? `input[id^="${A.PREFIXES.midInputs}"]`
        : A.PREFIXES.endInputs
            .map((prefix) => `input[id^="${prefix}"]`)
            .join(',');

    return Array.from(document.querySelectorAll(selector)).filter(
      (input) => input.type !== 'hidden'
    );
  }

  function fillRatingInputs(mode) {
    const inputs = getRatingInputs(mode);
    for (const input of inputs) {
      setNativeValue(input, String(biasedRandom()));
    }
    return inputs.length;
  }

  async function submitFeedback() {
    const button = byId('submit');
    if (!button) {
      throw new Error('The submit button was not found.');
    }

    button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await jitter(350, 650);

    if (button.classList.contains('ui-state-disabled')) {
      await waitFor(() => !button.classList.contains('ui-state-disabled'), {
        timeout: 5000,
        interval: 150,
        message: 'the submit button to become available',
      });
    }

    button.click();
  }

  async function waitForSubmission(course) {
    const deadline = Date.now() + 5000;
    const button = byId('submit');
    let sawDisabled = false;

    await sleep(120);

    while (Date.now() < deadline) {
      const dialogText = getCompletionDialogText();
      if (/completed!?/i.test(dialogText)) {
        return {
          ok: true,
          completed: true,
          completion: getCompletionText(),
        };
      }

      // The portal confirms each subject with a message such as
      // "'IS_25IS21T' entry Sucessfull". This is the authoritative
      // per-subject confirmation, so use it to move to the next dropdown
      // subject immediately.
      const successText = getCourseSuccess(course);
      if (successText) {
        console.debug('[AFFS] submission confirmed:', successText);
        return {
          ok: true,
          completed: false,
          success: successText,
          completion: getCompletionText(),
        };
      }

      // If the portal removes the submitted subject, that is also a positive
      // confirmation. Other portal versions keep every subject in the list,
      // so this is only one of several generic signals.
      const stillListed = getCourseOptions().some((item) =>
        isSameCourse(item, course)
      );
      if (!stillListed) {
        await sleep(200);
        const confirmed = !getCourseOptions().some((item) =>
          isSameCourse(item, course)
        );
        if (confirmed) {
          return {
            ok: true,
            completed: false,
            completion: getCompletionText(),
          };
        }
      }

      // PrimeFaces disables the submit button while the AJAX request is in
      // flight. Re-enabling it is a generic "submission finished" signal that
      // does not depend on knowing or waiting for the subject code.
      if (button?.classList.contains('ui-state-disabled')) {
        sawDisabled = true;
      } else if (sawDisabled) {
        return {
          ok: true,
          completed: false,
          completion: getCompletionText(),
        };
      }

      await sleep(100);
    }

    // Do not stall on a portal that keeps the subject listed and gives no
    // explicit confirmation. The next iteration must move to the next
    // unsubmitted dropdown item.
    return {
      ok: true,
      completed: /completed!?/i.test(getCompletionDialogText()),
      assumed: true,
      completion: getCompletionText(),
    };
  }

  async function waitForCourseListToSettle(previousCourse, timeout = 1500) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline && !stopRequested) {
      const dialogText = getCompletionDialogText();
      if (/completed!?/i.test(dialogText)) {
        return { completed: true, completion: dialogText };
      }

      const stillListed = getCourseOptions().some((item) =>
        isSameCourse(item, previousCourse)
      );
      if (!stillListed) {
        return { completed: false };
      }

      await sleep(150);
    }

    return { completed: false };
  }

  async function runFeedback(payload) {
    const { runId, student, mode, dryRun } = payload;
    const label = mode === 'mid' ? 'mid-term' : 'end-term';

    const initialCourses = getCourseOptions();
    const total = initialCourses.length;
    courseSuccessSignal = '';
    courseSuccessAt = 0;

    const submittedValues = new Set();
    const submittedLabels = new Set();
    const markCourseSubmitted = (course) => {
      const value = normalizeText(course?.value);
      const label = normalizeText(course?.label);
      if (value) {
        submittedValues.add(value);
      }
      if (label) {
        submittedLabels.add(label);
      }
    };
    const isCourseSubmitted = (course) => {
      const value = normalizeText(course?.value);
      const label = normalizeText(course?.label);
      return (
        (Boolean(value) && submittedValues.has(value)) ||
        (Boolean(label) && submittedLabels.has(label))
      );
    };

    const initialDialog = getCompletionDialogText();
    if (/completed!?/i.test(initialDialog)) {
      send({
        type: 'FEEDBACK_COMPLETE',
        runId,
        student,
        mode,
        submitted: 0,
        total,
        remaining: total,
        stopped: false,
        dryRun: Boolean(dryRun),
        alreadyCompleted: true,
        completion: getCompletionText(),
      });
      return;
    }

    if (total === 0) {
      send({
        type: 'FEEDBACK_COMPLETE',
        runId,
        student,
        mode,
        submitted: 0,
        total: 0,
        remaining: 0,
        stopped: false,
        dryRun: Boolean(dryRun),
        completion: getCompletionText(),
      });
      return;
    }

    if (dryRun) {
      const course = initialCourses[0];
      await selectCourse(course);
      const filled = fillRatingInputs(mode);
      if (!filled) {
        throw new Error('No rating fields were found.');
      }

      send({
        type: 'FEEDBACK_COMPLETE',
        runId,
        student,
        mode,
        submitted: 0,
        total,
        remaining: total,
        stopped: false,
        dryRun: true,
        course: course.label,
        filled,
        completion: getCompletionText(),
      });
      return;
    }

    let submitted = 0;
    let completion = '';

    while (!stopRequested) {
      const dialogText = getCompletionDialogText();
      if (/completed!?/i.test(dialogText)) {
        completion = dialogText;
        if (submitted === 0) {
          send({
            type: 'FEEDBACK_COMPLETE',
            runId,
            student,
            mode,
            submitted: 0,
            total,
            remaining: total,
            stopped: false,
            dryRun: false,
            alreadyCompleted: true,
            completion: getCompletionText(),
          });
          return;
        }
        break;
      }

      const courses = getCourseOptions();
      if (courses.length === 0) {
        // The submitted subject disappears before the AJAX response repopulates
        // the remaining list. Wait for the list to return or for the portal's
        // completion status; do not finish just because it is momentarily
        // empty during the re-render.
        const deadline = Date.now() + 15000;
        let nextCourses = [];

        while (Date.now() < deadline && !stopRequested) {
          const statusText = getCompletionDialogText();
          if (/completed!?/i.test(statusText)) {
            completion = statusText;
            break;
          }

          nextCourses = getCourseOptions();
          if (nextCourses.length > 0) {
            break;
          }

          await sleep(150);
        }

        if (stopRequested) {
          break;
        }

        if (/completed!?/i.test(completion)) {
          break;
        }

        if (nextCourses.length === 0) {
          if (submitted >= total) {
            break;
          }
          throw new Error(
            'The course list is empty but the portal did not report Completed!'
          );
        }

        // The remaining subjects were re-rendered; process the next one.
        continue;
      }

      // The portal can briefly keep the submitted subject in the list while
      // the AJAX re-render is still in flight. Track submitted subjects and
      // always pick the first one that has not been submitted yet; otherwise
      // the loop reselects the same subject and never reaches the next one.
      let course = courses.find((item) => !isCourseSubmitted(item));
      if (!course) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !stopRequested) {
          const statusText = getCompletionDialogText();
          if (/completed!?/i.test(statusText)) {
            completion = statusText;
            break;
          }

          course =
            getCourseOptions().find((item) => !isCourseSubmitted(item)) ||
            null;
          if (course) {
            break;
          }

          await sleep(150);
        }

        if (!course) {
          if (/completed!?/i.test(completion) || submitted >= total) {
            break;
          }
          throw new Error(
            'The course list did not provide another unsubmitted subject.'
          );
        }
      }

      await selectCourse(course);

      if (stopRequested) {
        break;
      }

      const dialogAfterSelect = getCompletionDialogText();
      if (/completed!?/i.test(dialogAfterSelect)) {
        completion = dialogAfterSelect;
        break;
      }

      const filled = fillRatingInputs(mode);
      if (!filled) {
        throw new Error('No rating fields were found on the feedback form.');
      }

      const dialogBeforeSubmit = getCompletionDialogText();
      if (/completed!?/i.test(dialogBeforeSubmit)) {
        completion = dialogBeforeSubmit;
        break;
      }

      await submitFeedback();
      const result = await waitForSubmission(course);
      if (!result.ok) {
        throw new Error(result.error);
      }

      completion = result.completion || completion;
      submitted += 1;
      markCourseSubmitted(course);
      send({
        type: 'FEEDBACK_PROGRESS',
        runId,
        student,
        mode,
        kind: 'course',
        course: course.label,
        submitted,
        total,
        completion: result.completion,
      });

      if (result.completed) {
        // The portal's "Completed!" dialog means this feedback type is done.
        break;
      }

      // The success message can arrive before the dropdown's AJAX re-render.
      // Wait briefly for the submitted subject to leave the list (or for the
      // completion dialog). If the portal keeps submitted subjects listed,
      // isCourseSubmitted() skips them on the next iteration.
      const settle = await waitForCourseListToSettle(course, 1500);
      if (settle.completed) {
        completion = settle.completion;
        break;
      }
    }

    // Some portal versions keep already-submitted subjects in the dropdown.
    // Report the number of initial subjects that still need feedback, not the
    // raw option count, so a stale list does not look like unfinished work.
    const remaining = Math.max(0, total - submitted);

    send({
      type: 'FEEDBACK_COMPLETE',
      runId,
      student,
      mode,
      submitted,
      total,
      remaining,
      stopped: stopRequested,
      dryRun: false,
      completion: completion || getCompletionText(),
    });
  }

  // ---------------------------------------------------------------------------
  // Message bridge
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'PING') {
      sendResponse(getPageInfo());
      return false;
    }

    if (message.type === 'LOGIN') {
      sendResponse(handleLogin(message));
      return false;
    }

    if (message.type === 'STOP') {
      stopRequested = true;
      sendResponse({ stopped: true });
      return false;
    }

    if (message.type === 'PREPARE_COURSE') {
      if (activeRun) {
        sendResponse({
          ok: false,
          error: 'Feedback automation is already running on this page.',
        });
        return false;
      }

      if (!VALID_MODES.has(message.mode)) {
        sendResponse({ ok: false, error: 'Unknown feedback mode.' });
        return false;
      }

      const course = message.course;
      if (!course || (!course.value && !course.label)) {
        sendResponse({ ok: false, error: 'No course was provided.' });
        return false;
      }

      activeRun = {
        runId: message.runId,
        student: message.student,
        mode: message.mode,
      };
      stopRequested = false;
      startHeartbeat();

      selectCourse(course)
        .then(() => {
          if (stopRequested) {
            throw new Error('The run was stopped.');
          }

          const filled = fillRatingInputs(message.mode);
          if (!filled) {
            throw new Error(
              'No rating fields were found on the feedback form.'
            );
          }

          sendResponse({
            ok: true,
            course: course.label || course.value,
            filled,
            mode: message.mode,
          });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error:
              error?.message || 'The course could not be prepared for submission.',
          });
        })
        .finally(() => {
          activeRun = null;
          stopHeartbeat();
        });

      return true;
    }

    if (message.type === 'START_FEEDBACK') {
      if (activeRun) {
        sendResponse({
          started: false,
          error: 'Feedback automation is already running on this page.',
        });
        return false;
      }

      if (!VALID_MODES.has(message.mode)) {
        sendResponse({ started: false, error: 'Unknown feedback mode.' });
        return false;
      }

      activeRun = {
        runId: message.runId,
        student: message.student,
        mode: message.mode,
      };
      stopRequested = false;
      startHeartbeat();
      sendResponse({ started: true, mode: message.mode });

      runFeedback(message)
        .catch((error) => {
          send({
            type: 'FEEDBACK_ERROR',
            runId: message.runId,
            student: message.student,
            mode: message.mode,
            error: error?.message || `The ${message.mode} feedback run failed.`,
          });
        })
        .finally(() => {
          stopHeartbeat();
          activeRun = null;
          stopRequested = false;
        });

      return false;
    }

    return false;
  });

  startCompletionObserver();

  console.debug('[AFFS] content script ready', getPageInfo().pageType);
})();

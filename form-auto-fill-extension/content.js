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

  function biasedRandom() {
    const value = Math.random();
    if (value < 0.15) return 1;
    if (value < 0.3) return 2;
    if (value < 0.55) return 3;
    if (value < 0.8) return 4;
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

  async function selectCourseWithMenu(course) {
    const widget = byId('courseSelect');
    if (!widget) {
      throw new Error('The course menu was not found.');
    }

    await openCourseMenu();

    const panel = getCoursePanel();
    const items = getCourseMenuItems(panel || document);
    const item = findCourseMenuItem(course, items);

    if (!item) {
      // The menu may be stale after an AJAX refresh. Ask the PrimeFaces
      // widget to select by value before giving up.
      const pfWidget = getPrimeFacesWidget();
      if (
        pfWidget &&
        course.value &&
        typeof pfWidget.selectValue === 'function'
      ) {
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

      const labels = items
        .slice(0, 8)
        .map((element) =>
          (element.getAttribute('data-label') || element.textContent || '').trim()
        )
        .filter(Boolean);
      const suffix = labels.length ? ` Options: ${labels.join(', ')}.` : '';
      throw new Error(
        `Course ${course.label || course.value} was not found in the course menu.${suffix}`
      );
    }

    clickCourseMenuItem(item);

    let selected = false;
    try {
      await waitFor(() => isCourseSelected(course), {
        timeout: 8000,
        interval: 150,
        message: 'the course to be selected',
      });
      selected = true;
    } catch {
      selected = false;
    }

    if (!selected) {
      const pfWidget = getPrimeFacesWidget();
      let attempted = false;

      try {
        if (pfWidget && typeof pfWidget.selectValue === 'function' && course.value) {
          pfWidget.selectValue(course.value);
          attempted = true;
        }
      } catch {
        attempted = false;
      }

      if (!attempted && pfWidget && typeof pfWidget.selectItem === 'function') {
        try {
          const jq = globalThis.jQuery;
          pfWidget.selectItem(jq ? jq(item) : item);
          attempted = true;
        } catch {
          attempted = false;
        }
      }

      if (attempted) {
        try {
          await waitFor(() => isCourseSelected(course), {
            timeout: 5000,
            interval: 150,
            message: 'the course to be selected',
          });
          selected = true;
        } catch {
          selected = false;
        }
      }
    }

    if (!selected) {
      const current = getSelectedLabel() || 'empty';
      throw new Error(
        `The portal did not select ${course.label || course.value} (current: ${current}).`
      );
    }
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

  async function runFeedback(payload) {
    const { runId, student, mode, dryRun } = payload;
    const label = mode === 'mid' ? 'mid-term' : 'end-term';

    const initialCourses = getCourseOptions();
    const total = initialCourses.length;
    courseSuccessSignal = '';
    courseSuccessAt = 0;

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
          throw new Error(
            'The course list is empty but the portal did not report Completed!'
          );
        }

        // The remaining subjects were re-rendered; process the next one.
        continue;
      }

      // The portal removes a subject from the dropdown as soon as it is
      // submitted, so the first remaining item is always the next subject.
      const course = courses[0];
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

      // The success message and the dropdown update arrive in the same AJAX
      // response. No fixed delay is needed before opening the menu again.
      await sleep(100);
    }

    const remaining = getCourseOptions().length;

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

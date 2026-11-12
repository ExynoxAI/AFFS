// Shared configuration for AFFS.
// Loaded by the service worker (importScripts), the content script, and the side panel.
(() => {
  const ORIGIN = 'http://192.168.10.72:8080';
  const BASE = `${ORIGIN}/feedback`;
  const DEFAULT_PORTAL_BASE = BASE;

  // Accepts an origin, the portal login URL, a feedback page URL, or the
  // /feedback base itself and returns a normalized base such as
  // https://example.com/feedback. Returns '' for anything that is not HTTP(S).
  function normalizePortalBase(value) {
    let text = String(value ?? '').trim();
    if (!text) {
      return '';
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const host = text.split('/')[0].split(':')[0];
      const isLocal =
        /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
          host
        );
      text = `${isLocal ? 'http' : 'https'}://${text}`;
    }

    let url;
    try {
      url = new URL(text);
    } catch {
      return '';
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }

    let path = (url.pathname || '/').replace(/\/+$/, '');
    const feedbackIndex = path.toLowerCase().indexOf('/feedback');

    if (feedbackIndex >= 0) {
      path = path.slice(0, feedbackIndex + '/feedback'.length);
    } else if (!path) {
      path = '/feedback';
    }

    return `${url.origin}${path}`;
  }

  function portalUrls(value) {
    const base = normalizePortalBase(value) || DEFAULT_PORTAL_BASE;
    const origin = new URL(base).origin;

    return Object.freeze({
      base,
      origin,
      login: `${base}/login.xhtml`,
      index: `${base}/index.xhtml`,
      mid: `${base}/pages/student/mfeedback.xhtml`,
      end: `${base}/pages/student/efeedback.xhtml`,
      logout: `${base}/feedback/j_spring_security_logout`,
      hostMatch: `${origin}/*`,
    });
  }

  globalThis.AFFS = Object.freeze({
    VERSION: '2.0.3',
    ORIGIN,
    BASE,
    DEFAULT_PORTAL_BASE,
    normalizePortalBase,
    portalUrls,
    LOGIN_URL: `${BASE}/login.xhtml`,
    INDEX_URL: `${BASE}/index.xhtml`,
    MID_URL: `${BASE}/pages/student/mfeedback.xhtml`,
    END_URL: `${BASE}/pages/student/efeedback.xhtml`,
    LOGOUT_URL: `${BASE}/feedback/j_spring_security_logout`,
    HOST_MATCH: `${ORIGIN}/*`,
    HOST_LABEL: '192.168.10.72:8080',

    IDS: Object.freeze({
      loginUser: 'input_email',
      loginPass: 'input_password',
      loginSubmit: 'j_idt11',
      courseSelect: 'k:sel',
      courseSelectInput: 'k:sel_input',
      courseSelectPanel: 'k:sel_panel',
      courseSelectLabel: 'k:sel_label',
      courseNameMid: 'k:sub',
      coordinatorMid: 'k:sub1',
      courseNameEnd: 'k:esub',
      coordinatorEnd: 'k:esub1',
      submit: 'k:s2',
      pageInfo: 'k:sss',
    }),

    PREFIXES: Object.freeze({
      midInputs: 'k:q',
      endInputs: ['k:aq', 'k:bq', 'k:cq'],
    }),

    STORAGE: Object.freeze({
      students: 'students',
      settings: 'settings',
    }),

    LIMITS: Object.freeze({
      maxStudents: 500,
      maxLogs: 500,
      maxFileBytes: 2 * 1024 * 1024,
    }),

    DEFAULTS: Object.freeze({
      modes: Object.freeze(['mid', 'end']),
      dryRun: false,
      delayMs: 1200,
      portalBase: DEFAULT_PORTAL_BASE,
    }),
  });
})();

// Shared configuration for AFFS.
// Loaded by the service worker (importScripts), the content script, and the side panel.
(() => {
  const ORIGIN = 'http://192.168.10.72:8080';
  const BASE = `${ORIGIN}/feedback`;

  globalThis.AFFS = Object.freeze({
    VERSION: '2.0.1',
    ORIGIN,
    BASE,
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
    }),
  });
})();

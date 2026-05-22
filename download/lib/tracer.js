/**
 * tracer.js — Workflow Tracer Engine v3.5 — Deep Semantic Tracing
 *
 * Traces end-to-end system workflows through the code graph.
 * Uses semantic tags from the parser + naming patterns + graph structure
 * to automatically discover and trace 15+ workflow types.
 *
 * Each trace contains:
 *   - Sub-flows: granular steps within the workflow (e.g., auth has login, logout, refresh sub-flows)
 *   - Spans: ordered steps through the graph with rich metadata
 *   - Paths: all discovered paths from entry to exit
 *   - Stats: steps, files, APIs, stores, security concerns
 *
 * NEW in v3.5:
 *   - 15+ auto-detected trace categories with 40+ sub-flows
 *   - Semantic tag-based detection (not just naming patterns)
 *   - Cross-file flow following through imports + calls
 *   - Security-focused sub-traces (token handling, secure storage)
 *   - Real-time/WebSocket flow detection
 *   - Analytics event tracking flows
 *   - Permission request flows
 *   - Deep link handling flows
 *   - Form submission flows with validation chains
 *   - Error propagation chains
 */

const fs = require('fs');
const path = require('path');

// ──────────── Auto-Detection Trace Definitions ────────────
// Each has: id, name, description, subFlows[], detection rules
// detection: { patterns (name/path regex), tags (semantic tags), edgeKinds, nodeTypes }

const AUTO_TRACE_DEFINITIONS = [
  // ══════════════ AUTHENTICATION ══════════════
  {
    id: 'auth',
    name: 'Authentication Flow',
    description: 'Complete authentication lifecycle: login, token handling, session management, protected routes, logout',
    icon: '🔐',
    subFlows: [
      {
        id: 'auth-login',
        name: 'Login Flow',
        description: 'User enters credentials → API call → token storage → redirect to app',
        entryPatterns: [/login/i, /signin/i, /sign.in/i, /LoginScreen/i, /SignInScreen/i, /LoginForm/i],
        entryTags: ['auth', 'auth-consumer', 'form-consumer'],
        exitPatterns: [/token/i, /session/i, /setToken/i, /setSession/i, /storeToken/i, /saveToken/i, /isAuthenticated/i],
        exitTags: ['auth-storage', 'auth-token', 'state-mutation'],
        throughPatterns: [/auth/i, /credential/i, /password/i, /validate/i],
        throughTags: ['auth', 'auth-api', 'auth-context'],
        edgeKinds: ['import', 'call', 'jsx', 'api_call', 'navigates_to', 'uses_context', 'storage_access', 'dispatches'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'store', 'function'],
      },
      {
        id: 'auth-logout',
        name: 'Logout Flow',
        description: 'User triggers logout → clear token → clear session → redirect to login',
        entryPatterns: [/logout/i, /signout/i, /sign.out/i, /SignOut/i, /log.out/i],
        entryTags: ['auth'],
        exitPatterns: [/login/i, /signin/i, /removeToken/i, /clearToken/i, /clearSession/i, /removeItem.*token/i],
        exitTags: ['auth-storage', 'auth-token'],
        throughPatterns: [/clear/i, /remove/i, /reset/i, /redirect/i],
        edgeKinds: ['import', 'call', 'api_call', 'navigates_to', 'storage_access', 'dispatches'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'store', 'function'],
      },
      {
        id: 'auth-token-refresh',
        name: 'Token Refresh Flow',
        description: 'Expired token → refresh request → new token → retry original request',
        entryPatterns: [/refreshToken/i, /tokenRefresh/i, /interceptor/i, /onUnauthorized/i, /401/i],
        entryTags: ['auth-token', 'auth-api'],
        exitPatterns: [/setToken/i, /retry/i, /newToken/i],
        exitTags: ['auth-storage', 'auth-token'],
        throughPatterns: [/refresh/i, /intercept/i, /retry/i],
        edgeKinds: ['import', 'call', 'api_call', 'storage_access', 'dispatches'],
        nodeTypes: ['hook', 'service', 'api', 'endpoint', 'store', 'function'],
      },
      {
        id: 'auth-protected-route',
        name: 'Protected Route Flow',
        description: 'Route access → auth guard check → redirect to login if unauthenticated',
        entryPatterns: [/ProtectedRoute/i, /AuthGuard/i, /PrivateRoute/i, /RequireAuth/i, /AuthenticatedRoute/i, /AuthenticatedScreen/i],
        entryTags: ['auth-guard'],
        exitPatterns: [/login/i, /signin/i, /navigate.*login/i, /isAuthenticated/i, /redirect/i],
        exitTags: ['auth-consumer', 'auth-check'],
        throughPatterns: [/auth/i, /isAuth/i, /canAccess/i, /permission/i],
        edgeKinds: ['import', 'call', 'jsx', 'navigates_to', 'uses_context'],
        nodeTypes: ['screen', 'component', 'hook', 'function'],
      },
      {
        id: 'auth-signup',
        name: 'Signup / Registration Flow',
        description: 'Registration form → validation → API call → verification → onboarding',
        entryPatterns: [/signup/i, /register/i, /sign.up/i, /RegisterScreen/i, /CreateAccount/i],
        entryTags: ['auth', 'form-consumer'],
        exitPatterns: [/verify/i, /confirm/i, /onboard/i, /welcome/i, /success/i],
        exitTags: ['auth-consumer'],
        throughPatterns: [/validate/i, /confirm/i, /email/i, /otp/i, /verification/i],
        edgeKinds: ['import', 'call', 'jsx', 'api_call', 'navigates_to', 'storage_access'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'function'],
      },
      {
        id: 'auth-password-reset',
        name: 'Password Reset Flow',
        description: 'Forgot password → email → OTP → new password → login',
        entryPatterns: [/forgotPassword/i, /resetPassword/i, /changePassword/i, /ForgotPassword/i],
        entryTags: ['auth'],
        exitPatterns: [/login/i, /success/i, /changed/i, /updated/i],
        exitTags: ['auth-consumer'],
        throughPatterns: [/email/i, /otp/i, /verify/i, /newPassword/i, /confirm/i],
        edgeKinds: ['import', 'call', 'jsx', 'api_call', 'navigates_to'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'function'],
      },
    ],
  },

  // ══════════════ NAVIGATION ══════════════
  {
    id: 'navigation',
    name: 'Navigation Flow',
    description: 'Screen-to-screen routing, deep linking, and navigation patterns',
    icon: '🧭',
    subFlows: [
      {
        id: 'nav-screen-flow',
        name: 'Screen Navigation Flow',
        description: 'User action → navigate to screen → screen mounts → data loads',
        entryPatterns: [/navigation/i, /navigate/i, /useNavigation/i, /onPress/i, /handlePress/i, /goTo/i],
        entryTags: ['navigation', 'navigation-consumer', 'nav-action'],
        exitPatterns: [/screen/i, /page/i, /mount/i, /useEffect/i, /loadData/i, /fetchData/i],
        exitTags: [],
        throughPatterns: [/route/i, /params/i, /pass/i, /arguments/i],
        edgeKinds: ['import', 'call', 'navigates_to', 'defines_route', 'jsx'],
        nodeTypes: ['screen', 'component', 'hook', 'function'],
      },
      {
        id: 'nav-deep-link',
        name: 'Deep Link Flow',
        description: 'External URL → app opens → route parsing → screen renders',
        entryPatterns: [/deepLink/i, /Linking/i, /useURL/i, /universalLink/i, /scheme/i],
        entryTags: ['deep-link'],
        exitPatterns: [/screen/i, /navigate/i, /handleURL/i, /processURL/i],
        exitTags: ['navigation'],
        throughPatterns: [/parse/i, /route/i, /match/i, /extract/i],
        edgeKinds: ['import', 'call', 'deep_link', 'navigates_to', 'jsx'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },

  // ══════════════ DATA FETCHING ══════════════
  {
    id: 'data-fetch',
    name: 'Data Fetching Flow',
    description: 'Component → hook → API call → loading → data/error state → rendering',
    icon: '📡',
    subFlows: [
      {
        id: 'data-query',
        name: 'Query / Data Loading Flow',
        description: 'Component mounts → useQuery/fetch → loading state → data/error → render',
        entryPatterns: [/useQuery/i, /useFetch/i, /useApi/i, /useData/i, /fetchData/i, /getData/i, /loadData/i],
        entryTags: ['state-consumer'],
        exitPatterns: [/api/i, /endpoint/i, /fetch/i, /axios/i, /loading/i, /error/i, /success/i],
        exitTags: ['api-import'],
        throughPatterns: [/loading/i, /cache/i, /stale/i, /refetch/i, /query/i],
        edgeKinds: ['import', 'call', 'api_call', 'references'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'function'],
      },
      {
        id: 'data-mutation',
        name: 'Mutation / Data Writing Flow',
        description: 'Form/action → useMutation/POST → optimistic update → cache invalidation',
        entryPatterns: [/useMutation/i, /postData/i, /createData/i, /updateData/i, /deleteData/i, /submitForm/i],
        entryTags: ['state-consumer'],
        exitPatterns: [/api/i, /endpoint/i, /invalidate/i, /refetch/i, /optimistic/i],
        exitTags: [],
        throughPatterns: [/mutation/i, /submit/i, /optimistic/i, /invalidate/i, /cache/i],
        edgeKinds: ['import', 'call', 'api_call', 'dispatches'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'store', 'function'],
      },
    ],
  },

  // ══════════════ STATE MANAGEMENT ══════════════
  {
    id: 'state',
    name: 'State Management Flow',
    description: 'Store creation → dispatch → selector → component re-render',
    icon: '🗄️',
    subFlows: [
      {
        id: 'state-store-creation',
        name: 'Store Creation Flow',
        description: 'createStore/createSlice → reducers → actions → selectors',
        entryPatterns: [/createStore/i, /createSlice/i, /configureStore/i, /create\(/i, /zustand/i],
        entryTags: ['state-store', 'state-slice'],
        exitPatterns: [/export/i, /selector/i, /useStore/i, /useSelector/i],
        exitTags: ['state-consumer'],
        throughPatterns: [/action/i, /reducer/i, /initial/i, /default/i],
        edgeKinds: ['import', 'call', 'dispatches', 'references'],
        nodeTypes: ['store', 'hook', 'service', 'function'],
      },
      {
        id: 'state-dispatch',
        name: 'Action Dispatch Flow',
        description: 'User action → dispatch → reducer → state update → re-render',
        entryPatterns: [/dispatch/i, /handleClick/i, /onPress/i, /handleAction/i],
        entryTags: ['state-mutation'],
        exitPatterns: [/reducer/i, /update/i, /set/i, /state/i, /useSelector/i],
        exitTags: ['state-consumer'],
        throughPatterns: [/action/i, /payload/i, /type/i, /case/i],
        edgeKinds: ['import', 'call', 'dispatches', 'uses_context'],
        nodeTypes: ['screen', 'component', 'hook', 'store', 'function'],
      },
    ],
  },

  // ══════════════ FORM HANDLING ══════════════
  {
    id: 'forms',
    name: 'Form Handling Flow',
    description: 'Form input → validation → submission → success/error handling',
    icon: '📝',
    subFlows: [
      {
        id: 'form-submit',
        name: 'Form Submission Flow',
        description: 'User fills form → validate → submit → API call → success/error feedback',
        entryPatterns: [/useForm/i, /useFormik/i, /Formik/i, /handleSubmit/i, /onSubmit/i, /useField/i],
        entryTags: ['form', 'form-consumer', 'form-component'],
        exitPatterns: [/api/i, /submit/i, /success/i, /error/i, /mutation/i, /post/i],
        exitTags: [],
        throughPatterns: [/validate/i, /onChange/i, /onBlur/i, /touched/i, /errors/i, /dirty/i, /isValid/i],
        edgeKinds: ['import', 'call', 'api_call', 'dispatches', 'jsx'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'function'],
      },
      {
        id: 'form-validation',
        name: 'Form Validation Flow',
        description: 'Input change → validation rules → error messages → form state',
        entryPatterns: [/validate/i, /validation/i, /schema/i, /yup/i, /zod/i, /rules/i],
        entryTags: ['form'],
        exitPatterns: [/error/i, /errors/i, /isValid/i, /invalid/i, /touched/i],
        exitTags: [],
        throughPatterns: [/check/i, /rule/i, /required/i, /min/i, /max/i, /pattern/i, /test/i],
        edgeKinds: ['import', 'call', 'references'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },

  // ══════════════ PAYMENT ══════════════
  {
    id: 'payment',
    name: 'Payment Flow',
    description: 'Cart → checkout → payment processing → order confirmation',
    icon: '💳',
    subFlows: [
      {
        id: 'payment-checkout',
        name: 'Checkout Flow',
        description: 'Cart review → shipping info → payment → processing → confirmation',
        entryPatterns: [/payment/i, /checkout/i, /purchase/i, /billing/i, /cart/i, /order/i, /CartScreen/i, /CheckoutScreen/i],
        exitPatterns: [/confirm/i, /receipt/i, /success/i, /webhook/i, /stripe/i, /charge/i, /complete/i],
        exitTags: ['payment-api'],
        throughPatterns: [/payment/i, /amount/i, /card/i, /transaction/i, /invoice/i, /shipping/i, /total/i, /currency/i],
        edgeKinds: ['import', 'call', 'jsx', 'api_call', 'storage_access', 'dispatches'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'store', 'function'],
      },
    ],
  },

  // ══════════════ ERROR HANDLING ══════════════
  {
    id: 'errors',
    name: 'Error Handling Flow',
    description: 'Error boundary → error service → error reporting → fallback UI',
    icon: '⚠️',
    subFlows: [
      {
        id: 'error-boundary',
        name: 'Error Boundary Flow',
        description: 'Component error → componentDidCatch → error report → fallback UI',
        entryPatterns: [/ErrorBoundary/i, /componentDidCatch/i, /catch/i, /try/i, /ErrorFallback/i],
        entryTags: ['error'],
        exitPatterns: [/sentry/i, /crashlytics/i, /report/i, /log/i, /analytics/i, /fallback/i, /ErrorScreen/i],
        exitTags: [],
        throughPatterns: [/error/i, /exception/i, /fallback/i, /retry/i, /message/i, /stack/i],
        edgeKinds: ['import', 'call', 'references', 'jsx'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'class', 'function'],
      },
    ],
  },

  // ══════════════ STORAGE ══════════════
  {
    id: 'storage',
    name: 'Data Storage Flow',
    description: 'AsyncStorage/SecureStore access patterns and data persistence',
    icon: '💾',
    subFlows: [
      {
        id: 'storage-persist',
        name: 'Data Persistence Flow',
        description: 'State change → persist to storage → rehydrate on app start',
        entryPatterns: [/AsyncStorage/i, /SecureStore/i, /localStorage/i, /MMKV/i, /persist/i, /rehydrate/i],
        entryTags: ['storage', 'secure-storage'],
        exitPatterns: [/getItem/i, /setItem/i, /removeItem/i, /clearAll/i, /save/i, /load/i],
        exitTags: [],
        throughPatterns: [/key/i, /serialize/i, /deserialize/i, /transform/i, /migrate/i],
        edgeKinds: ['import', 'call', 'storage_access', 'dispatches'],
        nodeTypes: ['screen', 'component', 'hook', 'store', 'service', 'function'],
      },
    ],
  },

  // ══════════════ REAL-TIME ══════════════
  {
    id: 'realtime',
    name: 'Real-time / WebSocket Flow',
    description: 'WebSocket connection → message handling → UI updates',
    icon: '⚡',
    subFlows: [
      {
        id: 'realtime-websocket',
        name: 'WebSocket Connection Flow',
        description: 'Connect → subscribe → receive messages → update UI → disconnect',
        entryPatterns: [/WebSocket/i, /socket\.io/i, /useWebSocket/i, /useSocket/i, /connectSocket/i, /realtime/i],
        entryTags: ['realtime'],
        exitPatterns: [/onMessage/i, /sendMessage/i, /subscribe/i, /unsubscribe/i, /disconnect/i, /update/i],
        exitTags: [],
        throughPatterns: [/connect/i, /listen/i, /emit/i, /event/i, /channel/i, /room/i],
        edgeKinds: ['import', 'call', 'emits_event', 'subscribes_event', 'dispatches'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },

  // ══════════════ PERMISSIONS ══════════════
  {
    id: 'permissions',
    name: 'Permission Flow',
    description: 'Permission check → request → grant/deny → feature access',
    icon: '🔒',
    subFlows: [
      {
        id: 'permission-request',
        name: 'Permission Request Flow',
        description: 'Feature needs permission → check → request → handle result',
        entryPatterns: [/checkPermission/i, /requestPermission/i, /usePermission/i, /hasPermission/i, /camera/i, /location/i, /notification.*permission/i],
        entryTags: ['permission', 'permission-request'],
        exitPatterns: [/granted/i, /denied/i, /blocked/i, /openSettings/i, /fallback/i],
        exitTags: [],
        throughPatterns: [/check/i, /request/i, /result/i, /status/i, /rationale/i, /alert/i],
        edgeKinds: ['import', 'call', 'navigates_to'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },

  // ══════════════ NOTIFICATIONS ══════════════
  {
    id: 'notifications',
    name: 'Push Notification Flow',
    description: 'Register → receive → handle → navigate to content',
    icon: '🔔',
    subFlows: [
      {
        id: 'notification-push',
        name: 'Push Notification Flow',
        description: 'Register for push → receive notification → handle tap → navigate to content',
        entryPatterns: [/PushNotification/i, /registerForPush/i, /usePushNotification/i, /FCM/i, /OneSignal/i, /Notifee/i, /RemoteMessage/i],
        entryTags: ['notification', 'notification-consumer'],
        exitPatterns: [/navigate/i, /screen/i, /handleNotification/i, /onNotification/i, /display/i],
        exitTags: ['navigation'],
        throughPatterns: [/register/i, /token/i, /permission/i, /receive/i, /tap/i, /data/i, /payload/i],
        edgeKinds: ['import', 'call', 'navigates_to', 'api_call'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },

  // ══════════════ ANALYTICS ══════════════
  {
    id: 'analytics',
    name: 'Analytics Tracking Flow',
    description: 'User action → track event → analytics service → reporting',
    icon: '📊',
    subFlows: [
      {
        id: 'analytics-tracking',
        name: 'Event Tracking Flow',
        description: 'User interaction → trackEvent → analytics provider → data pipeline',
        entryPatterns: [/analytics/i, /track/i, /trackEvent/i, /logEvent/i, /identify/i, /screenView/i, /FirebaseAnalytics/i, /Mixpanel/i, /Amplitude/i],
        entryTags: ['analytics'],
        exitPatterns: [/report/i, /send/i, /flush/i, /batch/i, /upload/i],
        exitTags: [],
        throughPatterns: [/event/i, /property/i, /user/i, /session/i, /screen/i, /conversion/i],
        edgeKinds: ['import', 'call', 'tracks_event'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },

  // ══════════════ ONBOARDING ══════════════
  {
    id: 'onboarding',
    name: 'Onboarding Flow',
    description: 'Welcome → steps → completion → main app',
    icon: '🎯',
    subFlows: [
      {
        id: 'onboarding-welcome',
        name: 'Onboarding Steps Flow',
        description: 'First launch → welcome screen → feature walkthrough → completion',
        entryPatterns: [/onboard/i, /welcome/i, /getting.started/i, /tutorial/i, /setup/i, /intro/i, /WelcomeScreen/i],
        exitPatterns: [/complete/i, /finish/i, /done/i, /dashboard/i, /home/i, /main/i, /MainScreen/i],
        exitTags: [],
        throughPatterns: [/step/i, /progress/i, /skip/i, /next/i, /swipe/i, /page/i],
        edgeKinds: ['import', 'call', 'jsx', 'navigates_to', 'storage_access'],
        nodeTypes: ['screen', 'component', 'hook', 'store', 'function'],
      },
    ],
  },

  // ══════════════ THEME ══════════════
  {
    id: 'theme',
    name: 'Theme / Dark Mode Flow',
    description: 'Theme provider → color scheme detection → style application',
    icon: '🎨',
    subFlows: [
      {
        id: 'theme-switch',
        name: 'Theme Switching Flow',
        description: 'System preference / user toggle → theme context → style update',
        entryPatterns: [/ThemeProvider/i, /useTheme/i, /useColorScheme/i, /darkMode/i, /toggleTheme/i, /Appearance/i],
        entryTags: ['theme'],
        exitPatterns: [/style/i, /color/i, /background/i, /render/i],
        exitTags: [],
        throughPatterns: [/scheme/i, /mode/i, /toggle/i, /persist/i, /preference/i],
        edgeKinds: ['import', 'call', 'uses_context', 'storage_access'],
        nodeTypes: ['screen', 'component', 'hook', 'store', 'function'],
      },
    ],
  },

  // ══════════════ I18N ══════════════
  {
    id: 'i18n',
    name: 'Internationalization Flow',
    description: 'Language selection → translation lookup → localized rendering',
    icon: '🌍',
    subFlows: [
      {
        id: 'i18n-translate',
        name: 'Translation Flow',
        description: 'Language provider → useTranslation → key lookup → localized text',
        entryPatterns: [/useTranslation/i, /i18n/i, /translate/i, /localize/i, /formatMessage/i, /LanguageProvider/i, /setLocale/i],
        entryTags: ['i18n'],
        exitPatterns: [/render/i, /text/i, /display/i, /switch/i],
        exitTags: [],
        throughPatterns: [/key/i, /locale/i, /fallback/i, /resource/i, /bundle/i, /plural/i],
        edgeKinds: ['import', 'call', 'uses_context'],
        nodeTypes: ['screen', 'component', 'hook', 'service', 'function'],
      },
    ],
  },
];

class Tracer {
  constructor(graph, storage) {
    this.graph = graph;
    this.storage = storage;
    this.traces = [];
  }

  // ──────────── Load User-Defined Traces ────────────

  loadUserTraces(projectRoot) {
    const tracePath = path.join(projectRoot, '.codegraph', 'traces.json');
    if (fs.existsSync(tracePath)) {
      try {
        const userTraces = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
        if (Array.isArray(userTraces)) {
          this.traces = userTraces;
        }
      } catch (e) {
        console.error(`  Warning: Failed to parse .codegraph/traces.json: ${e.message}`);
      }
    }
  }

  // ──────────── Find nodes matching patterns + tags ────────────

  _findMatchingNodes(allNodes, patterns, tags, nodeTypes) {
    if ((!patterns || patterns.length === 0) && (!tags || tags.length === 0)) return [];
    return allNodes.filter(n => {
      if (nodeTypes && nodeTypes.length > 0 && !nodeTypes.includes(n.type)) return false;
      const searchable = [n.name, n.id, n.qualified_name, n.file_path, n.kind].filter(Boolean).join(' ').toLowerCase();
      const nodeTags = (n.metadata?.tags || []);
      const matchesPattern = patterns && patterns.length > 0 && patterns.some(p => p.test(searchable));
      const matchesTag = tags && tags.length > 0 && tags.some(tag => nodeTags.includes(tag));
      return matchesPattern || matchesTag;
    });
  }

  // ──────────── Run a Single Sub-Flow ────────────

  _runSubFlow(subFlowDef, allNodes) {
    const entryNodes = this._findMatchingNodes(allNodes, subFlowDef.entryPatterns, subFlowDef.entryTags, subFlowDef.nodeTypes);
    const exitNodes = this._findMatchingNodes(allNodes, subFlowDef.exitPatterns, subFlowDef.exitTags, subFlowDef.nodeTypes);
    const exitIdSet = new Set(exitNodes.map(n => n.id));
    const edgeKinds = subFlowDef.edgeKinds || null;
    const maxDepth = subFlowDef.maxDepth || 10;

    const spans = [];
    const paths = [];
    const visitedNodes = new Set();
    const touchedFiles = new Set();
    const apiCalls = [];
    const storeAccess = [];
    const secureAccess = [];
    const dispatches = [];

    for (const entryId of (entryNodes.map(n => n.id))) {
      const bfsResult = this.graph.bfs(entryId, {
        direction: 'out',
        edgeKinds,
        maxDepth,
      });

      const entryPath = [];
      let reachedExit = false;

      for (const step of bfsResult) {
        visitedNodes.add(step.nodeId);
        const node = this.storage.getNode(step.nodeId);
        if (!node) continue;

        if (node.file_path) touchedFiles.add(node.file_path);

        const outEdges = this.storage.getOutgoingEdges(step.nodeId);
        for (const e of outEdges) {
          if (e.kind === 'api_call') {
            apiCalls.push({ from: step.nodeId, edge: e });
          }
          if (e.kind === 'storage_access') {
            storeAccess.push({ from: step.nodeId, edge: e });
            if (e.metadata?.tags?.includes('secure-storage') || e.metadata?.tags?.includes('auth-storage')) {
              secureAccess.push({ from: step.nodeId, edge: e });
            }
          }
          if (e.kind === 'dispatches') {
            dispatches.push({ from: step.nodeId, edge: e });
          }
          if (['call', 'references'].includes(e.kind)) {
            const target = this.storage.getNode(e.target);
            if (target && target.type === 'store') {
              storeAccess.push({ from: step.nodeId, to: e.target, edge: e });
            }
          }
        }

        const incomingEdge = step.depth > 0 ? this._findConnectingEdge(step.path[step.depth - 1], step.nodeId, edgeKinds) : null;

        spans.push({
          nodeId: step.nodeId,
          name: node.name || node.id,
          type: node.type,
          file_path: node.file_path,
          depth: step.depth,
          edgeKind: incomingEdge ? incomingEdge.kind : 'entry',
          label: incomingEdge ? incomingEdge.label : null,
          line: incomingEdge ? incomingEdge.line : null,
          is_exported: node.is_exported,
          is_async: node.is_async,
          isEntry: step.depth === 0,
          isExit: exitIdSet.has(step.nodeId),
          tags: node.metadata?.tags || [],
        });

        entryPath.push(step.nodeId);
        if (exitIdSet.has(step.nodeId)) reachedExit = true;
      }

      if (entryPath.length > 0) {
        paths.push({
          entryId,
          steps: entryPath,
          reachedExit,
          exitNodeId: reachedExit ? entryPath[entryPath.length - 1] : null,
        });
      }
    }

    const narrative = this._buildNarrative(subFlowDef, spans);

    return {
      id: subFlowDef.id,
      name: subFlowDef.name,
      description: subFlowDef.description,
      spans,
      paths,
      stats: {
        totalSteps: spans.length,
        uniqueNodes: visitedNodes.size,
        filesTouched: touchedFiles.size,
        apiCallCount: apiCalls.length,
        storeAccessCount: storeAccess.length,
        secureAccessCount: secureAccess.length,
        dispatchCount: dispatches.length,
        pathCount: paths.length,
        completePaths: paths.filter(p => p.reachedExit).length,
      },
      apiCalls: apiCalls.map(a => ({
        from: a.from,
        fromName: this.storage.getNode(a.from)?.name,
        method: a.edge.metadata?.method || a.edge.label,
        url: a.edge.metadata?.url,
        tags: a.edge.metadata?.tags || [],
      })),
      storeAccess: storeAccess.map(s => ({
        from: s.from,
        fromName: this.storage.getNode(s.from)?.name,
        store: s.to || s.edge?.target,
        storeName: s.to ? this.storage.getNode(s.to)?.name : s.edge?.target,
        tags: s.edge?.metadata?.tags || [],
      })),
      secureAccess: secureAccess.map(s => ({
        from: s.from,
        fromName: this.storage.getNode(s.from)?.name,
        key: s.edge?.metadata?.key,
        action: s.edge?.metadata?.action,
      })),
      dispatches: dispatches.map(d => ({
        from: d.from,
        fromName: this.storage.getNode(d.from)?.name,
        actionType: d.edge.metadata?.actionType,
      })),
      narrative,
    };
  }

  // ──────────── Run a Full Trace (all sub-flows) ────────────

  runTrace(traceDef) {
    const allNodes = this.storage.getAllNodes();
    const subFlowResults = [];

    for (const subFlow of (traceDef.subFlows || [])) {
      const result = this._runSubFlow(subFlow, allNodes);
      if (result.spans.length > 0) {
        subFlowResults.push(result);
      }
    }

    // Aggregate stats
    const totalSteps = subFlowResults.reduce((s, r) => s + r.stats.totalSteps, 0);
    const totalApiCalls = subFlowResults.reduce((s, r) => s + r.stats.apiCallCount, 0);
    const totalStoreAccess = subFlowResults.reduce((s, r) => s + r.stats.storeAccessCount, 0);
    const totalSecureAccess = subFlowResults.reduce((s, r) => s + r.stats.secureAccessCount, 0);
    const totalDispatches = subFlowResults.reduce((s, r) => s + r.stats.dispatchCount, 0);
    const allFiles = new Set();
    subFlowResults.forEach(r => r.spans.forEach(s => { if (s.file_path) allFiles.add(s.file_path); }));

    return {
      traceId: traceDef.id,
      name: traceDef.name,
      description: traceDef.description,
      icon: traceDef.icon || '🔍',
      subFlows: subFlowResults,
      stats: {
        totalSteps,
        uniqueFiles: allFiles.size,
        apiCallCount: totalApiCalls,
        storeAccessCount: totalStoreAccess,
        secureAccessCount: totalSecureAccess,
        dispatchCount: totalDispatches,
        subFlowCount: subFlowResults.length,
        totalSubFlows: traceDef.subFlows?.length || 0,
      },
    };
  }

  // ──────────── Run All Traces ────────────

  runAll(projectRoot) {
    this.loadUserTraces(projectRoot);

    // Merge user traces with auto-detected (user overrides by id)
    const userTraceIds = new Set(this.traces.map(t => t.id));
    const mergedDefs = [
      ...AUTO_TRACE_DEFINITIONS.filter(t => !userTraceIds.has(t.id)),
      ...this.traces,
    ];

    const results = [];
    for (const traceDef of mergedDefs) {
      const result = this.runTrace(traceDef);
      if (result.subFlows.length > 0) {
        results.push(result);
      }
    }

    return results;
  }

  // ──────────── Helpers ────────────

  _findConnectingEdge(sourceId, targetId, edgeKinds) {
    const edges = this.storage.getOutgoingEdges(sourceId);
    const matching = edges.filter(e => e.target === targetId && (!edgeKinds || edgeKinds.includes(e.kind)));
    return matching[0] || null;
  }

  _buildNarrative(subFlowDef, spans) {
    if (spans.length === 0) return [];

    const steps = [];
    const seen = new Set();

    for (const span of spans) {
      if (seen.has(span.nodeId)) continue;
      seen.add(span.nodeId);

      const parts = [];
      if (span.isEntry) parts.push('START');
      parts.push(`${span.type}:${span.name}`);
      if (span.file_path) parts.push(`(${span.file_path})`);
      if (span.edgeKind && span.edgeKind !== 'entry') parts.push(`via ${span.edgeKind}`);
      if (span.isExit) parts.push('→ END');

      steps.push({
        depth: span.depth,
        description: parts.join(' '),
        nodeId: span.nodeId,
        type: span.type,
        name: span.name,
        file_path: span.file_path,
        isEntry: span.isEntry,
        isExit: span.isExit,
        edgeKind: span.edgeKind,
        tags: span.tags || [],
      });
    }

    return steps;
  }

  // ──────────── Create Sample traces.json ────────────

  static generateSampleTraces() {
    return [
      {
        id: 'auth',
        name: 'Authentication Flow',
        description: 'Trace the complete auth workflow from login screen to API token usage',
        icon: '🔐',
        subFlows: [
          {
            id: 'auth-login',
            name: 'Login Flow',
            description: 'Login screen → auth API → token storage → redirect',
            entryPatterns: ['login', 'signin', 'LoginScreen'],
            entryTags: ['auth', 'auth-consumer'],
            exitPatterns: ['token', 'session', '/api/auth'],
            exitTags: ['auth-storage', 'auth-token'],
            edgeKinds: ['import', 'call', 'jsx', 'api_call', 'navigates_to', 'storage_access', 'dispatches', 'uses_context'],
            maxDepth: 8,
          },
        ],
      },
      {
        id: 'feature-checkout',
        name: 'Checkout Feature Flow',
        description: 'Trace the checkout process from cart to order confirmation',
        icon: '💳',
        subFlows: [
          {
            id: 'payment-checkout',
            name: 'Checkout Flow',
            description: 'Cart → shipping → payment → confirmation',
            entryPatterns: ['cart', 'checkout', 'CartScreen'],
            exitPatterns: ['order', 'payment', '/api/orders'],
            exitTags: ['payment-api'],
            edgeKinds: ['import', 'call', 'jsx', 'api_call', 'storage_access', 'dispatches'],
            maxDepth: 8,
          },
        ],
      },
    ];
  }
}

module.exports = { Tracer, AUTO_TRACE_DEFINITIONS };

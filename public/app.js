// ============================================================
// BACKEND CONFIG (real API integration)
// ============================================================
// Backend URL resolution:
//   1. window.WWWD_BACKEND_URL if set before page load
//   2. ?api=... URL query parameter
//   3. Default: same origin the page was served from. server.js serves
//      both /api/* and this static frontend, so colocated is the common
//      case (local dev, Codespaces port-forward, production).
const BACKEND_URL = (() => {
  if (typeof window !== 'undefined' && window.WWWD_BACKEND_URL) return window.WWWD_BACKEND_URL;
  const params = new URLSearchParams(window.location.search);
  if (params.get('api')) return params.get('api');
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'http://localhost:8000';
})();

// OAuth gateway URL — set via window.WWWD_OAUTH_GATEWAY_URL before page load.
// The gateway runs the OAuth dance for us and returns a JWT to the redirect URI.
const GATEWAY_URL =
  (typeof window !== 'undefined' && window.WWWD_OAUTH_GATEWAY_URL) ||
  'https://oauth.xiangenhu.info';

// Persistent session UUID for anonymous tracking.
// Per "不传" pledge: this is a random UUID, not derivable from identity.
const SESSION_KEY = 'wwwd_session_id';
function ensureSessionId() {
  let sid = localStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid =
      (crypto.randomUUID && crypto.randomUUID()) ||
      ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
      );
    localStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

// Gateway-issued JWT. Held in sessionStorage (cleared on tab close) so an
// XSS payload's blast radius is narrower than with localStorage.
const TOKEN_KEY = 'wwwd_gateway_token';
let gatewayToken = sessionStorage.getItem(TOKEN_KEY) || '';
let userProfile = null; // populated by /api/profile after sign-in

function getAuthHeaders() {
  const headers = { 'X-Wwwd-Session': ensureSessionId() };
  if (gatewayToken) headers['Authorization'] = `Bearer ${gatewayToken}`;
  return headers;
}

// Decode a JWT payload — used only as a fallback display name when the
// backend's /api/profile call hasn't returned yet. Never trusted for
// security decisions (the backend re-verifies with the gateway).
function decodeJwtPayload(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) {
    return null;
  }
}

// Capture a JWT delivered by the gateway in the redirect-back URL, then
// strip it from the address bar so it doesn't end up in history or get
// shared by accident. The gateway delivers it as either `?wwwd_token=…`
// or `#wwwd_token=…` depending on its return-mode configuration.
function captureGatewayCallback() {
  const url = new URL(window.location.href);
  let token = url.searchParams.get('wwwd_token') || url.searchParams.get('token');
  if (!token && url.hash) {
    const h = new URLSearchParams(url.hash.replace(/^#/, ''));
    token = h.get('wwwd_token') || h.get('token');
  }
  if (!token) return false;

  gatewayToken = token;
  sessionStorage.setItem(TOKEN_KEY, token);

  // Strip token from URL so it doesn't sit in history.
  url.searchParams.delete('wwwd_token');
  url.searchParams.delete('token');
  if (url.hash) url.hash = '';
  history.replaceState(null, '', url.toString());
  return true;
}

function signIn(provider = 'google') {
  // Return to the current page (minus any stale auth params) after the
  // gateway redirects back with the JWT.
  const ret = new URL(window.location.href);
  ret.searchParams.delete('wwwd_token');
  ret.searchParams.delete('token');
  ret.hash = '';
  const url = new URL(`${GATEWAY_URL}/auth/${provider}/login`);
  url.searchParams.set('redirect_uri', ret.toString());
  window.location.assign(url.toString());
}

function signOut() {
  gatewayToken = '';
  userProfile = null;
  sessionStorage.removeItem(TOKEN_KEY);
  renderAuthBar();
}

async function loadProfile() {
  if (!gatewayToken) return;
  try {
    const res = await fetch(`${BACKEND_URL}/api/profile`, { headers: getAuthHeaders() });
    if (res.status === 401) {
      // Token was rejected by the backend (expired or revoked) — drop it.
      signOut();
      return;
    }
    if (!res.ok) return;
    const body = await res.json();
    userProfile = body.profile || null;
    renderAuthBar();
  } catch (e) {
    /* non-blocking */
  }
}

function displayNameFor(profile, token) {
  if (profile?.identity?.name) return profile.identity.name;
  if (profile?.identity?.email) return profile.identity.email;
  const payload = decodeJwtPayload(token);
  return payload?.name || payload?.email || '已登录';
}

function renderAuthBar() {
  const bar = document.getElementById('authBar');
  if (!bar) return;
  // Construct via DOM so a name with HTML metacharacters can never break
  // out into markup.
  bar.textContent = '';
  if (gatewayToken) {
    const label = document.createElement('span');
    label.className = 'auth-bar-label';
    label.textContent = '已化名 · ';
    const name = document.createElement('span');
    name.className = 'auth-bar-name';
    name.textContent = displayNameFor(userProfile, gatewayToken);
    const signOutBtn = document.createElement('button');
    signOutBtn.id = 'signOutBtn';
    signOutBtn.className = 'auth-bar-btn';
    signOutBtn.textContent = '退';
    signOutBtn.onclick = signOut;
    bar.append(label, name, signOutBtn);
  } else {
    const label = document.createElement('span');
    label.className = 'auth-bar-label';
    label.textContent = '匿名问心 · ';
    const signInBtn = document.createElement('button');
    signInBtn.id = 'gatewaySignInBtn';
    signInBtn.className = 'auth-bar-btn';
    signInBtn.textContent = '化名登入';
    signInBtn.onclick = () => signIn('google');
    bar.append(label, signInBtn);
  }
}

function initGatewayAuth() {
  // 1. Capture the JWT if the gateway just redirected back to us.
  captureGatewayCallback();
  // 2. Render with whatever state we have (token may be from this load or
  //    a prior page render within the same tab).
  renderAuthBar();
  // 3. If we have a token, fetch the canonical profile from the backend.
  if (gatewayToken) loadProfile();
}

// Wire up any element marked .login-btn (the nav "入门" link) to signIn.
function bindLoginButtons() {
  document.querySelectorAll('.login-btn').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (gatewayToken) return; // already signed in
      signIn('google');
    });
  });
}

// Emit a frontend xAPI event (whitelisted verbs only — server also filters)
async function emitXapiEvent(verbKey, sessionId, resultExt) {
  if (!backendAvailable) return;
  try {
    await fetch(`${BACKEND_URL}/api/xapi/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        verb_key: verbKey,
        session_id: sessionId,
        result_ext: resultExt || {},
      }),
    });
  } catch (e) {
    /* non-blocking */
  }
}

let backendAvailable = false;
let backendInfo = null;

async function checkBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      backendInfo = await res.json();
      backendAvailable = true;
      renderBackendStatus(true);
      return true;
    }
  } catch (e) {
    /* unreachable */
  }
  backendAvailable = false;
  renderBackendStatus(false);
  return false;
}

function renderBackendStatus(connected) {
  let badge = document.getElementById('backendBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'backendBadge';
    badge.style.cssText =
      'font-family:"Noto Serif SC",serif;font-size:11.5px;letter-spacing:0.15em;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:100px;border:1px solid rgba(26,22,18,0.15);background:rgba(255,255,255,0.4);';
    const header = document.querySelector('.deliberation-header');
    if (header) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:10px;align-items:center;';
      wrap.appendChild(badge);
      const han = header.querySelector('.han');
      if (han) header.insertBefore(wrap, han);
      else header.appendChild(wrap);
    }
  }
  if (connected) {
    const corpus = backendInfo?.corpus_size || 0;
    const model = backendInfo?.model || 'Claude';
    badge.innerHTML = `<span style="display:inline-block;width:6px;height:6px;background:#4a8b4a;border-radius:50%;animation:pulse 2s infinite;"></span><span style="color:rgba(244,236,220,0.85);">实时 AI · ${model} · ${corpus} 段语料</span>`;
    badge.style.background = 'rgba(74,139,74,0.12)';
    badge.style.borderColor = 'rgba(74,139,74,0.4)';
  } else {
    badge.innerHTML = `<span style="display:inline-block;width:6px;height:6px;background:rgba(184,149,74,0.6);border-radius:50%;"></span><span style="color:rgba(244,236,220,0.7);">演示模式 · 后端未连</span>`;
    badge.style.background = 'rgba(184,149,74,0.12)';
    badge.style.borderColor = 'rgba(184,149,74,0.3)';
  }
}

// ============================================================
// SCENARIO LIBRARY (8 cases)
// ============================================================
const scenarios = [
  {
    cat: '家',
    catFull: '家庭',
    title: '父母独居之难',
    excerpt: '父母年近八十，体衰可见，然坚持独自留乡。我已三度请其同住，皆辞……',
    full: '父母年近八十，体力日衰，然坚持独自留乡。我已三度请其与我同住，父亲皆辞，言不愿成累赘。我心中两难：一则当尊其自主，一则似有真切之责。万一有事，恐终生不能自恕。',
  },
  {
    cat: '伦',
    catFull: '伦理',
    title: '同侪疑似学术不端',
    excerpt: '近日发现一同侪之论文中，引用一段我去岁与之私下讨论之未发观点，而未具我名……',
    full: '近日发现一同侪之论文中，引用一段我去岁与之私下讨论之未发观点，而未具我名。此事甚微，未达指控之地，然心中怏怏。是径告其上司，是私下相商，是含忍而过？三者之间，良知何辨？',
  },
  {
    cat: '职',
    catFull: '职场',
    title: '同事暗夺其功',
    excerpt: '团队会议上，一同事将我熬夜所成之分析以己之名上呈，主管遂大加赞许……',
    full: '团队会议上，一同事将我熬夜所成之分析以己之名上呈，主管遂大加赞许。我未当场辩明——一则不愿失体面，二则证据未尽。然事后愈思愈难安。沉默是宽厚？是怯懦？是暗助其得？',
  },
  {
    cat: '关',
    catFull: '关系',
    title: '旧友之间嫌怨渐生',
    excerpt: '一二十年之老友，近一年间往来日疏。回溯之，三年前彼曾于一事上失约，致我误事……',
    full: '一二十年之老友，近一年间往来日疏。回溯之，三年前彼曾于一事上失约，致我误事；当时未言。如今每见其朋友圈之更新，心中即微涌烦倦。问此心：我所抑者，是当年之失？是己之未言？抑或此友谊本已尽其时？',
  },
  {
    cat: '公',
    catFull: '公民',
    title: '见公门小恶',
    excerpt: '我于某政府部门工作。近见一上级与某外承包商往来之中，似有不当之利……',
    full: '我于某政府部门工作。近见一上级与某外承包商往来之中，似有不当之利。证据非铁，然迹象明显。检举有内部之渠道，然必将损及己之处境与生计。良知何令？是径告？是观望？是先求更确之证？',
  },
  {
    cat: '教',
    catFull: '教育',
    title: '严师慈师之间',
    excerpt: '我教一群高中生。其中一生，资质本佳，然此学期态度怠惰……',
    full: '我教一群高中生。其中一生，资质本佳，然此学期态度怠惰。我可严斥之以警其志，亦可慈柔以查其因。学校文化重前者；我之本心倾后者。然亦疑：所倾后者，是因其更利学生？抑或为避己之不快与冲突？',
  },
  {
    cat: '己',
    catFull: '己身',
    title: '远方之机与心中之愧',
    excerpt: '得一升职机会，须迁至千里之外。事业之机难得，然父母在堂，子尚年幼……',
    full: '得一升职机会，须迁至千里之外。事业之机难得，然父母在堂，子尚年幼，妻业亦在此。心中既向往，又生愧疚。问此志之欲，是为成就其当为之事？抑或为安一种"我应已至此处"之念？',
  },
  {
    cat: '言',
    catFull: '言默',
    title: '何时当言，何时当默',
    excerpt: '家庭聚会上，长辈对一近亲之子之教育大加批评。彼父母在场，颇受难堪……',
    full: '家庭聚会上，长辈对一近亲之子之教育大加批评。彼父母在场，颇受难堪。我本知其中委曲，亦觉长辈所论失当。然依乡俗，晚辈不宜公然反长辈之言。我可笑而不语；可委婉转话题；可直言相驳。良知何辨？',
  },
];

// ============================================================
// CASE LIBRARY (resolved cases for browse)
// ============================================================
// Filter keys are opaque so the case-library filter doesn't break when
// OpenCC converts display strings to traditional characters. Anything
// that should remain stable across CN↔TW lives under data-*-key.
const CAT_KEY_BY_FULL = {
  家庭: 'family',
  伦理: 'ethics',
  职场: 'work',
  关系: 'relations',
  公民: 'civic',
  教育: 'education',
  己身: 'self',
  言默: 'speech',
};
const caseLibrary = [
  {
    cat: '伦',
    catFull: '伦理',
    title: '父母独居之难（本期演示）',
    excerpt:
      '父母年迈，坚守独居，体衰可见。一头是孝义之责，一头是其自主之尊。对将来悔恨之惧，弥漫一切思虑。',
    diag: '心学诊断 · 真孝 vs 为己之孝',
    diff: 3,
    time: '今日 · 立志在审',
  },
  {
    cat: '职',
    catFull: '职场',
    title: '同事暗夺其功',
    excerpt: '修者发现一同侪，于上之前以己之分析为彼之名而呈。先私下温言相商，证据于备而不张。',
    diag: '心学诊断 · 直 vs 失体面',
    diff: 2,
    time: '三日前 · 七日已访',
  },
  {
    cat: '家',
    catFull: '家庭',
    title: '兄弟反复借贷',
    excerpt: '良知辨"济"与"纵"之别。婉拒下次借款，改荐其工作之机。',
    diag: '心学诊断 · 仁 vs 纵',
    diff: 2,
    time: '五日前 · 十四日已访',
  },
  {
    cat: '公',
    catFull: '公民',
    title: '见公门小恶',
    excerpt: '言与守之间踌躇——惧损己之立。内部正途呈报，外不张扬。',
    diag: '心学诊断 · 义 vs 自保',
    diff: 4,
    time: '十一日前 · 三十日已访',
  },
  {
    cat: '关',
    catFull: '关系',
    title: '旧友间隐怨渐生',
    excerpt: '良知浮显多年未言之失。一封诚恳之信，搁置二日，再寄。',
    diag: '心学诊断 · 念念不忘 vs 过则勿惮改',
    diff: 3,
    time: '两周前 · 四十五日已结',
  },
  {
    cat: '教',
    catFull: '教育',
    title: '学生态度怠惰',
    excerpt: '严慈之间。问其因，方知家中近遭变故。先慈而察情，后严而设界。',
    diag: '心学诊断 · 教 vs 化',
    diff: 3,
    time: '十八日前 · 三十日已访',
  },
  {
    cat: '己',
    catFull: '己身',
    title: '远方之机与心中之愧',
    excerpt: '与家人三度长谈，方知所谓"为家"实有为己之求。终未迁，留中调任，志已立。',
    diag: '心学诊断 · 立志 vs 自欺',
    diff: 4,
    time: '一月前 · 已结',
  },
  {
    cat: '言',
    catFull: '言默',
    title: '宴上长辈苛言',
    excerpt: '事后私下劝长辈，并去看望被批之亲。当场之默非怯，乃为日后之实。',
    diag: '心学诊断 · 时中 vs 乡愿',
    diff: 3,
    time: '七日前 · 七日已访',
  },
  {
    cat: '伦',
    catFull: '伦理',
    title: '同侪疑似学术不端',
    excerpt: '私下温言相商。彼承之，主动加引。事未上扬。良知不必每事张扬。',
    diag: '心学诊断 · 直 vs 苛',
    diff: 4,
    time: '一月前 · 已结',
  },
];

// ============================================================
// RENDER SCENARIO CARDS
// ============================================================
const cardsContainer = document.getElementById('scenarioCards');
const textarea = document.getElementById('scenarioBox');
const wordCount = document.getElementById('wordCount');

// Modal holds the entire deliberation shell (input + 4-stage output).
// Card clicks pre-fill the textarea and open it; the trigger button just
// opens it. ESC and backdrop click close via native <dialog> behavior.
const scenarioModal = document.getElementById('scenarioModal');

function openModal() {
  if (!scenarioModal || scenarioModal.open) return;
  scenarioModal.showModal();
  // Scroll modal content to top so the user lands on the textarea.
  const inner = scenarioModal.querySelector('.scenario-modal-inner');
  if (inner) inner.scrollTop = 0;
}

if (scenarioModal) {
  // Click on the backdrop (outside the inner sheet) closes.
  scenarioModal.addEventListener('click', (ev) => {
    if (ev.target === scenarioModal) scenarioModal.close('cancel');
  });
}

const openModalBtn = document.getElementById('openModalBtn');
if (openModalBtn) {
  openModalBtn.addEventListener('click', () => openModal());
}

scenarios.forEach((s, i) => {
  const card = document.createElement('button');
  card.className = 'scenario-card' + (i === 0 ? ' active' : '');
  card.setAttribute('aria-label', `案例 · ${s.catFull} · ${s.title}`);
  card.innerHTML = `
      <span class="sc-cat">${s.cat}</span>
      <div class="sc-title">${s.title}</div>
      <div class="sc-excerpt">${s.excerpt}</div>
    `;
  card.addEventListener('click', () => {
    document.querySelectorAll('.scenario-card').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    textarea.value = s.full;
    wordCount.textContent = s.full.length;
    const display = document.querySelector('.scenario-card-display');
    if (display) {
      const preview = s.full.length > 100 ? s.full.substring(0, 100) + '……' : s.full;
      display.textContent = preview;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent =
        '案例 · ' + s.catFull + ' · 隐名 · 难度 ' + ['浅', '中', '深', '深'][i % 4];
      display.appendChild(meta);
    }
    openModal();
  });
  cardsContainer.appendChild(card);
});

// ============================================================
// PILLAR MODAL (四阶释义 popup)
// One shared example thread runs through all four stages so the
// chain reads as a single piece of fieldwork rather than four
// disconnected definitions.
// ============================================================
const PILLAR_EXAMPLE_CONTEXT = '设一困：同事于会上夺我之议而归功于己。四阶之链于此境之展开——';

const pillarData = {
  1: {
    num: '第一阶',
    han: '心之体',
    saying: '无善无恶心之体',
    quote: '无善无恶者理之静，有善有恶者气之动。不动于气，即无善无恶，是谓至善。',
    cite: '——《传习录·上》薛侃录',
    guard:
      '此阶不入价值判断，不替良知拍板。只观此境之"条件"——人、事、时、所议者为何——而不先论"应当"。一旦动判，便已落第三阶之事，先后不可乱。',
    example:
      '于此阶但观：会议之实——所议之项、与会之人、议程之序、我之言出于何时、彼之接续出于何时。怒未起之先，事即是事。',
    conceptId: 'concept-xinjili',
    conceptName: '心即理',
    conceptNote: '心之体即理之静。澄观此境之本然，正是"理"自显于未动气之心——非外求于他人之评判。',
  },
  2: {
    num: '第二阶',
    han: '意之动',
    saying: '有善有恶意之动',
    quote: '心之所发便是意，意之本体便是知，意之所在便是物。',
    cite: '——《传习录·上》徐爱录',
    guard:
      '此阶但命名所动，不评其善恶，亦不为之辩护。自责与自辩，皆是再起一层之意，反掩前一层之实。"名"而已矣。',
    example:
      '心中所动者：怒（被夺）、被轻（议归他人）、求公正之欲、亦有一缕自疑（是否我言之时机不显？）、并求人前之颜面。逐一浮显，不掩，不责。',
    conceptId: 'concept-xingcha',
    conceptName: '省察',
    conceptNote: '省察之工，正在此阶。日日省察其意之所动，如理灯然——非以自责，乃以明所之。',
  },
  3: {
    num: '第三阶',
    han: '良知',
    saying: '知善知恶是良知',
    quote: '良知只是个是非之心。是非只是个好恶。只好恶就尽了是非，只是非就尽了万事万变。',
    cite: '——《传习录·下》',
    guard:
      '门户不替你下判。镜也，非判也。它只映照你良知所已知之事——你心中早已自明而被遮蔽之知——使其在不被遮蔽时得以显现。他人之意见，不可灌注于此阶。',
    example:
      '良知所已知者：此事须澄清，非为夺回功劳，乃使来者知此议之源；亦知怨非全为正气——其中有求名之欲在。两端并显，不可偏取。',
    conceptId: 'concept-zhiliangzhi',
    conceptName: '致良知',
    conceptNote: '致良知者，推扩此本然之知于事上而无所遮也。此阶之工，正是"致"字之核。',
  },
  4: {
    num: '第四阶',
    han: '为善去恶 · 知行合一',
    saying: '为善去恶是格物',
    quote: '知是行的主意，行是知的功夫；知是行之始，行是知之成。',
    cite: '——《传习录·上》徐爱录',
    guard:
      '此阶不容笼统之意向。"我当更注意"、"以后再说"——皆非行也。须是七日内可行、可验、可指出之具体一事，方为"格物"。知而不行，未为知也。',
    example:
      '七日之内，单独与该同事一晤（非于公开之场），明告"此议本出我手，望日后所议有继，亦归其源"。听其所应，不预判其意。事后于省察之中，记此一晤所动者为何。',
    conceptId: 'concept-zhixing',
    conceptName: '知行合一',
    conceptNote: '行是知之成。一项七日可行之事，使第三阶所明之良知，得见诸事上磨练，方为"一"。',
  },
};

const pillarModal = document.getElementById('pillarModal');

function fillPillarModal(data) {
  if (!pillarModal) return;
  const set = (key, value) => {
    pillarModal.querySelectorAll(`[data-fill="${key}"]`).forEach((el) => {
      el.textContent = value;
    });
  };
  set('num', data.num);
  set('han', data.han);
  set('saying', data.saying);
  set('quote', data.quote);
  set('cite', data.cite);
  set('guard', data.guard);
  set('exampleContext', PILLAR_EXAMPLE_CONTEXT);
  set('example', data.example);
  set('conceptName', data.conceptName);
  set('conceptNote', data.conceptNote);
  const link = pillarModal.querySelector('[data-fill="conceptLink"]');
  if (link) {
    link.setAttribute('href', '#' + data.conceptId);
    link.dataset.targetId = data.conceptId;
  }
}

function spotlightConcept(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('is-spotlighted');
  // Force reflow so the animation re-runs if the same card is reopened.
  void target.offsetWidth;
  target.classList.add('is-spotlighted');
  setTimeout(() => target.classList.remove('is-spotlighted'), 2400);
}

if (pillarModal) {
  pillarModal.addEventListener('click', (ev) => {
    if (ev.target === pillarModal) pillarModal.close('cancel');
  });
  const link = pillarModal.querySelector('[data-fill="conceptLink"]');
  if (link) {
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      const id = link.dataset.targetId;
      pillarModal.close('cancel');
      // Wait one frame so the dialog-close transition doesn't fight
      // the scrollIntoView animation.
      requestAnimationFrame(() => spotlightConcept(id));
    });
  }
}

document.querySelectorAll('.pillar[data-pillar]').forEach((el) => {
  el.addEventListener('click', () => {
    const key = el.dataset.pillar;
    const data = pillarData[key];
    if (!data || !pillarModal) return;
    fillPillarModal(data);
    pillarModal.showModal();
    const inner = pillarModal.querySelector('.pillar-modal-inner');
    if (inner) inner.scrollTop = 0;
  });
});

// ============================================================
// RENDER CASE LIBRARY
// ============================================================
const caseGrid = document.getElementById('caseGrid');
caseLibrary.forEach((c) => {
  const tile = document.createElement('div');
  tile.className = 'case-tile';
  // Opaque key (not display text) so the filter survives CN↔TW
  // conversion — OpenCC rewrites textContent in place but data-cat-key
  // is left alone.
  tile.dataset.catKey = CAT_KEY_BY_FULL[c.catFull] || 'other';
  tile.dataset.cat = c.catFull;
  const dots = Array.from(
    { length: 5 },
    (_, i) => `<span class="dot${i < c.diff ? '' : ' dim'}"></span>`,
  ).join('');
  tile.innerHTML = `
      <div class="case-tile-head">
        <span class="case-tile-cat">${c.cat}</span>
        <span class="case-tile-meta">${c.time}</span>
      </div>
      <h4>${c.title}</h4>
      <p>${c.excerpt}</p>
      <div class="case-tile-foot">
        <span class="case-tile-diag">${c.diag}</span>
        <span class="case-tile-difficulty">${dots}</span>
      </div>
    `;
  caseGrid.appendChild(tile);
});

// Filter chips for case library — compare opaque keys, not display text.
document.querySelectorAll('.case-library .filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.case-library .filter-chip').forEach((c) => {
      c.classList.remove('active');
      c.setAttribute('aria-pressed', 'false');
    });
    chip.classList.add('active');
    chip.setAttribute('aria-pressed', 'true');
    const key = chip.dataset.catKey;
    document.querySelectorAll('.case-tile').forEach((tile) => {
      if (key === 'all' || tile.dataset.catKey === key) {
        tile.style.display = '';
      } else {
        tile.style.display = 'none';
      }
    });
  });
});

// ============================================================
// WORD COUNT
// ============================================================
textarea.addEventListener('input', () => {
  wordCount.textContent = textarea.value.length;
});

// ============================================================
// AI GENERATE NEW SCENARIO
// ============================================================
const aiGenBtn = document.getElementById('aiGenBtn');
const generatedScenarios = [
  {
    cat: '己',
    catFull: '己身',
    title: '深夜未眠之时',
    full: '近来连日深夜方眠，明知有损身心，然每至深夜，似得一片唯属自己之闲，舍不去。问此心：所恋者非夜，乃日间之未尽？抑或为某种已成习之自我抚慰？知而不行，奈何？',
  },
  {
    cat: '言',
    catFull: '言默',
    title: '社群中之歧见',
    full: '在一线上群组中见某友传一明显之伪信。我可径指其谬，可私下相告，可不语。径指恐其失面，私告恐其不察，不语恐误他人。三者之间，良知何辨？',
  },
  {
    cat: '关',
    catFull: '关系',
    title: '伴侣之嫌',
    full: '与伴侣近月间小事多生龃龉。事过即和，然次次累积。我察其中有我之未察之习——惯以"为你好"之名，行掌控之实。今见此，何为？',
  },
  {
    cat: '职',
    catFull: '职场',
    title: '上级令我所不安之事',
    full: '上级令我做一事，于法无违，然觉与公司对外承诺之精神相悖。可径行，可缓行而暗减其害，可直陈己见。三者各有代价。良知此刻何令？',
  },
];

let genIndex = 0;
aiGenBtn.addEventListener('click', () => {
  aiGenBtn.disabled = true;
  aiGenBtn.innerHTML =
    '<span class="pulse"></span> 生成中 <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

  setTimeout(() => {
    const newCase = generatedScenarios[genIndex % generatedScenarios.length];
    genIndex++;

    // Create a new scenario card and prepend
    const card = document.createElement('button');
    card.className = 'scenario-card active';
    card.innerHTML = `
        <span class="sc-cat">${newCase.cat}</span>
        <div class="sc-title">${newCase.title} <small style="color:var(--vermillion-l);font-size:10px;letter-spacing:0.1em;">· 新</small></div>
        <div class="sc-excerpt">${newCase.full.substring(0, 50)}……</div>
      `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.scenario-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      textarea.value = newCase.full;
      wordCount.textContent = newCase.full.length;
      openModal();
    });
    document.querySelectorAll('.scenario-card').forEach((c) => c.classList.remove('active'));
    cardsContainer.insertBefore(card, cardsContainer.firstChild);

    // Fill textarea
    textarea.value = newCase.full;
    wordCount.textContent = newCase.full.length;

    aiGenBtn.disabled = false;
    aiGenBtn.innerHTML = '<span class="pulse"></span> AI 生成新案';

    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 1600);
});

// ============================================================
// DELIBERATION (real API streaming + mock fallback)
// ============================================================
const btn = document.getElementById('deliberateBtn');
const output = document.querySelector('.deliberation-output');
const stages = document.querySelectorAll('.stage, .action-card');

function getStageContent(stageEl, num) {
  return num === 4 ? stageEl : stageEl.querySelector('.stage-content');
}

// Build the deliberation header content via DOM (no innerHTML) so any
// user/network-supplied text we ever insert here cannot inject markup.
function renderProgressHeader(headerEl, label, opts = {}) {
  headerEl.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'pulse-dot';
  if (opts.dotColor) dot.style.background = opts.dotColor;
  headerEl.appendChild(dot);
  headerEl.appendChild(document.createTextNode(' ' + label));
  if (opts.typing) {
    for (let i = 0; i < 3; i++) {
      const td = document.createElement('span');
      td.className = 'typing-dot';
      headerEl.appendChild(document.createTextNode(' '));
      headerEl.appendChild(td);
    }
  }
}

function prepareStreamTarget(stageEl, num) {
  const content = getStageContent(stageEl, num);
  // Hide demo content selectively
  const toHide =
    num === 4
      ? content.querySelectorAll('.action-list, .commit-row')
      : content.querySelectorAll('p, .quoted, .sub-line');
  toHide.forEach((el) => (el.style.display = 'none'));

  let target = content.querySelector('.stream-target');
  if (!target) {
    target = document.createElement('div');
    target.className = 'stream-target';
    target.style.cssText =
      num === 4
        ? 'color: rgba(244,236,220,0.92); font-family: "Noto Serif SC", serif; font-size: 15px; line-height: 1.95; white-space: pre-wrap; padding: 12px 0; letter-spacing: 0.03em; min-height: 80px;'
        : 'color: var(--ink-soft); font-family: "Noto Serif SC", serif; font-size: 15.5px; line-height: 1.95; white-space: pre-wrap; letter-spacing: 0.03em; min-height: 60px;';
    content.appendChild(target);
  }
  target.textContent = '';
  target.style.display = '';
  return target;
}

function getCurrentMode() {
  const sel = document.getElementById('modeSelect');
  const v = sel && sel.value;
  return v === 'deep' || v === 'novice' ? v : 'standard';
}

async function realDeliberate(scenario) {
  const header = document.querySelector('.deliberation-header .title');

  // Cache check before any network I/O. If we've deliberated this exact
  // (scenario, style, mode) triple earlier in the session, paint
  // instantly and skip the LLM round-trip entirely.
  const styleAtCall = currentStyle || 'classical';
  const modeAtCall = getCurrentMode();
  const cached = await readCachedUser(scenario, styleAtCall, modeAtCall);
  if (cached) {
    paintCachedUser(scenario, cached.stages);
    return;
  }

  renderProgressHeader(header, '正在审心', { typing: true });

  const display = document.querySelector('.scenario-card-display');
  if (display) {
    // User-supplied scenario text goes through textContent so HTML in
    // the textarea can't break out into markup.
    const preview = scenario.length > 100 ? scenario.substring(0, 100) + '……' : scenario;
    display.textContent = preview;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '案例 · 在审 · 隐名 · 实时 AI 问心';
    display.appendChild(meta);
  }

  const targets = [];
  stages.forEach((stage, i) => {
    const t = prepareStreamTarget(stage, i + 1);
    targets.push(t);
    stage.style.opacity = 1;
    stage.style.transform = 'translateY(0)';
  });

  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const startTime = Date.now();
  let serverSessionId = '';

  try {
    const response = await fetch(`${BACKEND_URL}/api/deliberate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({
        scenario: scenario,
        mode: modeAtCall,
        script: currentScript || 'cn',
        style: currentStyle || 'classical',
      }),
    });

    if (!response.ok) {
      throw new Error(`后端错误 ${response.status}: ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop();

      for (const block of events) {
        if (!block.trim()) continue;
        let eventName = 'message',
          dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr += line.slice(6);
        }
        if (!dataStr) continue;
        let data;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (eventName === 'stage_chunk' && data.stage >= 1 && data.stage <= 4) {
          targets[data.stage - 1].textContent += data.text;
        } else if (eventName === 'session') {
          serverSessionId = data.session_id || '';
        } else if (eventName === 'stage_start') {
          // Optional: visual cue
        } else if (eventName === 'stage_end') {
          // Optional: mark complete
        } else if (eventName === 'complete') {
          const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
          renderProgressHeader(header, `问心已成 · 历时 ${seconds} 秒`, {
            dotColor: 'var(--aged-gold)',
          });
        } else if (eventName === 'error') {
          throw new Error(data.message || '问心受阻');
        } else if (eventName === 'corpus') {
          // Could display retrieved passages — kept silent for now
        }
      }
    }
  } catch (err) {
    renderProgressHeader(header, '问心受阻 · ' + (err.message || String(err)), {
      dotColor: 'var(--vermillion-l)',
    });
    targets.forEach((t) => {
      if (!t.textContent)
        t.textContent =
          '（API 调用失败 · 请检查后端连接、API key 是否有效，或浏览器控制台之错误信息）';
    });
    return;
  }

  // Persist a complete deliberation to the per-scenario × style cache so
  // a future re-run (or a 文/白 toggle that returns to this pair) is
  // instant and free. Only cache when all four stages produced output —
  // a partial stream is not worth re-displaying.
  const stageTexts = targets.map((t) => t.textContent || '');
  if (stageTexts.every((t) => t.length > 0)) {
    writeCachedUser(scenario, styleAtCall, modeAtCall, stageTexts);
  }
}

function mockDeliberate() {
  // The previous demo prose lived in the HTML; it now comes from the
  // LLM on page load, so there's nothing to "restore" when the backend
  // is unreachable. Render an explicit error in each stage instead of
  // animating empty cards.
  const header = document.querySelector('.deliberation-header .title');
  renderProgressHeader(header, '问心受阻 · 后端不可用', {
    dotColor: 'var(--vermillion-l)',
  });
  stages.forEach((stage, i) => {
    const t = prepareStreamTarget(stage, i + 1);
    t.textContent = '后端未连接，无法生成本阶之论。请稍后再试。';
    stage.style.opacity = 1;
    stage.style.transform = 'translateY(0)';
  });
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

if (btn && output) {
  btn.addEventListener('click', () => {
    const scenario = textarea.value.trim();
    if (scenario.length < 10) {
      textarea.style.borderColor = 'var(--vermillion)';
      setTimeout(() => (textarea.style.borderColor = ''), 1200);
      return;
    }
    if (backendAvailable) {
      realDeliberate(scenario);
    } else {
      mockDeliberate();
    }
  });
}

// ============================================================
// AUTO-DEMO ON PAGE LOAD
// ============================================================
// Replaces the formerly hard-coded sample (scenario + 4-stage prose)
// with a fresh LLM-generated example. Cached in sessionStorage so a
// tab refresh doesn't reburn the ~5 LLM calls. Cache key is keyed on
// style so a 白话 reload doesn't get shadowed by a stale 文言 demo.
function demoCacheKey() {
  return `wwwd:demo:v2:${currentStyle}:${getCurrentMode()}`;
}

function readCachedDemo() {
  try {
    const raw = sessionStorage.getItem(demoCacheKey());
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.scenario !== 'string') return null;
    if (!Array.isArray(obj.stages) || obj.stages.length !== 4) return null;
    if (!obj.stages.every((s) => typeof s === 'string')) return null;
    return obj;
  } catch {
    return null;
  }
}

function writeCachedDemo(scenario, stageTexts) {
  try {
    sessionStorage.setItem(
      demoCacheKey(),
      JSON.stringify({ scenario, stages: stageTexts, cachedAt: Date.now() }),
    );
  } catch {
    /* sessionStorage may be unavailable in private modes; ignore */
  }
}

function paintCachedDemo(scenario, stageTexts) {
  const header = document.querySelector('.deliberation-header .title');
  if (header) {
    renderProgressHeader(header, '示例已生成', { dotColor: 'var(--aged-gold)' });
  }
  const display = document.querySelector('.scenario-card-display');
  if (display) {
    display.textContent = '';
    const preview = scenario.length > 100 ? scenario.substring(0, 100) + '……' : scenario;
    display.appendChild(document.createTextNode(preview));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '案例 · 示例 · 隐名';
    display.appendChild(meta);
  }
  stages.forEach((stage, i) => {
    const t = prepareStreamTarget(stage, i + 1);
    t.textContent = stageTexts[i] || '';
    stage.style.opacity = 1;
    stage.style.transform = 'translateY(0)';
  });
}

function captureStageTexts() {
  return Array.from(stages).map((stage, i) => {
    const content = getStageContent(stage, i + 1);
    const target = content.querySelector('.stream-target');
    return target ? target.textContent : '';
  });
}

// ============================================================
// USER-DELIBERATION CACHE (per scenario × style)
// ============================================================
// Why: a deliberation costs ~4 LLM calls. If the user toggles 文/白 on a
// scenario they've already deliberated, re-running burns those calls
// again. Cache by (sha256(scenario), style) so toggling a previously
// seen pair is instant and free; new combinations still fetch.
async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function userCacheKey(scenario, style, mode) {
  // Truncate to 16 hex chars — collision risk is negligible for a single
  // user's session, and storage stays compact.
  const hash = (await sha256Hex(scenario.trim())).slice(0, 16);
  return `wwwd:user:v2:${hash}:${style}:${mode}`;
}

async function readCachedUser(scenario, style, mode) {
  try {
    const raw = sessionStorage.getItem(await userCacheKey(scenario, style, mode));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.scenario !== 'string') return null;
    if (!Array.isArray(obj.stages) || obj.stages.length !== 4) return null;
    if (!obj.stages.every((s) => typeof s === 'string')) return null;
    return obj;
  } catch {
    return null;
  }
}

async function writeCachedUser(scenario, style, mode, stageTexts) {
  try {
    sessionStorage.setItem(
      await userCacheKey(scenario, style, mode),
      JSON.stringify({
        scenario,
        style,
        mode,
        stages: stageTexts,
        cachedAt: Date.now(),
      }),
    );
  } catch {
    /* sessionStorage may be full or unavailable; ignore */
  }
}

function paintCachedUser(scenario, stageTexts) {
  const header = document.querySelector('.deliberation-header .title');
  if (header) {
    renderProgressHeader(header, '已读自缓存', { dotColor: 'var(--aged-gold)' });
  }
  const display = document.querySelector('.scenario-card-display');
  if (display) {
    display.textContent = '';
    const preview = scenario.length > 100 ? scenario.substring(0, 100) + '……' : scenario;
    display.appendChild(document.createTextNode(preview));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = '案例 · 已缓存 · 隐名';
    display.appendChild(meta);
  }
  stages.forEach((stage, i) => {
    const t = prepareStreamTarget(stage, i + 1);
    t.textContent = stageTexts[i] || '';
    stage.style.opacity = 1;
    stage.style.transform = 'translateY(0)';
  });
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function autoLoadDemo() {
  if (!backendAvailable) return;
  // Don't clobber a user who has started typing before the demo loads.
  if (textarea.value.trim().length > 0) return;

  const cached = readCachedDemo();
  if (cached) {
    textarea.value = cached.scenario;
    wordCount.textContent = cached.scenario.length;
    paintCachedDemo(cached.scenario, cached.stages);
    return;
  }

  let scenarioText = '';
  try {
    const styleQ = encodeURIComponent(currentStyle || 'classical');
    const resp = await fetch(`${BACKEND_URL}/api/scenario/demo?style=${styleQ}`, {
      headers: getAuthHeaders(),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    scenarioText = data?.scenario?.scenario || '';
    if (!scenarioText) return;
  } catch {
    return;
  }

  if (textarea.value.trim().length > 0) return; // user typed while we waited
  textarea.value = scenarioText;
  wordCount.textContent = scenarioText.length;

  await realDeliberate(scenarioText);

  const stageTexts = captureStageTexts();
  if (stageTexts.every((t) => t && t.length > 0)) {
    writeCachedDemo(scenarioText, stageTexts);
  }
}

// ============================================================
// CULTIVATION BARS ANIMATE
// ============================================================
const barObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.querySelectorAll('.bar-fill').forEach((b) => {
          const w = b.style.width;
          b.style.width = '0%';
          requestAnimationFrame(() => {
            setTimeout(() => {
              b.style.width = w;
            }, 50);
          });
        });
        barObserver.unobserve(e.target);
      }
    });
  },
  { threshold: 0.3 },
);
document.querySelectorAll('.cultivation-panel').forEach((el) => barObserver.observe(el));

// ============================================================
// REVEAL ON SCROLL
// ============================================================
const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  },
  { threshold: 0.12 },
);
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// ============================================================
// SIMPLIFIED / TRADITIONAL TOGGLE (using OpenCC.js)
// ============================================================
let s2tConverter = null;
let t2sConverter = null;
let currentScript = 'cn';

// 文/白 user preference. Default 'classical' (文言) to match the site's
// dominant voice; persists across sessions so a 白话 user doesn't have
// to flip the toggle on every visit.
const STYLE_KEY = 'wwwd_style';
let currentStyle = localStorage.getItem(STYLE_KEY) || 'classical';
if (currentStyle !== 'classical' && currentStyle !== 'vernacular') {
  currentStyle = 'classical';
}

// Cache original text content of all text nodes once
const originalCache = new Map();
let nodeIdCounter = 0;

function cacheTextNodes(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (!parent) return;
    const tag = parent.tagName;
    // Skip script, style, and contenteditable
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    const text = node.textContent;
    if (!text || !text.trim()) return;
    // Only cache if contains CJK
    if (!/[\u3400-\u9fff]/.test(text)) return;
    const id = ++nodeIdCounter;
    node.__convId = id;
    originalCache.set(id, text);
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    // Handle textarea separately
    if (node.tagName === 'TEXTAREA') {
      if (/[\u3400-\u9fff]/.test(node.value)) {
        const id = ++nodeIdCounter;
        node.__convValId = id;
        originalCache.set(id, node.value);
      }
      if (node.placeholder && /[\u3400-\u9fff]/.test(node.placeholder)) {
        const id = ++nodeIdCounter;
        node.__convPlaceId = id;
        originalCache.set(id, node.placeholder);
      }
    }
    // Handle title and other attribute conversions
    if (node.tagName === 'INPUT' && node.placeholder && /[\u3400-\u9fff]/.test(node.placeholder)) {
      const id = ++nodeIdCounter;
      node.__convPlaceId = id;
      originalCache.set(id, node.placeholder);
    }
    // Recurse
    for (const child of node.childNodes) cacheTextNodes(child);
  }
}

function applyConversion(target) {
  // target: 'cn' (original simplified) or 'tw' (traditional)
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE && node.__convId) {
      const original = originalCache.get(node.__convId);
      if (target === 'cn') {
        node.textContent = original;
      } else if (target === 'tw' && s2tConverter) {
        node.textContent = s2tConverter(original);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'TEXTAREA') {
        if (node.__convValId) {
          const orig = originalCache.get(node.__convValId);
          node.value = target === 'tw' && s2tConverter ? s2tConverter(orig) : orig;
        }
        if (node.__convPlaceId) {
          const orig = originalCache.get(node.__convPlaceId);
          node.placeholder = target === 'tw' && s2tConverter ? s2tConverter(orig) : orig;
        }
      }
      if (node.tagName === 'INPUT' && node.__convPlaceId) {
        const orig = originalCache.get(node.__convPlaceId);
        node.placeholder = target === 'tw' && s2tConverter ? s2tConverter(orig) : orig;
      }
      for (const child of node.childNodes) walk(child);
    }
  }
  walk(document.body);

  // Update lang attribute
  document.documentElement.lang = target === 'tw' ? 'zh-Hant' : 'zh-CN';
}

function initOpenCC() {
  if (window.OpenCC && !s2tConverter) {
    try {
      s2tConverter = OpenCC.Converter({ from: 'cn', to: 'twp' });
      t2sConverter = OpenCC.Converter({ from: 'twp', to: 'cn' });
      return true;
    } catch (e) {
      console.warn('OpenCC init failed:', e);
      return false;
    }
  }
  return !!s2tConverter;
}

// Cache nodes on load + auto-detect browser language + check backend
window.addEventListener('DOMContentLoaded', () => {
  cacheTextNodes(document.body);

  // Backend health check then auto-load the LLM-generated demo. Both
  // are non-blocking for the rest of init; the demo silently skips if
  // the backend isn't reachable.
  checkBackend().then((ok) => {
    if (ok) autoLoadDemo();
  });

  // OAuth gateway init: capture any callback token, render auth bar,
  // and fetch profile if signed in.
  initGatewayAuth();
  bindLoginButtons();

  // Auto-detect script preference from browser language
  // navigator.languages is most accurate; fallback to navigator.language
  const langs = (
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || 'zh-CN']
  ).map((l) => (l || '').toLowerCase());
  const wantsTraditional = langs.some(
    (l) =>
      l === 'zh-tw' ||
      l === 'zh-hk' ||
      l === 'zh-mo' ||
      l === 'zh-hant' ||
      l.startsWith('zh-hant-') ||
      l.includes('-tw') ||
      l.includes('-hk') ||
      l.includes('-mo'),
  );

  if (wantsTraditional) {
    const tryAutoSwitch = () => {
      if (initOpenCC()) {
        applyConversion('tw');
        currentScript = 'tw';
        const twBtn = scriptToggle.querySelector('[data-script="tw"]');
        if (twBtn) setActiveScriptBtn(twBtn);
        return true;
      }
      return false;
    };
    // OpenCC may not be loaded yet — poll briefly
    if (!tryAutoSwitch()) {
      const interval = setInterval(() => {
        if (tryAutoSwitch()) clearInterval(interval);
      }, 100);
      setTimeout(() => clearInterval(interval), 5000);
    }
  }
});

// 文/白 toggle: changes the LLM `style` for future deliberations and
// scenario generations. Does NOT rewrite static UI text — that stays as
// authored. Demo cache is keyed on style so a flip won't show a stale
// example in the wrong voice.
const styleToggle = document.getElementById('styleToggle');
function setActiveStyleBtn(btn) {
  styleToggle.querySelectorAll('button').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
}
if (styleToggle) {
  // Reflect persisted preference on first paint.
  const initBtn = styleToggle.querySelector(`[data-style="${currentStyle}"]`);
  if (initBtn) setActiveStyleBtn(initBtn);

  styleToggle.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.style;
      if (!target || target === currentStyle) return;
      currentStyle = target;
      try {
        localStorage.setItem(STYLE_KEY, currentStyle);
      } catch {
        /* private mode etc — non-fatal */
      }
      setActiveStyleBtn(btn);
    });
  });
}

// Set up toggle handler
const scriptToggle = document.getElementById('scriptToggle');
function setActiveScriptBtn(btn) {
  scriptToggle.querySelectorAll('button').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
}
scriptToggle.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.script;
    if (target === currentScript) return;

    if (target === 'tw' && !initOpenCC()) {
      // Wait for OpenCC to load
      const checkInterval = setInterval(() => {
        if (initOpenCC()) {
          clearInterval(checkInterval);
          applyConversion(target);
          currentScript = target;
          setActiveScriptBtn(btn);
        }
      }, 100);
      setTimeout(() => clearInterval(checkInterval), 5000);
      return;
    }

    // Re-cache any nodes added dynamically (scenario cards, etc.)
    // Find new nodes that don't have __convId yet
    const newNodes = [];
    function findUncached(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.__convId && /[\u3400-\u9fff]/.test(node.textContent)) {
          const parent = node.parentElement;
          if (parent && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) {
            newNodes.push(node);
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of node.childNodes) findUncached(child);
      }
    }
    findUncached(document.body);
    newNodes.forEach((n) => {
      const id = ++nodeIdCounter;
      n.__convId = id;
      originalCache.set(id, n.textContent);
    });

    applyConversion(target);
    currentScript = target;
    setActiveScriptBtn(btn);
  });
});

// Re-cache when textarea content changes (so toggle works on user input)
textarea.addEventListener('blur', () => {
  if (currentScript === 'cn' && /[\u3400-\u9fff]/.test(textarea.value)) {
    const id = ++nodeIdCounter;
    textarea.__convValId = id;
    originalCache.set(id, textarea.value);
  }
});

// ============================================================
// \u53e4/\u4eca ORIENTATION TOGGLE (\u7ad6\u6392 \u2194 \u6a2a\u6392)
// Body class drives all the vertical-text CSS in style.css.
// Default is \u7ad6\u6392 (mode-vertical, set in the markup) so first paint
// already shows the \u53e4\u7c4d layout \u2014 no horizontal flash.
// ============================================================
const ORIENT_KEY = 'wwwd.orient';
const orientToggle = document.getElementById('orientToggle');
function applyOrient(orient) {
  document.body.classList.toggle('mode-vertical', orient === 'vertical');
  document.body.classList.toggle('mode-horizontal', orient === 'horizontal');
}
function setActiveOrientBtn(btn) {
  if (!orientToggle) return;
  orientToggle.querySelectorAll('button').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
}
const savedOrient = localStorage.getItem(ORIENT_KEY);
if (savedOrient === 'horizontal') {
  applyOrient('horizontal');
  if (orientToggle) {
    const btn = orientToggle.querySelector('[data-orient="horizontal"]');
    if (btn) setActiveOrientBtn(btn);
  }
}
if (orientToggle) {
  orientToggle.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.orient;
      applyOrient(target);
      setActiveOrientBtn(btn);
      localStorage.setItem(ORIENT_KEY, target);
      // Reset open state on mode change so book-opens replay if user
      // switches back to vertical.
      if (target === 'vertical') {
        document.querySelectorAll('section').forEach((s) => s.classList.remove('book-open'));
        observeBookSections();
      } else {
        document.querySelectorAll('section.book-open').forEach((s) =>
          s.classList.remove('book-open'),
        );
        // Clear any scale transform from the fit-wrapper so horizontal
        // mode renders content at natural size.
        document.querySelectorAll('.book-fit').forEach((w) => {
          w.style.transform = '';
          w.style.width = '';
          w.style.height = '';
        });
      }
    });
  });
}

// ============================================================
// BOOK OPEN ON SCROLL (vertical mode only)
// Each <section> starts collapsed (rotateY -78deg, near-invisible). When
// it enters the viewport, IntersectionObserver adds .book-open which
// triggers the CSS swing-open animation. Hinge is on the right edge —
// 线装书 are bound on the right and open leftward.
// ============================================================
let bookObserver = null;
function observeBookSections() {
  if (!document.body.classList.contains('mode-vertical')) return;
  if (bookObserver) bookObserver.disconnect();
  bookObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.18) {
          // Slight stagger feels more like books opening one by one,
          // not all at once.
          const section = entry.target;
          const delay = parseInt(section.dataset.bookDelay || '0', 10);
          setTimeout(() => {
            section.classList.add('book-open');
            // Wait for the rotateY swing to complete, then fit content.
            // 1.4s animation + small buffer.
            setTimeout(() => fitBookSection(section), 1500);
          }, delay);
          bookObserver.unobserve(section);
        }
      });
    },
    { threshold: [0.18, 0.3] },
  );
  document.querySelectorAll('section').forEach((s, i) => {
    if (!s.classList.contains('book-open')) {
      s.dataset.bookDelay = String(i * 80);
      bookObserver.observe(s);
    } else {
      // Section is already open (e.g. user toggled back from horizontal).
      fitBookSection(s);
    }
  });
}

// === FIT-TO-SCALE ===
// Wrap each section's content in a .book-fit div, measure its natural
// size, compute the scale factor needed to fit inside the 960×720 page,
// apply transform: scale. transform-origin: top right so the scale
// shrinks toward where 古籍 readers start.
function ensureBookFitWrapper(section) {
  let wrapper = section.querySelector(':scope > .book-fit');
  if (wrapper) return wrapper;
  wrapper = document.createElement('div');
  wrapper.className = 'book-fit';
  // Move all existing children of section into the wrapper.
  while (section.firstChild) wrapper.appendChild(section.firstChild);
  section.appendChild(wrapper);
  return wrapper;
}
function fitBookSection(section) {
  if (!document.body.classList.contains('mode-vertical')) return;
  const wrapper = ensureBookFitWrapper(section);
  // Reset before measuring so prior scale doesn't bias the read.
  wrapper.style.transform = '';
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  // Force reflow so the measurement reflects the reset state.
  void wrapper.offsetWidth;

  const sectionStyle = getComputedStyle(section);
  const availableW =
    section.clientWidth -
    parseFloat(sectionStyle.paddingLeft) -
    parseFloat(sectionStyle.paddingRight);
  const availableH =
    section.clientHeight -
    parseFloat(sectionStyle.paddingTop) -
    parseFloat(sectionStyle.paddingBottom);
  const naturalW = wrapper.scrollWidth;
  const naturalH = wrapper.scrollHeight;
  if (!naturalW || !naturalH) return;

  const scaleW = availableW / naturalW;
  const scaleH = availableH / naturalH;
  // Never upscale. Clamp to a sensible floor so text doesn't get unreadable.
  const scale = Math.max(0.55, Math.min(scaleW, scaleH, 1));

  if (scale < 0.995) {
    wrapper.style.transform = `scale(${scale})`;
    // Don't expand the wrapper to compensate. Leftover space on the
    // bottom-left reads as authentic 古籍 margin where a 卷 didn't
    // fill all its columns.
  }
}

function fitAllBookSections() {
  if (!document.body.classList.contains('mode-vertical')) return;
  document.querySelectorAll('section').forEach((s) => {
    // Only refit sections that have been opened (visible).
    if (s.classList.contains('book-open') || s === document.querySelector('.hero')) {
      fitBookSection(s);
    }
  });
}

// Re-fit on window resize (debounced).
let _fitResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_fitResizeTimer);
  _fitResizeTimer = setTimeout(fitAllBookSections, 150);
});

// Re-fit after fonts settle — calligraphy fonts (Ma Shan Zheng) shift
// text metrics noticeably between fallback render and final render.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => setTimeout(fitAllBookSections, 100));
}

// Run on initial load. The body class is already set in the HTML, so
// this fires regardless of localStorage state.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeBookSections);
} else {
  observeBookSections();
}

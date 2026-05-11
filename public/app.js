  // ============================================================
  // BACKEND CONFIG (real API integration)
  // ============================================================
  // Backend URL resolution:
  //   1. window.WWWD_BACKEND_URL if set before page load
  //   2. ?api=... URL query parameter
  //   3. Default: http://localhost:8000
  const BACKEND_URL = (() => {
    if (typeof window !== 'undefined' && window.WWWD_BACKEND_URL) return window.WWWD_BACKEND_URL;
    const params = new URLSearchParams(window.location.search);
    if (params.get('api')) return params.get('api');
    return 'http://localhost:8000';
  })();

  // Google OAuth client ID — set via window.WWWD_GOOGLE_CLIENT_ID before page load.
  // If unset, OAuth login is disabled and all sessions are anonymous.
  const GOOGLE_CLIENT_ID = (typeof window !== 'undefined' && window.WWWD_GOOGLE_CLIENT_ID) || '';

  // Persistent session UUID for anonymous tracking.
  // Per "不传" pledge: this is a random UUID, not derivable from identity.
  const SESSION_KEY = 'wwwd_session_id';
  function ensureSessionId() {
    let sid = localStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = (crypto.randomUUID && crypto.randomUUID()) ||
            ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
              (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      localStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  }

  // Google ID token — set by handleCredentialResponse after login.
  let googleIdToken = localStorage.getItem('wwwd_id_token') || '';
  let googleProfileName = localStorage.getItem('wwwd_profile_name') || '';

  function getAuthHeaders() {
    const headers = { 'X-Wwwd-Session': ensureSessionId() };
    if (googleIdToken) headers['Authorization'] = `Bearer ${googleIdToken}`;
    return headers;
  }

  // Called by Google Identity Services on successful sign-in
  window.handleCredentialResponse = function(response) {
    googleIdToken = response.credential;
    localStorage.setItem('wwwd_id_token', googleIdToken);
    // Decode JWT payload (display name only — never sent to backend except as token)
    try {
      const payload = JSON.parse(atob(googleIdToken.split('.')[1]));
      googleProfileName = payload.name || payload.email || '已登录';
      localStorage.setItem('wwwd_profile_name', googleProfileName);
    } catch (e) { googleProfileName = '已登录'; }
    renderAuthBar();
  };

  function signOut() {
    googleIdToken = '';
    googleProfileName = '';
    localStorage.removeItem('wwwd_id_token');
    localStorage.removeItem('wwwd_profile_name');
    if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
    renderAuthBar();
  }

  function renderAuthBar() {
    const bar = document.getElementById('authBar');
    if (!bar) return;
    // Construct via DOM so a JWT-supplied name with HTML metacharacters
    // can never break out into markup.
    bar.textContent = '';
    if (googleIdToken && googleProfileName) {
      const label = document.createElement('span');
      label.className = 'auth-bar-label';
      label.textContent = '已化名 · ';
      const name = document.createElement('span');
      name.className = 'auth-bar-name';
      name.textContent = googleProfileName;
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
      const slot = document.createElement('div');
      slot.id = 'googleSignInBtn';
      bar.append(label, slot);
      if (GOOGLE_CLIENT_ID && window.google?.accounts?.id) {
        try {
          window.google.accounts.id.renderButton(
            slot,
            { theme: 'outline', size: 'small', text: 'signin', shape: 'pill', type: 'standard' }
          );
        } catch (e) { /* GIS not ready yet */ }
      } else if (!GOOGLE_CLIENT_ID) {
        const hint = document.createElement('span');
        hint.className = 'auth-bar-hint';
        hint.textContent = '（化名登录待配置）';
        slot.appendChild(hint);
      }
    }
  }

  function initGoogleAuth() {
    if (!GOOGLE_CLIENT_ID) return;
    if (!window.google?.accounts?.id) {
      // GIS script may load after this; retry briefly
      setTimeout(initGoogleAuth, 200);
      return;
    }
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: window.handleCredentialResponse,
      auto_select: false,
    });
    renderAuthBar();
  }

  // Emit a frontend xAPI event (whitelisted verbs only — server also filters)
  async function emitXapiEvent(verbKey, sessionId, resultExt) {
    if (!backendAvailable) return;
    try {
      await fetch(`${BACKEND_URL}/api/xapi/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ verb_key: verbKey, session_id: sessionId, result_ext: resultExt || {} }),
      });
    } catch (e) { /* non-blocking */ }
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
    } catch (e) { /* unreachable */ }
    backendAvailable = false;
    renderBackendStatus(false);
    return false;
  }

  function renderBackendStatus(connected) {
    let badge = document.getElementById('backendBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'backendBadge';
      badge.style.cssText = 'font-family:"Noto Serif SC",serif;font-size:11.5px;letter-spacing:0.15em;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:100px;border:1px solid rgba(26,22,18,0.15);background:rgba(255,255,255,0.4);';
      const header = document.querySelector('.deliberation-header');
      if (header) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:10px;align-items:center;';
        wrap.appendChild(badge);
        const han = header.querySelector('.han');
        if (han) header.insertBefore(wrap, han); else header.appendChild(wrap);
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
      full: '父母年近八十，体力日衰，然坚持独自留乡。我已三度请其与我同住，父亲皆辞，言不愿成累赘。我心中两难：一则当尊其自主，一则似有真切之责。万一有事，恐终生不能自恕。'
    },
    {
      cat: '伦',
      catFull: '伦理',
      title: '同侪疑似学术不端',
      excerpt: '近日发现一同侪之论文中，引用一段我去岁与之私下讨论之未发观点，而未具我名……',
      full: '近日发现一同侪之论文中，引用一段我去岁与之私下讨论之未发观点，而未具我名。此事甚微，未达指控之地，然心中怏怏。是径告其上司，是私下相商，是含忍而过？三者之间，良知何辨？'
    },
    {
      cat: '职',
      catFull: '职场',
      title: '同事暗夺其功',
      excerpt: '团队会议上，一同事将我熬夜所成之分析以己之名上呈，主管遂大加赞许……',
      full: '团队会议上，一同事将我熬夜所成之分析以己之名上呈，主管遂大加赞许。我未当场辩明——一则不愿失体面，二则证据未尽。然事后愈思愈难安。沉默是宽厚？是怯懦？是暗助其得？'
    },
    {
      cat: '关',
      catFull: '关系',
      title: '旧友之间嫌怨渐生',
      excerpt: '一二十年之老友，近一年间往来日疏。回溯之，三年前彼曾于一事上失约，致我误事……',
      full: '一二十年之老友，近一年间往来日疏。回溯之，三年前彼曾于一事上失约，致我误事；当时未言。如今每见其朋友圈之更新，心中即微涌烦倦。问此心：我所抑者，是当年之失？是己之未言？抑或此友谊本已尽其时？'
    },
    {
      cat: '公',
      catFull: '公民',
      title: '见公门小恶',
      excerpt: '我于某政府部门工作。近见一上级与某外承包商往来之中，似有不当之利……',
      full: '我于某政府部门工作。近见一上级与某外承包商往来之中，似有不当之利。证据非铁，然迹象明显。检举有内部之渠道，然必将损及己之处境与生计。良知何令？是径告？是观望？是先求更确之证？'
    },
    {
      cat: '教',
      catFull: '教育',
      title: '严师慈师之间',
      excerpt: '我教一群高中生。其中一生，资质本佳，然此学期态度怠惰……',
      full: '我教一群高中生。其中一生，资质本佳，然此学期态度怠惰。我可严斥之以警其志，亦可慈柔以查其因。学校文化重前者；我之本心倾后者。然亦疑：所倾后者，是因其更利学生？抑或为避己之不快与冲突？'
    },
    {
      cat: '己',
      catFull: '己身',
      title: '远方之机与心中之愧',
      excerpt: '得一升职机会，须迁至千里之外。事业之机难得，然父母在堂，子尚年幼……',
      full: '得一升职机会，须迁至千里之外。事业之机难得，然父母在堂，子尚年幼，妻业亦在此。心中既向往，又生愧疚。问此志之欲，是为成就其当为之事？抑或为安一种"我应已至此处"之念？'
    },
    {
      cat: '言',
      catFull: '言默',
      title: '何时当言，何时当默',
      excerpt: '家庭聚会上，长辈对一近亲之子之教育大加批评。彼父母在场，颇受难堪……',
      full: '家庭聚会上，长辈对一近亲之子之教育大加批评。彼父母在场，颇受难堪。我本知其中委曲，亦觉长辈所论失当。然依乡俗，晚辈不宜公然反长辈之言。我可笑而不语；可委婉转话题；可直言相驳。良知何辨？'
    }
  ];

  // ============================================================
  // CASE LIBRARY (resolved cases for browse)
  // ============================================================
  // Filter keys are opaque so the case-library filter doesn't break when
  // OpenCC converts display strings to traditional characters. Anything
  // that should remain stable across CN↔TW lives under data-*-key.
  const CAT_KEY_BY_FULL = {
    '家庭': 'family', '伦理': 'ethics', '职场': 'work', '关系': 'relations',
    '公民': 'civic', '教育': 'education', '己身': 'self', '言默': 'speech',
  };
  const caseLibrary = [
    { cat: '伦', catFull: '伦理', title: '父母独居之难（本期演示）', excerpt: '父母年迈，坚守独居，体衰可见。一头是孝义之责，一头是其自主之尊。对将来悔恨之惧，弥漫一切思虑。', diag: '心学诊断 · 真孝 vs 为己之孝', diff: 3, time: '今日 · 立志在审' },
    { cat: '职', catFull: '职场', title: '同事暗夺其功', excerpt: '修者发现一同侪，于上之前以己之分析为彼之名而呈。先私下温言相商，证据于备而不张。', diag: '心学诊断 · 直 vs 失体面', diff: 2, time: '三日前 · 七日已访' },
    { cat: '家', catFull: '家庭', title: '兄弟反复借贷', excerpt: '良知辨"济"与"纵"之别。婉拒下次借款，改荐其工作之机。', diag: '心学诊断 · 仁 vs 纵', diff: 2, time: '五日前 · 十四日已访' },
    { cat: '公', catFull: '公民', title: '见公门小恶', excerpt: '言与守之间踌躇——惧损己之立。内部正途呈报，外不张扬。', diag: '心学诊断 · 义 vs 自保', diff: 4, time: '十一日前 · 三十日已访' },
    { cat: '关', catFull: '关系', title: '旧友间隐怨渐生', excerpt: '良知浮显多年未言之失。一封诚恳之信，搁置二日，再寄。', diag: '心学诊断 · 念念不忘 vs 过则勿惮改', diff: 3, time: '两周前 · 四十五日已结' },
    { cat: '教', catFull: '教育', title: '学生态度怠惰', excerpt: '严慈之间。问其因，方知家中近遭变故。先慈而察情，后严而设界。', diag: '心学诊断 · 教 vs 化', diff: 3, time: '十八日前 · 三十日已访' },
    { cat: '己', catFull: '己身', title: '远方之机与心中之愧', excerpt: '与家人三度长谈，方知所谓"为家"实有为己之求。终未迁，留中调任，志已立。', diag: '心学诊断 · 立志 vs 自欺', diff: 4, time: '一月前 · 已结' },
    { cat: '言', catFull: '言默', title: '宴上长辈苛言', excerpt: '事后私下劝长辈，并去看望被批之亲。当场之默非怯，乃为日后之实。', diag: '心学诊断 · 时中 vs 乡愿', diff: 3, time: '七日前 · 七日已访' },
    { cat: '伦', catFull: '伦理', title: '同侪疑似学术不端', excerpt: '私下温言相商。彼承之，主动加引。事未上扬。良知不必每事张扬。', diag: '心学诊断 · 直 vs 苛', diff: 4, time: '一月前 · 已结' }
  ];

  // ============================================================
  // RENDER SCENARIO CARDS
  // ============================================================
  const cardsContainer = document.getElementById('scenarioCards');
  const textarea = document.getElementById('scenarioBox');
  const wordCount = document.getElementById('wordCount');

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
      document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      textarea.value = s.full;
      wordCount.textContent = s.full.length;
      // Update displayed scenario card
      const display = document.querySelector('.scenario-card-display');
      if (display) {
        const meta = display.querySelector('.meta');
        const newContent = s.full.length > 100 ? s.full.substring(0, 100) + '……' : s.full;
        // Replace text content while preserving meta
        display.innerHTML = newContent + '<div class="meta">案例 · ' + s.catFull + ' · 隐名 · 难度 ' + (['浅','中','深','深'][i % 4]) + '</div>';
      }
    });
    cardsContainer.appendChild(card);
  });

  // ============================================================
  // RENDER CASE LIBRARY
  // ============================================================
  const caseGrid = document.getElementById('caseGrid');
  caseLibrary.forEach(c => {
    const tile = document.createElement('div');
    tile.className = 'case-tile';
    // Opaque key (not display text) so the filter survives CN↔TW
    // conversion — OpenCC rewrites textContent in place but data-cat-key
    // is left alone.
    tile.dataset.catKey = CAT_KEY_BY_FULL[c.catFull] || 'other';
    tile.dataset.cat = c.catFull;
    const dots = Array.from({length: 5}, (_, i) =>
      `<span class="dot${i < c.diff ? '' : ' dim'}"></span>`).join('');
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
  document.querySelectorAll('.case-library .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.case-library .filter-chip').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
      const key = chip.dataset.catKey;
      document.querySelectorAll('.case-tile').forEach(tile => {
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
    { cat: '己', catFull: '己身', title: '深夜未眠之时', full: '近来连日深夜方眠，明知有损身心，然每至深夜，似得一片唯属自己之闲，舍不去。问此心：所恋者非夜，乃日间之未尽？抑或为某种已成习之自我抚慰？知而不行，奈何？' },
    { cat: '言', catFull: '言默', title: '社群中之歧见', full: '在一线上群组中见某友传一明显之伪信。我可径指其谬，可私下相告，可不语。径指恐其失面，私告恐其不察，不语恐误他人。三者之间，良知何辨？' },
    { cat: '关', catFull: '关系', title: '伴侣之嫌', full: '与伴侣近月间小事多生龃龉。事过即和，然次次累积。我察其中有我之未察之习——惯以"为你好"之名，行掌控之实。今见此，何为？' },
    { cat: '职', catFull: '职场', title: '上级令我所不安之事', full: '上级令我做一事，于法无违，然觉与公司对外承诺之精神相悖。可径行，可缓行而暗减其害，可直陈己见。三者各有代价。良知此刻何令？' }
  ];

  let genIndex = 0;
  aiGenBtn.addEventListener('click', () => {
    aiGenBtn.disabled = true;
    aiGenBtn.innerHTML = '<span class="pulse"></span> 生成中 <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

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
        document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        textarea.value = newCase.full;
        wordCount.textContent = newCase.full.length;
      });
      document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
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
    const toHide = num === 4
      ? content.querySelectorAll('.action-list, .commit-row')
      : content.querySelectorAll('p, .quoted, .sub-line');
    toHide.forEach(el => el.style.display = 'none');

    let target = content.querySelector('.stream-target');
    if (!target) {
      target = document.createElement('div');
      target.className = 'stream-target';
      target.style.cssText = num === 4
        ? 'color: rgba(244,236,220,0.92); font-family: "Noto Serif SC", serif; font-size: 15px; line-height: 1.95; white-space: pre-wrap; padding: 12px 0; letter-spacing: 0.03em; min-height: 80px;'
        : 'color: var(--ink-soft); font-family: "Noto Serif SC", serif; font-size: 15.5px; line-height: 1.95; white-space: pre-wrap; letter-spacing: 0.03em; min-height: 60px;';
      content.appendChild(target);
    }
    target.textContent = '';
    target.style.display = '';
    return target;
  }

  function restoreMockContent() {
    stages.forEach((stage, i) => {
      const num = i + 1;
      const content = getStageContent(stage, num);
      const all = content.querySelectorAll('p, .quoted, .sub-line, .action-list, .commit-row');
      all.forEach(el => el.style.display = '');
      const target = content.querySelector('.stream-target');
      if (target) target.style.display = 'none';
    });
  }

  async function realDeliberate(scenario) {
    const header = document.querySelector('.deliberation-header .title');
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
          mode: 'standard',
          script: currentScript || 'cn'
        })
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
          let eventName = 'message', dataStr = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }

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
            renderProgressHeader(header, `问心已成 · 历时 ${seconds} 秒`, { dotColor: 'var(--aged-gold)' });
          } else if (eventName === 'error') {
            throw new Error(data.message || '问心受阻');
          } else if (eventName === 'corpus') {
            // Could display retrieved passages — kept silent for now
          }
        }
      }
    } catch (err) {
      renderProgressHeader(header, '问心受阻 · ' + (err.message || String(err)), { dotColor: 'var(--vermillion-l)' });
      targets.forEach(t => {
        if (!t.textContent) t.textContent = '（API 调用失败 · 请检查后端连接、API key 是否有效，或浏览器控制台之错误信息）';
      });
    }
  }

  function mockDeliberate() {
    restoreMockContent();
    stages.forEach(s => {
      s.style.opacity = 0;
      s.style.transform = 'translateY(16px)';
      s.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
    });
    output.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const header = document.querySelector('.deliberation-header .title');
    renderProgressHeader(header, '正在审心', { typing: true });

    stages.forEach((s, i) => {
      setTimeout(() => {
        s.style.opacity = 1;
        s.style.transform = 'translateY(0)';
      }, 700 + i * 1000);
    });

    setTimeout(() => {
      renderProgressHeader(header, '问心已成 · 演示模式 · 历时 27.4 秒', { dotColor: 'var(--aged-gold)' });
    }, 700 + stages.length * 1000 + 200);
  }

  if (btn && output) {
    btn.addEventListener('click', () => {
      const scenario = textarea.value.trim();
      if (scenario.length < 10) {
        textarea.style.borderColor = 'var(--vermillion)';
        setTimeout(() => textarea.style.borderColor = '', 1200);
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
  // CULTIVATION BARS ANIMATE
  // ============================================================
  const barObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.querySelectorAll('.bar-fill').forEach(b => {
          const w = b.style.width;
          b.style.width = '0%';
          requestAnimationFrame(() => {
            setTimeout(() => { b.style.width = w; }, 50);
          });
        });
        barObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.3 });
  document.querySelectorAll('.cultivation-panel').forEach(el => barObserver.observe(el));

  // ============================================================
  // REVEAL ON SCROLL
  // ============================================================
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // ============================================================
  // SIMPLIFIED / TRADITIONAL TOGGLE (using OpenCC.js)
  // ============================================================
  let s2tConverter = null;
  let t2sConverter = null;
  let currentScript = 'cn';

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
            node.value = (target === 'tw' && s2tConverter) ? s2tConverter(orig) : orig;
          }
          if (node.__convPlaceId) {
            const orig = originalCache.get(node.__convPlaceId);
            node.placeholder = (target === 'tw' && s2tConverter) ? s2tConverter(orig) : orig;
          }
        }
        if (node.tagName === 'INPUT' && node.__convPlaceId) {
          const orig = originalCache.get(node.__convPlaceId);
          node.placeholder = (target === 'tw' && s2tConverter) ? s2tConverter(orig) : orig;
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

    // Backend health check (non-blocking)
    checkBackend();

    // Google OAuth init + render auth bar (idempotent — safe if GIS not yet loaded)
    initGoogleAuth();
    renderAuthBar();

    // Auto-detect script preference from browser language
    // navigator.languages is most accurate; fallback to navigator.language
    const langs = (navigator.languages && navigator.languages.length
      ? navigator.languages : [navigator.language || 'zh-CN']).map(l => (l || '').toLowerCase());
    const wantsTraditional = langs.some(l =>
      l === 'zh-tw' || l === 'zh-hk' || l === 'zh-mo' ||
      l === 'zh-hant' || l.startsWith('zh-hant-') ||
      l.includes('-tw') || l.includes('-hk') || l.includes('-mo')
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

  // Set up toggle handler
  const scriptToggle = document.getElementById('scriptToggle');
  function setActiveScriptBtn(btn) {
    scriptToggle.querySelectorAll('button').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
  }
  scriptToggle.querySelectorAll('button').forEach(btn => {
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
            if (parent && !['SCRIPT','STYLE','NOSCRIPT'].includes(parent.tagName)) {
              newNodes.push(node);
            }
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          for (const child of node.childNodes) findUncached(child);
        }
      }
      findUncached(document.body);
      newNodes.forEach(n => {
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

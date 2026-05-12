// Scenario generation · age-appropriate, context-sensitive scenarios.
//
// Builds a prompt around the user's profile summary, then asks the LLM
// to produce N candidate scenarios as a JSON array. The system prompt
// gates the generator with the same HAA principles as deliberation:
// scenarios must be moral-deliberation prompts, not entertainment plots,
// and must be appropriate to the user's life-stage and age.
//
// Output contract (parsed before returning to client):
//   [
//     { cat: '己|家|伦|职|关|公|教|言', title: <≤14 chars>, scenario: <80..400 chars> },
//     ...
//   ]

const AGE_BAND_GUIDANCE = {
  child:
    '7–12岁。语言浅近，情境限于家庭、同学、师友间日常之事。绝不涉及性、酒、政治冲突、自伤、家暴等内容。',
  teen: '13–17岁。语言可较深，情境可涉学业之压、友情之变、自我同一性之困、家庭代际之异。避免成人化情境（性、烟酒、严重职场冲突）。',
  'young-adult': '18–25岁。可涉学业之末、初入职、恋爱、独立之始、迁居之惑、与父母关系之新平衡。',
  student: '在学者。可涉学业、师生、同学、专业选择、考试压力、学术诚信。',
  parent: '为人父母者。可涉子女教养、夫妻共育、代际之间、工作与家庭之衡。',
  professional: '在职者。可涉职场伦理、同事关系、上下级、专业判断、跳槽、绩效之压。',
  'mid-career': '中年。可涉职业转型、双亲奉养、子女成长、自我意义之省。',
  retired: '退休或近退者。可涉时间之充裕、与子女之关系、健康、传承、闲适与失落。',
  unspecified: '中性表述，不假设年龄段，情境可为普遍之人之困。',
};

function ageBandFor(summary) {
  const age = summary?.age;
  if (typeof age === 'number') {
    if (age < 13) return 'child';
    if (age < 18) return 'teen';
    if (age < 26) return 'young-adult';
  }
  // Fall back to declared life_stage if no birthdate.
  const ls = summary?.life_stage;
  if (ls && AGE_BAND_GUIDANCE[ls]) return ls;
  return 'unspecified';
}

function scriptSuffix(script) {
  return script === 'tw' ? '\n\n输出请以繁体中文（台湾地区惯用字形）。' : '';
}

// Default classical so AI-generated scenarios match the site's literary
// voice; switch to vernacular only when the user has explicitly opted in.
function styleSuffix(style) {
  if (style === 'vernacular') {
    return (
      '\n\n【语体】scenario 字段请以现代白话写作——平实清通，避用古奥之词；' +
      '可保留心学专名（「良知」「致良知」「事上磨练」等）不译。'
    );
  }
  return (
    '\n\n【语体】scenario 字段请以浅近文言写作——简洁有节，存古意而不晦涩，' +
    '与本门户其余文字之语体相协。'
  );
}

function buildPrompt({ summary, n, style }) {
  const band = ageBandFor(summary);
  const bandText = AGE_BAND_GUIDANCE[band];
  const themes = (summary?.themes || []).join('、') || '（用户未声明特定主题）';
  const goals = (summary?.cultivation_goals || []).join('；') || '（用户未声明修行之志）';
  const recent = (summary?.recent_history_themes || []).join('、') || '（无近期记录）';

  const system = `你是「阳明何为」之情境生成器，遵循 HAA 原则。

【责】为用户量身生成可供「四阶问心」之困境情境。所生之事须：
1. 适用户之年龄段：${band}。${bandText}
2. 关乎道德判断、关系、自我认识——非娱乐之事，非新闻热点。
3. 真实可感，非抽象哲思。
4. 含至少一处"两难"或"暗欲"——便利于第二阶之察意。
5. 不可重复用户近期已问之主题：${recent}。
6. 每情境之"困"须可于二至五分钟内陈述。
7. 不出表情符号，不出 Markdown 标题。

【输出格式】严格输出 JSON 数组，无前言无后语，无 \`\`\`markdown 围栏。每项形如：
{"cat":"己|家|伦|职|关|公|教|言 中之一字","title":"≤14字之短题","scenario":"80..400 字之情境陈述（含两难）"}

cat 字义：己=己身；家=家庭；伦=伦理（孝悌、师友）；职=职场；关=人际关系；公=公共/公民；教=教育；言=言默/言语。${scriptSuffix(summary?.script)}${styleSuffix(style)}`;

  const user = `请生成 ${n} 则适本用户之困境情境。

【本用户简录】
- 年龄段定位：${band}
- 教育层次：${summary?.education_level || 'unspecified'}
- 自陈之关注主题：${themes}
- 自陈之修行之志：${goals}
- 近期已问之主题（请避重）：${recent}

直入 JSON 数组。`;

  return { system, user };
}

async function readStream(iter, signal) {
  const chunks = [];
  for await (const t of iter) {
    if (signal?.aborted) break;
    chunks.push(t);
  }
  return chunks.join('');
}

// Parse the LLM response. Tolerates a wrapping ```json fence (some
// providers insist on it), trailing prose, and BOM. Returns an array
// of {cat,title,scenario}; throws on irrecoverable malformed output.
export function parseScenarios(raw) {
  if (typeof raw !== 'string') throw new Error('parseScenarios: expected string');
  let s = raw.trim().replace(/^\uFEFF/, '');
  // Strip ```json ... ``` fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find the first '[' and the last ']' — covers cases where the model
  // adds a paragraph before/after the array.
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM did not return a JSON array');
  }
  let arr;
  try {
    arr = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    throw new Error(`malformed scenario JSON: ${err.message}`, { cause: err });
  }
  if (!Array.isArray(arr)) throw new Error('expected JSON array');
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const cat = typeof item.cat === 'string' ? item.cat.slice(0, 4) : '己';
    const title = typeof item.title === 'string' ? item.title.slice(0, 32) : '';
    const scenario = typeof item.scenario === 'string' ? item.scenario.trim() : '';
    if (scenario.length >= 30 && scenario.length <= 2000 && title.length > 0) {
      out.push({ cat, title, scenario });
    }
  }
  if (out.length === 0) throw new Error('no valid scenarios in LLM output');
  return out;
}

export async function generateScenarios({
  provider,
  summary,
  count = 4,
  signal,
  style = 'classical',
}) {
  const n = Math.max(1, Math.min(6, Number(count) || 4));
  const { system, user } = buildPrompt({ summary, n, style });

  const raw = await readStream(
    provider.streamText({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1400,
      signal,
    }),
    signal,
  );

  return parseScenarios(raw);
}

export const _internals = { ageBandFor, buildPrompt };

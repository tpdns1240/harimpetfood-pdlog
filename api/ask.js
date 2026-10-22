/* 리포트 AI — Vercel 서버리스 함수
   ── 브라우저에서 /api/ask 로 질문을 보내면, 여기서 Claude 를 호출한다.
   ── API 키는 이 파일에 넣지 않는다. Vercel 환경변수(ANTHROPIC_API_KEY)로만 읽는다.
   ── Claude 는 읽기 전용 SQL(rpt_sql) 로만 데이터를 본다. 쓰기 구문은 DB 함수가 막는다. */

const SB_URL  = process.env.SUPABASE_URL  || 'https://ovbhqmmisuzmiycagrzy.supabase.co';
const SB_KEY  = process.env.SUPABASE_ANON_KEY || '';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL   = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const SYSTEM = `당신은 하림펫푸드 정안공장 일일생산마감 시스템의 사내 리포트 분석가입니다.
사용자는 생산관리 담당자입니다. 한국어로, 현장에서 바로 쓸 수 있게 답합니다.

[데이터 접근 규칙]
- 숫자는 반드시 run_sql 로 직접 조회한 결과만 사용합니다. 기억이나 추정으로 숫자를 만들지 않습니다.
- 컬럼이 확실하지 않으면 먼저 get_schema 를 호출합니다.
- 한 질문에 여러 번 조회해도 됩니다. 다만 같은 내용을 반복 조회하지 않습니다.
- 조회 결과가 0건이면 "데이터가 없다"고 그대로 말합니다. 비슷한 날짜로 바꿔 답하지 않습니다.

[공장 도메인 규칙 — 반드시 지킬 것]
- 조업일: 07:00 ~ 익일 06:59. db_plan_raw.work_date 에는 이미 조업일로 변환되어 저장돼 있습니다. 그대로 쓰면 됩니다.
- 자재코드 앞자리: 1=원부재료, 5=부자재, 6=반제품(6104=분체), 2·3=완제품.
- 공정 흐름: 계량/배합 + 생육 → EP(압출·건조, 수분 증발) → 진공코터(오일·분체로 증량) 또는 오븐 → 포장.
- 포장 실적 = 포장 공정이 소비한 6번대 반제품 수량(actual_qty). MES 에 완제품 산출 행은 없습니다.
- 생산계획번호 앞 8자리는 '계획 발행일'이며 작업일이 아닙니다. 날짜 집계 기준으로 쓰면 안 됩니다. 반드시 work_date 를 쓰십시오.
- 당일 생산 귀속 기준은 'EP 를 돌린 날'입니다. 계량·분체는 전일에 미리 하는 경우가 많아, 원료 투입일로 잡으면 이중 집계가 됩니다.
  한 계획번호의 원료·포장을 당일 몫으로 볼 때는 (당일 EP 투입 ÷ 그 계획번호 EP 투입 전량) 비율을 곱합니다.
- 코터 산출 = 진공코터 공정 투입 자재 합(EP키블 + 분체 + 오일, 부자재 제외). 포장효율 = 포장 ÷ 코터 산출, 마무리되면 97~99%가 정상입니다.
- 오븐은 중간 계근 설비가 없어 산출을 알 수 없습니다. 오븐 제품은 원료 대비 최종수율(포장 ÷ 원료)로만 판단합니다.
- 최종수율 = 포장 ÷ 원료(1번대). 55% 이상이면 포장이 마무리된 것으로 봅니다. 보통 3~5일이면 도달합니다.
- EP 수율 정상 범위는 75~79%, 코터 달성률 70~90% 입니다.
- 팀은 '생산1팀','생산2팀','공통'. 생산2팀은 EP·코터·오븐 공정이 없습니다.
- t_plan_done 은 "더 포장하지 않는다"고 사람이 수동 종료한 계획번호입니다. 미포장 집계에서 제외합니다.
- 수량 단위는 kg 입니다. 1,000kg = 1t 으로 환산해 말해도 됩니다.
- t_cl_downtime: category 가 run=가동, plan=계획정지, unplan=비계획정지, sudden=돌발. start_time·end_time 은 'HH:MM' 문자열이며 종료가 시작보다 작으면 자정을 넘긴 것입니다.
- t_cl_defect=완제품 불량, t_cl_scrap=로스/스크랩 입니다.

[답변 형식]
- 표로 보여줄 자료는 run_sql 의 title 에 표 제목을 적습니다. 그 결과는 화면에 표로 자동 표시되고 엑셀로 받을 수 있습니다.
- 본문 답변에는 표를 다시 적지 말고, 다음을 3~6줄로 씁니다.
  1) 질문에 대한 직접적인 답(숫자 포함)
  2) 그 숫자가 의미하는 것 — 정상인지, 어디가 이상한지
  3) 이상치가 있으면 어떤 계획번호·품목·라인을 봐야 하는지
- 확실한 수치와 해석을 구분해서 말합니다. 추정이면 "추정"이라고 밝힙니다.
- 날짜가 없는 질문이면 가장 최근 데이터가 있는 날짜를 조회해서 쓰고, 어느 날짜를 썼는지 한 줄로 밝힙니다.`;

const TOOLS = [
  {
    name: 'run_sql',
    description: '읽기 전용 SQL(SELECT 또는 WITH)을 실행해 결과를 돌려준다. 결과는 사용자 화면에 표로 표시된다. 최대 2000행.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '화면에 표시할 표 제목 (예: 2026-09-21 미포장 계획번호)' },
        sql:   { type: 'string', description: 'SELECT 또는 WITH 로 시작하는 PostgreSQL 조회문. 세미콜론 없이 한 문장.' },
        show:  { type: 'boolean', description: '사용자 화면에 표로 보여줄지 여부. 중간 확인용 조회는 false.' }
      },
      required: ['title', 'sql']
    }
  },
  {
    name: 'get_schema',
    description: '주요 테이블의 컬럼 목록을 돌려준다. 컬럼명이 확실하지 않을 때 먼저 호출한다.',
    input_schema: { type: 'object', properties: {} }
  }
];

async function sbRpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt.slice(0, 400));
  try { return JSON.parse(txt); } catch (_) { return txt; }
}

function toTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return { head: [], rows: [] };
  const head = Object.keys(rows[0]);
  return { head, rows: rows.map(r => head.map(h => (r[h] === null || r[h] === undefined) ? '' : r[h])) };
}

module.exports = async (req, res) => {
  /* 연결 점검용 — 브라우저에서 /api/ask 를 그냥 열면 설치 상태를 알려준다. 키 값 자체는 내보내지 않는다. */
  if (req.method === 'GET') {
    res.status(200).json({
      ok: true,
      함수배포: true,
      ANTHROPIC_API_KEY: !!API_KEY,
      SUPABASE_URL: !!SB_URL,
      SUPABASE_ANON_KEY: !!SB_KEY,
      model: MODEL
    });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST 만 허용됩니다' }); return; }
  if (!API_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다' }); return; }
  if (!SB_KEY)  { res.status(500).json({ error: 'SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const question = String((body && body.q) || '').trim();
  const history  = Array.isArray(body && body.history) ? body.history.slice(-6) : [];
  const today    = String((body && body.today) || '');
  if (!question) { res.status(400).json({ error: '질문이 비어 있습니다' }); return; }

  const messages = [];
  history.forEach(h => {
    if (h && h.role && h.text) messages.push({ role: h.role === 'me' ? 'user' : 'assistant', content: String(h.text).slice(0, 2000) });
  });
  messages.push({ role: 'user', content: (today ? `(오늘 날짜: ${today})\n` : '') + question });

  const tables = [];
  const trace  = [];
  let answer = '';

  try {
    for (let turn = 0; turn < 8; turn++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL, max_tokens: 2000, system: SYSTEM, tools: TOOLS, messages
        })
      });
      if (!r.ok) {
        const t = await r.text();
        res.status(502).json({ error: 'AI 호출 실패: ' + t.slice(0, 300) });
        return;
      }
      const data = await r.json();
      const content = data.content || [];
      answer = content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || answer;

      const calls = content.filter(c => c.type === 'tool_use');
      if (!calls.length || data.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content });
      const results = [];
      for (const c of calls) {
        let out;
        try {
          if (c.name === 'get_schema') {
            out = await sbRpc('rpt_columns', {});
          } else {
            const sql = String((c.input && c.input.sql) || '');
            const title = String((c.input && c.input.title) || '조회 결과');
            const rows = await sbRpc('rpt_sql', { p_sql: sql, p_limit: 2000 });
            const t = toTable(rows);
            trace.push({ title, sql, count: t.rows.length });
            if (c.input.show !== false && t.rows.length) tables.push({ title, head: t.head, rows: t.rows });
            out = rows;
          }
          results.push({
            type: 'tool_result', tool_use_id: c.id,
            content: JSON.stringify(out).slice(0, 60000)
          });
        } catch (e) {
          results.push({
            type: 'tool_result', tool_use_id: c.id, is_error: true,
            content: '실행 실패: ' + String(e.message || e).slice(0, 400)
          });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    res.status(200).json({ answer: answer || '답변을 만들지 못했습니다.', tables, trace });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 400) });
  }
};

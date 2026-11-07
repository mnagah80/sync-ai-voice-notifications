'use strict';
// Customer-facing pages: Arabic, RTL, phone-first, no external resources.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171a;--muted:#5b6470;--line:#d9dde3;--accent:#0b6b5c;--accent-ink:#fff;--warn-bg:#fff6e0;--warn-ink:#6b4e00;--err:#b42318;--ok:#0b6b5c}
@media (prefers-color-scheme:dark){:root{--bg:#101315;--card:#1a1e21;--ink:#eef1f3;--muted:#a3acb6;--line:#2c3237;--accent:#3fbfa6;--accent-ink:#06211c;--warn-bg:#2d2511;--warn-ink:#f2d58a;--err:#ff8a80;--ok:#3fbfa6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
main{max-width:440px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:8px 0 4px}p{margin:6px 0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:16px}
label{display:block;font-weight:600;margin:14px 0 6px}input[type=text],input[type=tel]{width:100%;font:inherit;font-size:20px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);direction:ltr;text-align:center;letter-spacing:2px}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:14px;font-size:15px}.check input{width:22px;height:22px;margin-top:3px}
button{width:100%;margin-top:18px;font:inherit;font-weight:700;padding:14px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink)}
button:disabled{opacity:.5}.msg{min-height:24px;margin-top:12px;font-weight:600}.err{color:var(--err)}.ok{color:var(--ok)}
.note{background:var(--warn-bg);color:var(--warn-ink);border-radius:10px;padding:10px 12px;font-size:14px;margin-top:12px}
.steps{display:flex;gap:6px;margin-top:4px}.steps span{flex:1;height:4px;border-radius:2px;background:var(--line)}.steps span.on{background:var(--accent)}
.done{text-align:center;font-size:56px;line-height:1}.hidden{display:none}a{color:var(--accent)}
.call{border-bottom:1px solid var(--line);padding:12px 0}.call:last-child{border:0}.tag{font-size:13px;color:var(--muted)}
`;

function linkPage({ code, mock }) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ربط سينك</title><style>${STYLE}</style></head><body><main>
<h1>ربط هاتفك بإشعارات سينك</h1><p>سنتصل بك عندما ينتهي Claude من مهمة ونتحقق من نجاحها.</p>
<div class="steps"><span id="s1" class="on"></span><span id="s2"></span><span id="s3"></span></div>
${mock ? '<div class="note">وضع تجريبي: لا توجد مكالمات حقيقية. استخدم رقمًا تجريبيًا فقط من <b dir="ltr" style="white-space:nowrap">+1 202 555 0100</b> إلى <b dir="ltr" style="white-space:nowrap">+1 202 555 0199</b>.</div>' : ''}
<form id="f1" class="card" autocomplete="off">
  <label for="code">رمز الربط الظاهر في Claude</label>
  <input id="code" type="text" inputmode="text" maxlength="7" placeholder="ABC-123" value="${esc(code)}" required>
  <label for="phone">رقم هاتفك</label>
  <input id="phone" type="tel" inputmode="tel" placeholder="+1 202 555 0142" required>
  <label class="check"><input id="consent" type="checkbox" required><span>أوافق على استقبال مكالمات إشعار آلية على هذا الرقم، ويمكنني إيقافها في أي وقت بالضغط على 9 أثناء المكالمة.</span></label>
  <button id="b1" type="submit">اتصل بي للتحقق</button><div id="m1" class="msg" role="status"></div>
</form>
<form id="f2" class="card hidden" autocomplete="off">
  <p>اتصلنا بالرقم <b id="pm" dir="ltr"></b>. اكتب الرمز المكوّن من 4 أرقام الذي سمعته.</p>
  ${mock ? '<p class="tag">(تجريبي: المكالمة الوهمية تظهر في <a id="mocklink" target="_blank" href="/mock/phone">صفحة الهاتف التجريبي</a>)</p>' : ''}
  <label for="otp">رمز التحقق</label><input id="otp" type="text" inputmode="numeric" maxlength="4" placeholder="••••" required>
  <button id="b2" type="submit">تأكيد</button><div id="m2" class="msg" role="status"></div>
</form>
<div id="f3" class="card hidden"><div class="done">✓</div><h1 style="text-align:center">تم الربط</h1>
  <p style="text-align:center">يمكنك إغلاق هذه الصفحة. ستصلك مكالمة عند انتهاء مهمة ناجحة ومتحقق منها.</p>
  <p style="text-align:center" class="tag">للإيقاف: اضغط 9 أثناء أي مكالمة، أو اكتب <span dir="ltr">/sync-notify:pause</span> في Claude.</p></div>
</main><script>
const $=(i)=>document.getElementById(i);
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return {ok:r.ok,d:await r.json().catch(()=>({}))};}
function step(n){['s1','s2','s3'].forEach((s,i)=>$(s).classList.toggle('on',i<n));}
$('f1').onsubmit=async(e)=>{e.preventDefault();$('b1').disabled=true;$('m1').className='msg';$('m1').textContent='جارٍ الاتصال…';
  const r=await post('/link/start',{code:$('code').value,phone:$('phone').value,consent:$('consent').checked});$('b1').disabled=false;
  if(!r.ok){$('m1').className='msg err';$('m1').textContent=r.d.message||'حدث خطأ';return;}
  $('pm').textContent=r.d.phone_masked;const ml=$('mocklink');if(ml)ml.href='/mock/phone?to='+encodeURIComponent($('phone').value.replace(/[^+0-9]/g,''));
  $('f1').classList.add('hidden');$('f2').classList.remove('hidden');step(2);$('otp').focus();};
$('f2').onsubmit=async(e)=>{e.preventDefault();$('b2').disabled=true;
  const r=await post('/link/verify',{code:$('code').value,otp:$('otp').value});$('b2').disabled=false;
  if(!r.ok){$('m2').className='msg err';$('m2').textContent=r.d.message||'حدث خطأ';return;}
  $('f2').classList.add('hidden');$('f3').classList.remove('hidden');step(3);};
</script></body></html>`;
}

function mockPhonePage() {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>هاتف تجريبي</title><style>${STYLE}</style></head><body><main>
<h1>📱 هاتف تجريبي</h1><p>محاكاة: ما كانت ستقوله المكالمة الحقيقية. لا توجد أي مكالمة فعلية.</p>
<div class="note">رقم تجريبي: <b id="to" dir="ltr"></b></div><div id="list" class="card"><p>لا مكالمات بعد.</p></div>
</main><script>
const to=new URLSearchParams(location.search).get('to')||'';document.getElementById('to').textContent=to;
async function load(){const r=await fetch('/mock/calls?to='+encodeURIComponent(to));const d=await r.json();if(!d.calls||!d.calls.length)return;
  const l=document.getElementById('list');l.textContent='';
  for(const c of d.calls.slice().reverse()){const el=document.createElement('div');el.className='call';
    const h=document.createElement('div');h.className='tag';h.textContent=(c.purpose==='verify'?'مكالمة تحقق':'مكالمة إشعار — أحداث: '+c.event_count)+' — '+new Date(c.created_at*1000).toLocaleTimeString('ar-EG');
    const m=document.createElement('div');m.append('🔊 ');
    for(const part of c.message.split(/(\d(?: \d){3})/)){if(/^\d( \d){3}$/.test(part)){const b=document.createElement('b');b.dir='ltr';b.style.unicodeBidi='isolate';b.textContent=part;m.append(b);}else m.append(part);}
    el.append(h,m);l.append(el);}}
load();setInterval(load,2000);
</script></body></html>`;
}
module.exports = { linkPage, mockPhonePage };

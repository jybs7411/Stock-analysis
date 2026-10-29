#!/usr/bin/env python3
"""규칙 엔진(index.html 의 mod-rules / window.RuleEngine) 골든 파일 생성기.

기존 스케줄 작업의 Python 규칙(features.py feat·score, insight.py dleft·verdict)을 '있는 그대로' 아래 ORACLE 구역에 복사해 두고,
같은 입력으로 돌린 결과를 tools/rules-golden.json 에 저장한다. tools/test-rules.mjs 가 JS 엔진이 이 결과와 같은지 대조한다.
- 규칙을 일부러 바꿀 때: JS 의 CFG/로직을 고친 뒤 이 파일의 기대값 로직(또는 ORACLE)도 같은 의도로 고치고 골든을 다시 만든다.
- 사용법: python3 tools/gen-rules-golden.py   (결정론적 — 같은 결과가 나와야 한다)
"""
import json,math,os,datetime

# ---------------- ORACLE (기존 Python 규칙 원문, 2026-10-29 시점) ----------------
L={'quotes':{}};D={'quotes':{}};EV={'earn':{}};today=datetime.date(2026,10,29);yr=today.year
def sma(a,n): return sum(a[-n:])/n if len(a)>=n else None

def feat(s):
    q=L['quotes'].get(s) or {};d=D['quotes'].get(s) or {}
    o=d.get('ohlcv') or {};t=d.get('tech') or {};f=d.get('fund') or {}
    P=q.get('price')
    out={'s':s,'name':q.get('name') or '','price':P,'chg':q.get('chgPct'),'sector':d.get('sector') or ''}
    out.update({k:t.get(k) for k in ('rsi','sma20Pct','sma50Pct','sma200Pct','atrPct','fromHigh52','fromLow52','relVol','perf1w','perf1m','perf3m','perf6m','perf1y')})
    out.update({'pe':f.get('pe'),'peg':f.get('peg'),'roe':f.get('roe'),'mcap':f.get('marketCapVal'),'cons':f.get('consensus')})
    c=o.get('c') or [];lo=o.get('l') or [];hi=o.get('h') or []
    if len(c)>=60 and P:
        s20,s50,s200=sma(c,20),sma(c,50),sma(c,200)
        out['sma20'],out['sma50'],out['sma200']=[round(x,2) if x else None for x in (s20,s50,s200)]
        out['low20']=round(min(lo[-20:]),2);out['low60']=round(min(lo[-60:]),2);out['high52']=round(max(hi[-252:]),2)
        atr=(out.get('atrPct') or 2.5)/100*P
        sup=[v for v in (out['sma20'],out['sma50'],out['sma200'],out['low20'],out['low60']) if v and v<P*0.995]
        out['support']=round(max(sup),2) if sup else None
        out['buy']=round(out['support']*1.01,2) if out['support'] else None
        out['stop']=round((out['support']-1.5*atr),2) if out['support'] else None
        out['sell']=round(min(out['high52'],P*1.15),2)
        out['bars']=len(c)
    return out

def score(x):
    s=0;why=[]
    p200,p50,rsi=x.get('sma200Pct'),x.get('sma50Pct'),x.get('rsi')
    if p200 is not None: s+=2 if p200>0 else -2
    if p50 is not None: s+=1 if p50>0 else -1
    if (x.get('perf3m') or 0)>0: s+=1
    if rsi is not None:
        if rsi>=75: s-=2
        elif rsi>=70: s-=1
        elif rsi<=30 and (p200 or 0)>0: s+=1
    if (x.get('sma20Pct') or 0)<=-4 and (p200 or -1)>0: s+=2
    peg=x.get('peg');pe=x.get('pe')
    if peg and 0<peg<1.5: s+=1
    if pe and pe>45: s-=1
    cons=str(x.get('cons') or '').upper()
    if 'BUY' in cons: s+=1
    if 'SELL' in cons: s-=1
    return s

def dleft(s):
    e=EV['earn'].get(s)
    if not e: return None
    m,d=e[0].split('~')[0].split('/');return (datetime.date(yr,int(m),int(d))-today).days

def verdict(x):
    d=dleft(x['s']);sc=x['score'];rsi=x.get('rsi')
    if x.get('price') is None: return 'hold','데이터 없음'
    if sc<=-2: return 'sell','추세 약함'
    if sc>=4 and (rsi is None or rsi<70):
        if d is not None and 0<=d<=3: return 'hold','실적 임박'
        sp=x.get('support');dist=(x['price']/sp-1)*100 if sp else None
        if sc>=5 and dist is not None and dist<=4: return 'buy',''
        return 'hold','추격 보류'
    return 'hold',''
# ---------------- ORACLE 끝 ----------------

M32=0xFFFFFFFF
def mulberry32(a):
    st=[a&M32]
    def rnd():
        st[0]=(st[0]+0x6D2B79F5)&M32
        a=st[0]
        t=((a^(a>>15))*(1|a))&M32
        t=(((t+(((t^(t>>7))*(61|t))&M32))&M32)^t)&M32
        return ((t^(t>>14))&M32)/4294967296
    return rnd

def gen_hist(seed,n,vol,start):
    rnd=mulberry32(seed);c=start;out=[]
    for _ in range(n):
        step=math.floor((rnd()-0.5)*2*vol)
        c=max(100,c+step)
        h=c+math.floor(rnd()*80)
        l=max(50,c-math.floor(rnd()*80))
        out.append((c/100,h/100,l/100))
    return out

def pick(r,xs): return xs[math.floor(r()*len(xs))]
def rf(r,lo,hi,dec=1):
    k=10**dec;return math.floor((lo+r()*(hi-lo))*k)/k
def mixed(r,special,lo,hi,dec=1):
    return pick(r,special) if r()<0.5 else rf(r,lo,hi,dec)

def make_case(i):
    seed=1000+i;r=mulberry32(777000+i)
    n=pick(r,[40,59,60,61,90,130,199,200,260,400]);vol=50+math.floor(r()*200);start=2000+math.floor(r()*30000)
    hist=gen_hist(seed,n,vol,start);lastc=round(hist[-1][0]*100)
    pm=math.floor(r()*4)
    if pm==2: price=None
    elif pm==3: price=math.floor(lastc*(950+math.floor(r()*100))/1000)/100
    else: price=hist[-1][0]
    x={'price':price,
       'rsi':mixed(r,[None,0,29.9,30,31,55,69.99,70,74.99,75,90],10,90),
       'sma20Pct':mixed(r,[None,-4,-3.99,-4.01,0,5],-15,10),
       'sma50Pct':mixed(r,[None,0,3,-3],-20,20),
       'sma200Pct':mixed(r,[None,0,2,-2],-30,40),
       'perf3m':mixed(r,[None,0,0.1,-0.1],-20,40),
       'atrPct':mixed(r,[None,0,1,2.5,4],0.5,6),
       'pe':pick(r,[None,0,10,45,45.01,60,None]) if r()<0.5 else rf(r,5,80),
       'peg':pick(r,[None,0,-1,0.5,1.49,1.5,2]) if r()<0.5 else rf(r,0.1,3,2),
       'consensus':pick(r,[None,'','STRONG BUY','BUY','HOLD','UNDERPERFORM','SELL'])}
    capB=pick(r,[None,10,24.9,25,100])
    off=pick(r,[None,-3,-1,0,1,3,4,5,6,10])
    nextE=None if off is None else (today+datetime.timedelta(days=off)).isoformat()
    return {'seed':seed,'n':n,'vol':vol,'start':start,'x':x,'capB':capB,'nextEarnings':nextE,'today':today.isoformat()},hist

def run_oracle(case,hist):
    x=case['x'];s='T'
    L['quotes'][s]={'price':x['price'],'name':'T','chgPct':0}
    t={k:x[k] for k in ('rsi','sma20Pct','sma50Pct','sma200Pct','perf3m','atrPct')}
    D['quotes'][s]={'ohlcv':{'c':[b[0] for b in hist],'h':[b[1] for b in hist],'l':[b[2] for b in hist]},'tech':t,
                    'fund':{'pe':x['pe'],'peg':x['peg'],'consensus':x['consensus'],'marketCapVal':case['capB']}}
    f=feat(s);f['score']=score(f)
    if case['nextEarnings']: EV['earn'][s]=[case['nextEarnings'][5:7]+'/'+case['nextEarnings'][8:10],'','확인']
    else: EV['earn'].pop(s,None)
    f['s']=s;v,why=verdict(f)
    d=dleft(s)
    P=f.get('price');sup=f.get('support')
    near=bool(sup and P and (P/sup-1)*100<=3)
    ok=f['score']>=4 and (d is None or d>5 or d<0) and (f.get('rsi') or 50)>=30
    ap='approach' if ok and near else ('wait_support' if ok else 'hold_wait')
    cand=bool(x['sma20Pct'] is not None and x['sma20Pct']<=-4 and (case['capB'] or 0)>=25)
    lv={k:f.get(k) for k in ('support','buy','stop','sell','sma20','sma50','sma200','low20','low60')}
    lv['high52']=f.get('high52') if 'high52' in f else None
    return {'score':f['score'],'verdict':v,'reason':{'데이터 없음':'no_data','추세 약함':'weak_trend','실적 임박':'earnings_near','추격 보류':'chase_hold','':''}[why],
            'levels':lv if 'bars' in f else None,'days':d,'pbCandidate':cand,'pbAction':ap}


def boundary_cases():
    """판정·눌림목 경계값(점수·RSI·지지선 거리·실적까지 일수)을 격자로 점검 — 난수 케이스가 경계를 못 건드리는 부분을 메운다."""
    vc=[];pc=[]
    def setearn(days):
        if days is None: EV['earn'].pop('T',None)
        else:
            dt=today+datetime.timedelta(days=days);EV['earn']['T']=[dt.strftime('%m/%d'),'','확인']
    def px(dist): return (None,100.0) if dist is None else (100.0,100.0*(1+dist/100))
    for sc in (-3,-2,-1,3,4,5,6):
        for rsi in (None,69.9,70):
            for dist in (None,3.9,4.0,4.1):
                for days in (None,-1,0,3,4,5,6):
                    sup,price=px(dist);setearn(days)
                    v,why=verdict({'s':'T','price':price,'score':sc,'rsi':rsi,'support':sup})
                    reason={'데이터 없음':'no_data','추세 약함':'weak_trend','실적 임박':'earnings_near','추격 보류':'chase_hold','':''}[why]
                    vc.append({'x':{'price':price,'rsi':rsi},'score':sc,'support':sup,'days':days,'verdict':v,'reason':reason})
    for sc in (3,4,5):
        for rsi in (None,29.9,30):
            for dist in (None,2.9,3.0,3.1):
                for days in (None,-1,0,5,6):
                    sup,price=px(dist);setearn(days);d=dleft('T') if days is not None else None
                    near=bool(sup and price and (price/sup-1)*100<=3)
                    ok=sc>=4 and (d is None or d>5 or d<0) and (rsi or 50)>=30
                    ap='approach' if ok and near else ('wait_support' if ok else 'hold_wait')
                    pc.append({'x':{'price':price,'rsi':rsi},'score':sc,'support':sup,'days':d,'action':ap})
    EV['earn'].pop('T',None)
    return vc,pc

def main():
    cases=[]
    for i in range(240):
        c,h=make_case(i);c['expect']=run_oracle(c,h);cases.append(c)
    out=os.path.join(os.path.dirname(os.path.abspath(__file__)),'rules-golden.json')
    vc,pc=boundary_cases()
    json.dump({'about':'tools/gen-rules-golden.py 가 만든 골든 파일. 직접 고치지 말 것.','cases':cases,'verdictCases':vc,'pullbackCases':pc},open(out,'w'),ensure_ascii=False,separators=(',',':'))
    from collections import Counter
    print('verdictCases',len(vc),'pullbackCases',len(pc),'cases',len(cases),Counter(c['expect']['verdict'] for c in cases),Counter(c['expect']['pbAction'] for c in cases),'levels',sum(1 for c in cases if c['expect']['levels']))
main()

#!/usr/bin/env python3
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from curl_cffi import requests
except Exception as e:
    print(json.dumps({'ok': False, 'error': f'curl_cffi unavailable: {e}'}))
    sys.exit(0)

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
APP_ID = '936619743392459'
DEFAULT_DOCS = ['27128499623469141']

def csrf_from_cookies(s):
    return s.cookies.get('csrftoken', '') or ''

def lsd_from_html(text):
    pats = [r'name=["\']lsd["\'][^>]+value=["\']([^"\']+)', r'["\']LSD["\']\s*:\s*["\']([^"\']+)', r'"lsd"\s*:\s*\{"token"\s*:\s*"([^"]+)"']
    for p in pats:
        m = re.search(p, text or '', re.I)
        if m: return m.group(1)
    return ''

def normalize_url(u):
    if not u: return None
    return str(u).replace('\\/', '/').replace('\\u0026','&').replace('\\u003d','=').replace('\\u0025','%')

def best_image(node):
    cand = []
    for c in ((node or {}).get('image_versions2') or {}).get('candidates') or []:
        u = normalize_url(c.get('url'))
        if u:
            cand.append((int(c.get('width') or 0)*int(c.get('height') or 0), u))
    for c in (node or {}).get('image_versions', {}).get('candidates', []) or []:
        u = normalize_url(c.get('url'))
        if u:
            cand.append((int(c.get('width') or 0)*int(c.get('height') or 0), u))
    u = normalize_url((node or {}).get('display_url'))
    if u: cand.append((0,u))
    return max(cand, default=(0,None))[1]

def graphql(shortcode, doc_id, session, lsd, csrf, relay=True):
    variables = {'shortcode': shortcode}
    if relay:
        variables['__relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider'] = False
    data = {'doc_id': doc_id, 'variables': json.dumps(variables, separators=(',', ':'))}
    headers = {
        'User-Agent': UA, 'Accept': '*/*', 'Origin': 'https://www.instagram.com',
        'Referer': f'https://www.instagram.com/p/{shortcode}/',
        'X-IG-App-ID': APP_ID, 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
    }
    if lsd: headers['X-FB-LSD'] = lsd
    r = session.post('https://www.instagram.com/graphql/query', data=data, headers=headers, timeout=18)
    try: j = r.json()
    except Exception: j = {}
    return r.status_code, j

def extract(shortcode):
    s = requests.Session(impersonate='chrome')
    home_headers = {'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language':'en-US,en;q=0.9'}
    try:
        home = s.get('https://www.instagram.com/', headers=home_headers, timeout=15)
        csrf = csrf_from_cookies(s)
        lsd = lsd_from_html(home.text)
        if not csrf:
            # Some responses set csrftoken in a second navigation.
            home = s.get('https://www.instagram.com/accounts/login/', headers=home_headers, timeout=12)
            csrf = csrf_from_cookies(s)
            lsd = lsd or lsd_from_html(home.text)
        docs = []
        env = os.getenv('INSTAGRAM_GRAPHQL_DOC_IDS','')
        for x in env.split(',') + DEFAULT_DOCS:
            x=x.strip()
            if x and x not in docs: docs.append(x)
        errors=[]
        for doc in docs:
            for relay in (True, False):
                try:
                    status, j = graphql(shortcode, doc, s, lsd, csrf, relay)
                    web = ((j.get('data') or {}).get('xdt_api__v1__media__shortcode__web_info') or {})
                    items = web.get('items') or []
                    if items:
                        item = items[0]
                        nodes = list(item.get('carousel_media') or []) if (item.get('media_type') == 8 or item.get('carousel_media')) else [item]
                        result=[]
                        for n in nodes:
                            media_type=int(n.get('media_type') or 0)
                            if media_type == 2 or n.get('video_versions'):
                                # Photo-only downloader: don't turn a video cover into a fake photo.
                                continue
                            u=best_image(n)
                            if u and u not in result: result.append(u)
                        username=((item.get('user') or {}).get('username') or (item.get('owner') or {}).get('username') or '')
                        caption=((item.get('caption') or {}).get('text') or ((item.get('caption') or {}).get('body') or {}).get('text') or '')
                        title=(caption[:100] if caption else (f'Instagram post by @{username}' if username else 'Instagram post'))
                        return {'ok': bool(result), 'images': result, 'title': title, 'uploader': username, 'count': len(result), 'doc_id': doc, 'http_status': status}
                    errors.append(f'doc={doc} relay={relay} status={status} error={str(j.get("errors") or "")[:250]}')
                except Exception as e:
                    errors.append(f'doc={doc} relay={relay}: {e}')
        return {'ok':False,'images':[],'error':' | '.join(errors)[-1200:] or 'Instagram returned no public media metadata.'}
    except Exception as e:
        return {'ok':False,'images':[],'error':str(e)}

def download_images(payload):
    urls=payload.get('urls') or []
    outdir=payload.get('outdir')
    referer=payload.get('referer') or 'https://www.instagram.com/'
    if not urls or not outdir: return {'ok':False,'error':'No image URLs supplied.'}
    os.makedirs(outdir, exist_ok=True)
    def one(item):
        i,u=item
        last=''
        for attempt in range(3):
            try:
                s=requests.Session(impersonate='chrome')
                h={'User-Agent':UA,'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8','Referer':referer}
                r=s.get(u,headers=h,timeout=25)
                if r.status_code != 200:
                    last=f'HTTP {r.status_code}'; continue
                ctype=(r.headers.get('content-type') or '').split(';')[0].lower()
                data=r.content
                if not ctype.startswith('image/') or len(data)<1000:
                    last=f'bad response {ctype} {len(data)}'; continue
                ext='jpg'
                if ctype=='image/png': ext='png'
                elif ctype=='image/webp': ext='webp'
                elif ctype=='image/gif': ext='gif'
                fn=os.path.join(outdir,f'{i+1:02d}.{ext}')
                with open(fn,'wb') as f: f.write(data)
                return fn
            except Exception as e: last=str(e)
            time.sleep(.4)
        raise RuntimeError(f'image {i+1}: {last}')
    files=[]; errors=[]
    with ThreadPoolExecutor(max_workers=min(6,len(urls))) as ex:
        futs=[ex.submit(one,(i,u)) for i,u in enumerate(urls)]
        for f in as_completed(futs):
            try: files.append(f.result())
            except Exception as e: errors.append(str(e))
    files.sort()
    return {'ok':len(files)==len(urls),'files':files,'errors':errors}

def main():
    mode=sys.argv[1] if len(sys.argv)>1 else ''
    try: payload=json.load(sys.stdin)
    except Exception: payload={}
    if mode=='extract':
        print(json.dumps(extract(payload.get('shortcode','')), ensure_ascii=False))
    elif mode=='download':
        print(json.dumps(download_images(payload), ensure_ascii=False))
    else:
        print(json.dumps({'ok':False,'error':'unknown mode'}))

if __name__=='__main__': main()

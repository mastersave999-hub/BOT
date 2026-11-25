import urllib.request
import re

req = urllib.request.Request('https://bottcg.com/cards', headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as res:
    html = res.read().decode('utf-8')

scripts = re.findall(r'src="([^"]+\.js)"', html)
print('Found scripts:', scripts)

for s in scripts:
    url = s if s.startswith('http') else f'https://bottcg.com{s}'
    try:
        s_req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(s_req) as s_res:
            content = s_res.read().decode('utf-8', errors='ignore')
            if 'cdn.bottcg.com' in content:
                print('Found cdn.bottcg.com in:', url)
                # find context around cdn.bottcg.com
                for match in re.finditer(r'cdn\.bottcg\.com/cards', content):
                    start = max(0, match.start() - 100)
                    end = min(len(content), match.end() + 200)
                    print('Snippet:', content[start:end])
    except Exception as e:
        print('Error fetching script', url, e)

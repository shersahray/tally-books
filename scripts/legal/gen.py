# Builds public/legal/*.html from content.py (English and French). Run: python3 scripts/legal/gen.py
import html,re,os
OUT='/home/claude/tally-books/public/legal'
CO='[Corporation name] inc.'; NAME='[Your full name]'; EMAIL='shersahray@outlook.com'; ADDR='[mailing address]'
def inline(t):
    t=t.replace('« ','«\u00a0').replace(' »','\u00a0»').replace(' :','\u00a0:').replace(' ;','\u00a0;')
    t=html.escape(t,quote=False)
    t=re.sub(r'\*\*(.+?)\*\*',r'<b>\1</b>',t)
    t=re.sub(r'\[\[(.+?)\|(.+?)\]\]',r'<a href="\2">\1</a>',t)
    return t
def render(blocks):
    o=[]
    for b in blocks:
        k=b[0]
        if k=='h2':o.append(f'<h2>{inline(b[1])}</h2>')
        elif k=='p':o.append(f'<p>{inline(b[1])}</p>')
        elif k=='ul':o.append('<ul>'+''.join(f'<li>{inline(x)}</li>' for x in b[1])+'</ul>')
        elif k=='table':
            head,rows=b[1],b[2]
            o.append('<div class="tbl"><table><thead><tr>'+''.join(f'<th>{inline(h)}</th>' for h in head)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{inline(c)}</td>' for c in r)+'</tr>' for r in rows)+'</tbody></table></div>')
    return '\n'.join(o)
UI={'en':{'terms':'Terms of service','privacy':'Privacy policy','dpa':'Data agreement for firms','other':'Français','draft':'<b>Draft.</b> These documents are still being reviewed and may change. You’ll be asked to agree again when the final version is published.','eff':'Effective date: [date]','lang':'en','foot':f'Questions? Write to {EMAIL}.'},
    'fr':{'terms':'Conditions d’utilisation','privacy':'Politique de confidentialité','dpa':'Entente sur les données pour les cabinets','other':'English','draft':'<b>Version provisoire.</b> Ces documents sont en cours de révision et pourraient changer. On vous demandera de les accepter de nouveau quand la version définitive sera publiée.','eff':'Date d’entrée en vigueur : [date]','lang':'fr','foot':f'Des questions? Écrivez à {EMAIL}.'}}
FILES={'terms':'terms','privacy':'privacy','dpa':'data-agreement'}
def page(lang,key,blocks):
    u=UI[lang];suf='-fr' if lang=='fr' else ''
    other='' if lang=='fr' else '-fr'
    nav=''.join(f'<a href="{FILES[k]}{suf}.html">{u[k]}</a>' for k in FILES if k!=key)+f'<a href="{FILES[key]}{other}.html" lang="{"en" if lang=="fr" else "fr"}">{u["other"]}</a>'
    return f'''<!doctype html>
<html lang="{u['lang']}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{u[key]} · Sumlora</title><link rel="stylesheet" href="legal.css"></head>
<body><main><header><b>Sumlora</b><nav>{nav}</nav></header>
<h1>{u[key]}</h1><div class="muted">{u['eff']}</div>
<div class="draft">{u['draft']}</div>
{render(blocks)}
<footer>{CO} · {u['foot']}</footer></main></body></html>
'''
import sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from content import DOCS
for lang in ('en','fr'):
    for key in FILES:
        open(os.path.join(OUT,FILES[key]+('-fr' if lang=='fr' else '')+'.html'),'w').write(page(lang,key,DOCS[lang][key]))
print('written')

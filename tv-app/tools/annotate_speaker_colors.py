"""Measure visible subtitle speaker-name colours from existing source crops.

Colours belong to individual labelled lines, not character identities. Original
dialogue strings and lookup hashes are never changed by this tool.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata

import cv2
import numpy as np
from PIL import ImageFont

cv2.setNumThreads(1)
HEADER = re.compile(r"^([A-Za-zÀ-ž][A-Za-zÀ-ž0-9 &$.'’\-]{0,28}):[ \t]*(?=[^ \t\r\n])")
FONT = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 32)

def norm(value):
    value=unicodedata.normalize('NFD',value.lower())
    return ''.join(c for c in value if c.isalnum() and not unicodedata.combining(c))

@lru_cache(maxsize=40000)
def text_width(text):
    return FONT.getlength(text)

def colour_name(rgb):
    hsv=cv2.cvtColor(np.uint8([[rgb]]),cv2.COLOR_RGB2HSV)[0,0]
    h,s,v=map(int,hsv)
    if s<30:return 'Beyaz' if v>=200 else 'Gri'
    if h<8 or h>=173:return 'Pembe' if min(rgb)>120 else 'Kırmızı'
    if h<20:return 'Turuncu / şeftali'
    if h<40:return 'Sarı'
    if h<78:return 'Açık yeşil' if v>=190 else 'Yeşil'
    if h<86:return 'Nane yeşili'
    if h<104:return 'Turkuaz / açık mavi'
    if h<130:return 'Mavi'
    if h<160:return 'Mor / lila'
    return 'Pembe'

def measure(image,line,name):
    bounds=np.array(line['bounds'],dtype=float)
    if bounds.ndim==1:x0,y0,x1,y1=bounds
    else:x0,y0=bounds.min(axis=0);x1,y1=bounds.max(axis=0)
    raw=line['raw'];prefix=raw.split(':',1)[0]+':'
    fraction=text_width(prefix)/max(text_width(raw),1)
    # Stay inside the name; the white dialogue begins after its colon.
    end=x0+(x1-x0)*min(1,fraction)*.91
    h,w=image.shape[:2]
    box=[max(0,int(x0)-2),max(0,int(y0)-3),min(w,int(end)+1),min(h,int(y1)+4)]
    x0,y0,x1,y1=box
    if x1-x0<4 or y1-y0<5:return dict(status='unresolved',reason='Name region is too small',bbox=box)
    crop=image[y0:y1,x0:x1];hsv=cv2.cvtColor(crop,cv2.COLOR_RGB2HSV)
    black=(crop.max(axis=2)<105).astype(np.uint8)
    outlined=cv2.dilate(black,np.ones((5,5),np.uint8))>0
    # Letter fills are holes enclosed by their black outlines. This excludes
    # coloured scenery immediately outside the same outlines (skin, sand, etc).
    enclosed=np.zeros(black.shape,np.uint8)
    contours,hierarchy=cv2.findContours(black,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is not None:
        for i,contour in enumerate(contours):
            xx,yy,ww,hh=cv2.boundingRect(contour)
            if hierarchy[0,i,3]>=0 and 3<=hh<=crop.shape[0] and ww<crop.shape[0]*1.3 and cv2.contourArea(contour)>=4:
                cv2.drawContours(enclosed,[contour],-1,1,-1)
    mask=(hsv[:,:,1]>42)&(hsv[:,:,2]>125)&outlined&(enclosed>0)
    # Reject large coloured scenery blobs inside the OCR rectangle.
    n,components,stats,_=cv2.connectedComponentsWithStats(mask.astype(np.uint8),8)
    accepted=[]
    for i in range(1,n):
        xx,yy,ww,hh,area=stats[i]
        if area>=3 and hh>=max(2,crop.shape[0]*.12) and ww<crop.shape[0]*1.6:
            accepted.append(i)
    mask &=np.isin(components,accepted)
    pixels=crop[mask];hues=hsv[:,:,0][mask]
    if len(pixels)<12:
        # Some visible labels are achromatic. Do not borrow the colour from
        # another scene or infer a character's usual colour.
        neutral=(hsv[:,:,1]<30)&(hsv[:,:,2]>150)&outlined&(enclosed>0)
        pixels=crop[neutral]
        if len(pixels)<18:return dict(status='unresolved',reason='Insufficient outlined name-colour pixels',bbox=box)
        rgb=np.median(pixels,axis=0).astype(int).tolist()
        return dict(status='measured',name_tr=colour_name(rgb),hex='#'+''.join(f'{v:02X}' for v in rgb),confidence='medium',bbox=box,sample_pixels=len(pixels),achromatic=True)
    counts=np.bincount(hues//6,minlength=30)
    peak=int(np.argmax(counts))*6+3
    distance=np.minimum(abs(hues.astype(int)-peak),180-abs(hues.astype(int)-peak))
    chosen=pixels[distance<=9]
    purity=len(chosen)/len(pixels)
    if len(chosen)<12 or purity<.45:return dict(status='unresolved',reason='Multiple competing colours in name region',bbox=box)
    # Use brighter glyph cores rather than dark anti-aliasing/black outlines.
    bright=chosen.max(axis=1);chosen=chosen[bright>=np.percentile(bright,55)]
    rgb=np.median(chosen,axis=0).astype(int).tolist()
    return dict(status='measured',name_tr=colour_name(rgb),hex='#'+''.join(f'{v:02X}' for v in rgb),confidence='high' if purity>.8 and len(chosen)>=25 else 'medium',bbox=box,sample_pixels=len(chosen),hue_purity=round(purity,3))

def process(job):
    folder,row,sources=job
    known={x['source'] for x in row.get('speaker_labels',[])}
    occurrences=[]
    for index,text in enumerate(row['english'].splitlines()):
        match=HEADER.match(text)
        if match and match[1] in known:occurrences.append((index,match[1],text))
    if not occurrences:return dict(id=row['id'],occurrences=[])
    path=folder/row['source_frame']
    image=cv2.imread(str(path))
    if image is None:raise FileNotFoundError(path)
    image=cv2.cvtColor(image,cv2.COLOR_BGR2RGB)
    source=next((s for s in sources if s.get('source_frame')==row['source_frame']),None)
    if source is None:
        original_bytes=path.read_bytes()
        source=next((s for s in sources if (folder/s.get('source_frame','')).is_file()
                     and (folder/s['source_frame']).read_bytes()==original_bytes),None)
    lines=source.get('lines',[]) if source else []
    used=set();output=[]
    for index,name,text in occurrences:
        best=None
        for number,line in enumerate(lines):
            if number in used or not line.get('bounds') or ':' not in line.get('raw',''):continue
            prefix=line['raw'].split(':',1)[0].strip()
            similarity=SequenceMatcher(None,norm(prefix),norm(name)).ratio()
            if similarity<.72:continue
            score=similarity+SequenceMatcher(None,norm(line['raw']),norm(text)).ratio()
            if best is None or score>best[0]:best=(score,number,line)
        base=dict(line_index=index,source=name,source_frame=row['source_frame'])
        if best:
            _,number,line=best;used.add(number);base.update(measure(image,line,name));base['ocr_line_index']=number
        else:base.update(status='unresolved',reason='No matching name OCR box in the same native source frame')
        output.append(base)
    return dict(id=row['id'],occurrences=output)

def annotate(folder,workers=6):
    doc=json.loads((folder/'dialogues.json').read_text(encoding='utf8'))
    sources={}
    for filename in ['ocr-candidates.jsonl','ocr-recovered.jsonl','ocr-continuous.jsonl']:
        path=folder/filename
        if path.exists():
            for text in path.read_text(encoding='utf8').splitlines():
                row=json.loads(text);sources.setdefault(row['id'],[]).insert(0,row)
    jobs=((folder,row,sources.get(row['id'],[])) for row in doc['entries'])
    with ThreadPoolExecutor(max_workers=workers) as pool:rows=list(pool.map(process,jobs))
    occurrences=[item for row in rows for item in row['occurrences']]
    overrides_path=folder/'speaker-color-overrides.json'
    overrides=json.loads(overrides_path.read_text(encoding='utf8')) if overrides_path.exists() else {}
    for row in rows:
        for item in row['occurrences']:
            key=str(item['line_index'])
            if key in overrides.get(row['id'],{}):
                item.update(overrides[row['id']][key])
    occurrences=[item for row in rows for item in row['occurrences']]
    measured=sum(item['status']=='measured' for item in occurrences)
    identified=sum(item['status']!='unresolved' for item in occurrences)
    report=dict(format=1,method='Existing native source pixels inside matched speaker-name OCR bounds; estimated video colour, not an authoritative game palette. Explicit visual overrides may identify a colour family without guessing a hex value.',speaker_identity_policy='Colours belong to each visible labelled line. A name or generic role can have multiple colours, including in the same frame.',records=len(rows),label_occurrences=len(occurrences),measured=measured,visually_identified=identified-measured,unresolved=len(occurrences)-identified,entries=rows)
    (folder/'speaker-colors.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(dict(part=folder.name,labels=len(occurrences),measured=measured,visually_identified=identified-measured,unresolved=len(occurrences)-identified)),flush=True)
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('folders',type=Path,nargs='+');parser.add_argument('--workers',type=int,default=6)
    args=parser.parse_args()
    for folder in args.folders:annotate(folder,args.workers)

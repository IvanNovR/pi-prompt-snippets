#!/usr/bin/env python3
"""Actual Pi PTY in isolated tmux; export terminal-emulated cells, then rasterize."""
import asyncio, hashlib, json, os, re, shlex, shutil, subprocess, unicodedata
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/assets/capture-output'
COLS, ROWS, CW, CH = 110, 30, 10, 20
SOCKET = 'pi-snippets-capture-' + str(os.getpid())
DISCOVERY_PATH = str(Path.home()/'.pi/agent/bin') + os.pathsep + os.environ['PATH']
TOOL_VERSIONS = {tool: subprocess.check_output([tool, '--version'], env={**os.environ, 'PATH': DISCOVERY_PATH}, text=True).splitlines()[0] for tool in ['fd','rg']}
FONT = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16)
BOLD = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16, index=1)
# Explicit xterm terminal-emulator fixture defaults; not a Pi custom theme.
BG, FG = '#000000', '#e5e5e5'
frames = []
def tmux(*args):
    return subprocess.check_output(['tmux', '-L', SOCKET, '-f', '/dev/null', *args], text=True)
def raster(ansi, destination):
    image = Image.new('RGB', (COLS*CW, ROWS*CH), BG)
    draw = ImageDraw.Draw(image)
    palette = ['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5','#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff']
    def color(n):
        if n < 16: return palette[n]
        if n >= 232: return (8+10*(n-232),)*3
        n -= 16; v=[0,95,135,175,215,255]; return (v[n//36],v[n//6%6],v[n%6])
    fg,bg,bold,inverse,dim = FG,BG,False,False,False
    for y,line in enumerate(ansi.splitlines()):
        assert y < ROWS
        x = 0
        for part in re.split(r'(\x1b\[[0-9;]*m)',line):
            if part.startswith('\x1b'):
                codes = list(map(int, part[2:-1].split(';'))) if part[2:-1] else [0]
                i=0
                while i<len(codes):
                    c=codes[i]
                    if c==0: fg,bg,bold,inverse,dim=FG,BG,False,False,False
                    elif c==1: bold=True
                    elif c==2: dim=True
                    elif c==22: bold,dim=False,False
                    elif c==7: inverse=True
                    elif c==27: inverse=False
                    elif c==39: fg=FG
                    elif c==49: bg=BG
                    elif 30<=c<=37: fg=color(c-30)
                    elif 90<=c<=97: fg=color(c-90+8)
                    elif 40<=c<=47: bg=color(c-40)
                    elif 100<=c<=107: bg=color(c-100+8)
                    elif c in (38,48):
                        if codes[i+1]==2: v=tuple(codes[i+2:i+5]); i+=4
                        elif codes[i+1]==5: v=color(codes[i+2]); i+=2
                        else: raise AssertionError(part)
                        if c==38: fg=v
                        else: bg=v
                    else: raise AssertionError('Unsupported cell attribute '+str(c))
                    i+=1
            else:
                assert '\x1b' not in part
                for char in part:
                    width=0 if unicodedata.combining(char) else 2 if unicodedata.east_asian_width(char) in ('W','F') else 1
                    ink,paper=(bg,fg) if inverse else (fg,bg)
                    if dim:
                        def rgb(c): return tuple(bytes.fromhex(c[1:])) if isinstance(c,str) else c
                        ink=tuple((a+b)//2 for a,b in zip(rgb(ink),rgb(paper)))
                    if width:
                        draw.rectangle((x*CW,y*CH,(x+width)*CW-1,(y+1)*CH-1), fill=paper)
                    draw.text((x*CW,y*CH-1),char,font=BOLD if bold else FONT,fill=ink)
                    x+=width
                assert x<=COLS, (x,line)
    image.save(destination)
async def pause(): await asyncio.sleep(.45)
async def key(value, literal=False):
    tmux('send-keys','-t','demo',*(['-l'] if literal else []),value)
    await pause()
def snap(mode,name,duration=1.4):
    ansi=tmux('capture-pane','-e','-p','-t','demo')
    target=OUT/mode/(name+'.png')
    target.with_suffix('.ansi').write_text(ansi)
    raster(ansi,target)
    frames.append({'mode':mode,'name':name,'seconds':duration})
async def run(mode):
    folder=OUT/mode
    if folder.exists(): shutil.rmtree(folder)
    folder.mkdir(parents=True)
    config=folder/'agent'; config.mkdir()
    (config/'settings.json').write_text(json.dumps({'defaultProjectTrust':'never','retry':{'enabled':False},'compaction':{'enabled':False}}))
    cmd=['env','PATH='+DISCOVERY_PATH,'PI_CODING_AGENT_DIR='+str(config),'CAPTURE_RUN_DIR='+str(folder),'NODE_NO_WARNINGS=1',shutil.which('node'),'--experimental-vm-modules','--import',str(ROOT/'docs/assets/capture-native.mjs'),str(ROOT/'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),'--no-extensions','-e',str(ROOT/'docs/assets/capture.mjs'),'--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-mcp','--no-tools','--no-session','--offline','--provider','capture-offline','--model','GPT-Ivan']
    tmux('new-session','-d','-s','demo','-x',str(COLS),'-y',str(ROWS),'-c',str(ROOT),shlex.join(cmd))
    tmux('set-option','-t','demo','status','off')
    tmux('set-option','-s','extended-keys','on')
    tmux('set-option','-s','extended-keys-format','csi-u')
    await asyncio.sleep(4)
    snap(mode,'00-startup',2)
    await key('/snippets',True); await key('Enter')
    snap(mode,'01-menu')
    await key('Space'); snap(mode,'02-prepend-one',.8)
    await key('Down'); await key('Space'); snap(mode,'03-prepend-two',.8)
    await key('Down'); await key('Space'); snap(mode,'04-selection',2)
    await key('Tab'); snap(mode,'05-preview',2)
    await key('Tab')
    if mode=='hidden':
        for _ in range(4): await key('Down')
        await key('Space'); snap(mode,'06-hidden-setting',1.4)
    await key('Escape'); snap(mode,'07-widget',1.4)
    await key('Help me review this project.',True); snap(mode,'08-input',1.8)
    await key('Enter'); await asyncio.sleep(2); snap(mode,'09-sent',4)
    tmux('kill-session','-t','demo')
    request=json.loads((folder/'request.json').read_text())
    verification=json.loads((folder/'verification.json').read_text())
    assert verification['visibility']==mode
    assert verification['unchangedSnippetFixtures'] is True
    strip=lambda s: re.sub(r'\x1b\[[0-9;]*m','',s)
    selection=strip((folder/'04-selection.ansi').read_text())
    for title in ['Session kickoff','Orchestrator mode','Ask questions']:
        assert re.search(re.escape(title)+r'\s+temporary',selection)
    assert selection.count('temporary')==3
    assistant=[e['message'] for e in verification['entries'] if e['type']=='message' and e['message']['role']=='assistant']
    assert len(assistant)==1 and assistant[0]['content']==[] and assistant[0]['stopReason']=='stop'
    user=[m for m in request['messages'] if m['role']=='user']
    assert len(user)==1
    text=user[0]['content']; text=text if isinstance(text,str) else ''.join(c['text'] for c in text)
    bodies=[(ROOT/'snippets'/f).read_text().split('---',2)[2].strip() for f in ['session-kickoff.md','orchestrator-mode.md','ask-questions.md']]
    assert text=='\n\n'.join([*bodies[:2],'Help me review this project.',bodies[2]])
    for snapshot in folder.glob('*.ansi'):
        assert 'Warning:' not in snapshot.read_text(), 'Native warning requires infrastructure fix, never cropping'
        assert 'IdeaProjects' not in snapshot.read_text()
    assert '@ivannovr/pi-prompt-snippets' in (folder/'00-startup.ansi').read_text()
    sent=(folder/'09-sent.ansi').read_text()
    plain=' '.join(strip(sent).split())
    if mode=='visible':
        for body in [*bodies[:2],'Help me review this project.',bodies[2]]: assert ' '.join(body.split()) in plain
    else: assert 'Help me review this project.' in sent and all(' '.join(body.split()) not in plain for body in bodies)
    for name in ['07-widget','08-input','09-sent']:
        plain=strip((folder/(name+'.ansi')).read_text())
        assert 'Prompt snippets' not in plain and 'Preview: Ask questions' not in plain
        assert 'GPT-Ivan' in plain.splitlines()[-1]
        assert '~/Projects/pi-prompt-snippets' in plain.splitlines()[-2]
    return {'requestSha256':hashlib.sha256(text.encode()).hexdigest(),'visibility':mode,'verifiedFullPrompt':True,'verifiedEmptyCompletion':True,'verifiedSelectedTemporaryIDs':['session-kickoff.md','orchestrator-mode.md','ask-questions.md'],'verifiedSendClipsNoMenuOrPreview':True,'verifiedNativeFooterAtBottom':True}
async def main():
    OUT.mkdir(exist_ok=True)
    try:
        results=[await run(mode) for mode in ['visible','hidden']]
    finally:
        subprocess.run(['tmux','-L',SOCKET,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    assert results[0]['requestSha256']==results[1]['requestSha256']
    def gif(name,chosen):
        listing=OUT/(name+'.ffconcat')
        listing.write_text('ffconcat version 1.0\n'+''.join(f"file '{OUT/f['mode']/(f['name']+'.png')}'\nduration {f['seconds']}\n" for f in chosen)+f"file '{OUT/chosen[-1]['mode']/(chosen[-1]['name']+'.png')}'\n")
        subprocess.run([os.environ.get('FFMPEG','/opt/homebrew/bin/ffmpeg'),'-v','error','-y','-safe','0','-i',str(listing),'-filter_complex','[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse','-loop','0',str(ROOT/'docs/assets'/name)],check=True)
    gif('demo.gif',[f for f in frames if f['mode']=='visible'])
    gif('menu.gif',[f for f in frames if f['mode']=='visible' and '01-menu'<=f['name']<='04-selection'])
    for mode in ['visible','hidden']:
        chosen=[f for f in frames if f['mode']==mode and f['name']>='07-widget']
        assert [f['name'] for f in chosen]==['07-widget','08-input','09-sent']
        gif(mode+'.gif',chosen)
    for name,source in [('menu','04-selection'),('preview','05-preview'),('widget','08-input')]: shutil.copyfile(OUT/'visible'/(source+'.png'),ROOT/'docs/assets'/(name+'.png'))
    manifest={'mechanism':'Actual Pi CLI PTY; tmux VT emulation; ANSI styled cell export; Pillow rasterization; ffmpeg GIF encoding. Not desktop pixels.','sourceSha256':hashlib.sha256((ROOT/'index.ts').read_bytes()).hexdigest(),'piVersion':json.loads((ROOT/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version'],'grid':{'columns':COLS,'rows':ROWS,'cellPixels':[CW,CH]},'input':'Help me review this project.','snippets':['session-kickoff.md','orchestrator-mode.md','ask-questions.md'],'selection':'All temporary; two prepend, one append','provider':'capture-offline/GPT-Ivan: fixture name, empty completion; no network, model output, or real model cost','theme':{'name':'system','selection':'Clean unset Pi theme; no terminal OSC color replies; native ANSI fallback','terminalForeground':FG,'terminalBackground':BG,'terminalPalette':'xterm 16-color defaults in raster(); SGR2 half-intensity foreground composited against background'},'nativeAdaptations':{'header':'Actual built-in Pi header preserved; one muted npm attribution line appended to native header container','cwd':'Native footer first-line display-only replacement ~/Projects/IdeaProjects/pi-prompt-snippets -> ~/Projects/pi-prompt-snippets; actual cwd unchanged'},'versions':{'tmux':tmux_version,'pillow':Image.__version__,'node':subprocess.check_output(['node','--version'],text=True).strip(),'toolsFromChildPath':TOOL_VERSIONS,'ffmpeg':subprocess.check_output([os.environ.get('FFMPEG','/opt/homebrew/bin/ffmpeg'),'-version'],text=True).splitlines()[0]},'executableDiscovery':'Existing ~/.pi/agent/bin prepended to child PATH; no cache relocation','verification':results,'frames':frames}
    manifest['resolvedNativeTheme']=json.loads((OUT/'visible/native-theme.json').read_text())
    manifest['media']={}
    for name in ['demo.gif','menu.gif','visible.gif','hidden.gif']:
        target=ROOT/'docs/assets'/name
        probe=json.loads(subprocess.check_output([str(Path(os.environ.get('FFMPEG','/opt/homebrew/bin/ffmpeg')).with_name('ffprobe')),'-v','error','-count_frames','-show_entries','stream=width,height,nb_read_frames,duration:format=size,duration','-of','json',str(target)],text=True))
        with Image.open(target) as image:
            delays=[]
            for i in range(image.n_frames): image.seek(i); delays.append(image.info['duration'])
            assert image.size==(COLS*CW,ROWS*CH)
        manifest['media'][name]={'ffprobe':probe,'delaysMilliseconds':delays,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
    assert manifest['sourceSha256']==hashlib.sha256(subprocess.check_output(['git','show','HEAD:index.ts'],cwd=ROOT)).hexdigest(), 'Application source must remain unchanged'
    (ROOT/'docs/assets/capture-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    sheet=Image.new('RGB',(1650,600),BG)
    representatives=[('visible','04-selection'),('visible','05-preview'),('visible','08-input'),('visible','09-sent'),('hidden','06-hidden-setting'),('hidden','09-sent')]
    for i,(mode,name) in enumerate(representatives):
        with Image.open(OUT/mode/(name+'.png')) as image:
            sheet.paste(image.resize((550,300)),((i%3)*550,(i//3)*300))
    sheet.save(OUT/'contact-sheet.png')
    print('Native capture, prompt equality, Visible/Hidden display checks passed.')
tmux_version=subprocess.check_output(['tmux','-V'],text=True).strip()
asyncio.run(main())
